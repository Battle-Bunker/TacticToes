// Canvas board renderer: everything a spectator needs to read one turn of a
// board, drawn in CSS pixels onto a bitmap backed at the display's own
// resolution.

import { CLASH_RING_COLOR, clashCellKeys } from "./clashes"

export interface Cell {
  x: number
  y: number
}

export interface Orientation {
  dx: number
  dy: number
}

export type UnitIconKey =
  | "snake"
  | "pawn"
  | "knight"
  | "bishop"
  | "rook"
  | "queen"
  | "king"

/** One unit on the board. A chess piece is a single-cell body carrying its weight. */
export interface BoardUnit {
  id: string
  letter: string
  /** The team this unit belongs to, and that team's display name. */
  teamID: string
  teamName: string
  color: string
  unitType: UnitIconKey
  /** Head first. A piece occupies exactly one cell. */
  body: Cell[]
  /** Snakes: body length. Pieces: the weight stacked on their square. */
  weight: number
  health: number
  maxHealth: number
  orientation?: Orientation
  invulnerabilityLevel: number
  /** Absolute turn the unit's earliest invulnerability effect lapses on. */
  invulnerabilityExpiryTurn?: number
}

/** A cell where units died this turn, in the colour of whoever died there. */
export interface DeathMark {
  cell: Cell
  color: string
}

/**
 * One team in the game, in the order the setup lists them. The scoreboard reads
 * its groups from here so a team stays put as units of it live and die.
 */
export interface BoardTeam {
  id: string
  name: string
  color: string
}

/**
 * One collision the game server resolved this turn, in RENDERER coordinates:
 * where it happened, who took part, why someone died, and — for pieces, which
 * walk their path one square at a time — which within-turn sub-step it happened
 * on. It says nothing about who died: the server records PARTICIPANTS, and a
 * participant missing from `units` is one that did not walk away.
 */
export interface BoardClash {
  cell: Cell
  playerIDs: string[]
  reason: string
  subStep?: number
}

/**
 * A unit the board has dropped — dead — at its LAST-KNOWN state. It has no
 * body and no health, but it keeps its identity and the weight it died with, so
 * a scoreboard can list it (struck through, scoring nothing) instead of letting
 * it silently vanish from its team.
 */
export interface RosterUnit {
  id: string
  letter: string
  teamID: string
  teamName: string
  color: string
  unitType: UnitIconKey
  /** Weight on the last turn it was seen alive. */
  weight: number
}

export interface BoardModel {
  width: number
  height: number
  /** Absolute turn number, which is what invulnerability countdowns measure against. */
  turn: number
  walls: Cell[]
  hazards: Cell[]
  fertileTiles: Cell[]
  winningSquares: Cell[]
  food: Cell[]
  invulnerabilityPotions: Cell[]
  teams: BoardTeam[]
  units: BoardUnit[]
  deaths: DeathMark[]
  /** Every collision this turn, for the rings on the board and the inspector. */
  clashes: BoardClash[]
  /** Units that are no longer on the board, at their last-known state. */
  deadUnits: RosterUnit[]
}

let potionImage: HTMLImageElement | null = null
let potionImageLoading = false

function loadPotionImage() {
  if (potionImage || potionImageLoading) return
  potionImageLoading = true
  const img = new Image()
  img.onload = () => {
    potionImage = img
  }
  img.onerror = () => {
    potionImageLoading = false
  }
  img.src = "/invulnerability-potion.png"
}

if (typeof window !== "undefined") {
  loadPotionImage()
}

// ── Canvas resolution ───────────────────────────────────────────────────────
// Every canvas here is DRAWN in CSS pixels and BACKED by a bitmap at the
// display's own resolution: the backing store is cssSize x scale and the
// context carries a matching transform, which is what lets every draw call
// below keep speaking CSS pixels while landing on real device pixels.
//
// The scale is the device pixel ratio itself, floored at 1 and capped at 3.
// It is deliberately NOT raised to 2 on a 1x display: there the browser has to
// resample a 2x bitmap back down onto the CSS grid, which softens exactly what
// this board is made of — hairline grid strokes and small tag text — to buy
// smoother diagonals the board has almost none of. The cap stops a 4x display
// from paying 16x the fill rate for a difference no eye collects.
//
// The page owns each canvas's CSS box; the renderer owns only its backing
// store. Nothing here writes to canvas.style, so a canvas laid out by CSS keeps
// the box it was given.
const MAX_RENDER_SCALE = 3

function renderScale(): number {
  const dpr =
    typeof window !== "undefined" && window.devicePixelRatio
      ? window.devicePixelRatio
      : 1
  return Math.min(Math.max(dpr, 1), MAX_RENDER_SCALE)
}

// The scale each canvas/context was last prepared at, so CSS size and stroke
// alignment can be recovered without re-reading the display mid-frame.
const canvasScales = new WeakMap<HTMLCanvasElement, number>()
const contextScales = new WeakMap<CanvasRenderingContext2D, number>()

function contextScale(ctx: CanvasRenderingContext2D): number {
  const scale = contextScales.get(ctx)
  return typeof scale === "number" && scale > 0 ? scale : 1
}

// A canvas's drawing size in CSS pixels — the coordinate system every draw call
// in this file speaks. The laid-out box is the truth; a canvas with no layout
// (detached fixtures, tests) falls back to its backing store divided by the
// scale it was prepared at.
function canvasCssSize(canvas: HTMLCanvasElement): {
  width: number
  height: number
} {
  if (!canvas) return { width: 0, height: 0 }
  const boxWidth = canvas.clientWidth || 0
  const boxHeight = canvas.clientHeight || 0
  if (boxWidth > 0 && boxHeight > 0) {
    return { width: boxWidth, height: boxHeight }
  }
  const scale = canvasScales.get(canvas) || 1
  return { width: canvas.width / scale, height: canvas.height / scale }
}

// Size a canvas's backing store for the display and hand back a context whose
// units are CSS pixels. Resizing a canvas clears it, so the buffer is only
// written when it actually changes; the transform is (re)applied every time,
// since anything that does touch the buffer resets it.
function prepareCanvas(
  canvas: HTMLCanvasElement,
  cssWidth: number,
  cssHeight: number,
): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext("2d")
  if (!ctx) return null
  const scale = renderScale()
  const bufferWidth = Math.max(1, Math.round(cssWidth * scale))
  const bufferHeight = Math.max(1, Math.round(cssHeight * scale))
  if (canvas.width !== bufferWidth) canvas.width = bufferWidth
  if (canvas.height !== bufferHeight) canvas.height = bufferHeight
  canvasScales.set(canvas, scale)
  contextScales.set(ctx, scale)
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  return ctx
}

// Device-pixel alignment for the board's thin strokes. Under a scaled context
// the classic "+0.5 CSS pixel" no longer lands on a device-pixel boundary, so
// position and width are both resolved in DEVICE pixels and handed back in the
// CSS units the drawing code speaks: the width rounds to a whole number of
// device pixels, and the position takes the half-pixel offset only when that
// count is odd (an even-width stroke sits cleanly on the boundary).
function crispStroke(
  ctx: CanvasRenderingContext2D,
  cssPos: number,
  cssWidth: number,
): { pos: number; width: number } {
  const scale = contextScale(ctx)
  const deviceWidth = Math.max(1, Math.round(cssWidth * scale))
  const halfPixel = (deviceWidth % 2) / 2
  return {
    pos: (Math.round(cssPos * scale) + halfPixel) / scale,
    width: deviceWidth / scale,
  }
}

// Fire `onChange` whenever the display's device-pixel ratio changes — browser
// zoom, or the window moving to a monitor of another density. A media query can
// only watch ONE ratio, so the listener re-arms itself against the new ratio
// each time it fires. Returns a teardown that stops the chain.
export function watchRenderScale(onChange: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {}
  let media: MediaQueryList | null = null
  let fired: (() => void) | null = null
  let stopped = false
  const arm = () => {
    if (stopped) return
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    fired = () => {
      if (media && fired) media.removeEventListener("change", fired)
      arm()
      onChange()
    }
    media.addEventListener("change", fired)
  }
  arm()
  return () => {
    stopped = true
    if (media && fired) media.removeEventListener("change", fired)
  }
}

// The on-screen size of one board cell in CSS pixels — the single derivation the
// renderer and every hit-test share, so a resized board can never leave one of
// them on a stale scale.
function boardCellSize(
  canvas: HTMLCanvasElement,
  board: Pick<BoardModel, "width" | "height">,
): number {
  if (!canvas || !board) return 0
  const { width, height } = canvasCssSize(canvas)
  return Math.min(width / board.width, height / board.height)
}

// A pointer event's position in the canvas's CSS-pixel drawing space. The
// bounding rect is the BORDER box, so the element's own border is stepped over
// to land on the content box the renderer actually draws into.
function pointerToCanvas(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): Cell {
  const rect = canvas.getBoundingClientRect()
  const { width, height } = canvasCssSize(canvas)
  const boxWidth = canvas.clientWidth || rect.width || width
  const boxHeight = canvas.clientHeight || rect.height || height
  if (!boxWidth || !boxHeight) return { x: 0, y: 0 }
  const left = rect.left + (canvas.clientLeft || 0)
  const top = rect.top + (canvas.clientTop || 0)
  return {
    x: ((event.clientX - left) * width) / boxWidth,
    y: ((event.clientY - top) * height) / boxHeight,
  }
}

/** The board cell a pointer event landed on, or null when it fell outside. */
export function getClickedCell(
  canvas: HTMLCanvasElement,
  board: Pick<BoardModel, "width" | "height">,
  event: { clientX: number; clientY: number },
): Cell | null {
  const cellSize = boardCellSize(canvas, board)
  if (!cellSize) return null
  const point = pointerToCanvas(canvas, event)
  const col = Math.floor(point.x / cellSize)
  const row = Math.floor(point.y / cellSize)
  if (col < 0 || col >= board.width || row < 0 || row >= board.height) return null
  return { x: col, y: board.height - 1 - row }
}

// ── Unit orientation ────────────────────────────────────────────────────────
// Every unit carries its WIRE orientation (Turn.orientation, verbatim:
// full-board convention, dy grows DOWNWARD), which matches canvas rows exactly,
// so dx/dy apply to canvas offsets with no flip. Icons always draw UPRIGHT; a
// PIECE's facing shows as an eye on the faced cell edge (drawOrientationEye).
// Snakes carry their facing in the head/neck geometry and draw no eye.
// The eye takes the orientation's UNIT vector, so an axis step (±1, 0), a
// diagonal (±1, ±1) and a knight L-offset (±1, ±2) all resolve to their true
// screen angle rather than to one of four quarter turns.
function orientationUnitVector(
  orientation: Orientation | undefined,
): { ux: number; uy: number } | null {
  if (!orientation) return null
  const dx = orientation.dx || 0
  const dy = orientation.dy || 0
  const len = Math.hypot(dx, dy)
  if (!len) return null
  return { ux: dx / len, uy: dy / len }
}

