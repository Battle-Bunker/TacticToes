// functions/src/utils/createNewGame.ts

import { GameSetup, StartedGameSetup } from "@shared/types/Game"
import * as admin from "firebase-admin"
import { Timestamp, Transaction } from "firebase-admin/firestore"
import { logger } from "../logger"

export interface CreateNewGameResult {
  newGameID: string
  tournamentSchedule?: {
    sessionID: string
    gameID: string
    delaySeconds: number
    expectedScheduledStartMillis: number
  }
}

/**
 * Creates the next game's setup for a session, copying the previous setup
 * (teams, colours, snakesPerTeam, board and timing config) when one exists.
 */
export async function createNewGame(
  transaction: Transaction,
  sessionName: string,
  previousSetup: GameSetup | null,
): Promise<CreateNewGameResult> {
  try {
    const newGameSetup: GameSetup = previousSetup
      ? {
          ...previousSetup,
          hazardPercentage: previousSetup.hazardPercentage ?? 0,
          startRequested: false,
          started: false,
          timeCreated: Timestamp.now(),
        }
      : {
          // Default setup when no previous game exists
          teams: [],
          snakesPerTeam: 3,
          boardWidth: 13,
          boardHeight: 13,
          maxTurnTime: 10,
          firstTurnTime: 60,
          startRequested: false,
          started: false,
          hazardPercentage: 0,
          teamClustersEnabled: false,
          timeCreated: Timestamp.now(),
        }
    // A finished game's embedded setup carries the expanded snakes; the lobby
    // setup must not — snakes are regenerated at the next start.
    delete (newGameSetup as Partial<StartedGameSetup>).gamePlayers

    if (previousSetup?.tournamentMode && newGameSetup.remainingRounds !== undefined) {
      const decremented = newGameSetup.remainingRounds - 1
      newGameSetup.remainingRounds = decremented

      if (decremented > 0 && newGameSetup.interludeDuration !== undefined) {
        const nowMs = Date.now()
        const scheduledMs = nowMs + newGameSetup.interludeDuration * 1000
        newGameSetup.scheduledStartTime = Timestamp.fromMillis(scheduledMs)
      }
    }

    // Reference to the current session document
    const sessionRef = admin.firestore().collection("sessions").doc(sessionName)
    // Generate a new unique game ID
    const newGameSetupRef = sessionRef.collection("setups").doc()
    // Set the new game document within the transaction
    transaction.set(newGameSetupRef, newGameSetup)

    // Update the current game document's nextGame field to reference the new game
    transaction.update(sessionRef, { latestGameID: newGameSetupRef.id })

    logger.info(
      `New game created with ID ${newGameSetupRef.id} on sesh ${sessionName}`,
      {
        id: newGameSetupRef.id,
        sessionName: sessionName,
      },
    )

    const result: CreateNewGameResult = { newGameID: newGameSetupRef.id }

    if (
      previousSetup?.tournamentMode &&
      newGameSetup.remainingRounds !== undefined &&
      newGameSetup.remainingRounds > 0 &&
      newGameSetup.interludeDuration !== undefined &&
      newGameSetup.scheduledStartTime
    ) {
      const scheduledMillis = (newGameSetup.scheduledStartTime as Timestamp).toMillis()
      result.tournamentSchedule = {
        sessionID: sessionName,
        gameID: newGameSetupRef.id,
        delaySeconds: Math.max(0, newGameSetup.interludeDuration),
        expectedScheduledStartMillis: scheduledMillis,
      }
    }

    return result
  } catch (error) {
    logger.error(`Error creating new game for session ${sessionName}:`, error)
    throw error
  }
}
