// processTurn.ts

import {
  GameResult,
  GameState,
  Move,
  Ranking,
  Winner
} from "@shared/types/Game"
import * as admin from "firebase-admin"
import {
  DocumentData,
  FieldValue,
  QuerySnapshot,
  Timestamp,
  Transaction,
} from "firebase-admin/firestore"
import { logger } from "../logger"
import { createNewGame } from "../utils/createNewGame"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

interface TeamData {
  id: string
  rankingRef: FirebaseFirestore.DocumentReference
  rankingData: Ranking | null
  currentMMR: number
  gamesPlayed: number
  exists: boolean
}

export interface ProcessTurnResult {
  newTurnCreated: boolean
  newTurnNumber?: number
  turnDurationSeconds?: number
  tournamentSchedule?: {
    sessionID: string
    gameID: string
    delaySeconds: number
    expectedScheduledStartMillis: number
  }
}

const DEFAULT_MMR = 1000
const MIN_MMR = 0 // Minimum MMR value

/** One staged privateMoves document: its id and the move it carries. */
export interface StagedMove {
  id: string
  move: Move
}

/** The commit timestamp of a staged move, or null if it carries none. */
const stagedAt = (move: Move): Timestamp | null =>
  move.timestamp instanceof Timestamp ? move.timestamp : null

/**
 * Newest staged write first — a TOTAL order, so the winner never depends on
 * the order Firestore happened to return the documents in.
 *
 * 1. Commit timestamp at full Firestore precision (seconds, then nanoseconds).
 *    `Timestamp.toMillis()` floors, so ordering on it alone left two revisions
 *    committed inside the SAME millisecond tied — and a tie fell through to
 *    the query's implicit `__name__` ordering over random document ids, which
 *    has nothing to do with which write actually landed last.
 * 2. Document id ascending, as the final tie-break. Timestamps are only ever
 *    exactly equal when the two writes shared a commit — i.e. one writeBatch —
 *    and then neither write is later than the other, so the choice is
 *    arbitrary by nature. It is pinned here purely so it is deterministic and
 *    reproducible. Writing at most one document per player per batch keeps the
 *    case unreachable.
 */