/** A unit is a chess PIECE when its type is anything other than "snake". */
function isPieceUnit(unit: Pick<BoardUnit, "unitType">): boolean {
  return !!(unit && unit.unitType && unit.unitType !== "snake")
}

// Does this unit's head cell carry the orientation eye? A snake's facing is
// already legible in the geometry of its head and neck, so the eye only adds
// noise there; a piece occupies a single cell and has no such cue, so the mark
// is the only thing that says which way it points.
function unitDrawsOrientationEye(unit: BoardUnit): boolean {
  return isPieceUnit(unit) && !!orientationUnitVector(unit.orientation)
}

// Orientation eye: a stroke-only mark in a single translucent sky blue — no
// fill, so it never competes with the white/black icon language beneath it. Two
// strokes: a long FLAT brow arc spanning slightly beyond the cell, bowing gently
// out of the faced edge, and a small lens (the pupil) nested against the arc's
// back. The lens's anchor sits between the unit icon's edge and the cell
// boundary along the facing ray, so the mark reads as an eye surfacing at the
// faced edge. Drawn OUTSIDE the head-cell clip: the brow's tips and apex
// deliberately overhang the cell by a few percent.
const EYE_STROKE = "rgba(56, 174, 255, 0.8)"
function drawOrientationEye(
  ctx: CanvasRenderingContext2D,
  orientation: Orientation | undefined,
  hx: number,
  hy: number,
  cellSize: number,
) {
  const u = orientationUnitVector(orientation)
  if (!u) return
  const { ux, uy } = u
  // Tangent to the faced edge: the orientation vector turned a quarter turn.
  const tx = -uy
  const ty = ux
  const cx = hx + cellSize / 2
  const cy = hy + cellSize / 2
  // Cell centre -> the point where the facing ray LEAVES the cell: half a cell
  // for an axis facing, the corner itself for a 45 degree diagonal, so a
  // diagonal eye surfaces at the corner it faces.
  const reach = cellSize / 2 / Math.max(Math.abs(ux), Math.abs(uy))
  const at = (d: number, s: number): [number, number] => [
    cx + ux * d + tx * s,
    cy + uy * d + ty * s,
  ]

  ctx.save()
  ctx.strokeStyle = EYE_STROKE
  ctx.lineWidth = Math.max(1.6, cellSize * 0.055)
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  // Depths along the facing ray are measured from the point where the ray
  // leaves the cell (`reach`) in CELL units, not in fractions of `reach`: that
  // keeps the brow's overhang and the lens's thickness identical for axis,
  // diagonal and knight facings, where `reach` itself differs by up to 1.4x. A
  // quadratic's apex sits halfway between its control point and the chord, so
  // each control is placed at twice the wanted bulge.
  // Brow: a long flat arc, tips a whisker past the cell's sides, apex clearing
  // the faced edge by ~24% of a cell.
  const browEnd = reach * 0.6
  const browApex = reach + cellSize * 0.24
  const half = cellSize * 0.62
  const [ax, ay] = at(browEnd, half)
  const [bx, by] = at(browEnd, -half)
  const [qx, qy] = at(2 * browApex - browEnd, 0)
  ctx.beginPath()
  ctx.moveTo(ax, ay)
  ctx.quadraticCurveTo(qx, qy, bx, by)
  ctx.stroke()

  // Lens (the pupil): a slim almond nested against the brow's back, its chord
  // anchored between the icon's edge and the cell boundary, with a clear gap of
  // ~1/5 cell between its front and the brow's apex.
  const lensHalf = cellSize * 0.22
  const lensMid = reach - cellSize * 0.06
  const lensDepth = cellSize * 0.1
  const [s1x, s1y] = at(lensMid, lensHalf)
  const [s2x, s2y] = at(lensMid, -lensHalf)
  const [fx, fy] = at(lensMid + 2 * lensDepth, 0) // front (toward the brow)
  const [kx, ky] = at(lensMid - 2 * lensDepth, 0) // back (toward the icon)
  ctx.beginPath()
  ctx.moveTo(s1x, s1y)
  ctx.quadraticCurveTo(fx, fy, s2x, s2y)
  ctx.quadraticCurveTo(kx, ky, s1x, s1y)
  ctx.stroke()
  ctx.restore()
}

// Unit icons: custom-drawn marks (SVG path data in a 24×24 box) that stay
// distinctive at ~20px, where Unicode chess glyphs blur together. Each icon is
// an ordered list of layers; a layer is either a filled shape (white with a dark
// outline so it reads on any team colour) or a stroked detail.
// Design notes for small-size separability: pawn = round head on a squat base;
// bishop = tall pointed mitre with a dark slash; rook = square crenellations;
// king = big cross over a plain body; queen = spiky crown with dots; knight =
// horse silhouette; snake = coiled serpent.
// ORIENTATION: icons draw UPRIGHT everywhere. Facing is carried by the
// orientation eye on the cell edge (drawOrientationEye), which reads as a
// direction at a glance where a rotated 2D icon does not.
export const ICON_COLORS: Record<string, string> = {
  base: "#ffffff",
  line: "rgba(0, 0, 0, 0.8)",
  accent: "#e53935",
}

export interface IconLayer {
  d: string
  op: "fill" | "stroke"
  color: string
  w?: number
  outline?: boolean
}

// An Archimedean spiral sampled into a polyline, running outward from the tail
// at the centre and finishing at `endAngle`. Round joins and caps make the
// samples read as one smooth curve. `pitch` is the radius gained per full turn —
// keeping it wider than the body stroke is what stops adjacent coils from fusing
// into a plain disc.
function spiralPath(
  cx: number,
  cy: number,
  innerRadius: number,
  pitch: number,
  turns: number,
  endAngle: number,
): string {
  const sweep = turns * Math.PI * 2
  const steps = Math.max(8, Math.round(turns * 28))
  const points: string[] = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const angle = endAngle - sweep * (1 - t)
    const radius = innerRadius + pitch * turns * t
    points.push(
      `${(cx + radius * Math.cos(angle)).toFixed(2)} ${(cy + radius * Math.sin(angle)).toFixed(2)}`,
    )
  }
  return `M${points[0]} L${points.slice(1).join(" L")}`
}

// The snake's body: a coil spiralling out from the tail at its centre to the
// top, then a neck rising to the head at the upper right.
const SNAKE_COIL = `${spiralPath(9.4, 14.2, 0.2, 3.8, 1.3, -Math.PI / 2)} C10.6 7.6 11.6 6.6 13.4 6.2`

