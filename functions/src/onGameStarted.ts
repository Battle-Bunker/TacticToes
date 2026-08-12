// functions/src/onGameStarted.ts

import * as functions from "firebase-functions/v1"
import { FUNCTIONS_REGION } from "./config/region"
import { enqueueTask } from "./utils/enqueueTask"
import { Timestamp } from "firebase-admin/firestore"
import { GameSetup } from "@shared/types/Game"
import { logger } from "./logger"
import { syncPendingInvites } from "./utils/centaurGameMeta"
import { startGame } from "./utils/startGame"

/**
 * Firestore trigger on the lobby setup document.
 *
 * Two jobs, both thin:
 *  1. While the lobby is unstarted, keep each centaur's pending invite in sync
 *     with setup.teams (create on team add, delete on team remove). Runs on
 *     CREATE too — createNewGame carries teams over from the previous game.
 *     Pending invites are never deleted at start: startGame's post-transaction
 *     invite write overwrites the same doc with status 'started'.
 *  2. Decide whether an update is worth *attempting* a start for. Whether the
 *     game may actually start — and the guarantee that it starts exactly once —
 *     lives in startGame(), because this trigger fires on every setup edit and
 *     Firestore delivers at-least-once.
 */
export const onGameStarted = functions
  .region(FUNCTIONS_REGION)
  .firestore
  .document("sessions/{sessionID}/setups/{gameID}")
  .onWrite(async (change, context) => {
    const { gameID, sessionID } = context.params

    if (!change.after.exists) return
    const afterData = change.after.data() as GameSetup
    const beforeData = change.before.exists
      ? (change.before.data() as GameSetup)
      : null

    logger.debug(`Checking write on game: ${gameID}`)

    if (!afterData.started) {
      await syncPendingInvites(
        sessionID,
        gameID,
        beforeData?.teams ?? [],
        afterData.teams
      )
    }

    if (afterData.started) {
      logger.info(`Game ${gameID} already started — nothing to do.`)
      return
    }

    // A freshly created setup cannot be startable (startRequested is false and
    // tournament rounds are scheduled by createNewGame's caller).
    if (!beforeData) return

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

      await enqueueTask({
        functionName: "processScheduledGameStart",
        payload: { sessionID, gameID, expectedScheduledStartMillis: scheduledTime.toMillis() },
        scheduleDelaySeconds: delaySeconds,
        source: "onGameStarted",
        purpose: "Scheduled tournament game start",
        context: { sessionID, gameID, scheduledMillis: scheduledTime.toMillis() },
      })
      return
    }

    await startGame(sessionID, gameID, { kind: "startRequested" }, "onGameStarted")
  })
