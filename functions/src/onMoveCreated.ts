import * as admin from "firebase-admin"
import * as functions from "firebase-functions"
import * as logger from "firebase-functions/logger"
import { getFunctions } from "firebase-admin/functions"
import { processTurn } from "./gameprocessors/processTurn"
import { notifyBots } from "./utils/notifyBots"
import { MoveStatus } from "./types/Game" // Adjust the import path as necessary

export const onMoveCreated = functions.firestore
  .document("sessions/{sessionID}/games/{gameID}/moveStatuses/{moveNumber}")
  .onUpdate(async (snap, context) => {
    const moveData = snap.after.data() as MoveStatus
    const { gameID, sessionID, moveNumber } = context.params

    logger.info(`[onMoveCreated] Processing move for gameID: ${gameID}`, { 
      moveData,
      aliveCount: moveData.alivePlayerIDs.length,
      movedCount: moveData.movedPlayerIDs.length
    })

    const result = await admin.firestore().runTransaction(async (transaction) => {
      // Check if all alive players have moved
      const allPlayersMoved = moveData.alivePlayerIDs.every((playerID) =>
        moveData.movedPlayerIDs.includes(playerID),
      )

      logger.info(`[onMoveCreated] All players moved check`, {
        gameID,
        moveNumber,
        allPlayersMoved,
        alivePlayerIDs: moveData.alivePlayerIDs,
        movedPlayerIDs: moveData.movedPlayerIDs
      })

      if (!allPlayersMoved) {
        logger.info(`[onMoveCreated] Waiting for more players - returning null`, { gameID, moveNumber })
        return null
      }

      logger.info(`[onMoveCreated] All players have moved - calling processTurn`, { gameID, moveNumber })
      // Process the turn and update the game state
      const turnResult = await processTurn(transaction, gameID, sessionID, Number(moveNumber))
      logger.info(`[onMoveCreated] processTurn returned`, { gameID, moveNumber, turnResult })
      return turnResult
    })

    logger.info(`[onMoveCreated] Transaction completed`, { 
      gameID, 
      moveNumber,
      result,
      hasResult: !!result,
      newTurnCreated: result?.newTurnCreated
    })

    // After transaction commits, schedule turn expiration and notify bots
    if (result?.newTurnCreated && result.newTurnNumber !== undefined && result.turnDurationSeconds !== undefined) {
      logger.info(`[onMoveCreated] Starting post-transaction orchestration`, { 
        gameID, 
        newTurnNumber: result.newTurnNumber 
      })

      try {
        // Schedule turn expiration task
        const queue = getFunctions().taskQueue("processTurnExpirationTask")
        logger.info(`[onMoveCreated] Got task queue reference`, { gameID })
        
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
          `[onMoveCreated] Successfully scheduled turn expiration for game ${gameID}, turn ${result.newTurnNumber}`,
          {
            sessionID,
            gameID,
            turnNumber: result.newTurnNumber,
            delaySeconds: result.turnDurationSeconds,
          }
        )
      } catch (error) {
        logger.error(`[onMoveCreated] Error scheduling turn expiration`, { gameID, error })
        throw error
      }

      try {
        // Notify bots immediately
        logger.info(`[onMoveCreated] Starting bot notifications`, { gameID, turnNumber: result.newTurnNumber })
        await notifyBots(sessionID, gameID, result.newTurnNumber)
        logger.info(`[onMoveCreated] Bot notifications completed`, { gameID, turnNumber: result.newTurnNumber })
      } catch (error) {
        logger.error(
          `[onMoveCreated] Error notifying bots for game ${gameID}, turn ${result.newTurnNumber}`,
          error
        )
      }
    } else {
      logger.info(`[onMoveCreated] Skipping post-transaction work`, { 
        gameID,
        moveNumber,
        reason: !result ? 'no result' : !result.newTurnCreated ? 'no new turn' : 'missing metadata'
      })
    }

    logger.info(`[onMoveCreated] Completed`, { gameID, moveNumber })
  })
