import { getFunctions } from "firebase-admin/functions"
import { taskQueueName } from "../config/region"
import { logger } from "../logger"

export interface AnnounceTurnParams {
  sessionID: string
  gameID: string
  turnNumber: number
  /** Seconds from now until this turn's endTime. */
  turnDurationSeconds: number
  /** Caller name, for log correlation only. */
  source: string
}

/**
 * Arms the expiration task for a turn that has been committed to Firestore.
 * Turn 0 and every later turn go through this one function.
 *
 * Never throws. The turn is already committed, so a function retry would find
 * it resolved or superseded and could not recover anyway.
 */
export async function announceTurn(params: AnnounceTurnParams): Promise<void> {
  const { sessionID, gameID, turnNumber, turnDurationSeconds, source } = params

  try {
    const queue = getFunctions().taskQueue(taskQueueName("processTurnExpirationTask"))
    await queue.enqueue(
      { sessionID, gameID, turnNumber },
      { scheduleDelaySeconds: turnDurationSeconds }
    )
    logger.info(`[${source}] Scheduled turn expiration`, {
      sessionID,
      gameID,
      turnNumber,
      delaySeconds: turnDurationSeconds,
    })
  } catch (error) {
    logger.error(
      `[${source}] Turn expiration NOT scheduled for game ${gameID}, turn ${turnNumber} — ` +
        `the turn will only resolve if every player moves`,
      { sessionID, gameID, turnNumber, error }
    )
  }
}
