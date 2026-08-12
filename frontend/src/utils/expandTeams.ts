import { GamePlayer, Team } from "@shared/types/Game"

// Mirrors functions/src/utils/expandTeams.ts — the two must stay identical so
// the lobby preview matches the snakes the server generates at game start.
export const expandTeams = (
  teams: Team[],
  snakesPerTeam: number,
): GamePlayer[] =>
  teams.flatMap((team) =>
    Array.from({ length: snakesPerTeam }, (_, k) => ({
      id: k === 0 ? team.id : `${team.id}#${k + 1}`,
      teamID: team.id,
      letter: String.fromCharCode(65 + k),
    })),
  )
