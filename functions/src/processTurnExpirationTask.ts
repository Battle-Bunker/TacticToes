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
      `[processTurnExpirationTask] Turn expiration task started for game ${gameID}, turn ${turnNumber}`,
      {
        sessionID,
        gameID,
        turnNumber,
        taskStartTime: new Date().toISOString()
      }
    )

    if (typeof turnNumber !== "number" || Number.isNaN(turnNumber)) {
      logger.error(
        `[processTurnExpirationTask] Invalid turnNumber—expected a number but got "${turnNumber}"`
      )
      return
    }

    if (turnNumber > 1000) {
      logger.error("[processTurnExpirationTask] Turn number over 1000, rejecting.")
      return
    }

    logger.info(`[processTurnExpirationTask] Starting transaction`, { gameID, turnNumber })
    const result = await admin.firestore().runTransaction(async (transaction) => {
      const turnResult = await processTurn(transaction, gameID, sessionID, turnNumber)
      logger.info(`[processTurnExpirationTask] processTurn returned`, { gameID, turnNumber, turnResult })
      return turnResult
    })
    logger.info(`[processTurnExpirationTask] Transaction completed`, { gameID, turnNumber, result })

    // After transaction commits, schedule turn expiration and notify bots
    if (result?.newTurnCreated && result.newTurnNumber !== undefined && result.turnDurationSeconds !== undefined) {
      logger.info(`[processTurnExpirationTask] Starting post-transaction orchestration`, { 
        gameID, 
        newTurnNumber: result.newTurnNumber 
      })

      try {
        // Schedule turn expiration task
        const queue = getFunctions().taskQueue("processTurnExpirationTask")
        logger.info(`[processTurnExpirationTask] Got task queue reference`, { gameID })
        
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
          `[processTurnExpirationTask] Successfully scheduled turn expiration for game ${gameID}, turn ${result.newTurnNumber}`,
          {
            sessionID,
            gameID,
            turnNumber: result.newTurnNumber,
            delaySeconds: result.turnDurationSeconds,
          }
        )
      } catch (error) {
        logger.error(`[processTurnExpirationTask] Error scheduling turn expiration`, { gameID, error })
        throw error
      }

      try {
        // Notify bots immediately
        logger.info(`[processTurnExpirationTask] Starting bot notifications`, { gameID, turnNumber: result.newTurnNumber })
        await notifyBots(sessionID, gameID, result.newTurnNumber)
        logger.info(`[processTurnExpirationTask] Bot notifications completed`, { gameID, turnNumber: result.newTurnNumber })
      } catch (error) {
        logger.error(
          `[processTurnExpirationTask] Error notifying bots for game ${gameID}, turn ${result.newTurnNumber}`,
          error
        )
      }
    } else {
      logger.info(`[processTurnExpirationTask] Skipping post-transaction work`, { 
        gameID,
        turnNumber,
        reason: !result ? 'no result' : !result.newTurnCreated ? 'no new turn' : 'missing metadata'
      })
    }

    logger.info(
      `[processTurnExpirationTask] Task completed for game ${gameID}, turn ${turnNumber}`
    )
  }
)
