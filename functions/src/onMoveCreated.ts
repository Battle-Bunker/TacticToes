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

    logger.info(`Processing move for gameID: ${gameID}`, { moveData })

    const result = await admin.firestore().runTransaction(async (transaction) => {
      // Check if all alive players have moved
      const allPlayersMoved = moveData.alivePlayerIDs.every((playerID) =>
        moveData.movedPlayerIDs.includes(playerID),
      )

      if (!allPlayersMoved) {
        return null
      }

      // Process the turn and update the game state
      return await processTurn(transaction, gameID, sessionID, Number(moveNumber))
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
  })
