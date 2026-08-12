import * as admin from "firebase-admin"
import * as logger from "firebase-functions/logger"
import { processTurn } from "../gameprocessors/processTurn"
import { announceTurn } from "./announceTurn"
import { enqueueTask } from "./enqueueTask"

/**
 * Resolves a turn and arms the follow-up work. Shared by the two triggers
 * that resolve turns: onMoveCreated (all players moved) and
 * processTurnExpirationTask (turn timed out).
 *
 * Runs processTurn in a Firestore transaction, then — after the transaction
 * commits — announces the new turn (arming its expiration task, the same
 * announceTurn() path turn 0 goes through) and enqueues the optional
 * tournament game start.
 *
 * @param source Caller name, used as the log prefix and as the source string
 *   passed to announceTurn/enqueueTask, so logs stay attributable per trigger.
 */
export async function resolveTurnAndAnnounce(
  sessionID: string,
  gameID: string,
  turnNumber: number,
  source: string,
): Promise<void> {
  const result = await admin.firestore().runTransaction(async (transaction) => {
    const turnResult = await processTurn(transaction, gameID, sessionID, turnNumber)
    logger.info(`[${source}] processTurn returned`, { gameID, turnNumber, turnResult })
    return turnResult
  })

  logger.info(`[${source}] Transaction completed`, { gameID, turnNumber, result })

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
      source,
    })
  } else {
    logger.info(`[${source}] Skipping post-transaction work`, {
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
      source,
      purpose: "Scheduled tournament game start",
      context: { sessionID: schedSessionID, gameID: schedGameID },
    })
  }
}
