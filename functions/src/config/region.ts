/**
 * Deployment region for all Cloud Functions in this codebase.
 *
 * This MUST match the Firestore database location. Firestore triggers are
 * backed by Eventarc, which refuses to create a trigger in a region other than
 * the database's own -- a mismatch fails the deploy with
 * "unsupported Cloud Firestore region <region>: invalid argument".
 *
 * There is deliberately NO default value. Source code is deployment agnostic:
 * every deployment supplies VITE_FIREBASE_FUNCTIONS_REGION as an ORDINARY
 * ENVIRONMENT VARIABLE -- a Replit Secret, a CI variable, an `export` in a
 * shell. No config file, anywhere, ever. A silent fallback has caused
 * wrong-region deploys before, so a missing value throws at module load.
 *
 * Why the build stamps the value in as well (functions/tools/build-entry.mjs):
 * firebase-tools does not hand the ambient environment to the processes it
 * spawns. It rebuilds one from scratch -- see spawnFunctionsProcess() in
 * firebase-tools/lib/deploy/functions/runtimes/node/index.js -- so function
 * discovery, the emulated runtime and the deployed runtime see only
 * FIREBASE_CONFIG, GCLOUD_PROJECT, GOOGLE_CLOUD_QUOTA_PROJECT, PORT,
 * FUNCTIONS_CONTROL_API, HOME and PATH, however the deploy shell was set up.
 * The build DOES run in the deploy shell (firebase.json's predeploy hook), so
 * that is where the value is read and stamped into the generated entrypoint,
 * exactly as Vite bakes the frontend's VITE_ vars into its bundle. An
 * environment that really does carry the variable always wins over the stamp.
 *
 * The VITE_ prefix reads oddly here, but it is deliberate: the client needs
 * this value too, Vite only exposes VITE_-prefixed vars to the browser, and
 * Node can read any name. One variable cannot drift out of sync with itself,
 * and it stays in the VITE_FIREBASE_* family the bootstrap script prints.
 */
const region = process.env.VITE_FIREBASE_FUNCTIONS_REGION
if (!region) {
  throw new Error(
    "VITE_FIREBASE_FUNCTIONS_REGION is required and has no default: set it " +
      "in the environment of whatever builds or runs this codebase (Replit " +
      "Secrets, CI variables, your shell). It must match the project's " +
      "Firestore region. If a deploy reaches this line, the functions build " +
      "ran without the variable set -- rebuild with it in the environment."
  )
}

export const FUNCTIONS_REGION = region

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
