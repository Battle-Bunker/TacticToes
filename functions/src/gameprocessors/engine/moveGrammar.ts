import { UnitType } from "@shared/types/Game"
import { Rng } from "./spawn"

/**
 * The movement grammar: the one place unit-kind names still matter. It turns a
 * staged destination square into the action a unit of that kind may take, and
 * supplies the action a unit takes when nothing legal was staged.
 *
 * Everything downstream of this file is property-driven (see turnEngine.ts):
 * the engine never asks what kind a unit is, only whether it leaves a trail,
 * whether it traverses edges, and what path it is walking.
 */

export interface Orientation {
  dx: number
  dy: number
}

// A pawn becomes a queen when its weight reaches the configured threshold
// (GameSetup.pawnPromotionWeight); this is the default.
export const DEFAULT_PAWN_PROMOTION_WEIGHT = 10

export const isPieceType = (t?: UnitType): boolean => t !== undefined && t !== "snake"

/** Trail units (snakes) drag their occupancy behind the head; pieces teleport their stack. */
export const leavesTrail = (type: UnitType): boolean => type === "snake"

/** A jump crosses no edge, so a knight can never contest one. */
export const traversesEdges = (type: UnitType): boolean => type !== "knight"

export const toXY = (index: number, boardWidth: number): { x: number; y: number } => ({
  x: index % boardWidth,
  y: Math.floor(index / boardWidth),
})

export const toIndex = (x: number, y: number, boardWidth: number): number => y * boardWidth + x

// Interior = every square that is not part of the perimeter wall.
export const isInterior = (x: number, y: number, boardWidth: number, boardHeight: number): boolean =>
  x >= 1 && x <= boardWidth - 2 && y >= 1 && y <= boardHeight - 2

export const ORTHOGONALS: Orientation[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
]
const DIAGONALS: Orientation[] = [
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
]
const KNIGHT_OFFSETS: Orientation[] = [
  { dx: 1, dy: 2 },
  { dx: 2, dy: 1 },
  { dx: 2, dy: -1 },
  { dx: 1, dy: -2 },
  { dx: -1, dy: -2 },
  { dx: -2, dy: -1 },
  { dx: -2, dy: 1 },
  { dx: -1, dy: 2 },
]

// The legal orientation set per unit type: the directions a unit's
// orientation can ever take (snake/rook/pawn: the 4 orthogonals; bishop:
// the 4 diagonals; queen/king: all 8; knight: its 8 L-offsets).
export const legalOrientations = (type: UnitType): Orientation[] => {
  switch (type) {
    case "bishop":
      return DIAGONALS
    case "queen":
    case "king":
      return [...ORTHOGONALS, ...DIAGONALS]
    case "knight":
      return KNIGHT_OFFSETS
    default: // snake, rook, pawn
      return ORTHOGONALS
  }
}

// Spawn orientation candidates: the orientation(s) from the type's legal
// orientation set
// with minimal angle to the vector from the spawn square to the board
// centre. Several candidates tie when the spawn sits on a symmetry axis of
// the set (e.g. a rook exactly on the diagonal from centre) or exactly at
// the centre (every candidate ties).
export const spawnOrientationCandidates = (
  type: UnitType,
  index: number,
  boardWidth: number,
  boardHeight: number,
): Orientation[] => {
  const { x, y } = toXY(index, boardWidth)
  const vx = (boardWidth - 1) / 2 - x
  const vy = (boardHeight - 1) / 2 - y
  const candidates = legalOrientations(type)
  if (vx === 0 && vy === 0) return candidates

  const EPS = 1e-9
  let best: Orientation[] = []
  let bestScore = -Infinity
  candidates.forEach((f) => {
    // cos(angle) up to the constant |v|: dot(f, v) / |f|
    const score = (f.dx * vx + f.dy * vy) / Math.hypot(f.dx, f.dy)
    if (score > bestScore + EPS) {
      bestScore = score
      best = [f]
    } else if (score > bestScore - EPS) {
      best.push(f)
    }
  })
  return best
}

/**
 * The orientation a unit is placed facing: one of the candidates above, drawn
 * uniformly when several tie. The candidate SET was always a rule; which of
 * the tied candidates is taken is a die roll, and the die is injected like
 * every other one in this module (engine/spawn.ts) — nothing in this
 * directory reads a clock or an RNG of its own (see VENDOR.md).
 */
export const pickSpawnOrientation = (
  type: UnitType,
  index: number,
  boardWidth: number,
  boardHeight: number,
  rng: Rng,
): Orientation => {
  const best = spawnOrientationCandidates(type, index, boardWidth, boardHeight)
  return best[Math.floor(rng.next() * best.length)]
}

export type UnitAction =
  | { kind: "stay" }
  | { kind: "move"; path: number[] }
  | { kind: "rotate"; orientation: Orientation }

