import { getFunctions } from "firebase-admin/functions"
import { FUNCTIONS_REGION, taskQueueName } from "../config/region"
import { logger } from "../logger"

/**
 * Stable marker for the class of failure where the deployment itself is wrong:
 * the queue is missing, paused, or unreachable to this service account. Every
 * enqueue will fail the same way until someone fixes the project, so this is
 * worth alerting on. Grep or build a log-based alert on this exact string.
 */
export const TASK_QUEUE_ALERT = "TASK_QUEUE_MISCONFIGURED"

/**
 * Error codes from the Admin SDK that indicate a broken deployment rather than
 * a transient problem with one enqueue.
 *
 * `functions/not-found` is the one that stalled every game on the Sydney
 * project: the Cloud Tasks queue had never been created, because the deploy
 * step that creates it failed once on permissions and later deploys skipped the
 * unchanged function without retrying.
 */
const MISCONFIGURATION_CODES = new Set([
  "functions/not-found",
  "functions/permission-denied",
  "functions/unauthenticated",
])

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code
    if (typeof code === "string") return code
  }
  return undefined
}

/**
 * Enqueues a Cloud Tasks task for one of this codebase's onTaskDispatched
 * functions.
 *
 * Never throws. Callers reach here after their work is already committed to
 * Firestore, so throwing would trigger a retry that finds the write resolved or
 * superseded and cannot recover anyway.
 *
 * Returns whether the task was enqueued, so callers can record the outcome
 * rather than assume success.
 */
export async function enqueueTask(params: {
  /** Exported function name, e.g. "processTurnExpirationTask". */
  functionName: string
  payload: Record<string, unknown>
  scheduleDelaySeconds: number
  /** Caller name, for log correlation. */
  source: string
  /** Noun phrase for what this task does, e.g. "Turn expiry". */
  purpose: string
  /** IDs to attach to every log line from this call. */
  context: Record<string, unknown>
}): Promise<boolean> {
  const { functionName, payload, scheduleDelaySeconds, source, purpose, context } = params

  // Logged on both paths. When an enqueue targets the wrong queue, the resolved
  // name is the single most useful thing to see, and reconstructing it from the
  // function name and region afterwards is exactly the guesswork to avoid.
  const queuePath = taskQueueName(functionName)

  try {
    await getFunctions()
      .taskQueue(queuePath)
      .enqueue(payload, { scheduleDelaySeconds })

    logger.info(`[${source}] Enqueued ${functionName}`, {
      ...context,
      queuePath,
      delaySeconds: scheduleDelaySeconds,
    })
    return true
  } catch (error) {
    const code = errorCode(error)
    const misconfigured = code !== undefined && MISCONFIGURATION_CODES.has(code)

    if (misconfigured) {
      logger.error(
        `${TASK_QUEUE_ALERT}: [${source}] cannot reach task queue ${queuePath} ` +
          `(${code}). ${purpose} will not happen, for this or any other game, ` +
          `until the deployment is fixed. Check the queue exists and is running:\n` +
          `  gcloud tasks queues describe ${functionName} --location=${FUNCTIONS_REGION}\n` +
          `Create it with:\n` +
          `  gcloud tasks queues create ${functionName} --location=${FUNCTIONS_REGION}\n` +
          `or re-run scripts/bootstrap-gcp-project.sh, which does both.`,
        { ...context, alert: TASK_QUEUE_ALERT, queuePath, functionName, code, error }
      )
    } else {
      logger.error(
        `[${source}] Enqueue of ${functionName} failed. ${purpose} will not happen ` +
          `for this game.`,
        { ...context, queuePath, functionName, code, error }
      )
    }
    return false
  }
}
