import { GamePlayer, Team, UnitType } from "@shared/types/Game"
import { pieceGlyph } from "./unitGlyphs"

/** Display name of one snake: the team's name plus the snake's letter. */
export const snakeLabel = (
  team: Pick<Team, "name">,
  player: Pick<GamePlayer, "letter">,
): string => `${team.name} ${player.letter}`

/**
 * Display name of one unit: the piece glyph (chess-piece games), then the
 * team's name plus the unit's letter. `currentType` is the type as of the
 * turn being shown (turn.unitTypes — tracks pawn promotions); it falls back
 * to the player's configured unitType, and snakes get no glyph.
 */
export const unitLabel = (
  team: Pick<Team, "name">,
  player: Pick<GamePlayer, "letter" | "unitType">,
  currentType?: UnitType,
): string => {
  const glyph = pieceGlyph(currentType ?? player.unitType)
  return `${glyph ? `${glyph} ` : ""}${snakeLabel(team, player)}`
}
