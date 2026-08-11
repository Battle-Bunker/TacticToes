import * as admin from "firebase-admin"
import { FieldValue, Transaction } from "firebase-admin/firestore"
import { StartedGameSetup } from "@shared/types/Game"
import { logger } from "../logger"

/**
 * Support data for the direct-Firebase centaur interface.
 *
 * centaurMap: written into the game-start transaction at
 * sessions/{sessionID}/games/{gameID}/meta/centaurMap as
 * { players: { [snakeID]: centaurId } }. Firestore rules use it to decide
 * which snakes a centaur principal may stage moves for.
 *
 * Game invites: written post-transaction at centaurs/{centaurId}/games/{gameID}
 * so a centaur can discover its games with a single collection listener.
 */

export function buildCentaurPlayerMap(
  setup: StartedGameSetup
): { [snakeID: string]: string } {
  const players: { [snakeID: string]: string } = {}
  for (const gp of setup.gamePlayers) {
    players[gp.id] = gp.teamID
  }
  return players
}

export function writeCentaurMap(
  transaction: Transaction,
  sessionID: string,
  gameID: string,
  setup: StartedGameSetup
): void {
  const players = buildCentaurPlayerMap(setup)
  const centaurMapRef = admin
    .firestore()
    .doc(`sessions/${sessionID}/games/${gameID}/meta/centaurMap`)
  transaction.set(centaurMapRef, {
    players,
    createdAt: FieldValue.serverTimestamp(),
  })
}

/**
 * Writes one invite doc per centaur in the game. Runs after the game-start
 * transaction commits; failures are logged but never block the game, since
 * centaurs can also watch sessions directly.
 */
export async function writeCentaurGameInvites(
  sessionID: string,
  gameID: string,
  setup: StartedGameSetup
): Promise<void> {
  const players = buildCentaurPlayerMap(setup)
  const centaurIDs = [...new Set(Object.values(players))]
  if (centaurIDs.length === 0) return

  const db = admin.firestore()
  await Promise.all(
    centaurIDs.map(async (centaurId) => {
      try {
        const snakeIDs = Object.keys(players).filter((pid) => players[pid] === centaurId)
        await db.doc(`centaurs/${centaurId}/games/${gameID}`).set({
          sessionID,
          gameID,
          snakeIDs,
          createdAt: FieldValue.serverTimestamp(),
        })
      } catch (error) {
        logger.error(`Failed to write game invite for centaur ${centaurId}`, {
          sessionID,
          gameID,
          error,
        })
      }
    })
  )
}
