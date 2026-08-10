import * as admin from "firebase-admin"
import { FieldValue, Transaction } from "firebase-admin/firestore"
import { GameSetup } from "@shared/types/Game"
import { logger } from "../logger"

/**
 * Support data for the direct-Firebase bot interface.
 *
 * botMap: written into the game-start transaction at
 * sessions/{sessionID}/games/{gameID}/meta/botMap as
 * { players: { [gamePlayerID]: underlyingBotID } }. Firestore rules use it
 * to decide which snakes a bot principal may stage moves for — including
 * Team Snek clones, whose in-game id differs from the bot id but whose
 * botRef points back to it.
 *
 * Game invites: written post-transaction at bots/{botId}/games/{gameID}
 * so a Firebase-connected bot can discover its games with a single
 * collection listener instead of being poked over HTTP.
 */

export function buildBotPlayerMap(setup: GameSetup): { [gamePlayerID: string]: string } {
  const players: { [gamePlayerID: string]: string } = {}
  for (const gp of setup.gamePlayers) {
    if (gp.type !== "bot") continue
    players[gp.id] = gp.botRef ?? gp.id
  }
  return players
}

export function writeBotMap(
  transaction: Transaction,
  sessionID: string,
  gameID: string,
  setup: GameSetup
): void {
  const players = buildBotPlayerMap(setup)
  const botMapRef = admin
    .firestore()
    .doc(`sessions/${sessionID}/games/${gameID}/meta/botMap`)
  transaction.set(botMapRef, {
    players,
    createdAt: FieldValue.serverTimestamp(),
  })
}

/**
 * Writes one invite doc per distinct underlying bot in the game. Runs after
 * the game-start transaction commits; failures are logged but never block
 * the game (HTTP notification remains the delivery guarantee for HTTP bots,
 * and Firebase bots can also watch sessions directly).
 */
export async function writeBotGameInvites(
  sessionID: string,
  gameID: string,
  setup: GameSetup
): Promise<void> {
  const players = buildBotPlayerMap(setup)
  const underlyingBotIDs = [...new Set(Object.values(players))]
  if (underlyingBotIDs.length === 0) return

  const db = admin.firestore()
  await Promise.all(
    underlyingBotIDs.map(async (botId) => {
      try {
        const snakeIDs = Object.keys(players).filter((pid) => players[pid] === botId)
        await db.doc(`bots/${botId}/games/${gameID}`).set({
          sessionID,
          gameID,
          gameType: setup.gameType,
          snakeIDs,
          createdAt: FieldValue.serverTimestamp(),
        })
      } catch (error) {
        logger.error(`Failed to write game invite for bot ${botId}`, {
          sessionID,
          gameID,
          error,
        })
      }
    })
  )
}
