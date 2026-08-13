import { readFileSync } from "fs"
import { join } from "path"

/**
 * Deployment region for all Cloud Functions in this codebase.
 *
 * This MUST match the Firestore database location. Firestore triggers are
 * backed by Eventarc, which refuses to create a trigger in a region other than
 * the database's own -- a mismatch fails the deploy with
 * "unsupported Cloud Firestore region <region>: invalid argument".
 *
 * There is deliberately NO default value. Source code is deployment agnostic:
 * every deployment provides VITE_FIREBASE_FUNCTIONS_REGION explicitly via a
 * local, gitignored functions/.env.<projectId> file (see
 * functions/.env.example) or the process environment. A silent fallback has
 * caused wrong-region deploys before, so a missing value throws at module
 * load instead.
 *
 * The per-project file is loaded HERE, by this module, not by firebase-tools:
 * the CLI's function-discovery subprocess strips the deploy shell's
 * environment and (at least through firebase-tools 15.x with this
 * firebase-functions major) does not feed .env files into discovery either --
 * which is how the old "override via env var" comment never actually worked
 * and the old default silently won on every deploy. GCLOUD_PROJECT is set by
 * the CLI in discovery, by the emulators, and by the deployed runtime (where
 * the .env.<projectId> file is part of the uploaded source), so self-loading
 * covers all three. An already-set process env var always wins.
 *
 * The VITE_ prefix reads oddly here, but it is deliberate: the client needs
 * this value too, Vite only exposes VITE_-prefixed vars to the browser, and
 * Node can read any name. One variable cannot drift out of sync with itself,
 * and it stays in the VITE_FIREBASE_* family the bootstrap script prints.
 */
const loadPerProjectEnvFile = (): void => {
  if (process.env.VITE_FIREBASE_FUNCTIONS_REGION) return
  const projectId =
    process.env.GCLOUD_PROJECT ??
    (() => {
      try {
        return JSON.parse(process.env.FIREBASE_CONFIG ?? "{}").projectId
      } catch {
        return undefined
      }
    })()
  if (!projectId) return
  // cwd is the functions package root in discovery (CLI spawns node there),
  // in the emulators, and in the deployed runtime (/workspace).
  const path = join(process.cwd(), `.env.${projectId}`)
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const eq = trimmed.indexOf("=")
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (!(key in process.env)) process.env[key] = value
  }
}

loadPerProjectEnvFile()

const region = process.env.VITE_FIREBASE_FUNCTIONS_REGION
if (!region) {
  throw new Error(
    "VITE_FIREBASE_FUNCTIONS_REGION is required: provide it via " +
      "functions/.env.<projectId> (see functions/.env.example) or the " +
      "process environment; it must match the project's Firestore region"
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
