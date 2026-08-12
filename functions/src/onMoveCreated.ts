import * as functions from "firebase-functions/v1"
import { FUNCTIONS_REGION } from "./config/region"
import * as logger from "firebase-functions/logger"
import { resolveTurnAndAnnounce } from "./utils/resolveTurnAndAnnounce"
import { MoveStatus } from "@shared/types/Game"

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

    // Check if all alive players have moved. This is a pure check over the
    // snapshot data, so it does not need to run inside the transaction.
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
      return
    }

    logger.info(`[onMoveCreated] All players have moved - calling processTurn`, { gameID, moveNumber })
    await resolveTurnAndAnnounce(sessionID, gameID, Number(moveNumber), "onMoveCreated")

    logger.info(`[onMoveCreated] Completed`, { gameID, moveNumber })
  })
