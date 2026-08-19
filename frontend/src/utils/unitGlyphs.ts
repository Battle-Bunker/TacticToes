import { UnitType } from "@shared/types/Game"

// Filled chess glyphs per piece unit type.
export const PIECE_GLYPHS: { [T in Exclude<UnitType, "snake">]: string } = {
  pawn: "♟",
  knight: "♞",
  bishop: "♝",
  rook: "♜",
  queen: "♛",
  king: "♚",
}

// Snakes have no chess glyph, so they use the snake symbol the rest of the UI
// names them by.
export const SNAKE_GLYPH = "🐍"

export const pieceGlyph = (unitType: UnitType | undefined): string | null =>
  unitType && unitType !== "snake" ? PIECE_GLYPHS[unitType] : null

/** Glyph for any unit, snakes included. An absent type means snake. */
export const unitGlyph = (unitType: UnitType | undefined): string =>
  pieceGlyph(unitType) ?? SNAKE_GLYPH
