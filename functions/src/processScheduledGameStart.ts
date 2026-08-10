import { onTaskDispatched } from "firebase-functions/v2/tasks"
import * as logger from "firebase-functions/logger"
import { startGame } from "./utils/startGame"

/**
 * Tournament-mode game start. Same job as onGameStarted, just triggered by the
 * clock instead of by readiness — so it delegates to the same startGame(),
 * which re-validates the schedule against fresh data and guarantees a single
 * start even if this task is delivered more than once.
 */
export const processScheduledGameStart = onTaskDispatched(async (request) => {
  const { sessionID, gameID, expectedScheduledStartMillis } = request.data

  logger.info(
    `[processScheduledGameStart] Task started for session ${sessionID}, game ${gameID}`,
    { sessionID, gameID, taskStartTime: new Date().toISOString() }
  )

  await startGame(
    sessionID,
    gameID,
    { kind: "scheduled", expectedScheduledStartMillis },
    "processScheduledGameStart"
  )

  logger.info(`[processScheduledGameStart] Task completed for game ${gameID}`)
})