export const UNIT_ICONS: Record<UnitIconKey, IconLayer[]> = {
  pawn: [
    {
      // Plain pawn: a round ball head over a flared body on a wide foot.
      d:
        "M12 2.3 a3.6 3.6 0 1 0 0.001 0 Z " +
        "M10.3 8.6 L9.1 16.2 L5.6 18.3 L5.6 20.8 L18.4 20.8 L18.4 18.3 L14.9 16.2 L13.7 8.6 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
  ],
  bishop: [
    {
      d:
        "M12 1.6 a1.7 1.7 0 1 0 0.001 0 Z " +
        "M12 5.6 C9 8.2 7.5 10.7 7.5 12.9 C7.5 15.3 9.4 16.9 12 16.9 C14.6 16.9 16.5 15.3 16.5 12.9 C16.5 10.7 15 8.2 12 5.6 Z " +
        "M7.2 18.4 L16.8 18.4 L17.8 20.8 L6.2 20.8 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
    { d: "M12.2 7.6 L15.2 11.2", op: "stroke", color: "line", w: 1.6 },
  ],
  rook: [
    {
      d:
        "M5.5 3.2 L8.3 3.2 L8.3 5.8 L10.6 5.8 L10.6 3.2 L13.4 3.2 L13.4 5.8 L15.7 5.8 L15.7 3.2 L18.5 3.2 " +
        "L18.5 8.2 L16.8 9.8 L16.8 16.6 L18.5 18.2 L18.5 20.8 L5.5 20.8 L5.5 18.2 L7.2 16.6 L7.2 9.8 L5.5 8.2 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
  ],
  knight: [
    {
      d:
        "M7 20.8 C7 15.6 8.9 13.7 11.3 12.4 C9.8 13 7.9 13.2 7.1 12.3 C6.5 11.6 6.9 10.6 7.6 9.9 " +
        "C9.1 8.5 10.5 7.1 11 5.3 L11.8 3 L13 5.1 C16.8 6.7 18.8 9.9 18.8 14.1 L18.8 20.8 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
    { d: "M12.9 6.6 a1 1 0 1 0 0.001 0 Z", op: "fill", color: "line" },
  ],
  queen: [
    {
      d:
        "M4.3 4.4 a1.4 1.4 0 1 0 0.001 0 Z " +
        "M12 1.9 a1.5 1.5 0 1 0 0.001 0 Z " +
        "M19.7 4.4 a1.4 1.4 0 1 0 0.001 0 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
    {
      d: "M4.3 8.6 L8.2 12.6 L12 7 L15.8 12.6 L19.7 8.6 L18.1 17 L5.9 17 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
    {
      d: "M6.3 18.5 L17.7 18.5 L18.4 20.8 L5.6 20.8 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
  ],
  king: [
    {
      d: "M10.8 1.6 L13.2 1.6 L13.2 3.8 L15.4 3.8 L15.4 6.2 L13.2 6.2 L13.2 8.4 L10.8 8.4 L10.8 6.2 L8.6 6.2 L8.6 3.8 L10.8 3.8 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
    {
      d:
        "M7.6 9.6 L16.4 9.6 L17.4 17.2 L6.6 17.2 Z " +
        "M6.2 18.5 L17.8 18.5 L18.5 20.8 L5.5 20.8 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
  ],
  snake: [
    // Curled-up snake. The coil is one stroke laid down twice: a wide dark pass
    // that serves as both outline and the seam between adjacent coils, then a
    // narrower light core. Head, eye and forked tongue go on top — they are what
    // carries the read at ~20px, where the coil arms merge.
    { d: SNAKE_COIL, op: "stroke", color: "line", w: 5 },
    { d: SNAKE_COIL, op: "stroke", color: "base", w: 3 },
    {
      d: "M19 6.3 L21.2 6.9 M21.2 6.9 L22.5 6.3 M21.2 6.9 L22.3 8",
      op: "stroke",
      color: "accent",
      w: 1.5,
    },
    {
      // Wedge head: broad behind the eye, tapering to a blunt snout, which is
      // the silhouette that says "snake" once the coil is a thumbnail.
      d:
        "M12.2 3.2 C14.6 2.5 17.2 3.4 19 4.9 C19.8 5.5 19.8 6.5 19 7.1 " +
        "C17.2 8.6 14.6 9.5 12.2 8.8 C10.4 8.3 10.4 3.7 12.2 3.2 Z",
      op: "fill",
      color: "base",
      outline: true,
    },
    { d: "M15.2 3.95 a1.05 1.05 0 1 0 0.001 0 Z", op: "fill", color: "line" },
  ],
}

// Draw a unit icon centred at (cx, cy) with the given pixel size. Filled layers
// stroke their dark outline FIRST so the outline sits behind the fill (bold
// mark, thin dark rim).
function drawUnitIcon(
  ctx: CanvasRenderingContext2D,
  unitKey: UnitIconKey,
  cx: number,
  cy: number,
  size: number,
) {
  const icon = UNIT_ICONS[unitKey] || UNIT_ICONS.snake
  ctx.save()
  ctx.translate(cx - size / 2, cy - size / 2)
  ctx.scale(size / 24, size / 24)
  ctx.lineJoin = "round"
  ctx.lineCap = "round"
  for (const layer of icon) {
    const p = new Path2D(layer.d)
    const color = ICON_COLORS[layer.color] || ICON_COLORS.base
    if (layer.op === "stroke") {
      ctx.strokeStyle = color
      ctx.lineWidth = layer.w || 2
      ctx.stroke(p)
    } else {
      if (layer.outline) {
        ctx.strokeStyle = ICON_COLORS.line
        ctx.lineWidth = 2.4
        ctx.stroke(p)
      }
      ctx.fillStyle = color
      ctx.fill(p)
    }
  }
  ctx.restore()
}

// Head glyph: a PIECE's single cell draws its unit ICON upright, plus the
// orientation eye on the faced cell edge. The cell carries no letter: a piece
// has no body to write on, so its tag's letter square is the letter's home,
// anchored on the cell diagonally adjacent to this one (renderUnitTags). Snakes
// take the other path — their head cell carries the letter itself, at the head
// of the information their body spells out (unitBodyInfoPlan). The eye draws
// over the icon and under the tags, so facing is never buried and never buries.
function drawHeadGlyph(
  ctx: CanvasRenderingContext2D,
  unit: BoardUnit,
  hx: number,
  hy: number,
  cellSize: number,
) {
  const cx = hx + cellSize / 2
  // Nudged slightly above center so the glyph clears the health bar anchored to
  // the cell's bottom edge (drawHealthBar).
  const cy = hy + cellSize / 2 - cellSize * 0.06
  ctx.save()
  ctx.beginPath()
  ctx.rect(hx, hy, cellSize, cellSize)
  ctx.clip()
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  drawUnitIcon(ctx, unit.unitType, cx, cy, Math.max(cellSize * 0.78, 12))
  ctx.restore()
  // Outside the cell clip: the eye deliberately overhangs the cell.
  if (unitDrawsOrientationEye(unit)) {
    drawOrientationEye(ctx, unit.orientation, hx, hy, cellSize)
  }
}

// Weight icon: a silver ANVIL, drawn from one path. No anvil EMOJI renders
// reliably (the codepoint is young and most platforms fall back to a coloured
// stand-in or tofu), and weight wants a heavy, monochrome silhouette rather than
// a colour picture — hence the hand-drawn path. `w`/`h` are its box, so callers
// can scale it to a text line without guessing its aspect.
export const ANVIL_ICON = {
  w: 24,
  h: 20,
  // Pointed horn on the left, long flat face across the top overhanging a
  // waisted body, splayed foot: the silhouette that says "anvil" and nothing
  // else at a dozen pixels.
  d:
    "M0.5 7 L7 3 L23 3 L23 7 L16.5 8.6 L15 13.4 L20 17 L20 19.5 " +
    "L4 19.5 L4 17 L9 13.4 L7.5 8.6 L3 7.8 Z",
  // Where the path's INK sits inside that box: the anvil leaves air above and
  // below, and a symbol stacked over a number only reads as its equal if it is
  // sized and centred by the ink the eye sees.
  ink: { x: 0.5, y: 3, w: 22.5, h: 16.5 },
}
export const ANVIL_COLORS = {
  fill: "#c2c7cd", // silver
  line: "rgba(20, 24, 30, 0.75)", // the rim that keeps it legible on white
}

// The anvil, left-aligned at `x` and vertically centred on `midY` at the given
// line height.
function drawAnvilIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  midY: number,
  height: number,
) {
  const scale = height / ANVIL_ICON.h
  ctx.save()
  ctx.translate(x, midY - height / 2)
  ctx.scale(scale, scale)
  const p = new Path2D(ANVIL_ICON.d)
  ctx.lineJoin = "round"
  ctx.strokeStyle = ANVIL_COLORS.line
  ctx.lineWidth = 1.8
  ctx.stroke(p)
  ctx.fillStyle = ANVIL_COLORS.fill
  ctx.fill(p)
  ctx.restore()
}

// Hazard mark: a RED warning triangle with an exclamation, drawn from one path.
// The warning EMOJI it replaces arrives in each platform's own colour (amber on
// most, and a picture rather than a symbol), which reads as decoration next to
// the board's red hazard lattice instead of as the same danger. One path, one
// red, every surface.
export const HAZARD_ICON = {
  w: 24,
  h: 21,
  // ONE path: the rounded triangle, then the exclamation's bar and dot as
  // further sub-paths wound the SAME way as the triangle. Filled nonzero the
  // path is a solid triangle (the white backing); filled even-odd the bar and
  // dot become holes, so the exclamation is the backing showing through rather
  // than a second shape that could drift out of register. The bar and dot are
  // cut FAT — at a dozen pixels a fine exclamation closes up and the mark reads
  // as a plain red triangle.
  d:
    "M13.34 3.62 L21.76 17.58 Q23.1 19.8 20.5 19.8 L3.5 19.8 " +
    "Q0.9 19.8 2.24 17.58 L10.66 3.62 Q12 1.4 13.34 3.62 Z " +
    "M9.8 6.6 L14.2 6.6 L13.7 13.4 L10.3 13.4 Z " +
    "M10.15 15.2 L13.85 15.2 L13.85 18.6 L10.15 18.6 Z",
  // The triangle's own extent inside that box, apex to base.
  ink: { x: 0.9, y: 1.4, w: 22.2, h: 18.4 },
}
export const HAZARD_COLORS = {
  fill: "#d81b1b", // the hazard lattice's red, at full strength
  inner: "#ffffff", // the exclamation, backing the even-odd holes
}

function drawHazardIcon(
  ctx: CanvasRenderingContext2D,
  x: number,
  midY: number,
  height: number,
) {
  const scale = height / HAZARD_ICON.h
  ctx.save()
  ctx.translate(x, midY - height / 2)
  ctx.scale(scale, scale)
  const p = new Path2D(HAZARD_ICON.d)
  ctx.fillStyle = HAZARD_COLORS.inner
  ctx.fill(p, "nonzero")
  ctx.fillStyle = HAZARD_COLORS.fill
  ctx.fill(p, "evenodd")
  ctx.restore()
}

// Stat glyphs shared by the on-board unit tags and the body plates, so one stat
// always reads as one symbol wherever it appears. Weight (the anvil) and
// extra-vulnerability (the hazard triangle) are drawn paths rather than
// characters, so neither carries an entry here.
export const STAT_ICON = {
  health: "\u2665", // heart, tinted by healthBarColor
  invulnerable: "\u{1F6E1}\uFE0F", // shield (positive level)
}

export type MarkName = "anvil" | "hazard"

interface DrawnMark {
  icon: { w: number; h: number; d: string; ink: { x: number; y: number; w: number; h: number } }
  draw: (
    ctx: CanvasRenderingContext2D,
    x: number,
    midY: number,
    height: number,
  ) => void
}

// The drawn stat marks, keyed by the name a stat carries in `stat.mark`. Both
// the layout pass and the draw pass look a mark up here, so a mark can never be
// measured from one path and painted from another.
const STAT_MARK: Record<MarkName, DrawnMark> = {
  anvil: { icon: ANVIL_ICON, draw: drawAnvilIcon },
  hazard: { icon: HAZARD_ICON, draw: drawHazardIcon },
}

// The INK of the glyph stat symbols, per unit of font size: how tall it stands,
// and how far its centre sits above the alphabetic baseline. A glyph fills its
// em box neither fully nor symmetrically — a heart is barely more than half its
// font size tall and rides high, the shield emoji overflows the em in both
// directions — so a symbol stacked over a number can only be sized and centred
// against numbers if it is measured by its ink.
const STAT_GLYPH_INK: Record<string, { h: number; mid: number }> = {
  [STAT_ICON.health]: { h: 0.58, mid: 0.27 },
  [STAT_ICON.invulnerable]: { h: 1.18, mid: 0.34 },
}
// A glyph nobody has measured: assume it behaves like a capital letter. The fit
// still measures its WIDTH for real, so the worst case is a symbol drawn a
// little small rather than one that overruns its plate.
const STAT_GLYPH_INK_DEFAULT = { h: 0.7, mid: 0.35 }
// The ink height of a bold sans DIGIT, per unit of font size: digits sit on the
// baseline and stand 0.70 of their size tall, so a number's row height and its
// baseline both follow from its font size.
const DIGIT_INK_HEIGHT = 0.7

// The on-cell health bar's track is SOLID BLACK: it sits on the unit's own body
// colour, and only an opaque track keeps the empty part of the bar reading as
// "missing health" rather than as a tint of the team colour.
const HEALTH_BAR_CELL_TRACK = "#000000"

// The invulnerability mark for a level: the shield GLYPH when protected, the
// drawn red hazard MARK when the level is negative (extra-vulnerable).
export function invulnerabilityMark(level: number): { icon?: string; mark?: MarkName } {
  return level > 0 ? { icon: STAT_ICON.invulnerable } : { mark: "hazard" }
}

// Turns of invulnerability left, INCLUSIVE of the turn being displayed, derived
// from the absolute expiry turn the game server supplies. Returns null when the
// wire carries no expiry, or when the level has already lapsed at that turn — so
// the board's plates and its tags can never disagree about how long a buff has
// to run.
export function invulnerabilityTurnsRemaining(
  unit: BoardUnit,
  currentTurn: number,
): number | null {
  const expiry = unit && unit.invulnerabilityExpiryTurn
  if (typeof expiry !== "number" || typeof currentTurn !== "number") return null
  const remaining = expiry - currentTurn + 1
  return remaining >= 1 ? remaining : null
}

// Health-bar fill colour by remaining fraction: red when nearly starved, orange
// when low, green otherwise. Shared by the board bar and the stat plates so the
// two readouts always agree.
export function healthBarColor(frac: number): string {
  if (frac < 0.1) return "#e53935"
  if (frac < 0.25) return "#fb8c00"
  return "#43a047"
}

// Health fraction: health over the unit's configured per-type max, clamped.
export function healthFraction(unit: BoardUnit): number {
  const max = unit.maxHealth ?? 100
  if (!(max > 0)) return 0
  return Math.max(0, Math.min(1, (unit.health ?? 0) / max))
}

// Prominent per-unit health bar on the unit's key cell (snake head cell / piece
// cell): bottom-anchored, ~90% of the cell wide, ~15% tall, a BLACK track under
// a red/orange/green fill.
function drawHealthBar(
  ctx: CanvasRenderingContext2D,
  unit: BoardUnit,
  hx: number,
  hy: number,
  cellSize: number,
) {
  if (typeof unit.health !== "number") return
  const frac = healthFraction(unit)
  const barW = cellSize * 0.9
  const barH = Math.max(2, cellSize * 0.15)
  const inset = Math.max(1, cellSize * 0.03)
  const bx = hx + (cellSize - barW) / 2
  const by = hy + cellSize - barH - inset
  ctx.save()
  ctx.fillStyle = HEALTH_BAR_CELL_TRACK
  ctx.fillRect(bx, by, barW, barH)
  if (frac > 0) {
    ctx.fillStyle = healthBarColor(frac)
    ctx.fillRect(bx, by, barW * frac, barH)
  }
  ctx.restore()
}

// Hazard cell: a red lattice — a faint wash crossed by GRID-ALIGNED bars,
// horizontal and vertical — rather than a solid red block. The bars carry the
// "danger" read while the gaps between them leave whatever shares the cell
// visible: the black grid lines, a unit standing in the hazard. Running the bars
// square to the board rather than on the diagonals keeps them from reading as
// the diagonal hatch the fertile tiles already own. The clip is inset by a pixel
// on every side so the lattice never paints over the cell's own grid lines.
function drawHazardCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellSize: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x + 1, y + 1, cellSize - 2, cellSize - 2)
  ctx.clip()
  ctx.fillStyle = "rgba(220, 30, 30, 0.18)"
  ctx.fillRect(x, y, cellSize, cellSize)
  ctx.strokeStyle = "rgba(200, 12, 12, 0.9)"
  ctx.lineWidth = Math.max(1, cellSize / 11)
  const spacing = Math.max(4, cellSize / 3)
  // Half a spacing in from the edges, so the pattern is centred in the cell and
  // no bar lands exactly on a grid line the clip is protecting.
  for (let offset = spacing / 2; offset < cellSize; offset += spacing) {
    ctx.beginPath()
    ctx.moveTo(x, y + offset)
    ctx.lineTo(x + cellSize, y + offset)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x + offset, y)
    ctx.lineTo(x + offset, y + cellSize)
    ctx.stroke()
  }
  ctx.restore()
}

// Fertile ground: a diagonal hatch in a wheat yellow, slanted "/" — the one
// diagonal pattern on the board, which is what tells it apart from the hazard
// lattice's square bars at a glance.
function drawFertileCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellSize: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, cellSize, cellSize)
  ctx.clip()
  ctx.strokeStyle = "rgba(240, 198, 70, 0.85)"
  ctx.lineWidth = Math.max(1.5, cellSize / 7)
  const stripeSpacing = Math.max(4, cellSize / 3.5)
  for (let offset = 0; offset <= cellSize * 2; offset += stripeSpacing) {
    ctx.beginPath()
    ctx.moveTo(x + offset, y)
    ctx.lineTo(x + offset - cellSize, y + cellSize)
    ctx.stroke()
  }
  ctx.restore()
}

// Wall cell: solid masonry, courses offset every other row. Nothing enters a
// wall, so it is the one terrain drawn opaque — it reads as the board's edge
// rather than as ground anything could stand on.
const WALL_FILL = "#7a5230"
const WALL_MORTAR = "rgba(28, 18, 10, 0.55)"
function drawWallCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellSize: number,
  row: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, cellSize, cellSize)
  ctx.clip()
  ctx.fillStyle = WALL_FILL
  ctx.fillRect(x, y, cellSize, cellSize)
  ctx.strokeStyle = WALL_MORTAR
  ctx.lineWidth = Math.max(1, cellSize / 14)
  const courses = 3
  const courseH = cellSize / courses
  for (let i = 1; i < courses; i++) {
    ctx.beginPath()
    ctx.moveTo(x, y + i * courseH)
    ctx.lineTo(x + cellSize, y + i * courseH)
    ctx.stroke()
  }
  for (let i = 0; i < courses; i++) {
    // Alternate the head joint by half a brick, course by course and row by
    // row, so a run of wall cells never lines its joints up into a seam.
    const shift = (i + row) % 2 === 0 ? cellSize / 2 : 0
    ctx.beginPath()
    ctx.moveTo(x + shift, y + i * courseH)
    ctx.lineTo(x + shift, y + (i + 1) * courseH)
    ctx.stroke()
  }
  ctx.restore()
}

// ── A snake's body as information real estate ───────────────────────────────
// A snake is several cells long, and every cell behind its head is canvas the
// unit's own numbers can live on — which is where they belong, because a number
// ON the unit needs no line traced back to it. Walking head → tail, each
// DISTINCT body cell carries exactly one item:
//   head        the unit's LETTER, on the same plate every stat behind it uses,
//               filled with its own body colour
//   neck        weight, under the silver anvil
//   2nd cell    health, under the heart tinted by the shared thresholds
//   3rd cell    the TURNS of invulnerability still to run, under the shield /
//               hazard mark — only while a level is running
//   tail        how many body parts are STACKED on the tail cell — only when
//               more than one is
// Every stat is SYMBOL OVER NUMBER, two rows on one square plate: the symbol is
// what names the number, so the two arrive together or not at all.
// The tail's stack count OUTRANKS the flow items: it is the one number nothing
// else on the board says, so its cell is reserved before the rest are dealt out.
// Anything that finds no cell — or no cell that can hold both its rows — is
// dropped, and a dropped item is precisely what makes this unit's TAG worth
// drawing (renderUnitTags asks this plan, and nothing else).

// The smallest text a body item may shrink to. Below this a number stops being
// read and starts being texture, so the item is dropped instead and the tag
// carries it.
const BODY_ITEM_MIN_FONT = 9
// The smallest a stat's SYMBOL may be drawn, measured across its ink. Below this
// an anvil, a heart and a shield all collapse into the same small dark blob, and
// a symbol that cannot be told apart names nothing — so the item is dropped
// whole rather than drawn as a number nobody can label.
const BODY_ITEM_MIN_SYMBOL = 6
// The share of a plate's inner column the SYMBOL is guaranteed before the number
// may take any of it, and the air between the two rows as a share of that column.
const BODY_STACK_SYMBOL = 0.44
const BODY_STACK_GAP = 0.07
// The plaque a stat item is drawn on: near-white, so a tinted heart, a silver
// anvil and a dark number keep the same contrast on EVERY team colour and over
// every terrain a body can lie on.
const BODY_ITEM_PLAQUE = "rgba(255, 255, 255, 0.94)"
const BODY_ITEM_TEXT = "#14181e"

// Every item — the head's letter and every stat behind it — is drawn on ONE
// square of the same size, so a body reads as a run of identical plates rather
// than as pills each taking whatever width its own number happens to want. The
// side is a fraction of the body's own THICKNESS, not the cell's, which is what
// keeps the unit's colour showing all the way round the plate at every cell size
// — and what keeps the head's plate clear of the health BAR along that cell's
// bottom edge (drawHealthBar).
const BODY_PLATE_SIDE = 0.86
// How much of the plate its content may spend, in BOTH directions; the rest is
// the margin that keeps a number, and the symbol stacked over it, off the
// plate's rounded corners.
const BODY_PLATE_INNER = 0.9
// The corner radius as a fraction of the side — one value, so the letter square
// and the stat plates round identically.
const BODY_PLATE_RADIUS = 0.26

interface PlateBox {
  x: number
  y: number
  w: number
  h: number
}

interface LetterItem {
  kind: "letter"
  text: string
  fill: string
}

interface StatItem {
  kind: "stat"
  mark?: MarkName
  icon?: string
  iconColor?: string
  text: string
}

type BodyItem = LetterItem | StatItem

interface SymbolFit {
  inkH: number
  inkW: number
  boxH?: number
  boxDX?: number
  boxDY?: number
  font?: string
  baselineDY?: number
}

interface StatFit {
  font: string
  fontSize: number
  text: string
  textInk: number
  symbol: SymbolFit | null
  blockH: number
}

interface LetterFit {
  font: string
  fontSize: number
}

interface Placement {
  item: BodyItem
  box: PlateBox
  fit: StatFit | LetterFit
}

interface BodyInfoPlan {
  placements: Placement[]
  tagWarranted: boolean
}

// The body cells an item can be placed on: the DISTINCT coordinates the body
// occupies, head → tail. A snake that doubles back over itself — a stacked tail,
// a coiled body — shows one cell per coordinate on screen, so it carries one
// item there too. Same walk renderSnakeUnified fills from, so an item can never
// land on a cell the body did not draw.
function distinctBodyCells(body: Cell[]): Cell[] {
  const seen = new Set<string>()
  const cells: Cell[] = []
  for (const seg of body) {
    const key = `${seg.x},${seg.y}`
    if (seen.has(key)) continue
    seen.add(key)
    cells.push(seg)
  }
  return cells
}

// How many body parts sit stacked on the tail cell — the trailing run of
// segments sharing the last one's coordinate, which is what a snake carries
// while it is still growing into the length it has eaten.
function tailStackCount(body: Cell[]): number {
  if (!body || body.length === 0) return 0
  const tail = body[body.length - 1]
  let n = 0
  for (let i = body.length - 1; i >= 0; i--) {
    if (body[i].x !== tail.x || body[i].y !== tail.y) break
    n++
  }
  return n
}

// THE box every body item is drawn in: the shared square, centred in its cell.
// One geometry for the letter and for every stat, so a cell can never be located
// two ways and no item can quietly claim more room than another.
function bodyPlateBox(
  cell: Cell,
  boardHeight: number,
  cellSize: number,
): PlateBox {
  const side = (cellSize - getSnakeGap(cellSize) * 2) * BODY_PLATE_SIDE
  const inset = (cellSize - side) / 2
  return {
    x: cell.x * cellSize + inset,
    y: (boardHeight - 1 - cell.y) * cellSize + inset,
    w: side,
    h: side,
  }
}

// One stat SYMBOL solved to a given ink height: what it measures across, and
// everything the draw pass needs to land that ink on a point. A drawn mark and a
// glyph answer here alike — the mark by scaling its path box until the ink
// inside it stands `inkH` tall, the glyph by choosing the font size whose ink
// does — so the layout pass and the draw pass can never size or place a symbol
// two different ways. Leaves the measuring font on `ctx`.
function statSymbolFit(
  ctx: CanvasRenderingContext2D,
  item: StatItem,
  inkH: number,
): SymbolFit {
  const mark = item.mark ? STAT_MARK[item.mark] : null
  if (mark) {
    const { h, ink } = mark.icon
    const scale = inkH / ink.h
    return {
      inkH,
      inkW: ink.w * scale,
      // What the mark drawer is given: the height of the whole path box, and
      // where that box's centre lies relative to the ink's (the drawer centres
      // the BOX on the y it is handed, and starts it at the x).
      boxH: h * scale,
      boxDX: -ink.x * scale,
      boxDY: (h / 2 - (ink.y + ink.h / 2)) * scale,
    }
  }
  const icon = item.icon ?? ""
  const glyph = STAT_GLYPH_INK[icon] || STAT_GLYPH_INK_DEFAULT
  const fontSize = inkH / glyph.h
  ctx.font = `700 ${fontSize}px sans-serif`
  return {
    inkH,
    inkW: ctx.measureText(icon).width,
    font: ctx.font,
    // The baseline to draw on, measured down from the ink's centre.
    baselineDY: glyph.mid * fontSize,
  }
}

// Fit a STAT item INSIDE the plate, SYMBOL OVER NUMBER. The plate is a square —
// as tall as it is wide — so a symbol set BESIDE its number spends the width
// twice over and the height not at all. Stacked, each row gets the plate's full
// width and its own share of the height, and both are solved against that one
// inner box.
// Text width scales exactly with font size, so the size that fits is solved for
// rather than searched: measure once at the preferred size, then take the
// smallest of what the width allows, what the preferred size allows, and what
// leaves the SYMBOL its guaranteed share of the column. The symbol then takes
// every pixel of column the number did not, capped by the plate's width. `null`
// means the two cannot both be read here — and then the caller drops the item
// whole, because a number with no symbol over it names nothing, and the unit's
// tag says it properly instead.
function fitBodyStat(
  ctx: CanvasRenderingContext2D,
  item: StatItem,
  box: PlateBox,
  cellSize: number,
): StatFit | null {
  // The text's ceiling is the body's own thickness, not the cell's.
  const bodyH = cellSize - getSnakeGap(cellSize) * 2
  const pref = Math.min(
    Math.max(BODY_ITEM_MIN_FONT, cellSize * 0.34),
    bodyH * 0.62,
  )
  if (pref < BODY_ITEM_MIN_FONT) return null
  const innerW = box.w * BODY_PLATE_INNER
  const innerH = box.h * BODY_PLATE_INNER
  // The tail's stack count is a bare number by design — the tail's own position
  // is what names it — so it has no second row, and no air to leave for one.
  const hasSymbol = !!(item.mark || item.icon)
  const rowGap = hasSymbol ? innerH * BODY_STACK_GAP : 0
  const column = innerH - rowGap
  const reserved = hasSymbol
    ? Math.max(BODY_ITEM_MIN_SYMBOL, column * BODY_STACK_SYMBOL)
    : 0
  ctx.save()
  try {
    ctx.font = `700 ${pref}px sans-serif`
    const widthPerPx = ctx.measureText(item.text).width / pref
    if (!(widthPerPx > 0)) return null
    const fontSize = Math.min(
      pref,
      innerW / widthPerPx,
      (column - reserved) / DIGIT_INK_HEIGHT,
    )
    if (fontSize < BODY_ITEM_MIN_FONT) return null
    const textInk = fontSize * DIGIT_INK_HEIGHT
    const fit: StatFit = {
      font: `700 ${fontSize}px sans-serif`,
      fontSize,
      text: item.text,
      textInk,
      symbol: null,
      blockH: textInk,
    }
    if (!hasSymbol) return fit
    let symbol = statSymbolFit(ctx, item, column - textInk)
    if (symbol.inkW > innerW) {
      symbol = statSymbolFit(ctx, item, (symbol.inkH * innerW) / symbol.inkW)
    }
    if (symbol.inkH < BODY_ITEM_MIN_SYMBOL) return null
    fit.symbol = symbol
    fit.blockH = symbol.inkH + rowGap + textInk
    return fit
  } finally {
    ctx.restore()
  }
}

// Fit the LETTER into the same plate, solved against the same inner width: the
// letter is the unit's name out loud, so a wide one is made smaller rather than
// turned away, and only a plate too small to read anything in gives it up to the
// tag.
function fitBodyLetter(
  ctx: CanvasRenderingContext2D,
  item: LetterItem,
  box: PlateBox,
): LetterFit | null {
  if (box.w < BODY_ITEM_MIN_FONT) return null
  const pref = box.w * 0.74
  ctx.save()
  ctx.font = `800 ${pref}px sans-serif`
  const atPref = ctx.measureText(item.text).width
  ctx.restore()
  const avail = box.w * BODY_PLATE_INNER
  const fontSize = atPref > avail ? (pref * avail) / atPref : pref
  if (fontSize < BODY_ITEM_MIN_FONT) return null
  return { font: `800 ${fontSize}px sans-serif`, fontSize }
}

// THE plate every body item is drawn on: a rounded square of the shared size and
// radius, optionally rimmed. Both readings — the head's letter square and a
// stat's plaque — are painted through here, so the two can never round or size
// differently. The rim is drawn INSIDE the square, so a rimmed plate and a bare
// one take up exactly the same footprint.
function drawBodyPlate(
  ctx: CanvasRenderingContext2D,
  box: PlateBox,
  fill: string,
  rim?: string,
  rimWidth?: number,
) {
  const r = box.w * BODY_PLATE_RADIUS
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(box.x, box.y, box.w, box.h, r)
  else ctx.rect(box.x, box.y, box.w, box.h)
  ctx.fillStyle = fill
  ctx.fill()
  if (!rim || !rimWidth) return
  const half = rimWidth / 2
  ctx.beginPath()
  if (ctx.roundRect) {
    ctx.roundRect(
      box.x + half,
      box.y + half,
      box.w - rimWidth,
      box.h - rimWidth,
      Math.max(0, r - half),
    )
  } else {
    ctx.rect(box.x + half, box.y + half, box.w - rimWidth, box.h - rimWidth)
  }
  ctx.lineWidth = rimWidth
  ctx.strokeStyle = rim
  ctx.stroke()
}

// Draw one stat item: its plate, then the symbol over the number, the two rows
// centred on the plate as one block. Everything is placed by INK — the symbol's
// centre and the number's baseline — so the pair sits optically centred whatever
// shape the symbol is.
function drawBodyStatItem(
  ctx: CanvasRenderingContext2D,
  item: StatItem,
  box: PlateBox,
  fit: StatFit,
) {
  const cx = box.x + box.w / 2
  const top = box.y + (box.h - fit.blockH) / 2
  ctx.save()
  drawBodyPlate(ctx, box, BODY_ITEM_PLAQUE)
  const symbol = fit.symbol
  if (symbol) {
    const symMidY = top + symbol.inkH / 2
    const mark = item.mark ? STAT_MARK[item.mark] : null
    if (mark) {
      mark.draw(
        ctx,
        cx - symbol.inkW / 2 + (symbol.boxDX ?? 0),
        symMidY + (symbol.boxDY ?? 0),
        symbol.boxH ?? symbol.inkH,
      )
    } else {
      ctx.font = symbol.font ?? fit.font
      ctx.textAlign = "center"
      ctx.textBaseline = "alphabetic"
      ctx.fillStyle = item.iconColor || BODY_ITEM_TEXT
      ctx.fillText(item.icon ?? "", cx, symMidY + (symbol.baselineDY ?? 0))
    }
  }
  ctx.font = fit.font
  ctx.textAlign = "center"
  ctx.textBaseline = "alphabetic"
  ctx.fillStyle = BODY_ITEM_TEXT
  ctx.fillText(fit.text, cx, top + fit.blockH)
  ctx.restore()
}

// Draw the head's letter plate: the unit's own colour behind a white letter,
// rimmed in white so the plate still reads when its fill IS the body colour
// around it, and the letter carries a dark halo so it survives a light colour.
function drawBodyLetter(
  ctx: CanvasRenderingContext2D,
  item: LetterItem,
  box: PlateBox,
  fit: LetterFit,
) {
  ctx.save()
  drawBodyPlate(
    ctx,
    box,
    item.fill,
    "rgba(255, 255, 255, 0.9)",
    Math.max(1, fit.fontSize * 0.11),
  )
  ctx.font = fit.font
  ctx.textAlign = "center"
  ctx.textBaseline = "middle"
  ctx.lineJoin = "round"
  ctx.lineWidth = Math.max(1.5, fit.fontSize * 0.16)
  ctx.strokeStyle = "rgba(12, 16, 22, 0.72)"
  ctx.strokeText(item.text, box.x + box.w / 2, box.y + box.h / 2)
  ctx.fillStyle = "#ffffff"
  ctx.fillText(item.text, box.x + box.w / 2, box.y + box.h / 2)
  ctx.restore()
}

// THE body-information plan for one unit: which item each body cell carries at
// this cell size, and whether anything was dropped — which is the whole of the
// tag rule. Built once per unit per frame and read by BOTH the body pass (which
// draws it) and the tag pass (which asks only `tagWarranted`), so the board and
// its tags can never disagree.
function unitBodyInfoPlan(
  ctx: CanvasRenderingContext2D,
  unit: BoardUnit,
  boardHeight: number,
  cellSize: number,
  turn: number,
): BodyInfoPlan {
  const plan: BodyInfoPlan = { placements: [], tagWarranted: true }
  const body = unit && unit.body
  if (!body || body.length === 0) return plan
  // A piece is ONE cell: it has no body to write on, so it keeps the unit icon
  // on that cell and the tag that carries its numbers.
  if (isPieceUnit(unit)) return plan

  const cells = distinctBodyCells(body)
  const letterItem: LetterItem = {
    kind: "letter",
    text: unit.letter || "?",
    fill: unit.color,
  }

  // Flow items, head → tail.
  const flow: StatItem[] = [
    { kind: "stat", mark: "anvil", text: String(unit.weight ?? body.length) },
  ]
  if (typeof unit.health === "number") {
    flow.push({
      kind: "stat",
      icon: STAT_ICON.health,
      iconColor: healthBarColor(healthFraction(unit)),
      text: String(unit.health),
    })
  }
  // The buff writes the TURNS it still has to run, and nothing else: its LEVEL
  // is already spelled out by the body's own outline colour — blue for
  // protected, red for extra-vulnerable — so a number for it would say twice
  // what one glance says once.
  const invulnLevel = unit.invulnerabilityLevel || 0
  const invulnTurns =
    invulnLevel !== 0 ? invulnerabilityTurnsRemaining(unit, turn) : null
  if (invulnTurns != null) {
    flow.push({
      kind: "stat",
      ...invulnerabilityMark(invulnLevel),
      text: String(invulnTurns),
    })
  }

  const tailIndex = cells.length - 1
  const stacked = tailStackCount(body)
  // A stack on a cell that IS the head is not a tail the eye can find, and the
  // letter never gives its square up, so there is nothing to reserve.
  const tailItem: StatItem | null =
    stacked > 1 && tailIndex > 0
      ? { kind: "stat", text: `×${stacked}` }
      : null

  let dropped = 0
  const place = (item: BodyItem, cell: Cell) => {
    const box = bodyPlateBox(cell, boardHeight, cellSize)
    const fit =
      item.kind === "letter"
        ? fitBodyLetter(ctx, item, box)
        : fitBodyStat(ctx, item, box, cellSize)
    if (!fit) {
      dropped++
      return
    }
    plan.placements.push({ item, box, fit })
  }

  place(letterItem, cells[0])
  // The tail's cell is reserved first — it outranks the flow — so the flow stops
  // one cell short whenever a stack has to be shown.
  const lastFlowIndex = tailItem ? tailIndex - 1 : tailIndex
  let slot = 1
  for (const item of flow) {
    if (slot > lastFlowIndex) {
      dropped++
      continue
    }
    place(item, cells[slot])
    slot++
  }
  if (tailItem) place(tailItem, cells[tailIndex])

  plan.tagWarranted = dropped > 0
  return plan
}

// Paint a body-information plan onto the board. One plan in, one drawing out —
// the tag pass reads the very same object.
function drawUnitBodyInfo(ctx: CanvasRenderingContext2D, plan: BodyInfoPlan) {
  if (!plan) return
  for (const { item, box, fit } of plan.placements) {
    if (item.kind === "letter") drawBodyLetter(ctx, item, box, fit as LetterFit)
    else drawBodyStatItem(ctx, item, box, fit as StatFit)
  }
}

// ── Unit bodies ─────────────────────────────────────────────────────────────

function getSnakeGap(cellSize: number): number {
  return Math.max(2, Math.floor(cellSize * 0.15))
}

interface CellConnections {
  hasTop: boolean
  hasBottom: boolean
  hasLeft: boolean
  hasRight: boolean
}

function buildPathNeighbors(body: Cell[]): Record<string, Set<string>> {
  const pathNeighbors: Record<string, Set<string>> = {}
  for (let i = 0; i < body.length; i++) {
    const key = `${body[i].x},${body[i].y}`
    if (!pathNeighbors[key]) pathNeighbors[key] = new Set()
    if (i > 0) pathNeighbors[key].add(`${body[i - 1].x},${body[i - 1].y}`)
    if (i < body.length - 1) {
      pathNeighbors[key].add(`${body[i + 1].x},${body[i + 1].y}`)
    }
  }
  return pathNeighbors
}

function getCellConnections(
  segment: Cell,
  pathNeighbors: Record<string, Set<string>>,
): CellConnections {
  const key = `${segment.x},${segment.y}`
  const neighbors = pathNeighbors[key] || new Set<string>()
  return {
    hasTop: neighbors.has(`${segment.x},${segment.y + 1}`),
    hasBottom: neighbors.has(`${segment.x},${segment.y - 1}`),
    hasLeft: neighbors.has(`${segment.x - 1},${segment.y}`),
    hasRight: neighbors.has(`${segment.x + 1},${segment.y}`),
  }
}

// One unit's body as a single continuous shape: each distinct cell is an inset
// square, bridged into its neighbours along the body's own path, so a snake
// reads as one creature rather than a run of tiles. An invulnerability level
// wraps that silhouette in an outline — blue for protected, red for
// extra-vulnerable.
function renderUnitBody(
  ctx: CanvasRenderingContext2D,
  unit: Pick<BoardUnit, "body" | "color" | "invulnerabilityLevel">,
  boardHeight: number,
  cellSize: number,
) {
  if (unit.body.length === 0) return

  const unitColor = unit.color || "#888888"
  const gap = getSnakeGap(cellSize)
  const pathNeighbors = buildPathNeighbors(unit.body)
  const invulnLevel = unit.invulnerabilityLevel || 0

  const visited = new Set<string>()
  const segments: { segment: Cell; conn: CellConnections }[] = []
  for (let i = 0; i < unit.body.length; i++) {
    const segment = unit.body[i]
    const key = `${segment.x},${segment.y}`
    if (visited.has(key)) continue
    visited.add(key)
    segments.push({ segment, conn: getCellConnections(segment, pathNeighbors) })
  }

  if (invulnLevel !== 0) {
    const outerExpand = Math.max(2, cellSize * 0.06)
    const outerColor =
      invulnLevel < 0 ? "rgba(255, 40, 40, 1)" : "rgba(40, 120, 255, 1)"
    const lineWidth = Math.max(2, cellSize * 0.08)
    ctx.save()
    ctx.strokeStyle = outerColor
    ctx.lineWidth = lineWidth
    ctx.lineCap = "square"

    for (const { segment, conn } of segments) {
      const sx = segment.x * cellSize
      const sy = (boardHeight - 1 - segment.y) * cellSize
      const left = (conn.hasLeft ? sx : sx + gap) - outerExpand
      const right =
        (conn.hasRight ? sx + cellSize : sx + cellSize - gap) + outerExpand
      const top = (conn.hasTop ? sy : sy + gap) - outerExpand
      const bottom =
        (conn.hasBottom ? sy + cellSize : sy + cellSize - gap) + outerExpand

      if (!conn.hasTop) {
        ctx.beginPath()
        ctx.moveTo(left, top)
        ctx.lineTo(right, top)
        ctx.stroke()
      }
      if (!conn.hasBottom) {
        ctx.beginPath()
        ctx.moveTo(left, bottom)
        ctx.lineTo(right, bottom)
        ctx.stroke()
      }
      if (!conn.hasLeft) {
        ctx.beginPath()
        ctx.moveTo(left, top)
        ctx.lineTo(left, bottom)
        ctx.stroke()
      }
      if (!conn.hasRight) {
        ctx.beginPath()
        ctx.moveTo(right, top)
        ctx.lineTo(right, bottom)
        ctx.stroke()
      }

      // Inner corners: where two arms meet, the outline turns back on itself,
      // so each corner gets its own short pair of strokes.
      if (conn.hasRight && conn.hasBottom) {
        const cx = sx + cellSize - gap + outerExpand
        const cy = sy + cellSize - gap + outerExpand
        ctx.beginPath()
        ctx.moveTo(cx - 2 * outerExpand, cy)
        ctx.lineTo(cx, cy)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(cx, cy - 2 * outerExpand)
        ctx.lineTo(cx, cy)
        ctx.stroke()
      }
      if (conn.hasRight && conn.hasTop) {
        const cx = sx + cellSize - gap + outerExpand
        const cy = sy + gap - outerExpand
        ctx.beginPath()
        ctx.moveTo(cx - 2 * outerExpand, cy)
        ctx.lineTo(cx, cy)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx, cy + 2 * outerExpand)
        ctx.stroke()
      }
      if (conn.hasLeft && conn.hasBottom) {
        const cx = sx + gap - outerExpand
        const cy = sy + cellSize - gap + outerExpand
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + 2 * outerExpand, cy)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(cx, cy - 2 * outerExpand)
        ctx.lineTo(cx, cy)
        ctx.stroke()
      }
      if (conn.hasLeft && conn.hasTop) {
        const cx = sx + gap - outerExpand
        const cy = sy + gap - outerExpand
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + 2 * outerExpand, cy)
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx, cy + 2 * outerExpand)
        ctx.stroke()
      }
    }
    ctx.lineCap = "butt"
    ctx.restore()
  }

  ctx.fillStyle = unitColor
  for (const { segment, conn } of segments) {
    const sx = segment.x * cellSize
    const sy = (boardHeight - 1 - segment.y) * cellSize
    ctx.fillRect(sx + gap, sy + gap, cellSize - 2 * gap, cellSize - 2 * gap)
    if (conn.hasRight) {
      ctx.fillRect(sx + cellSize - gap - 1, sy + gap, gap + 1, cellSize - 2 * gap)
    }
    if (conn.hasLeft) ctx.fillRect(sx, sy + gap, gap + 1, cellSize - 2 * gap)
    if (conn.hasTop) ctx.fillRect(sx + gap, sy, cellSize - 2 * gap, gap + 1)
    if (conn.hasBottom) {
      ctx.fillRect(sx + gap, sy + cellSize - gap - 1, cellSize - 2 * gap, gap + 1)
    }
  }
}

