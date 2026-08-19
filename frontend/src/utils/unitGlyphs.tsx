import React from "react"
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

// Snakes have no chess glyph, so plain-text labels (e.g. the unit-type
// picker) name them with this emoji instead. Colour emoji like this one are
// painted by the platform with their own fixed colours, ignoring CSS
// `color` — fine for a plain label, but unusable anywhere a marker needs to
// take a team's colour. Use SnakeMark for that instead.
export const SNAKE_GLYPH = "🐍"

export const pieceGlyph = (unitType: UnitType | undefined): string | null =>
  unitType && unitType !== "snake" ? PIECE_GLYPHS[unitType] : null

/**
 * Colour-inheriting snake mark. Plain inline SVG stroked with
 * `currentColor`, so — like the text piece glyphs (♟♞♝♜♛♚) — it always
 * renders in whatever CSS `color` its container sets, unlike the 🐍 emoji
 * which the platform paints in its own fixed colour regardless of `color`.
 */
export const SnakeMark: React.FC<{ size?: number | string }> = ({ size = "1em" }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={2.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: "block" }}
    aria-hidden="true"
  >
    <path d="M4 19c0-3.2 3.4-3.2 3.4-6.5S4 9.2 4 6s3.4-3.2 3.4-3.2" />
    <path d="M11.8 21c2.8 0 5-2.3 5-5.2 0-2.5-1.8-4.3-4-4.3-1.7 0-3 1.3-3 3 0 1.3 1 2.3 2.2 2.3" />
    <circle cx="18.3" cy="6.2" r="1.7" fill="currentColor" stroke="none" />
    <path d="M16.4 4.6 13.9 12" />
  </svg>
)

/** Glyph or mark for any unit, snakes included. An absent type means snake. */
export const unitMark = (unitType: UnitType | undefined): React.ReactNode =>
  pieceGlyph(unitType) ?? <SnakeMark />
