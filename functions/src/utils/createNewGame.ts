// functions/src/utils/createNewGame.ts

import { GameSetup } from "@shared/types/Game"
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
 * Creates a new game after determining the winner(s).
 * @param transaction Firestore transaction object.
//  * @param gameID The ID of the current game.
 */
export async function createNewGame(
  transaction: Transaction,
  sessionName: string,
  previousSetup: GameSetup | null,
): Promise<CreateNewGameResult> {
  try {
    // Copy all fields from previous setup (if exists) and override only what must be reset
    const newGameSetup: GameSetup = previousSetup
      ? {
          ...previousSetup, // Copy all fields including gamePlayers (preserves bots, kings, team assignments)
          hazardPercentage: previousSetup.hazardPercentage ?? 0,
          playersReady: [], // Reset ready state - players must re-ready
          startRequested: false, // Reset start flag
          started: false, // Reset started flag
          timeCreated: Timestamp.now(), // New timestamp
        }
      : {
          // Default setup when no previous game exists
          gameType: "snek",
          gamePlayers: [],
          boardWidth: 11,
          boardHeight: 11,
          maxTurnTime: 10,
          firstTurnTime: 60,
          playersReady: [],
          startRequested: false,
          started: false,
          hazardPercentage: 0,
          teamClustersEnabled: false,
          timeCreated: Timestamp.now(),
        }

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