// The mark that says "something collided here, and the board can tell you what".
// Drawn on every cell this turn's clash records name — including the ones a
// SURVIVOR is standing on, which is exactly where no death marker is drawn and
// exactly where the explanation is worth most.
//
// It comes in two shapes for one reason: a clash mark must never bury the unit
// standing on it, and it must never be buried BY it either.
//   - Nobody home: the quiet dashed ring inside the cell, the same mark the
//     centaur draws. It shares the cell with a death marker, which keeps the
//     middle.
//   - A survivor standing there: the ring would be drawn over by the body that
//     owns the cell (bodies inset ~15%, so a ring at 0.44 disappears behind
//     one), so the mark moves OUT to a dashed square hugging the cell's edge —
//     outside any body, its buff outline and its plates. The survivor draws on
//     top of it, which is the point: the living unit is the subject, and the
//     dashes around it are the handle.
// Either way it is deliberately quiet and unmistakably an outline — an
// affordance, not a second death marker competing with the real one.
function drawClashMarker(
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  boardHeight: number,
  cellSize: number,
  occupied: boolean,
) {
  if (!cell) return
  const x = cell.x * cellSize
  const y = (boardHeight - 1 - cell.y) * cellSize
  const width = Math.max(1, cellSize * 0.05)
  const path = () => {
    ctx.beginPath()
    if (occupied) {
      // Hard against the cell's edge: a unit's body is inset ~15%, and a
      // buffed one wears an outline ~9% in, so this is the one band nothing
      // standing on the cell can cover.
      const inset = Math.max(1, cellSize * 0.02)
      ctx.rect(x + inset, y + inset, cellSize - inset * 2, cellSize - inset * 2)
    } else {
      ctx.arc(x + cellSize / 2, y + cellSize / 2, cellSize * 0.44, 0, Math.PI * 2)
    }
  }
  ctx.save()
  ctx.lineJoin = "round"
  ctx.setLineDash([Math.max(2, cellSize * 0.12), Math.max(2, cellSize * 0.1)])
  // A dark halo under the amber, because this board is a LIGHT one: amber dashes
  // on a yellow fertile tile are dashes nobody can see, and an affordance that
  // shows on some terrain and not others is not an affordance.
  ctx.globalAlpha = 0.45
  ctx.lineWidth = width * 2.2
  ctx.strokeStyle = "#000000"
  path()
  ctx.stroke()
  ctx.globalAlpha = 0.95
  ctx.lineWidth = width
  ctx.strokeStyle = CLASH_RING_COLOR
  path()
  ctx.stroke()
  ctx.restore()
}

