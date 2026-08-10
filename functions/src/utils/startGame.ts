import * as admin from "firebase-admin"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import { GameSetup, GameState, MoveStatus, Turn } from "@shared/types/Game"
import { getGameProcessor, getProcessorClass } from "../gameprocessors/ProcessorFactory"
import { logger } from "../logger"
import { FirstMoveTimeoutSeconds } from "../timings"
import { announceTurn } from "./announceTurn"
import { writeBotGameInvites, writeBotMap } from "./botGameMeta"
import { loadIdentityDirectory, withResolvedIdentities } from "./playerIdentity"

/**
 * The one and only way a game goes from "setup" to "turn 0 exists".
 *
 * Both entry points — the ready/start trigger (onGameStarted) and the
 * tournament scheduler (processScheduledGameStart) — funnel through here, and
 * the result is deliberately shaped like any other turn: build the turn, commit
 * it, then announceTurn() arms the expiry task and notifies bots exactly as
 * processTurn's callers do for turns 1..n.
 *
 * Idempotency matters more here than anywhere else in the codebase. The setup
 * document is written by the lobby on every edit (ready, start, kick, preview
 * regeneration...), Firestore triggers are at-least-once, and `started` only
 * becomes visible once this transaction commits — so several invocations can
 * legitimately observe `started === false` at the same moment. Previously each
 * one ran `transaction.set()` over the game document, which meant a game could
 * be re-created several times in its first second: a fresh randomised board, a
 * fresh turn-0 endTime, and a moveStatuses/0 reset to empty. Bots that had
 * already staged a move for the old board were left with moves the read-back
 * could no longer match (their head had moved), so the move never showed as
 * confirmed, and clients saw the turn-0 deadline jump around.
 *
 * The guard is now structural rather than best-effort:
 *   - the setup document is READ inside the transaction, so two concurrent
 *     starts contend and the loser retries and sees `started === true`;
 *   - the game document is created with `transaction.create()`, so even a
 *     start that somehow slipped the first guard cannot overwrite a live board.
 */

export type StartTrigger =
  | { kind: "playersReady" }
  | { kind: "scheduled"; expectedScheduledStartMillis?: number }

/** How long turn 0 runs for. Falls back to the standard per-turn time. */
export function firstTurnDurationSeconds(setup: GameSetup): number {
  return setup.firstTurnTime ?? FirstMoveTimeoutSeconds
}

/**
 * Why this setup can't be started right now, or null when it can. Evaluated
 * both before opening the transaction (cheap early-out) and again inside it
 * against freshly-read data (correctness).
 */
export function reasonNotToStart(setup: GameSetup, trigger: StartTrigger): string | null {
  if (setup.started) return "game already started"
  if (!setup.gamePlayers || setup.gamePlayers.length === 0) return "no players in game"

  if (trigger.kind === "scheduled") {
    if (!setup.tournamentMode) return "tournament mode not active"
    if (!setup.scheduledStartTime) return "no scheduledStartTime set"
    if (trigger.expectedScheduledStartMillis) {
      const scheduledMillis = (setup.scheduledStartTime as Timestamp).toMillis()
      if (Math.abs(scheduledMillis - trigger.expectedScheduledStartMillis) > 5000) {
        return "scheduledStartTime changed — stale task"
      }
    }
    return null
  }

  if (setup.tournamentMode) return "tournament mode — start is scheduler-driven"
  if (!setup.startRequested) return "start not requested yet"

  const playersReady = setup.playersReady ?? []
  const allPlayersReady = setup.gamePlayers
    .filter((gamePlayer) => gamePlayer.type === "human")
    .every((player) => playersReady.includes(player.id))
  if (!allPlayersReady) return "not all players are ready"

  return null
}

/**
 * Starts the game if it is startable, and returns whether it did. Safe to call
 * concurrently and repeatedly for the same game: at most one call ever creates
 * the game document.
 */
