import * as admin from "firebase-admin"
import { FieldValue, Timestamp } from "firebase-admin/firestore"
import {
  GameSetup,
  GameState,
  MoveStatus,
  StartedGameSetup,
  Turn,
} from "@shared/types/Game"
import { TeamSnekProcessor } from "../gameprocessors/TeamSnekProcessor"
import { logger } from "../logger"
import { FirstMoveTimeoutSeconds } from "../timings"
import { announceTurn } from "./announceTurn"
import { writeCentaurGameInvites, writeCentaurMap } from "./centaurGameMeta"
import { expandTeams } from "./expandTeams"

/**
 * The one and only way a game goes from "setup" to "turn 0 exists".
 *
 * Both entry points — the start trigger (onGameStarted) and the tournament
 * scheduler (processScheduledGameStart) — funnel through here, and the result
 * is deliberately shaped like any other turn: build the turn, commit it, then
 * announceTurn() arms the expiry task exactly as processTurn's callers do for
 * turns 1..n.
 *
 * Idempotency matters more here than anywhere else in the codebase. The setup
 * document is written by the lobby on every edit, Firestore triggers are
 * at-least-once, and `started` only becomes visible once this transaction
 * commits — so several invocations can legitimately observe
 * `started === false` at the same moment. The guard is structural:
 *   - the setup document is READ inside the transaction, so two concurrent
 *     starts contend and the loser retries and sees `started === true`;
 *   - the game document is created with `transaction.create()`, so even a
 *     start that somehow slipped the first guard cannot overwrite a live board.
 */

export type StartTrigger =
  | { kind: "startRequested" }
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
  if (setup.teams.length < 2) return "fewer than 2 teams"

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

    const gamePlayers = expandTeams(setup.teams, setup.snakesPerTeam)
    const gameSetup: StartedGameSetup = { ...setup, gamePlayers, started: true }

    // The processor needs a GameState to build against; only `setup` is read
    // while producing the first turn.
    const processor = new TeamSnekProcessor({
      turns: [],
      setup: gameSetup,
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: null,
    })

    // The turn window is stamped here and nowhere else. The processor fills in
    // its own placeholder times while building the board; turn 0's real
    // window is this one, written once, never revised.
    const now = Date.now()
    const turnDurationSeconds = firstTurnDurationSeconds(gameSetup)

    const firstTurn: Turn = processor.firstTurn()
    firstTurn.startTime = Timestamp.fromMillis(now)
    firstTurn.endTime = Timestamp.fromMillis(now + turnDurationSeconds * 1000)

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

    // Snake ownership map for the centaur security rules
    writeCentaurMap(transaction, sessionID, gameID, gameSetup)

    logger.info(`[${source}] Game ${gameID} initialized`, {
      sessionID,
      gameID,
      turnDurationSeconds,
    })

    return { setup: gameSetup, turnDurationSeconds }
  })

  if (!started) return false

  try {
    await writeCentaurGameInvites(sessionID, gameID, started.setup)
  } catch (error) {
    logger.error(`[${source}] Error writing centaur game invites`, { gameID, error })
  }

  await announceTurn({
    sessionID,
    gameID,
    turnNumber: 0,
    turnDurationSeconds: started.turnDurationSeconds,
    source,
  })

  logger.info(`[${source}] Game ${gameID} initialization complete`, { sessionID, gameID })
  return true
}
