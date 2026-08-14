import { UnitType } from "@shared/types/Game"

export interface Facing {
  dx: number
  dy: number
}

// A pawn becomes a queen when its weight reaches the configured threshold
// (GameSetup.pawnPromotionWeight); this is the default.
export const DEFAULT_PAWN_PROMOTION_WEIGHT = 10

// Fixed expansion order for a team's units; letters are assigned in this order.
export const UNIT_EXPANSION_ORDER: UnitType[] = [
  "snake",
  "king",
  "queen",
  "rook",
  "bishop",
  "knight",
  "pawn",
]

export const isPieceType = (t?: UnitType): boolean => t !== undefined && t !== "snake"

export const toXY = (index: number, boardWidth: number): { x: number; y: number } => ({
  x: index % boardWidth,
  y: Math.floor(index / boardWidth),
})

export const toIndex = (x: number, y: number, boardWidth: number): number => y * boardWidth + x

// Interior = every square that is not part of the perimeter wall.
export const isInterior = (x: number, y: number, boardWidth: number, boardHeight: number): boolean =>
  x >= 1 && x <= boardWidth - 2 && y >= 1 && y <= boardHeight - 2

export const ORTHOGONALS: Facing[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
]
const DIAGONALS: Facing[] = [
  { dx: 1, dy: 1 },
  { dx: 1, dy: -1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
]
const KNIGHT_OFFSETS: Facing[] = [
  { dx: 1, dy: 2 },
  { dx: 2, dy: 1 },
  { dx: 2, dy: -1 },
  { dx: 1, dy: -2 },
  { dx: -1, dy: -2 },
  { dx: -2, dy: -1 },
  { dx: -2, dy: 1 },
  { dx: -1, dy: 2 },
]

// The legal facing-direction set per unit type: the directions a unit's
// orientation can ever take (snake/rook/pawn: the 4 orthogonals; bishop:
// the 4 diagonals; queen/king: all 8; knight: its 8 L-offsets).
export const facingDirections = (type: UnitType): Facing[] => {
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

// Spawn orientation candidates: the facing(s) from the type's legal set
// with minimal angle to the vector from the spawn square to the board
// centre. Several candidates tie when the spawn sits on a symmetry axis of
// the set (e.g. a rook exactly on the diagonal from centre) or exactly at
// the centre (every candidate ties).
export const spawnFacingCandidates = (
  type: UnitType,
  index: number,
  boardWidth: number,
  boardHeight: number,
): Facing[] => {
  const { x, y } = toXY(index, boardWidth)
  const vx = (boardWidth - 1) / 2 - x
  const vy = (boardHeight - 1) / 2 - y
  const candidates = facingDirections(type)
  if (vx === 0 && vy === 0) return candidates

  const EPS = 1e-9
  let best: Facing[] = []
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

// Spawn orientation, assigned once at turn 0: toward the board centre,
// ties resolved uniformly at random among the tied candidates.
export const spawnFacing = (
  type: UnitType,
  index: number,
  boardWidth: number,
  boardHeight: number,
): Facing => {
  const best = spawnFacingCandidates(type, index, boardWidth, boardHeight)
  return best[Math.floor(Math.random() * best.length)]
}

export type PieceAction =
  | { kind: "stay" }
  | { kind: "move"; path: number[] }
  | { kind: "rotate"; facing: Facing }

/**
 * Plans a piece's staged destination into an action.
 *
 * Returns null when the destination is not legal for this piece — the caller
 * substitutes the default action (stay). `pawnTargets` holds every square
 * containing food or another unit at the start of the turn: a pawn's
 * diagonal-forward step is legal only into one of those (attack or eat).
 * Staging a pawn's side square means "spend the turn rotating to face that
 * way"; the square behind is never legal.
 */
export const planPieceAction = (
  type: UnitType,
  origin: number,
  dest: number,
  boardWidth: number,
  boardHeight: number,
  facing: Facing,
  pawnTargets?: Set<number>,
): PieceAction | null => {
  if (dest === origin) return { kind: "stay" }
  if (!Number.isInteger(dest) || dest < 0 || dest >= boardWidth * boardHeight) return null
  const o = toXY(origin, boardWidth)
  const d = toXY(dest, boardWidth)
  // Origins are always interior and the interior is convex, so a straight
  // ray between interior squares never touches the perimeter wall — only the
  // destination needs the check.
  if (!isInterior(d.x, d.y, boardWidth, boardHeight)) return null
  const dx = d.x - o.x
  const dy = d.y - o.y
  const adx = Math.abs(dx)
  const ady = Math.abs(dy)

  switch (type) {
    case "knight":
      return (adx === 1 && ady === 2) || (adx === 2 && ady === 1)
        ? { kind: "move", path: [dest] }
        : null
    case "king":
      return Math.max(adx, ady) === 1 ? { kind: "move", path: [dest] } : null
    case "rook":
      return (dx === 0) !== (dy === 0) ? { kind: "move", path: rayPath(o, d, boardWidth) } : null
    case "bishop":
      return adx === ady && adx > 0 ? { kind: "move", path: rayPath(o, d, boardWidth) } : null
    case "queen":
      return (dx === 0) !== (dy === 0) || (adx === ady && adx > 0)
        ? { kind: "move", path: rayPath(o, d, boardWidth) }
        : null
    case "pawn": {
      if (dx === facing.dx && dy === facing.dy) return { kind: "move", path: [dest] }
      // Side squares: a full-turn quarter rotation toward that side.
      if ((dx === -facing.dy && dy === facing.dx) || (dx === facing.dy && dy === -facing.dx)) {
        return { kind: "rotate", facing: { dx, dy } }
      }
      // Diagonal-forward: attack/eat only.
      const diag1 = { dx: facing.dx - facing.dy, dy: facing.dy + facing.dx }
      const diag2 = { dx: facing.dx + facing.dy, dy: facing.dy - facing.dx }
      if ((dx === diag1.dx && dy === diag1.dy) || (dx === diag2.dx && dy === diag2.dy)) {
        return pawnTargets?.has(dest) ? { kind: "move", path: [dest] } : null
      }
      return null
    }
    default:
      return null
  }
}

const rayPath = (o: { x: number; y: number }, d: { x: number; y: number }, boardWidth: number): number[] => {
  const steps = Math.max(Math.abs(d.x - o.x), Math.abs(d.y - o.y))
  const sx = Math.sign(d.x - o.x)
  const sy = Math.sign(d.y - o.y)
  const path: number[] = []
  for (let i = 1; i <= steps; i++) {
    path.push(toIndex(o.x + sx * i, o.y + sy * i, boardWidth))
  }
  return path
}
