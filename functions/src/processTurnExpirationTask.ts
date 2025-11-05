import * as admin from "firebase-admin"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import * as logger from "firebase-functions/logger"
import { processTurn } from "./gameprocessors/processTurn"

/**
 * Firebase task queue function for processing turn expirations.
 * This is invoked when a turn's timeout period has elapsed.
 */
export const processTurnExpirationTask = onTaskDispatched(
  async (request) => {
    const { sessionID, gameID, turnNumber } = request.data

    logger.info(
      `Turn expiration task started for game ${gameID}, turn ${turnNumber}`,
      {
        sessionID,
        gameID,
        turnNumber,
        taskStartTime: new Date().toISOString()
      }
    )

    if (typeof turnNumber !== "number" || Number.isNaN(turnNumber)) {
      logger.error(
        `Invalid turnNumber—expected a number but got "${turnNumber}"`
      )
      return
    }

    if (turnNumber > 1000) {
      logger.error("Turn number over 1000, rejecting.")
      return
    }

    await admin.firestore().runTransaction(async (transaction) => {
      await processTurn(transaction, gameID, sessionID, turnNumber)
    })

    logger.info(
      `Turn expiration task completed for game ${gameID}, turn ${turnNumber}`
    )
  }
)