// A death marker at a board cell: a filled disc in the fallen unit's colour with
// a white ✗, drawn last so it sits on top of everything the cell holds.
function drawDeathMarker(
  ctx: CanvasRenderingContext2D,
  cell: Cell,
  boardHeight: number,
  cellSize: number,
  color: string,
) {
  if (!cell) return
  const cx = cell.x * cellSize + cellSize / 2
  const cy = (boardHeight - 1 - cell.y) * cellSize + cellSize / 2
  const r = cellSize * 0.34
  const markColor = color || "#888888"
  ctx.save()
  ctx.fillStyle = markColor
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.lineWidth = Math.max(1.5, cellSize * 0.07)
  ctx.strokeStyle = "#000000"
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.stroke()
  const d = r * 0.55
  ctx.lineCap = "round"
  ctx.lineWidth = Math.max(1.5, cellSize * 0.1)
  ctx.strokeStyle = "#ffffff"
  ctx.beginPath()
  ctx.moveTo(cx - d, cy - d)
  ctx.lineTo(cx + d, cy + d)
  ctx.moveTo(cx + d, cy - d)
  ctx.lineTo(cx - d, cy + d)
  ctx.stroke()
  ctx.restore()
}

// ── Unit tags ───────────────────────────────────────────────────────────────

interface TagStat {
  mark?: MarkName
  icon?: string
  iconColor?: string | null
  text: string
}

