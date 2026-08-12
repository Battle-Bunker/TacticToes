import * as admin from "firebase-admin"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import { FUNCTIONS_REGION } from "./config/region"
import { enqueueTask } from "./utils/enqueueTask"
import * as logger from "firebase-functions/logger"
import { processTurn } from "./gameprocessors/processTurn"
import { announceTurn } from "./utils/announceTurn"

/**
 * Firebase task queue function for processing turn expirations.
 * This is invoked when a turn's timeout period has elapsed.
 */
export const processTurnExpirationTask = onTaskDispatched(
  { region: FUNCTIONS_REGION },
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

    // Guard against early dispatch: Cloud Tasks may deliver before the
    // scheduled time (and the Cloud Tasks emulator ignores scheduleTime
    // entirely), which would resolve the turn before its staging window
    // closed. Wait out any remaining time until the turn's actual endTime.
    const preDoc = await admin
      .firestore()
      .doc(`sessions/${sessionID}/games/${gameID}`)
      .get()
    const preTurns = preDoc.data()?.turns
    const preTurn = Array.isArray(preTurns) ? preTurns[turnNumber] : undefined
    const endTimeMillis = preTurn?.endTime?.toMillis?.()
    if (typeof endTimeMillis === "number") {
      const remaining = endTimeMillis - Date.now()
      if (remaining > 50) {
        const waitMs = Math.min(remaining, 120_000)
        logger.info(
          `[processTurnExpirationTask] Dispatched ${remaining}ms early for game ${gameID}, turn ${turnNumber} — waiting ${waitMs}ms until endTime`
        )
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }

    logger.info(`[processTurnExpirationTask] Starting transaction`, { gameID, turnNumber })
    const result = await admin.firestore().runTransaction(async (transaction) => {
      const turnResult = await processTurn(transaction, gameID, sessionID, turnNumber)
      logger.info(`[processTurnExpirationTask] processTurn returned`, { gameID, turnNumber, turnResult })
      return turnResult
    })
    logger.info(`[processTurnExpirationTask] Transaction completed`, { gameID, turnNumber, result })

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
        source: "processTurnExpirationTask",
      })
    } else {
      logger.info(`[processTurnExpirationTask] Skipping post-transaction work`, { 
        gameID,
        turnNumber,
        reason: !result ? 'no result' : !result.newTurnCreated ? 'no new turn' : 'missing metadata'
      })
    }

    if (result?.tournamentSchedule) {
      const { sessionID: schedSessionID, gameID: schedGameID, delaySeconds, expectedScheduledStartMillis } = result.tournamentSchedule
      await enqueueTask({
        functionName: "processScheduledGameStart",
        payload: { sessionID: schedSessionID, gameID: schedGameID, expectedScheduledStartMillis },
        scheduleDelaySeconds: delaySeconds,
        source: "processTurnExpirationTask",
        purpose: "Scheduled tournament game start",
        context: { sessionID: schedSessionID, gameID: schedGameID },
      })
    }

    logger.info(
      `[processTurnExpirationTask] Task completed for game ${gameID}, turn ${turnNumber}`
    )
  }
)
