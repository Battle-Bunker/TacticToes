import * as admin from "firebase-admin"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import { getFunctions } from "firebase-admin/functions"
import * as logger from "firebase-functions/logger"
import { processTurn } from "./gameprocessors/processTurn"
import { notifyBots } from "./utils/notifyBots"

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

    const result = await admin.firestore().runTransaction(async (transaction) => {
      return await processTurn(transaction, gameID, sessionID, turnNumber)
    })

    // After transaction commits, schedule turn expiration and notify bots
    if (result?.newTurnCreated && result.newTurnNumber !== undefined && result.turnDurationSeconds !== undefined) {
      // Schedule turn expiration task
      const queue = getFunctions().taskQueue("processTurnExpirationTask")
      await queue.enqueue(
        {
          sessionID,
          gameID,
          turnNumber: result.newTurnNumber,
        },
        {
          scheduleDelaySeconds: result.turnDurationSeconds,
        }
      )

      logger.info(
        `Scheduled turn expiration for game ${gameID}, turn ${result.newTurnNumber}`,
        {
          sessionID,
          gameID,
          turnNumber: result.newTurnNumber,
          delaySeconds: result.turnDurationSeconds,
        }
      )

      // Notify bots immediately
      await notifyBots(sessionID, gameID, result.newTurnNumber).catch((error) => {
        logger.error(
          `Error notifying bots for game ${gameID}, turn ${result.newTurnNumber}`,
          error
        )
      })
    }

    logger.info(
      `Turn expiration task completed for game ${gameID}, turn ${turnNumber}`
    )
  }
)
