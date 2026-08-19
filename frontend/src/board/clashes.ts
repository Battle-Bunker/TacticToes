// ── Clash inspection ────────────────────────────────────────────────────────
//
// A clash is the game server's own record of a collision it resolved: WHERE it
// happened, WHO took part, WHY someone died, and — in piece games, which resolve
// a turn in several sub-steps as sliders walk their paths — WHICH sub-step it
// happened on. The records ride on the board model in renderer coordinates
// (turnToBoard is the one place the wire's indices are mapped), so the live
// board and a scrubbed historic one read a clash exactly the same way, and a
// spectator reads it exactly as a player would: a clash says nothing about
// control or ownership.

import { BoardClash, BoardModel, Cell } from "./renderer"

/** The dashed ring the board wears on an inspectable clash cell. */
export const CLASH_RING_COLOR = "#FFD54F"

/** The clash records marking one cell. */
export const clashesAtCell = (
  board: BoardModel,
  cell: Cell,
): BoardClash[] =>
  board.clashes.filter((c) => c.cell.x === cell.x && c.cell.y === cell.y)

/**
 * The distinct COLLISIONS among a set of records. The server writes one record
 * per body cell of each unit that died, so a single collision can mark several
 * cells and one cell can carry several records — records agreeing on reason,
 * sub-step and participants describe one event and are folded together.
 */
export const distinctClashes = (clashes: BoardClash[]): BoardClash[] => {
  const seen = new Set<string>()
  const out: BoardClash[] = []
  for (const clash of clashes) {
    const key = [
      clash.reason ?? "",
      clash.subStep == null ? "" : clash.subStep,
      clash.playerIDs.join(","),
    ].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clash)
  }
  return out
}

/**
 * The cells any clash marks, as an "x,y" key set — what a renderer needs to
 * decide which cells are worth marking as inspectable.
 */
export const clashCellKeys = (board: BoardModel): Set<string> => {
  const keys = new Set<string>()
  for (const clash of board.clashes) keys.add(`${clash.cell.x},${clash.cell.y}`)
  return keys
}