const newestStagedFirst = (a: StagedMove, b: StagedMove): number => {
  const at = stagedAt(a.move)
  const bt = stagedAt(b.move)
  const seconds = (bt?.seconds ?? 0) - (at?.seconds ?? 0)
  if (seconds !== 0) return seconds
  const nanos = (bt?.nanoseconds ?? 0) - (at?.nanoseconds ?? 0)
  if (nanos !== 0) return nanos
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * The move each player actually gets: their newest staged write committed at
 * or before the turn's `endTime`.
 *
 * The deadline comparison is in whole milliseconds — `toMillis()` floors both
 * sides — so a write that lands inside the millisecond `endTime` falls in
 * still counts. Everything later is dropped, whatever the client believed.
 * A move carrying no usable timestamp sorts as the epoch: it always passes the
 * deadline and always loses to a timestamped write from the same player.
 *
 * Players with nothing staged are simply absent from the result; resolution
 * substitutes each unit's default action for them (see engine/resolveTurn.ts).
 */
export function selectLatestMoves(
  staged: StagedMove[],
  endTime: Timestamp
): Move[] {
  const latestAllowedTime = endTime.toMillis()

  return staged
    .filter((s) => (stagedAt(s.move)?.toMillis() ?? 0) <= latestAllowedTime)
    .sort(newestStagedFirst)
    .reduce((acc: Move[], s: StagedMove) => {
      if (!acc.find((m) => m.playerID === s.move.playerID)) {
        acc.push(s.move)
      }
      return acc
    }, [])
}

async function preparePlayerUpdates(
  transaction: Transaction,
  sessionID: string,
  gameID: string,
  gameState: GameState,
  winners: Winner[]
): Promise<void> {
  const teams = gameState.setup.teams

  // Build references to the rankings documents
  const rankingRefs = teams.map((team) =>
    admin.firestore().collection("rankings").doc(team.id)
  )

  // Fetch existing rankings
  const rankingDocs = await Promise.all(
    rankingRefs.map((ref) => transaction.get(ref))
  )

  const teamData: TeamData[] = rankingDocs.map((doc) => {
    const data = doc.data() as Ranking | undefined

    return {
      id: doc.id,
      rankingRef: doc.ref,
      rankingData: data || null,
      currentMMR: data?.currentMMR ?? DEFAULT_MMR,
      gamesPlayed: data?.gamesPlayed ?? 0,
      exists: doc.exists,
    }
  })

  // Map of team ID to placement, handling draws
  const teamResults = teamData.map((team) => {
    const score = winners.find((w) => w.teamID === team.id)?.teamScore ?? 0
    return { teamID: team.id, score }
  })

  // Sort by score in descending order
  teamResults.sort((a, b) => b.score - a.score)

  // Assign placements, handling ties
  const placementsMap = new Map<string, number>()
  let currentPlacement = 1
  for (let i = 0; i < teamResults.length; i++) {
    const teamID = teamResults[i].teamID
    const score = teamResults[i].score

    // If not the first team and score is equal to previous score, same placement
    if (i > 0 && score === teamResults[i - 1].score) {
      // Same placement as previous
      placementsMap.set(teamID, currentPlacement)
    } else {
      // New placement
      currentPlacement = i + 1
      placementsMap.set(teamID, currentPlacement)
    }
  }

  // Get the list of placements in the same order as teamData
  const placements: number[] = teamData.map(
    (team) => placementsMap.get(team.id)!
  )

  // Prepare data for MMR calculation
  const teamsForMMR = teamData.map((team) => ({
    mmr: team.currentMMR,
    gamesPlayed: team.gamesPlayed,
  }))

  // Calculate MMR changes for all teams
  const mmrChanges = calculateMMRChanges(teamsForMMR, placements)

  const mmrChangeByTeam = new Map<string, { mmrChange: number; newMMR: number }>()
  const now = Date.now()

  for (let i = 0; i < teamData.length; i++) {
    const team = teamData[i]
    const mmrChange = mmrChanges[i]
    const placement = placements[i]

    const newMMR = team.currentMMR + mmrChange

    const gameResult: GameResult = {
      sessionID,
      gameID,
      timestamp: Timestamp.fromMillis(now),
      previousMMR: team.currentMMR,
      mmrChange,
      placement,
      opponents: teamData
        .filter((t) => t.id !== team.id)
        .map((opponent) => ({
          playerID: opponent.id,
          mmr: opponent.currentMMR,
          placement: placementsMap.get(opponent.id)!,
        })),
    }

    const existingRanking = team.rankingData ?? {
      currentMMR: DEFAULT_MMR,
      gamesPlayed: 0,
      wins: 0,
      losses: 0,
      gameHistory: [],
      lastUpdated: Timestamp.fromMillis(now),
    }

    const gameHistory = [...existingRanking.gameHistory, gameResult].slice(-100)

    const newRanking: Ranking = {
      currentMMR: newMMR,
      gamesPlayed: existingRanking.gamesPlayed + 1,
      wins: existingRanking.wins + (placement === 1 ? 1 : 0),
      losses: existingRanking.losses + (placement !== 1 ? 1 : 0),
      gameHistory,
      lastUpdated: FieldValue.serverTimestamp(),
    }

    mmrChangeByTeam.set(team.id, { mmrChange, newMMR })

    logger.info(`Preparing ranking update for team ${team.id}`, {
      previousMMR: team.currentMMR,
      newMMR: newMMR,
      mmrChange,
      placement,
      gamesPlayed: team.gamesPlayed,
      creating: !team.exists,
    })

    if (team.exists) {
      transaction.update(team.rankingRef, { ...newRanking })
    } else {
      transaction.create(team.rankingRef, newRanking)
    }
  }

  // Update the winners array to include mmrChange and newMMR
  for (const winner of winners) {
    const teamUpdate = mmrChangeByTeam.get(winner.teamID)
    if (teamUpdate) {
      winner.mmrChange = teamUpdate.mmrChange
      winner.newMMR = teamUpdate.newMMR
    }
  }
}

export async function processTurn(
  transaction: Transaction,
  gameID: string,
  sessionID: string,
  turnNumber: number
): Promise<ProcessTurnResult> {
  try {
    logger.info(
      `processTurn transaction started for game ${gameID}, turn ${turnNumber}`,
      {
        sessionID,
        gameID,
        turnNumber,
        transactionStartTime: new Date().toISOString()
      }
    )

    // Get game state
    const gameStateRef = admin
      .firestore()
      .collection(`sessions/${sessionID}/games`)
      .doc(gameID)
    const gameStateDoc = await transaction.get(gameStateRef)
    const gameState = gameStateDoc.data() as GameState

    if (!gameState) {
      logger.error("Game state not found", { gameID })
      return { newTurnCreated: false }
    }

    if (gameState.turns.length === 0) {
      logger.error("No turns in game state.")
      return { newTurnCreated: false }
    }

    const latestTurnNumber = gameState.turns.length - 1
    if (latestTurnNumber !== turnNumber) {
      logger.error(
        "Processing previous turn",
        latestTurnNumber,
        turnNumber
      )
      return { newTurnCreated: false }
    }
    const currentTurn = gameState.turns[turnNumber]

    // Get moves
    const movesQuery = admin
      .firestore()
      .collection(`sessions/${sessionID}/games/${gameID}/privateMoves`)
      .where("moveNumber", "==", turnNumber)
    const movesSnapshot: QuerySnapshot<DocumentData> = await transaction.get(
      movesQuery
    )

    if (currentTurn.winners.length > 0) {
      logger.warn("Game already finished.")
      return { newTurnCreated: false }
    }

    // Process moves and get next turn. Every write a player made for this turn
    // is here — the collection is append-only, so a revision is another
    // document, never an edit of the first.
    const stagedThisRound: StagedMove[] = movesSnapshot.docs.map((doc) => ({
      id: doc.id,
      move: doc.data() as Move,
    }))

    const latestMoves: Move[] = selectLatestMoves(
      stagedThisRound,
      currentTurn.endTime
    )

    if (!currentTurn) {
      logger.info("No current turn found for the game.", { gameID })
      return { newTurnCreated: false }
    }

    const processor = new TeamSnekProcessor(gameState)

    const nextTurn = await processor.applyMoves(currentTurn, latestMoves)
    const now = Date.now()
    const turnDurationMillis = gameState.setup.maxTurnTime * 1000
    const endTime = new Date(now + turnDurationMillis)

    nextTurn.startTime = Timestamp.fromMillis(now)
    nextTurn.endTime = Timestamp.fromDate(endTime)

    if (nextTurn.winners.length > 0) {
      // Prepare all ranking updates (reads and writes are done in preparePlayerUpdates)
      await preparePlayerUpdates(
        transaction,
        sessionID,
        gameID,
        gameState,
        nextTurn.winners
      )

      // Perform all writes together
      transaction.update(gameStateRef, {
        turns: FieldValue.arrayUnion(nextTurn),
        timeFinished: FieldValue.serverTimestamp(),
      })


      // Create new game
      const createResult = await createNewGame(transaction, sessionID, gameState.setup)

      logger.info(`Game ${gameID} finished and rankings updated.`, {
        winners: nextTurn.winners,
      })

      return { newTurnCreated: false, tournamentSchedule: createResult.tournamentSchedule }
    } else {
      // normal turn
      transaction.update(gameStateRef, {
        turns: FieldValue.arrayUnion(nextTurn),
      })

      const newTurnNumber = gameState.turns.length        // index of nextTurn
      const moveStatusRef = admin
        .firestore()
        .collection(`sessions/${sessionID}/games/${gameID}/moveStatuses`)
        .doc(`${newTurnNumber}`)
      // create(), not set(): this doc is only ever written here, atomically
      // with the arrayUnion above, and the latestTurnNumber guard bails out of
      // any re-run once that commit lands — so an existing doc means data
      // surgery or a logic bug, and failing loudly beats silently resetting a
      // moveStatus players may already be writing to. Mirrors startGame's
      // create() discipline for the game doc.
      transaction.create(moveStatusRef, {
        moveNumber: newTurnNumber,
        alivePlayerIDs: nextTurn.alivePlayers,
        movedPlayerIDs: [],
      })

      const turnDurationSeconds = gameState.setup.maxTurnTime

      logger.info(
        `Created new turn for game ${gameID}, turn ${newTurnNumber}`,
        {
          sessionID,
          gameID,
          turnNumber: newTurnNumber,
          turnDurationSeconds,
        }
      )

      // Return metadata for caller to handle task scheduling
      return {
        newTurnCreated: true,
        newTurnNumber,
        turnDurationSeconds,
      }
    }
  } catch (error) {
    logger.error(
      `Error processing turn ${turnNumber} for game ${gameID}:`,
      error
    )
    throw error
  }
}

export const calculateMMRChanges = (
  players: { mmr: number; gamesPlayed: number }[],
  placements: number[]
): number[] => {
  const mmrChanges: number[] = []

  players.forEach((player, idx) => {
    const opponentPlayers = players.filter((_, i) => i !== idx)
    const numOpponents = opponentPlayers.length

    if (numOpponents === 0) {
      mmrChanges.push(0)
      return
    }

    // Expected score
    let expectedScore = 0
    opponentPlayers.forEach((opponent) => {
      const mmrDiff = player.mmr - opponent.mmr
      const winProb = 1 / (1 + Math.pow(10, -mmrDiff / 400))
      expectedScore += winProb
    })
    expectedScore = expectedScore / numOpponents

    // Actual score considering draws
    let actualScore = 0
    const playerPlacement = placements[idx]
    opponentPlayers.forEach((_, oppIdx) => {
      const opponentPlacement = placements[oppIdx >= idx ? oppIdx + 1 : oppIdx]
      let scoreVsOpponent = 0
      if (playerPlacement < opponentPlacement) {
        scoreVsOpponent = 1 // Player beat opponent
      } else if (playerPlacement === opponentPlacement) {
        scoreVsOpponent = 0.5 // Draw
      } else {
        scoreVsOpponent = 0 // Player lost to opponent
      }
      actualScore += scoreVsOpponent
    })
    actualScore = actualScore / numOpponents

    // Dynamic K-factor
    const K = calculateKFactor(player.gamesPlayed)

    // MMR change
    const mmrChange = K * (actualScore - expectedScore)
    mmrChanges.push(mmrChange)
  })

  // Adjust MMR changes to prevent MMR from going below MIN_MMR
  const adjustedMMRChanges = adjustMMRChangesForMinMMR(players, mmrChanges, MIN_MMR)

  // Round the MMR changes
  return adjustedMMRChanges.map((change) => Math.round(change))
}

function calculateKFactor(gamesPlayed: number): number {
  const MAX_K = 64 // High K-factor for new players
  const MIN_K = 16 // Lower K-factor for experienced players
  const K = Math.max(MIN_K, MAX_K - (gamesPlayed * (MAX_K - MIN_K)) / 50)
  return K
}

// Adjust MMR changes to prevent MMR from going below MIN_MMR
function adjustMMRChangesForMinMMR(
  players: { mmr: number }[],
  mmrChanges: number[],
  minMMR: number
): number[] {
  const adjustedChanges = [...mmrChanges]
  let totalAdjustment = 0

  for (let i = 0; i < players.length; i++) {
    const playerMMR = players[i].mmr
    const mmrChange = adjustedChanges[i]
    const newMMR = playerMMR + mmrChange

    if (newMMR < minMMR) {
      const adjustmentNeeded = minMMR - newMMR
      totalAdjustment += adjustmentNeeded // This amount needs to be redistributed
      adjustedChanges[i] += adjustmentNeeded // Adjust MMR change
    }
  }

  // Redistribute the total adjustment among other players proportionally
  const playersWhoCanReceiveAdjustment = players
    .map((player, idx) => ({ idx, mmrChange: adjustedChanges[idx] }))
    .filter((p) => adjustedChanges[p.idx] + totalAdjustment / players.length > 0)

  if (playersWhoCanReceiveAdjustment.length > 0) {
    const adjustmentPerPlayer = totalAdjustment / playersWhoCanReceiveAdjustment.length
    playersWhoCanReceiveAdjustment.forEach((p) => {
      adjustedChanges[p.idx] -= adjustmentPerPlayer
    })
  }

  return adjustedChanges
}
