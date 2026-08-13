import { GamePlayer, Team, UnitCounts, UnitType } from "@shared/types/Game"

// Unit expansion order; letters are assigned in this order within a team.
const UNIT_ORDER: UnitType[] = ["snake", "king", "queen", "rook", "bishop", "knight", "pawn"]

/**
 * Expands the lobby's teams into the units that play the game. Kept in sync
 * with frontend/src/utils/expandTeams.ts — same algorithm, do not diverge.
 *
 * Without unitsPerTeam this produces snakesPerTeam snakes per team, exactly
 * as before chess pieces existed (no unitType key on the players). With
 * unitsPerTeam, each team gets the configured count of each unit type in
 * UNIT_ORDER, letters running A, B, C… across the whole team.
 */
export const expandTeams = (
  teams: Team[],
  snakesPerTeam: number,
  unitsPerTeam?: UnitCounts,
): GamePlayer[] =>
  teams.flatMap((team) => {
    const counts: [UnitType, number][] = unitsPerTeam
      ? UNIT_ORDER.map((t) => [t, unitsPerTeam[t] ?? 0])
      : [["snake", snakesPerTeam]]
    const players: GamePlayer[] = []
    counts.forEach(([unitType, count]) => {
      for (let i = 0; i < count; i++) {
        const k = players.length
        players.push({
          id: k === 0 ? team.id : `${team.id}#${k + 1}`,
          teamID: team.id,
          letter: String.fromCharCode(65 + k),
          ...(unitsPerTeam ? { unitType } : {}),
        })
      }
    })
    return players
  })
