import { getFunctions } from "firebase-admin/functions"
import { logger } from "../logger"
import { notifyBots } from "./notifyBots"

export interface AnnounceTurnParams {
  sessionID: string
  gameID: string
  turnNumber: number
  /** Seconds from now until this turn's endTime. */
  turnDurationSeconds: number
  /** Absolute millis of this turn's endTime, forwarded to bots. */
  turnExpiryTime: number
  /** Caller name, for log correlation only. */
  source: string
}

/**
 * Everything that must happen once a turn has been committed to Firestore:
 * arm its expiration task and notify the HTTP bots.
 *
 * Turn 0 and every later turn go through this one function, so "the first
 * turn" is not a separate orchestration path with its own subtly different
 * ordering and error handling.
 *
 * Neither step throws. The turn is already committed, so a function retry
 * would find it resolved or superseded and could not recover anyway — while
 * throwing on the first step would skip the second and strand the turn for
 * certain.
 */
export async function announceTurn(params: AnnounceTurnParams): Promise<void> {
  const {
    sessionID,
    gameID,
    turnNumber,
    turnDurationSeconds,
    turnExpiryTime,
    source,
  } = params

  try {
    const queue = getFunctions().taskQueue("processTurnExpirationTask")
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

  try {
    await notifyBots(sessionID, gameID, turnNumber, turnExpiryTime)
    logger.info(`[${source}] Bot notifications completed`, { gameID, turnNumber })
  } catch (error) {
    logger.error(
      `[${source}] Error notifying bots for game ${gameID}, turn ${turnNumber}`,
      error
    )
  }
}
