import { useMemo } from "react"
import { Team } from "@shared/types/Game"

/** Team id -> team color. Plain function for non-hook contexts. */
export const teamColorMap = (teams: Team[]): Map<string, string> =>
  new Map(teams.map((team) => [team.id, team.color]))

/** Memoized team id -> color map. */
export const useTeamColors = (teams: Team[]): Map<string, string> =>
  useMemo(() => teamColorMap(teams), [teams])