interface TagRect {
  x: number
  y: number
  w: number
  h: number
  letterAtEnd: boolean
}

/** A drawn tag's rect, named by the unit it belongs to, for hit-testing. */
interface TagHit extends TagRect {
  unitId: string
}

// Where the last render left each unit's tag, per canvas — the only record a
// pointer can be tested against, and the reason the hit-test can never disagree
// with what is on screen. A tag that has STEPPED ASIDE under the pointer keeps
// publishing its rect: that rect is what lets the caller see the pointer leave
// it and bring the tag back.
const tagRectsByCanvas = new WeakMap<HTMLCanvasElement, TagHit[]>()

/**
 * The unit whose TAG a pointer event landed on, or null. Rects are recorded in
 * the renderer's CSS-pixel space, which is what `pointerToCanvas` answers in.
 */
export function getTagAt(
  canvas: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): string | null {
  const rects = tagRectsByCanvas.get(canvas)
  if (!rects || rects.length === 0) return null
  const point = pointerToCanvas(canvas, event)
  for (const r of rects) {
    if (
      point.x >= r.x &&
      point.x <= r.x + r.w &&
      point.y >= r.y &&
      point.y <= r.y + r.h
    ) {
      return r.unitId
    }
  }
  return null
}

interface TagLayout {
  rect: TagRect
  fontSize: number
  font: string
  letterFont: string
  padX: number
  gap: number
  iconGap: number
  chipW: number
  tagH: number
  letterAtEnd: boolean
  letter: string
  stats: TagStat[]
  unitColor: string
}

