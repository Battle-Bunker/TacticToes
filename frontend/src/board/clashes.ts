// ── Clash inspection ────────────────────────────────────────────────────────
//
// A clash is the game server's own record of an event it adjudicated: WHERE it
// happened, WHAT KIND of event it was, WHO took part, WHICH of them died, WHICH
// one was left standing, and — in piece games, which resolve a turn in several
// sub-steps as sliders walk their paths — WHICH sub-step it happened on.
//
// Everything a reader is told comes off that record and off the turn's death
// registry. Nothing is inferred from end-of-turn occupancy, which is the one
// habit this module exists to prevent: occupancy and the record disagree on a
// sever (the cut snake is alive, elsewhere, shorter) and on a durable cell (a
// later arrival can be standing on a corpse's square), and where they disagree
// the record is right and occupancy is a coincidence.
//
// The records ride on the board model in renderer coordinates (turnToBoard is
// the one place the wire's indices are mapped), so the live board and a scrubbed
// historic one read an event exactly the same way, and a spectator reads it
// exactly as a player would: a clash says nothing about control or ownership.

import {
  BoardClash,
  BoardClashKind,
  BoardModel,
  Cell,
  DeathMark,
  RecoveryMark,
  SeverMark,
  UncertaintyMark,
} from "./renderer"

/** The dashed ring the board wears on an inspectable clash cell. */
export const CLASH_RING_COLOR = "#FFD54F"

/** The muted ink of everything the board is not sure about. */
export const UNCERTAIN_RING_COLOR = "#7a8290"

/** The line the inspector shows whenever a cell's record is missing something. */
export const INCOMPLETE_RECORD_LINE = "This turn's record is incomplete."

const sameCell = (a: Cell, b: Cell): boolean => a.x === b.x && a.y === b.y

/** The clash records marking one cell. */
export const clashesAtCell = (board: BoardModel, cell: Cell): BoardClash[] =>
  board.clashes.filter((c) => sameCell(c.cell, cell))

/** The deaths recorded on one cell — one mark, holding every unit that fell there. */
export const deathsAtCell = (board: BoardModel, cell: Cell): DeathMark | null =>
  board.deaths.find((d) => sameCell(d.cell, cell)) ?? null

/** The near-deaths recorded on one cell: units that exhausted here and got back up. */
export const recoveriesAtCell = (
  board: BoardModel,
  cell: Cell,
): RecoveryMark[] => board.recoveries.filter((r) => sameCell(r.cell, cell))

/** The sever damage recorded on one cell (one per owner whose body was cut there). */
export const seversAtCell = (board: BoardModel, cell: Cell): SeverMark[] =>
  board.severed.filter((s) => sameCell(s.cell, cell))

/** What the board could not account for at one cell. */
export const uncertaintiesAtCell = (
  board: BoardModel,
  cell: Cell,
): UncertaintyMark[] => board.uncertainties.filter((u) => sameCell(u.cell, cell))

/**
 * The distinct EVENTS among a set of records. A collision that spans two cells
 * writes one record per cell, so one cell can carry several records that
 * describe the same thing; records agreeing on kind, sub-step, participants,
 * victims and survivor are one event and are folded together.
 */
export const distinctClashes = (clashes: BoardClash[]): BoardClash[] => {
  const seen = new Set<string>()
  const out: BoardClash[] = []
  for (const clash of clashes) {
    const key = [
      clash.kind,
      clash.subStep,
      clash.playerIDs.join(","),
      clash.victimIDs.join(","),
      clash.survivorID ?? "",
    ].join("|")
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clash)
  }
  return out
}

/**
 * Every cell worth clicking: one that carries a clash record, a death, sever
 * damage, or a note about what the record failed to say. All four are things the
 * inspector can explain, so all four are things the pointer should offer.
 */
export const inspectableCellKeys = (board: BoardModel): Set<string> => {
  const keys = new Set<string>()
  const add = (cell: Cell) => keys.add(`${cell.x},${cell.y}`)
  board.clashes.forEach((c) => add(c.cell))
  board.deaths.forEach((d) => add(d.cell))
  board.severed.forEach((s) => add(s.cell))
  board.recoveries.forEach((r) => add(r.cell))
  board.uncertainties.forEach((u) => add(u.cell))
  return keys
}

