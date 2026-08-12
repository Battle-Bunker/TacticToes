import { GamePlayer, Team } from "@shared/types/Game"

/**
 * Expands the lobby's teams into the snakes that play the game. Kept in sync
 * with frontend/src/utils/expandTeams.ts — same algorithm, do not diverge.
 */
export const expandTeams = (teams: Team[], snakesPerTeam: number): GamePlayer[] =>
  teams.flatMap((team) =>
    Array.from({ length: snakesPerTeam }, (_, k) => ({
      id: k === 0 ? team.id : `${team.id}#${k + 1}`,
      teamID: team.id,
      letter: String.fromCharCode(65 + k),
    }))
  )
