import * as admin from "firebase-admin"
import * as functions from "firebase-functions/v1"
import { FUNCTIONS_REGION, taskQueueName } from "./config/region"
import * as logger from "firebase-functions/logger"
import { getFunctions } from "firebase-admin/functions"
import { processTurn } from "./gameprocessors/processTurn"
import { announceTurn } from "./utils/announceTurn"
import { MoveStatus } from "./types/Game"

export const onMoveCreated = functions
  .region(FUNCTIONS_REGION)
  .firestore
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

    // After transaction commits, schedule turn expiration — the same
    // announceTurn() path turn 0 goes through.
    if (
      result?.newTurnCreated &&
      result.newTurnNumber !== undefined &&
      result.turnDurationSeconds !== undefined
    ) {
      await announceTurn({
        sessionID,
        gameID,
        turnNumber: result.newTurnNumber,
        turnDurationSeconds: result.turnDurationSeconds,
        source: "onMoveCreated",
      })
    } else {
      logger.info(`[onMoveCreated] Skipping post-transaction work`, {
        gameID,
        moveNumber,
        reason: !result ? 'no result' : !result.newTurnCreated ? 'no new turn' : 'missing metadata'
      })
    }

    if (result?.tournamentSchedule) {
      const { sessionID: schedSessionID, gameID: schedGameID, delaySeconds, expectedScheduledStartMillis } = result.tournamentSchedule
      try {
        const queue = getFunctions().taskQueue(taskQueueName("processScheduledGameStart"))
        await queue.enqueue(
          { sessionID: schedSessionID, gameID: schedGameID, expectedScheduledStartMillis },
          { scheduleDelaySeconds: delaySeconds }
        )
        logger.info(
          `[onMoveCreated] Scheduled next tournament game start`,
          { sessionID: schedSessionID, gameID: schedGameID, delaySeconds }
        )
      } catch (error) {
        logger.error(`[onMoveCreated] Error scheduling tournament game start`, { schedGameID, error })
      }
    }

    logger.info(`[onMoveCreated] Completed`, { gameID, moveNumber })
  })
