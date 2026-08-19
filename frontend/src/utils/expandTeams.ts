import { GamePlayer, Team, UnitCounts, UnitType } from "@shared/types/Game"

// Unit expansion order; letters are assigned in this order within a team.
const UNIT_ORDER: UnitType[] = ["snake", "king", "queen", "rook", "bishop", "knight", "pawn"]

// Mirrors functions/src/utils/expandTeams.ts — the two must stay identical so
// the lobby preview matches the units the server generates at game start.
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