export async function startGame(
  sessionID: string,
  gameID: string,
  trigger: StartTrigger,
  source: string
): Promise<boolean> {
  const db = admin.firestore()
  const setupRef = db.doc(`sessions/${sessionID}/setups/${gameID}`)
  const gameStateRef = db.doc(`sessions/${sessionID}/games/${gameID}`)

  const preSnap = await setupRef.get()
  if (!preSnap.exists) {
    logger.warn(`[${source}] Setup not found for game ${gameID}`, { sessionID, gameID })
    return false
  }

  const preSetup = preSnap.data() as GameSetup
  const preReason = reasonNotToStart(preSetup, trigger)
  if (preReason) {
    logger.info(`[${source}] Not starting game ${gameID}: ${preReason}`, { sessionID, gameID })
    return false
  }

  if (!getProcessorClass(preSetup.gameType)) {
    logger.error(`[${source}] No processor class for gameType: ${preSetup.gameType}`, {
      sessionID,
      gameID,
    })
    return false
  }

  // Name/emoji lookups hit collections the transaction has no business
  // locking, so they happen up front and are applied to the freshly-read
  // player list inside the transaction.
  const identities = await loadIdentityDirectory(preSetup)

  const started = await db.runTransaction(async (transaction) => {
    // Read first: this is what serialises concurrent starts. A second
    // invocation either reads `started === true` here, or contends on the
    // update below, retries, and then reads it.
    const setupSnap = await transaction.get(setupRef)
    if (!setupSnap.exists) return null
    const setup = setupSnap.data() as GameSetup

    const reason = reasonNotToStart(setup, trigger)
    if (reason) {
      logger.info(`[${source}] Not starting game ${gameID} (in transaction): ${reason}`, {
        sessionID,
        gameID,
      })
      return null
    }

    const gameSnap = await transaction.get(gameStateRef)
    if (gameSnap.exists) {
      // The game document outlives its setup flag: honour the board that is
      // already being played and just repair the flag.
      logger.warn(
        `[${source}] Game document for ${gameID} already exists — marking setup started instead of recreating`,
        { sessionID, gameID }
      )
      transaction.update(setupRef, { started: true })
      return null
    }

    const ProcessorClass = getProcessorClass(setup.gameType)
    if (!ProcessorClass) return null

    // Players not returned by the processor become observers, and every
    // remaining player carries a resolved display name/emoji from here on.
    const gamePlayers = withResolvedIdentities(
      ProcessorClass.filterActivePlayers(setup),
      identities
    )
    const gameSetup: GameSetup = { ...setup, gamePlayers, started: true }

    // The processor needs a GameState to build against; only `setup` is read
    // while producing the first turn.
    const processor = getGameProcessor({
      turns: [],
      setup: gameSetup,
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: null,
    })
    if (!processor) {
      logger.error(`[${source}] No processor for gameType: ${setup.gameType}`, {
        sessionID,
        gameID,
      })
      return null
    }

    // The turn window is stamped here and nowhere else. Processors fill in
    // their own placeholder times while building the board; turn 0's real
    // window is this one, written once, never revised.
    const now = Date.now()
    const turnDurationSeconds = firstTurnDurationSeconds(gameSetup)
    const turnExpiryTime = now + turnDurationSeconds * 1000

    const firstTurn: Turn = processor.firstTurn()
    firstTurn.startTime = Timestamp.fromMillis(now)
    firstTurn.endTime = Timestamp.fromMillis(turnExpiryTime)

    const newGame: GameState = {
      setup: gameSetup,
      turns: [firstTurn],
      timeCreated: FieldValue.serverTimestamp(),
      timeFinished: null,
    }
    // create(), not set(): a duplicate start fails the transaction rather than
    // silently replacing a board that players are already moving on.
    transaction.create(gameStateRef, newGame)

    transaction.update(setupRef, { started: true, startRequested: true })

    const moveStatus: MoveStatus = {
      moveNumber: 0,
      alivePlayerIDs: firstTurn.alivePlayers,
      movedPlayerIDs: [],
    }
    transaction.set(
      db.doc(`sessions/${sessionID}/games/${gameID}/moveStatuses/0`),
      moveStatus
    )

    // Bot ownership map for the Firebase bot interface security rules
    writeBotMap(transaction, sessionID, gameID, gameSetup)

    logger.info(`[${source}] Game ${gameID} initialized`, {
      sessionID,
      gameID,
      turnDurationSeconds,
    })

    return { setup: gameSetup, turnDurationSeconds, turnExpiryTime }
  })

  if (!started) return false

  try {
    // Game invites for Firebase-connected bots.
    await writeBotGameInvites(sessionID, gameID, started.setup)
  } catch (error) {
    logger.error(`[${source}] Error writing bot game invites`, { gameID, error })
  }

  await announceTurn({
    sessionID,
    gameID,
    turnNumber: 0,
    turnDurationSeconds: started.turnDurationSeconds,
    turnExpiryTime: started.turnExpiryTime,
    source,
  })

  logger.info(`[${source}] Game ${gameID} initialization complete`, { sessionID, gameID })
  return true
}
