// functions/src/onGameStarted.ts

import * as functions from "firebase-functions/v1"
import { getFunctions } from "firebase-admin/functions"
import { Timestamp } from "firebase-admin/firestore"
import { GameSetup } from "@shared/types/Game"
import { logger } from "./logger"
import { startGame } from "./utils/startGame"

/**
 * Firestore trigger on the lobby setup document.
 *
 * Deliberately thin: it decides only whether this update is worth *attempting*
 * a start for. Whether the game may actually start — and the guarantee that it
 * starts exactly once — lives in startGame(), because this trigger fires on
 * every setup edit and Firestore delivers at-least-once.
 */
export const onGameStarted = functions.firestore
  .document("sessions/{sessionID}/setups/{gameID}")
  .onUpdate(async (change, context) => {
    const beforeData = change.before.data() as GameSetup
    const afterData = change.after.data() as GameSetup
    const { gameID, sessionID } = context.params

    logger.debug(`Checking update on game: ${gameID}`)

    if (afterData.started) {
      logger.info(`Game ${gameID} already started — nothing to do.`)
      return
    }

    if (afterData.tournamentMode) {
      // Tournament games start on a schedule, not on start requests. Enqueue the
      // scheduler whenever the scheduled time is set or moved; a stale task
      // detects the change and no-ops.
      const scheduledChanged =
        afterData.scheduledStartTime &&
        (!beforeData.scheduledStartTime ||
          (beforeData.scheduledStartTime as Timestamp).toMillis?.() !==
            (afterData.scheduledStartTime as Timestamp).toMillis?.())

      if (!scheduledChanged) {
        logger.info(`Game ${gameID} is in tournament mode — no schedule change.`)
        return
      }

      const scheduledTime = afterData.scheduledStartTime as Timestamp
      const delaySeconds = Math.max(
        0,
        Math.round((scheduledTime.toMillis() - Date.now()) / 1000)
      )

      try {
        const queue = getFunctions().taskQueue("processScheduledGameStart")
        await queue.enqueue(
          { sessionID, gameID, expectedScheduledStartMillis: scheduledTime.toMillis() },
          { scheduleDelaySeconds: delaySeconds }
        )
        logger.info(
          `[onGameStarted] Enqueued processScheduledGameStart for game ${gameID} in ${delaySeconds}s`,
          { sessionID, gameID, scheduledMillis: scheduledTime.toMillis(), delaySeconds }
        )
      } catch (error) {
        logger.error(`[onGameStarted] Error scheduling tournament game start`, {
          gameID,
          error,
        })
      }
      return
    }

    await startGame(sessionID, gameID, { kind: "startRequested" }, "onGameStarted")
  })
