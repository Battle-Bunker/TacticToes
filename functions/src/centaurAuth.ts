import * as functions from "firebase-functions/v1"
import * as admin from "firebase-admin"
import * as crypto from "crypto"
import { FieldValue } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { Centaur } from "@shared/types/Game"

/**
 * Centaur authentication for the direct-Firebase interface.
 *
 * Centaurs are non-human principals, so they can't use the interactive
 * sign-in flows humans use. Instead each centaur gets a long-lived API key
 * (shown to the owner once, only a SHA-256 hash is stored). The centaur
 * exchanges that key for a Firebase custom token whenever it needs to
 * (re)authenticate, then signs in with signInWithCustomToken. The resulting
 * auth context is:
 *
 *   uid:    "centaur:<centaurId>"  (prefixed so it can never collide with a
 *                                   human uid, and so rules can't confuse a
 *                                   centaur principal with a user)
 *   claims: { centaur: true, centaurId, centaurOwner }
 *
 * Firestore rules key off `request.auth.token.centaur` / `token.centaurId`
 * to grant centaurs exactly the writes they need (staging moves for snakes
 * they own).
 */

const API_KEY_PREFIX = "ttc_"

function hashApiKey(apiKey: string): string {
  return crypto.createHash("sha256").update(apiKey, "utf8").digest("hex")
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex")
  const bufB = Buffer.from(b, "hex")
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

/**
 * Owner-only callable that creates (or rotates) the API key for a centaur.
 * The plaintext key is returned exactly once; only its hash is persisted in
 * the `centaurCredentials` collection, which has no Firestore rules and is
 * therefore inaccessible to all clients.
 */
export const createCentaurApiKey = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be signed in to manage centaur credentials"
    )
  }

  const { centaurId } = data as { centaurId?: unknown }
  if (!centaurId || typeof centaurId !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "centaurId is required and must be a string"
    )
  }

  const centaurDoc = await admin.firestore().collection("centaurs").doc(centaurId).get()
  if (!centaurDoc.exists) {
    throw new functions.https.HttpsError("not-found", `Centaur ${centaurId} not found`)
  }

  const centaur = centaurDoc.data() as Centaur
  if (centaur.owner !== context.auth.uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the centaur owner can manage its credentials"
    )
  }

  const apiKey = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`
  const credentialRef = admin.firestore().collection("centaurCredentials").doc(centaurId)
  const existing = await credentialRef.get()

  await credentialRef.set({
    centaurId,
    owner: centaur.owner,
    keyHash: hashApiKey(apiKey),
    createdAt: existing.exists
      ? existing.data()?.createdAt ?? FieldValue.serverTimestamp()
      : FieldValue.serverTimestamp(),
    rotatedAt: FieldValue.serverTimestamp(),
  })

  logger.info(`API key ${existing.exists ? "rotated" : "created"} for centaur ${centaurId}`, {
    centaurId,
    owner: centaur.owner,
  })

  return { centaurId, apiKey, rotated: existing.exists }
})

/**
 * Owner-only status check. The plaintext key is never persisted, so clients
 * can only learn whether a credential exists—not retrieve the key itself.
 */
export const getCentaurApiKeyStatus = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be signed in to view centaur credential status"
    )
  }

  const { centaurId } = data as { centaurId?: unknown }
  if (!centaurId || typeof centaurId !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "centaurId is required and must be a string"
    )
  }

  const centaurDoc = await admin.firestore().collection("centaurs").doc(centaurId).get()
  if (!centaurDoc.exists) {
    throw new functions.https.HttpsError("not-found", `Centaur ${centaurId} not found`)
  }

  const centaur = centaurDoc.data() as Centaur
  if (centaur.owner !== context.auth.uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the centaur owner can view its credential status"
    )
  }

  const credentialDoc = await admin
    .firestore()
    .collection("centaurCredentials")
    .doc(centaurId)
    .get()

  return { centaurId, configured: credentialDoc.exists }
})

/**
 * Unauthenticated callable that exchanges a centaur API key for a Firebase
 * custom token. The centaur then calls signInWithCustomToken with the result.
 * Custom tokens are short-lived (1h) but the sign-in yields a refresh token,
 * and centaurs can simply re-exchange whenever they need a fresh session.
 */
export const exchangeCentaurApiKey = functions.https.onCall(async (data) => {
  const { centaurId, apiKey } = data as { centaurId?: unknown; apiKey?: unknown }

  if (!centaurId || typeof centaurId !== "string" || !apiKey || typeof apiKey !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "centaurId and apiKey are required and must be strings"
    )
  }

  const credentialDoc = await admin
    .firestore()
    .collection("centaurCredentials")
    .doc(centaurId)
    .get()

  const storedHash = credentialDoc.data()?.keyHash
  if (
    !credentialDoc.exists ||
    typeof storedHash !== "string" ||
    !timingSafeEqualHex(storedHash, hashApiKey(apiKey))
  ) {
    logger.warn(`Rejected API key exchange for centaur ${centaurId}`)
    throw new functions.https.HttpsError(
      "permission-denied",
      "Unknown centaur or invalid API key"
    )
  }

  const owner = credentialDoc.data()?.owner ?? null
  const customToken = await admin.auth().createCustomToken(`centaur:${centaurId}`, {
    centaur: true,
    centaurId,
    centaurOwner: owner,
  })

  logger.info(`Issued custom token for centaur ${centaurId}`)

  return { customToken }
})
