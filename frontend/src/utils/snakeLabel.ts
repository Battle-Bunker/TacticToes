import { GamePlayer, Team } from "@shared/types/Game"

/** Display name of one snake: the team's name plus the snake's letter. */
export const snakeLabel = (
  team: Pick<Team, "name">,
  player: Pick<GamePlayer, "letter">,
): string => `${team.name} ${player.letter}`
