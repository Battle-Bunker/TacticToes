import * as admin from "firebase-admin"
import { FieldValue, Transaction } from "firebase-admin/firestore"
import { StartedGameSetup, Team } from "@shared/types/Game"
import { logger } from "../logger"

/**
 * Support data for the direct-Firebase centaur interface.
 *
 * centaurMap: written into the game-start transaction at
 * sessions/{sessionID}/games/{gameID}/meta/centaurMap as
 * { players: { [snakeID]: centaurId } }. Firestore rules use it to decide
 * which snakes a centaur principal may stage moves for.
 *
 * Game invites: written at centaurs/{centaurId}/games/{gameID} so a centaur
 * can discover its games with a single collection listener. While the lobby
 * is unstarted the invite carries status 'pending' (kept in sync with
 * setup.teams by the setups trigger); at game start the same doc is
 * overwritten with status 'started' plus the snake ids.
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

/** The invite doc a centaur discovers one of its games through. */
const inviteRef = (centaurId: string, gameID: string) =>
  admin.firestore().doc(`centaurs/${centaurId}/games/${gameID}`)

/**
 * An invite write that must never block the game — centaurs can also watch
 * sessions directly, so a failure here is logged against the game it belongs
 * to and swallowed. One writer, so the three log context keys cannot drift
 * apart between the create, the delete and the game-start write.
 */
const bestEffort = async (
  label: string,
  context: { sessionID: string; gameID: string },
  write: () => Promise<unknown>,
): Promise<void> => {
  try {
    await write()
  } catch (error) {
    logger.error(label, { ...context, error })
  }
}

/**
 * Which centaurs gained or lost a team between two lobby teams lists. Pure so
 * the invite-sync diff is testable; identity is team.id (== the centaur id).
 */
export function diffInviteCentaurs(
  beforeTeams: Team[],
  afterTeams: Team[]
): { added: string[]; removed: string[] } {
  const before = new Set(beforeTeams.map((team) => team.id))
  const after = new Set(afterTeams.map((team) => team.id))
  return {
    added: [...after].filter((id) => !before.has(id)),
    removed: [...before].filter((id) => !after.has(id)),
  }
}

/**
 * Keeps pending invites in step with an unstarted lobby: a team added creates
 * a pending invite, a team removed deletes it. Only the diff is written, so
 * unrelated setup edits never churn an invite's createdAt.
 */
export async function syncPendingInvites(
  sessionID: string,
  gameID: string,
  beforeTeams: Team[],
  afterTeams: Team[]
): Promise<void> {
  const { added, removed } = diffInviteCentaurs(beforeTeams, afterTeams)
  if (added.length === 0 && removed.length === 0) return

  await Promise.all([
    ...added.map((centaurId) =>
      bestEffort(
        `Failed to write pending invite for centaur ${centaurId}`,
        { sessionID, gameID },
        () =>
          inviteRef(centaurId, gameID).set({
            sessionID,
            gameID,
            status: "pending",
            createdAt: FieldValue.serverTimestamp(),
          }),
      ),
    ),
    ...removed.map((centaurId) =>
      bestEffort(
        `Failed to delete pending invite for centaur ${centaurId}`,
        { sessionID, gameID },
        () => inviteRef(centaurId, gameID).delete(),
      ),
    ),
  ])
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

  await Promise.all(
    centaurIDs.map((centaurId) =>
      bestEffort(
        `Failed to write game invite for centaur ${centaurId}`,
        { sessionID, gameID },
        () =>
          inviteRef(centaurId, gameID).set({
            sessionID,
            gameID,
            snakeIDs: Object.keys(players).filter(
              (pid) => players[pid] === centaurId,
            ),
            status: "started",
            createdAt: FieldValue.serverTimestamp(),
          }),
      ),
    )
  )
}
