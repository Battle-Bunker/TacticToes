import { enqueueTask } from "./enqueueTask"

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
 *
 * Returns whether the expiry was armed. A false return means this turn can only
 * resolve if every player moves -- it will never time out.
 */
export async function announceTurn(params: AnnounceTurnParams): Promise<boolean> {
  const { sessionID, gameID, turnNumber, turnDurationSeconds, source } = params

  return enqueueTask({
    functionName: "processTurnExpirationTask",
    payload: { sessionID, gameID, turnNumber },
    scheduleDelaySeconds: turnDurationSeconds,
    source,
    purpose: "Turn expiry",
    context: { sessionID, gameID, turnNumber },
  })
}
