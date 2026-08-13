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

// Default pawn facing: toward the board centre along the dominant axis
// (ties prefer horizontal). Assigned once at spawn.
export const defaultFacing = (index: number, boardWidth: number, boardHeight: number): Facing => {
  const { x, y } = toXY(index, boardWidth)
  const dx = (boardWidth - 1) / 2 - x
  const dy = (boardHeight - 1) / 2 - y
  if (Math.abs(dx) >= Math.abs(dy)) return { dx: dx >= 0 ? 1 : -1, dy: 0 }
  return { dx: 0, dy: dy >= 0 ? 1 : -1 }
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
  facing?: Facing,
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
      if (!facing) return null
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
