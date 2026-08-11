/**
 * Deployment region for all Cloud Functions in this codebase.
 *
 * This MUST match the Firestore database location. Firestore triggers are
 * backed by Eventarc, which refuses to create a trigger in a region other than
 * the database's own -- a mismatch fails the deploy with
 * "unsupported Cloud Firestore region <region>: invalid argument".
 *
 * Override via the VITE_FIREBASE_FUNCTIONS_REGION env var at deploy time when
 * targeting a project whose Firestore lives elsewhere (e.g. the us-central1 dev
 * project). The VITE_ prefix reads oddly here, but it is deliberate: the client
 * needs this value too, Vite only exposes VITE_-prefixed vars to the browser,
 * and Node can read any name. One variable cannot drift out of sync with
 * itself, and it stays in the VITE_FIREBASE_* family the bootstrap script
 * prints.
 */
export const FUNCTIONS_REGION =
  process.env.VITE_FIREBASE_FUNCTIONS_REGION || "australia-southeast1"

/**
 * Fully-qualified name for an Admin SDK task queue lookup.
 *
 * `getFunctions().taskQueue("name")` resolves an unqualified name against
 * us-central1 regardless of where the function actually lives, so every
 * enqueue site must qualify the name with the deployment region. Enqueue
 * failures are caught and logged rather than thrown, so getting this wrong
 * silently stops turn expiry instead of erroring.
 */
export const taskQueueName = (functionName: string): string =>
  `locations/${FUNCTIONS_REGION}/functions/${functionName}`
