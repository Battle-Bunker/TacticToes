import { UnitType } from "@shared/types/Game"

// Filled chess glyphs per piece unit type. Snakes have no glyph — they keep
// their existing ✕ / letter rendering.
export const PIECE_GLYPHS: { [T in Exclude<UnitType, "snake">]: string } = {
  pawn: "♟",
  knight: "♞",
  bishop: "♝",
  rook: "♜",
  queen: "♛",
  king: "♚",
}

export const pieceGlyph = (unitType: UnitType | undefined): string | null =>
  unitType && unitType !== "snake" ? PIECE_GLYPHS[unitType] : null
