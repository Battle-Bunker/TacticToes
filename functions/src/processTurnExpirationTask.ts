import * as admin from "firebase-admin"
import { onTaskDispatched } from "firebase-functions/v2/tasks"
import { FUNCTIONS_REGION } from "./config/region"
import * as logger from "firebase-functions/logger"
import { resolveTurnAndAnnounce } from "./utils/resolveTurnAndAnnounce"

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
    await resolveTurnAndAnnounce(sessionID, gameID, turnNumber, "processTurnExpirationTask")

    logger.info(
      `[processTurnExpirationTask] Task completed for game ${gameID}, turn ${turnNumber}`
    )
  }
)