/** Whether one cell has anything the inspector can say about it. */
export const isInspectable = (board: BoardModel, cell: Cell): boolean =>
  clashesAtCell(board, cell).length > 0 ||
  deathsAtCell(board, cell) !== null ||
  seversAtCell(board, cell).length > 0 ||
  recoveriesAtCell(board, cell).length > 0 ||
  uncertaintiesAtCell(board, cell).length > 0

/**
 * The rings the board draws on its clash cells, and the colour each one gets:
 * amber where the record is whole, muted grey where it is not — the ring itself
 * grades the record it points at, so a reader knows before they click whether
 * there is a straight answer waiting.
 */
export const clashRings = (
  board: BoardModel,
): { cell: Cell; color: string }[] => {
  const byKey = new Map<string, { cell: Cell; complete: boolean }>()
  for (const clash of board.clashes) {
    const key = `${clash.cell.x},${clash.cell.y}`
    const seen = byKey.get(key)
    if (!seen) byKey.set(key, { cell: clash.cell, complete: clash.complete })
    else seen.complete = seen.complete || clash.complete
  }
  return [...byKey.values()].map(({ cell, complete }) => ({
    cell,
    color: complete ? CLASH_RING_COLOR : UNCERTAIN_RING_COLOR,
  }))
}

/**
 * The headline one event gets in the inspector, from its KIND — never from the
 * server's `reason` string, which is display text and free to change. The
 * reason is shown too, underneath, as the server's own words for it.
 */
export const clashHeadline = (kind: BoardClashKind): string => {
  switch (kind) {
    case "contest":
      return "Contest for the square"
    case "edge":
      return "Edge exchange"
    case "bodyBlock":
      return "Ran into a body"
    case "sever":
      return "Body severed"
    case "hazard":
      return "Exhausted by hazard damage"
    case "exhaustion":
      return "Exhausted — out of energy"
    case "wall":
      return "Hit the wall"
    case "self":
      return "Hit its own body"
    case "regicide":
      return "Team eliminated — last king fell"
    default:
      return "Unrecorded event"
  }
}

/** How a death reads in the inspector, from the cause the registry recorded. */
export const deathHeadline = (cause: BoardClashKind): string => {
  switch (cause) {
    case "contest":
      return "Lost the contest for this square"
    case "edge":
      return "Lost an edge exchange"
    case "bodyBlock":
      return "Ran into a body"
    case "hazard":
      return "Hazard damage emptied its energy — collapsed here"
    case "exhaustion":
      return "Ran out of energy and collapsed here"
    case "wall":
      return "Hit the wall"
    case "self":
      return "Hit its own body"
    case "regicide":
      return "Removed with its team when the last king fell"
    case "sever":
      // A sever is non-fatal by definition; a death registry naming it as a
      // cause is a record that contradicts itself, and is reported as such.
      return "Recorded as a sever — a sever does not kill"
    default:
      return "Cause not recorded"
  }
}

/**
 * The two kinds that empty a unit's energy where it stands. Neither is fatal on
 * its own: exhaustion is a PROVISIONAL death — the unit halts, stays a
 * collision object, and dies only if it is still at or below zero when the turn
 * ends. One that eats on its halt square lives, and the record it leaves behind
 * is one of these kinds with an EMPTY victim list.
 */
export const EXHAUSTION_KINDS: ReadonlySet<BoardClashKind> = new Set<BoardClashKind>([
  "exhaustion",
  "hazard",
])

/** One participant's fate in one record: read off the record, never off the board. */
export type ParticipantStatus =
  | "died"
  | "stood"
  | "shortened"
  | "recovered"
  | "survived"
  | "unknown"

export const participantStatus = (
  clash: BoardClash,
  playerID: string,
  severedOwnerIDs: Set<string>,
): ParticipantStatus => {
  if (clash.victimIDs.includes(playerID)) return "died"
  if (!clash.complete) return "unknown"
  // An exhaustion record that names no victim is a unit that went down here and
  // got back up: it ate on its halt square and finished the turn alive.
  if (EXHAUSTION_KINDS.has(clash.kind) && clash.victimIDs.length === 0) {
    return "recovered"
  }
  if (clash.survivorID === playerID) return "stood"
  // The owner of a severed body walked away from this one — shorter.
  if (clash.kind === "sever" && severedOwnerIDs.has(playerID)) return "shortened"
  return "survived"
}

export const STATUS_LABEL: Record<ParticipantStatus, string> = {
  died: "died",
  stood: "stood",
  shortened: "cut short",
  recovered: "recovered",
  survived: "survived",
  unknown: "not recorded",
}