// Width of one stat's icon inside a tag. A drawn mark has a fixed aspect taken
// from its own box; every other stat icon is a text glyph the canvas measures.
// Both the layout pass and the draw pass go through here, so a tag can never be
// measured one way and painted another.
function statIconWidth(
  ctx: CanvasRenderingContext2D,
  stat: TagStat,
  iconH: number,
): number {
  const mark = stat.mark ? STAT_MARK[stat.mark] : null
  if (mark) return (iconH * mark.icon.w) / mark.icon.h
  return ctx.measureText(stat.icon ?? "").width
}

// Draw ONE unit tag: a rounded white pill whose LETTER SQUARE is its anchor,
// sitting on the cell diagonally adjacent to the unit's head. The body carries
// the unit's WEIGHT behind the silver anvil, its numeric HEALTH behind a heart
// tinted by the shared health thresholds, and its remaining INVULNERABILITY
// turns behind the shared shield/warning mark. The tag carries no health BAR:
// the numeric heart says it, and the unit's own cell already wears the bar.
// `letterAtEnd` flips the body's reading order: the square stays on the anchor
// cell while the stats run to its LEFT, which is what lets a tag near the
// board's right edge extend inward without losing its anchor.
function drawUnitTag(ctx: CanvasRenderingContext2D, tag: TagLayout) {
  const {
    rect,
    fontSize,
    font,
    letterFont,
    padX,
    gap,
    iconGap,
    chipW,
    tagH,
    letterAtEnd,
    letter,
    stats,
    unitColor,
  } = tag

  ctx.save()
  ctx.globalAlpha = 0.92
  ctx.textBaseline = "middle"

  // Tag body: white, banded in the unit's own colour so the pill is tied to the
  // unit it names without a line drawn back to it.
  const r = tagH * 0.3
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(rect.x, rect.y, rect.w, tagH, r)
  else ctx.rect(rect.x, rect.y, rect.w, tagH)
  ctx.fillStyle = "#ffffff"
  ctx.fill()
  ctx.lineWidth = Math.max(2.5, fontSize * 0.16)
  ctx.strokeStyle = unitColor
  ctx.stroke()

  const midY = rect.y + tagH / 2 + fontSize * 0.05

  // Letter square in the unit's colour: the tag's anchor and its primary
  // identifier, drawn larger and heavier than the stats so it carries at any
  // board scale. It takes the anchor end of the pill; the stats take what is
  // left.
  const chipH = tagH - Math.max(3, fontSize * 0.22)
  const chipY = rect.y + (tagH - chipH) / 2
  const chipX = letterAtEnd ? rect.x + rect.w - padX - chipW : rect.x + padX
  ctx.beginPath()
  if (ctx.roundRect) ctx.roundRect(chipX, chipY, chipW, chipH, chipH * 0.25)
  else ctx.rect(chipX, chipY, chipW, chipH)
  ctx.fillStyle = unitColor
  ctx.fill()
  ctx.font = letterFont
  ctx.textAlign = "center"
  ctx.fillStyle = "#ffffff"
  ctx.fillText(letter, chipX + chipW / 2, midY)

  // Stat pairs (icon + value), laid out from whichever end the letter square did
  // not take.
  let x = letterAtEnd ? rect.x + padX : chipX + chipW
  const iconH = fontSize * 0.92
  ctx.font = font
  ctx.textAlign = "left"
  stats.forEach((stat) => {
    if (!letterAtEnd) x += gap
    const mark = stat.mark ? STAT_MARK[stat.mark] : null
    if (mark) {
      mark.draw(ctx, x, midY, iconH)
    } else {
      ctx.fillStyle = stat.iconColor || "#1a1a1a"
      ctx.fillText(stat.icon ?? "", x, midY)
    }
    x += statIconWidth(ctx, stat, iconH) + iconGap
    ctx.fillStyle = "#1a1a1a"
    ctx.fillText(stat.text, x, midY)
    x += ctx.measureText(stat.text).width
    if (letterAtEnd) x += gap
  })
  ctx.restore()
}

// One tag per unit head cell. The tag's LETTER SQUARE is its anchor and it sits
// on a cell DIAGONALLY adjacent to the unit's head (top-right preferred, then
// top-left / bottom-right / bottom-left), so the tag never covers its own unit's
// head cell and the letter always names the unit one step away from it. Among
// the diagonals that keep the tag on the board, the one covering the fewest
// other unit heads and already-placed tags wins. The body extends rightward from
// the square; where the right edge is too close it extends leftward instead and
// the letter moves to the tag's right end, so the square keeps the anchor cell
// either way.
// A tag is the FALLBACK, not the default: a unit gets one only when it cannot
// carry all of its applicable information on its own body, which is the single
// question `bodyPlans` answers (unitBodyInfoPlan). A snake long enough to spell
// everything out never wears a tag; a piece, having no body to write on, always
// warrants one.
// This is a spectator board, so there is no display mode and no ownership: every
// warranted tag is shown. The pointer is the only other input — resting on a tag
// makes it STEP ASIDE (`tagHoverUnitId`) so the board under it can be read, and
// the tag comes straight back when the pointer leaves. The stepped-aside tag is
// still laid out and still published: it holds its place against the other tags,
// and its rect is what tells the caller the pointer has left it.
function renderUnitTags(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  board: BoardModel,
  cellSize: number,
  bodyPlans: Map<string, BodyInfoPlan>,
  currentTurn: number,
  tagHoverUnitId: string | null,
) {
  const rects: TagHit[] = []
  tagRectsByCanvas.set(canvas, rects)
  // Other units' head cells (board-pixel rects) for overlap avoidance.
  const headRects: Record<string, PlateBox> = {}
  board.units.forEach((u) => {
    const h = u.body && u.body[0]
    if (h) {
      headRects[u.id] = {
        x: h.x * cellSize,
        y: (board.height - 1 - h.y) * cellSize,
        w: cellSize,
        h: cellSize,
      }
    }
  })
  const intersects = (a: PlateBox, b: PlateBox) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  const placed: TagRect[] = []

  board.units.forEach((unit) => {
    const head = unit.body && unit.body[0]
    if (!head) return
    // The tag is warranted only when the unit's own body could not carry
    // everything.
    const plan = bodyPlans.get(unit.id)
    if (plan && !plan.tagWarranted) return

    const unitColor = unit.color || "#888888"
    const letter = unit.letter || "?"
    const weight = unit.weight ?? unit.body.length
    const health = typeof unit.health === "number" ? unit.health : null
    const frac = health != null ? healthFraction(unit) : 0
    const invulnLevel = unit.invulnerabilityLevel || 0

    // Text sizes are floored in PIXELS as well as scaled off the cell, so a
    // small board shrinks the board, not the readout; the letter runs a step
    // larger and heavier than the stats because it is what units are called by
    // out loud.
    const fontSize = Math.max(12, cellSize * 0.38)
    const letterSize = Math.max(17, fontSize * 1.25)
    const font = `500 ${fontSize}px sans-serif`
    const letterFont = `800 ${letterSize}px sans-serif`
    const padX = fontSize * 0.45
    const gap = fontSize * 0.45
    const iconGap = fontSize * 0.16
    // Stat pairs: weight, health, invulnerability. Weight rides the drawn silver
    // anvil and a negative invulnerability the drawn red hazard mark; the health
    // heart is the one tinted glyph, the shield a plain one.
    const stats: TagStat[] = [{ mark: "anvil", iconColor: null, text: String(weight) }]
    if (health != null) {
      stats.push({
        icon: STAT_ICON.health,
        iconColor: healthBarColor(frac),
        text: String(health),
      })
    }
    // The tag writes the buff's TURNS, same as the body plate — its LEVEL is
    // already spelled out by the body's own outline colour.
    if (invulnLevel !== 0) {
      const invulnTurns = invulnerabilityTurnsRemaining(unit, currentTurn)
      if (invulnTurns != null) {
        stats.push({
          ...invulnerabilityMark(invulnLevel),
          iconColor: null,
          text: String(invulnTurns),
        })
      }
    }

    // The letter square is SQUARE by construction — it is the anchor that lands
    // on a board cell — and widens only for a glyph that would not otherwise fit.
    const tagH = Math.max(fontSize * 1.7, letterSize * 1.5)
    const chipH = tagH - Math.max(3, fontSize * 0.22)
    const iconH = fontSize * 0.92
    ctx.save()
    ctx.font = letterFont
    const chipW = Math.max(chipH, ctx.measureText(letter).width + letterSize * 0.4)
    ctx.font = font
    let contentW = chipW
    stats.forEach((stat) => {
      contentW +=
        gap +
        statIconWidth(ctx, stat, iconH) +
        iconGap +
        ctx.measureText(stat.text).width
    })
    ctx.restore()
    const tagW = contentW + padX * 2

    const boardW = board.width * cellSize
    const boardH = board.height * cellSize
    const headRow = board.height - 1 - head.y
    const headTop = headRow * cellSize
    const ownHeadRect = headRects[unit.id]
    // The four diagonally adjacent cells the letter square can take, in
    // preference order — top-right first, as the tag reads best above and to the
    // right of the unit it names. Steps are in CANVAS space, where rows grow
    // downward.
    const diagonals = [
      { dx: 1, dy: -1 },
      { dx: -1, dy: -1 },
      { dx: 1, dy: 1 },
      { dx: -1, dy: 1 },
    ]
    let best: TagRect | null = null
    let bestScore = Infinity
    for (const d of diagonals) {
      const col = head.x + d.dx
      const row = headRow + d.dy
      // The anchor cell must BE a cell: a diagonal off the board would strand
      // the letter square outside the grid.
      if (col < 0 || col >= board.width) continue
      if (row < 0 || row >= board.height) continue
      // Letter square centred on the anchor cell, then pushed clear of the head
      // cell's row — on a cramped board the pill stands taller than a cell, and
      // it must never cover the unit it names.
      const chipX = col * cellSize + (cellSize - chipW) / 2
      let y = row * cellSize + (cellSize - tagH) / 2
      y = d.dy < 0 ? Math.min(y, headTop - tagH) : Math.max(y, headTop + cellSize)
      // The body extends RIGHTWARD from the square. Where that would run past
      // the board's right edge it extends leftward instead and the square moves
      // to the tag's right end, so the anchor cell keeps the letter either way.
      let letterAtEnd = false
      let x = chipX - padX
      if (x + tagW > boardW - 1) {
        const leftwardX = chipX + chipW + padX - tagW
        if (leftwardX >= 1) {
          x = leftwardX
          letterAtEnd = true
        }
      }
      // A tag wider or taller than the board itself: clamp it into view and let
      // the score below prefer a diagonal that keeps the head clear.
      x = Math.max(1, Math.min(x, Math.max(1, boardW - tagW - 1)))
      y = Math.max(1, Math.min(y, Math.max(1, boardH - tagH - 1)))
      const rect: TagRect = { x, y, w: tagW, h: tagH, letterAtEnd }
      // Covering the unit's OWN head defeats the anchor, so it outweighs any
      // amount of ordinary crowding; other heads and already-placed tags each
      // count one.
      let score = ownHeadRect && intersects(rect, ownHeadRect) ? 100 : 0
      for (const [uid, hr] of Object.entries(headRects)) {
        if (uid === unit.id) continue
        if (intersects(rect, hr)) score++
      }
      for (const pr of placed) {
        if (intersects(rect, pr)) score++
      }
      if (score < bestScore) {
        bestScore = score
        best = rect
      }
      if (score === 0) break
    }
    // No diagonal cell exists at all (a 1×1 board): nothing to anchor to.
    if (!best) return

    // The one tag the pointer is resting on is laid out but not painted: that
    // is the whole "hover the tag to peek underneath" gesture.
    if (tagHoverUnitId !== unit.id) {
      drawUnitTag(ctx, {
        rect: best,
        fontSize,
        font,
        letterFont,
        padX,
        gap,
        iconGap,
        chipW,
        tagH,
        letterAtEnd: best.letterAtEnd,
        letter,
        stats,
        unitColor,
      })
    }

    placed.push(best)
    rects.push({ unitId: unit.id, ...best })
  })
}

