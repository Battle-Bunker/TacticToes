import * as functions from "firebase-functions/v1"
import * as admin from "firebase-admin"
import * as crypto from "crypto"
import { FieldValue } from "firebase-admin/firestore"
import * as logger from "firebase-functions/logger"
import { Bot } from "@shared/types/Game"

/**
 * Bot authentication for the direct-Firebase bot interface.
 *
 * Bots are non-human principals, so they can't use the interactive sign-in
 * flows humans use. Instead each bot gets a long-lived API key (shown to the
 * owner once, only a SHA-256 hash is stored). The bot exchanges that key for
 * a Firebase custom token whenever it needs to (re)authenticate, then signs
 * in with signInWithCustomToken. The resulting auth context is:
 *
 *   uid:    "bot:<botId>"          (prefixed so it can never collide with a
 *                                   human uid, and so rules can't confuse a
 *                                   bot principal with a user)
 *   claims: { bot: true, botId, botOwner }
 *
 * Firestore rules key off `request.auth.token.bot` / `token.botId` to grant
 * bots exactly the writes they need (staging moves for snakes they own).
 */

const API_KEY_PREFIX = "ttb_"

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
 * Owner-only callable that creates (or rotates) the API key for a bot.
 * The plaintext key is returned exactly once; only its hash is persisted in
 * the `botCredentials` collection, which has no Firestore rules and is
 * therefore inaccessible to all clients.
 */
export const createBotApiKey = functions.https.onCall(async (data, context) => {
  if (!context.auth) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Must be signed in to manage bot credentials"
    )
  }

  const { botId } = data as { botId?: unknown }
  if (!botId || typeof botId !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "botId is required and must be a string"
    )
  }

  const botDoc = await admin.firestore().collection("bots").doc(botId).get()
  if (!botDoc.exists) {
    throw new functions.https.HttpsError("not-found", `Bot ${botId} not found`)
  }

  const bot = botDoc.data() as Bot
  if (bot.owner !== context.auth.uid) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Only the bot owner can manage its credentials"
    )
  }

  const apiKey = `${API_KEY_PREFIX}${crypto.randomBytes(32).toString("base64url")}`
  const credentialRef = admin.firestore().collection("botCredentials").doc(botId)
  const existing = await credentialRef.get()

  await credentialRef.set({
    botId,
    owner: bot.owner,
    keyHash: hashApiKey(apiKey),
    createdAt: existing.exists
      ? existing.data()?.createdAt ?? FieldValue.serverTimestamp()
      : FieldValue.serverTimestamp(),
    rotatedAt: FieldValue.serverTimestamp(),
  })

  logger.info(`API key ${existing.exists ? "rotated" : "created"} for bot ${botId}`, {
    botId,
    owner: bot.owner,
  })

  return { botId, apiKey, rotated: existing.exists }
})

/**
 * Unauthenticated callable that exchanges a bot API key for a Firebase
 * custom token. The bot then calls signInWithCustomToken with the result.
 * Custom tokens are short-lived (1h) but the sign-in yields a refresh token,
 * and bots can simply re-exchange whenever they need a fresh session.
 */
export const exchangeBotApiKey = functions.https.onCall(async (data) => {
  const { botId, apiKey } = data as { botId?: unknown; apiKey?: unknown }

  if (!botId || typeof botId !== "string" || !apiKey || typeof apiKey !== "string") {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "botId and apiKey are required and must be strings"
    )
  }

  const credentialDoc = await admin
    .firestore()
    .collection("botCredentials")
    .doc(botId)
    .get()

  const storedHash = credentialDoc.data()?.keyHash
  if (
    !credentialDoc.exists ||
    typeof storedHash !== "string" ||
    !timingSafeEqualHex(storedHash, hashApiKey(apiKey))
  ) {
    logger.warn(`Rejected API key exchange for bot ${botId}`)
    throw new functions.https.HttpsError(
      "permission-denied",
      "Unknown bot or invalid API key"
    )
  }

  const owner = credentialDoc.data()?.owner ?? null
  const customToken = await admin.auth().createCustomToken(`bot:${botId}`, {
    bot: true,
    botId,
    botOwner: owner,
  })

  logger.info(`Issued custom token for bot ${botId}`)

  return { customToken }
})