/**
 * Plans a unit's staged destination into an action.
 *
 * Returns null when the destination is not legal for this kind — the caller
 * substitutes `defaultAction`. `pawnTargets` holds every square containing
 * food or another unit at the start of the turn: a pawn's diagonal-forward
 * step is legal only into one of those (attack or eat). Staging a pawn's side
 * square means "spend the turn rotating to face that way"; the square behind
 * is never legal.
 *
 * Bounds: a piece may only ever enter the interior, so every branch that
 * MOVES a piece requires it. The pawn's rotation branch does not — the side
 * square is pure signalling, never entered, so a pawn against the wall may
 * still turn. A trail unit (snake) is the one kind allowed to stage a wall
 * square: walking into the perimeter is a legal, fatal move.
 */
export const planUnitAction = (
  type: UnitType,
  origin: number,
  dest: number,
  boardWidth: number,
  boardHeight: number,
  orientation: Orientation,
  pawnTargets?: Set<number>,
): UnitAction | null => {
  if (!Number.isInteger(dest) || dest < 0 || dest >= boardWidth * boardHeight) return null
  // Read as scalars rather than through `toXY`. This is the innermost call of
  // every query in the module — a board sweep per unit per turn — and the two
  // coordinate objects it used to allocate here were the module's largest
  // source of garbage, for arithmetic that fits in four numbers.
  const ox = origin % boardWidth
  const oy = Math.floor(origin / boardWidth)
  const dxCell = dest % boardWidth
  const dyCell = Math.floor(dest / boardWidth)
  const dx = dxCell - ox
  const dy = dyCell - oy
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)
  // Origins are always interior and the interior is convex, so a straight ray
  // between interior squares never touches the perimeter wall — only the
  // destination needs the check.
  const interior = isInterior(dxCell, dyCell, boardWidth, boardHeight)

  // Trail units: one orthogonal step, walls included. They have no "stay":
  // staging their own square is not a move, so the default (continue straight)
  // takes over.
  if (type === "snake") {
    return adx + ady === 1 ? { kind: "move", path: [dest] } : null
  }

  if (dest === origin) return { kind: "stay" }

  switch (type) {
    case "knight":
      return interior && ((adx === 1 && ady === 2) || (adx === 2 && ady === 1))
        ? { kind: "move", path: [dest] }
        : null
    case "king":
      return interior && Math.max(adx, ady) === 1 ? { kind: "move", path: [dest] } : null
    case "rook":
      return interior && (dx === 0) !== (dy === 0)
        ? { kind: "move", path: rayPath(ox, oy, dx, dy, boardWidth) }
        : null
    case "bishop":
      return interior && adx === ady && adx > 0
        ? { kind: "move", path: rayPath(ox, oy, dx, dy, boardWidth) }
        : null
    case "queen":
      return interior && ((dx === 0) !== (dy === 0) || (adx === ady && adx > 0))
        ? { kind: "move", path: rayPath(ox, oy, dx, dy, boardWidth) }
        : null
    case "pawn": {
      if (dx === orientation.dx && dy === orientation.dy) {
        return interior ? { kind: "move", path: [dest] } : null
      }
      // Side squares: a full-turn quarter rotation toward that side. The pawn
      // never enters the square, so it may sit anywhere — including a wall.
      if (
        (dx === -orientation.dy && dy === orientation.dx) ||
        (dx === orientation.dy && dy === -orientation.dx)
      ) {
        return { kind: "rotate", orientation: { dx, dy } }
      }
      // Diagonal-forward: attack/eat only.
      const diag1 = { dx: orientation.dx - orientation.dy, dy: orientation.dy + orientation.dx }
      const diag2 = { dx: orientation.dx + orientation.dy, dy: orientation.dy - orientation.dx }
      if ((dx === diag1.dx && dy === diag1.dy) || (dx === diag2.dx && dy === diag2.dy)) {
        return interior && pawnTargets?.has(dest) ? { kind: "move", path: [dest] } : null
      }
      return null
    }
    default:
      return null
  }
}

/**
 * What a unit does when nothing legal was staged. Trail units have momentum:
 * they continue one step along their orientation, wherever that leads (walls
 * included — the default never re-routes). Pieces have none, so they hold.
 */
export const defaultAction = (
  type: UnitType,
  origin: number,
  boardWidth: number,
  boardHeight: number,
  orientation: Orientation,
): UnitAction => {
  if (type !== "snake") return { kind: "stay" }
  const { x, y } = toXY(origin, boardWidth)
  const nx = x + orientation.dx
  const ny = y + orientation.dy
  // Only reachable from a head already off the interior, which cannot survive
  // a turn; holding is the safe degenerate answer.
  if (nx < 0 || nx >= boardWidth || ny < 0 || ny >= boardHeight) return { kind: "stay" }
  return { kind: "move", path: [toIndex(nx, ny, boardWidth)] }
}

const rayPath = (
  ox: number,
  oy: number,
  dx: number,
  dy: number,
  boardWidth: number,
): number[] => {
  const steps = Math.max(Math.abs(dx), Math.abs(dy))
  const sx = Math.sign(dx)
  const sy = Math.sign(dy)
  const path: number[] = new Array(steps)
  for (let i = 1; i <= steps; i++) {
    path[i - 1] = toIndex(ox + sx * i, oy + sy * i, boardWidth)
  }
  return path
}