/** Everything outside the turn itself that changes what a board draws. */
export interface RenderOptions {
  /**
   * The unit whose TAG the pointer is resting on. That tag steps aside for as
   * long as the pointer is on it, so the board underneath can be read.
   */
  tagHoverUnitId?: string | null
}

/**
 * Draw one turn of a board. Returns the cell size in CSS pixels it drew at, or
 * 0 when there was nothing to draw.
 */
export function renderBoard(
  canvas: HTMLCanvasElement,
  board: BoardModel,
  options?: RenderOptions,
): number {
  if (!canvas || !board) return 0

  // Measure the CSS box FIRST, then back the bitmap at the display's resolution
  // for that box. Everything below works in the CSS pixels the transform maps.
  const { width: cssWidth, height: cssHeight } = canvasCssSize(canvas)
  const ctx = prepareCanvas(canvas, cssWidth, cssHeight)
  if (!ctx) return 0
  const cellSize = Math.min(cssWidth / board.width, cssHeight / board.height)
  const boardW = board.width * cellSize
  const boardH = board.height * cellSize
  const turn = board.turn || 0

  ctx.imageSmoothingEnabled = false
  ctx.globalAlpha = 1

  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, cssWidth, cssHeight)

  ctx.strokeStyle = "#000000"
  for (let x = 0; x <= board.width; x++) {
    const line = crispStroke(ctx, x * cellSize, 1.5)
    ctx.lineWidth = line.width
    ctx.beginPath()
    ctx.moveTo(line.pos, 0)
    ctx.lineTo(line.pos, boardH)
    ctx.stroke()
  }
  for (let y = 0; y <= board.height; y++) {
    const line = crispStroke(ctx, y * cellSize, 1.5)
    ctx.lineWidth = line.width
    ctx.beginPath()
    ctx.moveTo(0, line.pos)
    ctx.lineTo(boardW, line.pos)
    ctx.stroke()
  }

  ctx.strokeStyle = "#000000"
  ctx.lineWidth = 2
  ctx.strokeRect(1, 1, boardW - 2, boardH - 2)

  board.walls.forEach((wall) => {
    const row = board.height - 1 - wall.y
    drawWallCell(ctx, wall.x * cellSize, row * cellSize, cellSize, row)
  })

  board.hazards.forEach((hazard) => {
    drawHazardCell(
      ctx,
      hazard.x * cellSize,
      (board.height - 1 - hazard.y) * cellSize,
      cellSize,
    )
  })

  board.fertileTiles.forEach((tile) => {
    drawFertileCell(
      ctx,
      tile.x * cellSize,
      (board.height - 1 - tile.y) * cellSize,
      cellSize,
    )
  })

  // The squares that won the game, under everything standing on them.
  board.winningSquares.forEach((cell) => {
    ctx.save()
    ctx.fillStyle = "rgba(46, 160, 67, 0.75)"
    ctx.fillRect(
      cell.x * cellSize + 1,
      (board.height - 1 - cell.y) * cellSize + 1,
      cellSize - 2,
      cellSize - 2,
    )
    ctx.restore()
  })

  board.food.forEach((food) => {
    const x = food.x * cellSize
    const y = (board.height - 1 - food.y) * cellSize
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, cellSize, cellSize)
    ctx.clip()
    ctx.fillStyle = "#000000"
    const emojiSize = Math.max(cellSize * 0.7, 10)
    ctx.font = `${emojiSize}px serif`
    ctx.textAlign = "center"
    ctx.textBaseline = "middle"
    ctx.fillText("\u{1F383}", x + cellSize / 2, y + cellSize / 2)
    ctx.restore()
  })

  board.invulnerabilityPotions.forEach((potion) => {
    const x = potion.x * cellSize
    const y = (board.height - 1 - potion.y) * cellSize
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, cellSize, cellSize)
    ctx.clip()
    if (potionImage) {
      const pad = cellSize * 0.1
      ctx.drawImage(potionImage, x + pad, y + pad, cellSize - pad * 2, cellSize - pad * 2)
    } else {
      const emojiSize = Math.max(cellSize * 0.7, 10)
      ctx.font = `${emojiSize}px serif`
      ctx.textAlign = "center"
      ctx.textBaseline = "middle"
      ctx.fillText("\u{1F9EA}", x + cellSize / 2, y + cellSize / 2)
    }
    ctx.restore()
  })

  // Clash marks go down BEFORE the units, so a unit that survived a collision
  // is drawn on top of the mark rather than under it: the survivor is the
  // subject of its cell, and the dashes are what say the cell has a story to
  // tell. Death markers come last of all, for the cells nobody walked away
  // from.
  const occupiedCells = new Set<string>()
  board.units.forEach((unit) => {
    unit.body.forEach((cell) => occupiedCells.add(`${cell.x},${cell.y}`))
  })
  clashCellKeys(board).forEach((key) => {
    const [x, y] = key.split(",")
    drawClashMarker(
      ctx,
      { x: Number(x), y: Number(y) },
      board.height,
      cellSize,
      occupiedCells.has(key),
    )
  })

  board.units.forEach((unit) => {
    renderUnitBody(ctx, unit, board.height, cellSize)
  })

  // ONE body-information plan per unit, built before anything is written on a
  // body: the pass below paints it, and the tag pass asks the same object
  // whether anything was dropped. Two readers, one plan, no drift.
  const bodyPlans = new Map<string, BodyInfoPlan>()
  board.units.forEach((unit) => {
    bodyPlans.set(
      unit.id,
      unitBodyInfoPlan(ctx, unit, board.height, cellSize, turn),
    )
  })

  board.units.forEach((unit) => {
    const head = unit.body[0]
    if (head) {
      const hx = head.x * cellSize
      const hy = (board.height - 1 - head.y) * cellSize
      // Health bar first: a south-facing unit's orientation eye lands on the
      // same bottom edge, and the eye is the one that must stay whole.
      drawHealthBar(ctx, unit, hx, hy, cellSize)
      // A piece is one cell and keeps its icon (and its eye) there; a snake's
      // head cell carries its LETTER instead, drawn with the rest of its body
      // information below.
      if (isPieceUnit(unit)) {
        drawHeadGlyph(ctx, unit, hx, hy, cellSize)
      }
    }
    // The unit's own numbers, along its own body — letter, weight, health, buff,
    // tail stack — in whatever of them this cell size can hold.
    const plan = bodyPlans.get(unit.id)
    if (plan) drawUnitBodyInfo(ctx, plan)
  })

  renderUnitTags(
    ctx,
    canvas,
    board,
    cellSize,
    bodyPlans,
    turn,
    options?.tagHoverUnitId ?? null,
  )

  // Death markers last, so a cell that ended the turn as a grave says so over
  // whatever terrain it sits on.
  board.deaths.forEach((death) => {
    drawDeathMarker(ctx, death.cell, board.height, cellSize, death.color)
  })

  return cellSize
}
