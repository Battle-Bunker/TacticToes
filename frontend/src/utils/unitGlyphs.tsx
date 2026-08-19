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

// Coiled-body path (a spiral wound outward from the centre, plus a short
// neck leading up to the head) and the head/eye/tongue paths below are the
// same literal geometry Chris-Centaur's board renderer draws for its snake
// icon (src/web/board-renderer.js, UNIT_ICONS.snake / spiralPath), in the
// same 24x24 box. Kept as literal path data rather than imported — the two
// projects are separate deployables — so this drawing must stay in lockstep
// by hand if that source ever changes.
const SNAKE_COIL =
  "M9.21 14.26 L9.06 14.23 L8.93 14.13 L8.83 13.98 L8.78 13.78 L8.80 13.55 " +
  "L8.89 13.31 L9.06 13.09 L9.31 12.91 L9.62 12.78 L9.99 12.74 L10.38 12.80 " +
  "L10.77 12.96 L11.14 13.24 L11.44 13.62 L11.66 14.08 L11.76 14.62 L11.73 15.19 " +
  "L11.56 15.77 L11.24 16.32 L10.78 16.80 L10.20 17.18 L9.51 17.42 L8.76 17.49 " +
  "L7.98 17.39 L7.22 17.10 L6.51 16.62 L5.92 15.97 L5.48 15.18 L5.22 14.27 " +
  "L5.18 13.30 L5.36 12.32 L5.78 11.37 L6.42 10.53 L7.27 9.83 L8.27 9.33 " +
  "L9.40 9.06 C10.6 7.6 11.6 6.6 13.4 6.2"

const SNAKE_HEAD =
  "M12.2 3.2 C14.6 2.5 17.2 3.4 19 4.9 C19.8 5.5 19.8 6.5 19 7.1 " +
  "C17.2 8.6 14.6 9.5 12.2 8.8 C10.4 8.3 10.4 3.7 12.2 3.2 Z"

const SNAKE_EYE = "M15.2 3.95 a1.05 1.05 0 1 0 0.001 0 Z"

const SNAKE_TONGUE = "M19 6.3 L21.2 6.9 M21.2 6.9 L22.5 6.3 M21.2 6.9 L22.3 8"

// Chris-Centaur draws this white-on-dark-outline because it sits on
// team-coloured cells there. Here the mark itself has to carry the team
// colour, so the roles flip: the coil core and the head fill take
// `currentColor` (the only thing that identifies the team — nothing here
// ever overrides it), and the dark "line" pass that Chris-Centaur uses for
// its outline/seam becomes this fixed near-black instead of a second team
// colour. It's the same rgba(0,0,0,0.8) Chris-Centaur uses for that pass,
// chosen for exactly this reason: at 80% opacity it reads as near-black
// over any currentColor, light or dark, so the seam between coils and the
// eye stay legible whichever team owns the mark. The tongue stays in
// currentColor rather than Chris-Centaur's red accent — red would compete
// with the team colour as the "what colour is this" signal, whereas a
// currentColor tongue reads as part of the same silhouette.
const SNAKE_SEAM = "rgba(0, 0, 0, 0.8)"

/**
 * Colour-inheriting snake mark: a curled coil, wedge head, eye and forked
 * tongue, painted in `currentColor` so — like the text piece glyphs
 * (♟♞♝♜♛♚) — it always renders in whatever CSS `color` its container sets,
 * unlike the 🐍 emoji which the platform paints in its own fixed colour
 * regardless of `color`.
 */
export const SnakeMark: React.FC<{ size?: number | string }> = ({ size = "1em" }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    style={{ display: "block" }}
    aria-hidden="true"
  >
    {/* Coil: a wide dark seam pass first, then the narrower currentColor
        core on top, so adjacent coil turns stay visually separated instead
        of fusing into a solid disc at small sizes. */}
    <path d={SNAKE_COIL} fill="none" stroke={SNAKE_SEAM} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" />
    <path d={SNAKE_COIL} fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />

    {/* Forked tongue */}
    <path d={SNAKE_TONGUE} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />

    {/* Wedge head: dark rim behind a currentColor fill, same trick as the coil */}
    <path d={SNAKE_HEAD} fill="none" stroke={SNAKE_SEAM} strokeWidth={2.4} strokeLinejoin="round" />
    <path d={SNAKE_HEAD} fill="currentColor" stroke="none" />

    {/* Eye, punched dark so it reads against any team colour */}
    <path d={SNAKE_EYE} fill={SNAKE_SEAM} stroke="none" />
  </svg>
)

/** Glyph or mark for any unit, snakes included. An absent type means snake. */
export const unitMark = (unitType: UnitType | undefined): React.ReactNode =>
  pieceGlyph(unitType) ?? <SnakeMark />
