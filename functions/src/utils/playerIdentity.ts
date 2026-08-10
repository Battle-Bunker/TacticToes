import * as admin from "firebase-admin"
import { Bot, GamePlayer, GameSetup, Human } from "@shared/types/Game"
import { logger } from "../logger"

/**
 * Display identity (name + emoji) for every player in a game.
 *
 * `gamePlayers` only ever carried `displayName`/`displayEmoji` for Team Snek
 * CLONES — the original instance of a bot, and every human, were left bare and
 * each consumer had to re-resolve them against `bots/` and `users/`. Consumers
 * that can't do that (the direct-Firebase bot interface reads the game doc and
 * nothing else) ended up showing a raw document ID as the player's name.
 *
 * So the start transaction now stamps the resolved name/emoji onto EVERY
 * gamePlayer in the game document's setup snapshot. Clone overrides win, then
 * the underlying `bots/` or `users/` record. The setup doc in `setups/` is left
 * untouched: it stays the editable lobby state, where "no displayName" still
 * means "this is the original instance".
 */

export interface IdentityDirectory {
  bots: Map<string, Bot>
  humans: Map<string, Human>
}

/** Fetches the bot and user records backing a setup's players. */
export async function loadIdentityDirectory(
  setup: GameSetup
): Promise<IdentityDirectory> {
  const db = admin.firestore()
  const botIDs = new Set<string>()
  const humanIDs = new Set<string>()

  for (const gp of setup.gamePlayers ?? []) {
    if (gp.type === "bot") botIDs.add(gp.botRef ?? gp.id)
    else humanIDs.add(gp.id)
  }

  const bots = new Map<string, Bot>()
  const humans = new Map<string, Human>()

  const botRefs = [...botIDs].map((id) => db.collection("bots").doc(id))
  const humanRefs = [...humanIDs].map((id) => db.collection("users").doc(id))
  const refs = [...botRefs, ...humanRefs]
  if (refs.length === 0) return { bots, humans }

  try {
    const docs = await db.getAll(...refs)
    for (const doc of docs) {
      if (!doc.exists) continue
      if (botIDs.has(doc.id)) bots.set(doc.id, doc.data() as Bot)
      else humans.set(doc.id, doc.data() as Human)
    }
  } catch (error) {
    // Names are cosmetic — never let a lookup failure block a game start.
    logger.error("Failed to load player identity directory", { error })
  }

  return { bots, humans }
}

/**
 * Returns `gamePlayers` with `displayName`/`displayEmoji` filled in for every
 * player that doesn't already carry an explicit override. Players whose record
 * is missing keep whatever they had (so the old ID fallback still applies).
 */
export function withResolvedIdentities(
  gamePlayers: GamePlayer[],
  directory: IdentityDirectory
): GamePlayer[] {
  return gamePlayers.map((gp) => {
    const record =
      gp.type === "bot"
        ? directory.bots.get(gp.botRef ?? gp.id)
        : directory.humans.get(gp.id)
    if (!record) return gp

    const displayName = gp.displayName ?? record.name
    const displayEmoji = gp.displayEmoji ?? record.emoji
    return {
      ...gp,
      ...(displayName ? { displayName } : {}),
      ...(displayEmoji ? { displayEmoji } : {}),
    }
  })
}
