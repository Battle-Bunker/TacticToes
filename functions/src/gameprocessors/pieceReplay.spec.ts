// THE GOLDEN PIECE REPLAY — the gate for the phases that only pieces reach.
//
// `settlementReplay.spec.ts` pins a snake game, and snakes exercise exactly
// one of the orientation rule's five branches. The migration in
// `19-ENGINE-SPEC.md` moves the orientation rewrite and pawn promotion into
// the vendorable engine next, and neither phase is meaningfully covered by a
// board with nothing but trail units on it: a snake never rotates, never
// jumps, never slides, and never promotes.
//
// So this file plays a whole chess-piece game, turn by turn, and pins the
// complete produced turn stream as a byte-for-byte fixture — the same
// canonicalisation, the same UPDATE_GOLDEN escape hatch, the same rule that
// re-recording is only ever legitimate BEFORE a phase moves.
//
// DETERMINISM. As in the snake replay: `applyMoves` is driven from a
// constructed turn (never `firstTurn`), potions are off, and a seeded LCG is
// installed over `Math.random` so the food spawner is pinned whether it is
// running or not.
//
// THE GAME. A 13x13 board. Two teams of five — queen, rook, bishop, knight,
// pawn — with team two's five standing still down the right-hand edge for the
// whole replay, because a unit that holds keeps its facing and that is a
// branch too. Team one's five are scripted through every orientation rule
// there is:
//
//   sliders (queen, rook, bishop)  face the SIGN of their ray, so the same
//                                  unit turning twice reports two facings;
//   the knight                     faces its exact L-offset, {1,2} and
//                                  {-2,-1} and {1,-2} — never a sign;
//   a unit that holds              keeps the facing it had;
//   the pawn                       is the exception: it changes facing ONLY
//                                  through its rotation action, so turn 1
//                                  rotates it a quarter turn without moving
//                                  it, and turn 2 walks it diagonally forward
//                                  onto food while its facing stays
//                                  orthogonal — the one move on the board
//                                  whose direction and whose reported facing
//                                  disagree.
//
// Turn 3 walks the pawn onto the second food, which takes it to weight 3 and
// the configured promotion threshold: it becomes a queen, its stack collapses
// to the single square it stands on, and its health is clamped from the
// pawn's max of 100 to the queen's of 40. It is a queen for turns 4 and 5,
// which is how the fixture knows promotion happened at all — the two staged
// slides are legal for a queen and illegal for a pawn, so a pawn would have
// held on both.
//
// Promotion lands on the same turn as an orientation rewrite, which is the
// interleaving worth pinning: the rewrite runs FIRST, so a pawn that promotes
// this turn is still a pawn when its facing is decided and keeps it.

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { Timestamp } from "firebase-admin/firestore"
import {
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
  UnitCounts,
  UnitType,
} from "@shared/types/Game"
import { expandTeams } from "../utils/expandTeams"
import { Orientation } from "./engine/moveGrammar"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

// ── the board ──────────────────────────────────────────────────────────────

/** 13x13, index = y * 13 + x, perimeter wall, interior 1..11. */
const W = 13
const at = (x: number, y: number): number => y * W + x

// ── the units ──────────────────────────────────────────────────────────────

const teams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
]

/**
 * One of each kind, per team. `expandTeams` walks its unit order and names
 * them A..E, so team one is queen `t1`, rook `t1#2`, bishop `t1#3`, knight
 * `t1#4`, pawn `t1#5`, and team two the same again.
 */
const UNITS_PER_TEAM: UnitCounts = { queen: 1, rook: 1, bishop: 1, knight: 1, pawn: 1 }

/** Where each unit stands, and which way it faces, when the replay opens. */
const START: { [playerID: string]: { cell: number; facing: Orientation } } = {
  t1: { cell: at(2, 2), facing: { dx: 0, dy: 1 } },
  "t1#2": { cell: at(2, 5), facing: { dx: 0, dy: 1 } },
  "t1#3": { cell: at(2, 9), facing: { dx: 1, dy: -1 } },
  "t1#4": { cell: at(8, 2), facing: { dx: 0, dy: 1 } },
  "t1#5": { cell: at(6, 10), facing: { dx: 0, dy: -1 } },
  t2: { cell: at(11, 1), facing: { dx: -1, dy: 1 } },
  "t2#2": { cell: at(11, 3), facing: { dx: -1, dy: 0 } },
  "t2#3": { cell: at(11, 5), facing: { dx: -1, dy: -1 } },
  "t2#4": { cell: at(11, 7), facing: { dx: -1, dy: 0 } },
  "t2#5": { cell: at(11, 9), facing: { dx: -1, dy: 0 } },
}

// ── the script ─────────────────────────────────────────────────────────────

const REPLAY_TURNS = 6

/** The pawn's two meals, and the weight the second one takes it to. */
const FIRST_MEAL = at(7, 9)
const SECOND_MEAL = at(8, 9)
const PROMOTION_WEIGHT = 3
const PROMOTION_TURN = 3

/** Health caps: the pawn tops up to 100, the queen it becomes may hold 40. */
const PAWN_MAX_HEALTH = 100
const QUEEN_MAX_HEALTH = 40

/**
 * What each unit stages, turn by turn. Team two stages nothing ever, and an
 * absent entry is a unit that stages nothing THIS turn — both hold, which is
 * what a piece does when no legal destination arrives.
 */
const SCRIPT: ReadonlyArray<{ [playerID: string]: number }> = [
  // turn 1: three sliders open, the knight jumps, the pawn spends the turn
  // rotating a quarter turn to its right — it stages a side square it never
  // enters, so it neither moves nor pays movement cost.
  {
    t1: at(4, 2),
    "t1#2": at(6, 5),
    "t1#3": at(4, 11),
    "t1#4": at(9, 4),
    "t1#5": at(7, 10),
  },
  // turn 2: everything turns. The pawn takes its diagonal-forward step onto
  // food — moving {1,-1} while still facing {1,0}.
  {
    t1: at(4, 4),
    "t1#2": at(6, 3),
    "t1#3": at(2, 9),
    "t1#4": at(7, 3),
    "t1#5": FIRST_MEAL,
  },
  // turn 3: the pawn steps straight forward onto its second meal and reaches
  // the promotion weight.
  {
    t1: at(2, 2),
    "t1#2": at(4, 3),
    "t1#3": at(4, 7),
    "t1#4": at(8, 1),
    "t1#5": SECOND_MEAL,
  },
  // turn 4: the queen stages its own square and holds; the promoted unit
  // takes a diagonal no pawn could.
  {
    t1: at(2, 2),
    "t1#4": at(6, 2),
    "t1#5": at(6, 7),
  },
  // turn 5: and an orthogonal ray, for a second post-promotion facing.
  {
    "t1#5": at(6, 10),
  },
  // turn 6: nobody stages anything, so every unit on the board holds and
  // every facing is carried through untouched.
  {},
]

// ── the fixtures the replay starts from ────────────────────────────────────

const mkSetup = (overrides: Partial<StartedGameSetup> = {}): StartedGameSetup => ({
  teams,
  snakesPerTeam: 0,
  unitsPerTeam: UNITS_PER_TEAM,
  gamePlayers: expandTeams(teams, 0, UNITS_PER_TEAM),
  boardWidth: W,
  boardHeight: W,
  maxTurnTime: 5,
  startRequested: false,
  started: true,
  timeCreated: Timestamp.fromMillis(0),
  pawnPromotionWeight: PROMOTION_WEIGHT,
  maxHealthPerUnit: { pawn: PAWN_MAX_HEALTH, queen: QUEEN_MAX_HEALTH },
  // The food on the board is the food on the wire; potions are off entirely.
  foodSpawnRate: 0,
  invulnerabilityPotionEnabled: false,
  ...overrides,
})

const startingTurn = (): Turn => {
  const ids = Object.keys(START)
  const unitTypes: { [playerID: string]: UnitType } = {}
  expandTeams(teams, 0, UNITS_PER_TEAM).forEach((p) => {
    unitTypes[p.id] = p.unitType ?? "snake"
  })
  return {
    playerHealth: Object.fromEntries(ids.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(ids.map((id) => [id, 1])),
    alivePlayers: ids,
    food: [FIRST_MEAL, SECOND_MEAL],
    hazards: [],
    playerPieces: Object.fromEntries(ids.map((id) => [id, [START[id].cell]])),
    clashes: [],
    deaths: {},
    moves: {},
    winners: [],
    unitTypes,
    orientation: Object.fromEntries(ids.map((id) => [id, { ...START[id].facing }])),
    invulnerabilityPotions: [],
    playerInvulnerabilityLevel: Object.fromEntries(ids.map((id) => [id, 0])),
    activeEffects: [],
  }
}

const mkGameState = (setup: StartedGameSetup, turns: Turn[]): GameState => ({
  setup,
  turns,
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

const mv = (playerID: string, move: number): Move => ({
  gameID: "replay",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(0),
})

// ── the replay ─────────────────────────────────────────────────────────────

/** A seeded LCG, so the replay owns its own randomness rather than borrowing. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

const REPLAY_SEED = 0x9e3779b

/** Plays REPLAY_TURNS turns and returns every turn the processor produced. */
const runReplay = (setupOverrides: Partial<StartedGameSetup> = {}): Turn[] => {
  const setup = mkSetup(setupOverrides)
  const original = Math.random
  Math.random = seededRandom(REPLAY_SEED)
  try {
    const turns: Turn[] = [startingTurn()]
    const produced: Turn[] = []
    for (let turn = 1; turn <= REPLAY_TURNS; turn++) {
      const current = turns[turns.length - 1]
      const staged = SCRIPT[turn - 1]
      const processor = new TeamSnekProcessor(mkGameState(setup, turns))
      const moves = current.alivePlayers
        .filter((id) => staged[id] !== undefined)
        .map((id) => mv(id, staged[id]))
      const next = processor.applyMoves(current, moves)
      turns.push(next)
      produced.push(next)
    }
    return produced
  } finally {
    Math.random = original
  }
}

/**
 * Key order is not a wire fact (Firestore stores documents, not JSON text), so
 * the fixture is canonicalised with sorted keys. Array order IS a wire fact —
 * the clash stream and a piece's traversed path are both ordered — and is kept.
 */
const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object") {
    const source = value as { [key: string]: unknown }
    const out: { [key: string]: unknown } = {}
    Object.keys(source)
      .sort()
      .forEach((key) => {
        out[key] = canonical(source[key])
      })
    return out
  }
  return value
}

const serialise = (stream: Turn[]): string =>
  `${JSON.stringify(canonical(stream), null, 2)}\n`

const GOLDEN = join(__dirname, "pieceReplay.golden.json")

/** Set UPDATE_GOLDEN=1 to re-record. Only ever legitimate before a move. */
const check = (actual: string, path: string): void => {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, actual)
  expect(actual).toBe(readFileSync(path, "utf8"))
}

describe("golden piece replay", () => {
  it("replays a chess-piece game turn by turn, byte for byte", () => {
    check(serialise(runReplay()), GOLDEN)
  })

  it("faces every kind the way its own rule says, so the fixture is not vacuous", () => {
    const stream = runReplay()
    const facing = (turn: number, playerID: string): Orientation =>
      stream[turn - 1].orientation[playerID]

    // Sliders report the SIGN of the ray they walked, however long it was:
    // the rook's four-cell opening and the queen's two-cell one both read
    // {1,0}, and both units report a different facing once they turn.
    expect(facing(1, "t1")).toEqual({ dx: 1, dy: 0 })
    expect(facing(2, "t1")).toEqual({ dx: 0, dy: 1 })
    expect(facing(3, "t1")).toEqual({ dx: -1, dy: -1 })
    expect(facing(1, "t1#2")).toEqual({ dx: 1, dy: 0 })
    expect(facing(2, "t1#2")).toEqual({ dx: 0, dy: -1 })
    expect(facing(3, "t1#2")).toEqual({ dx: -1, dy: 0 })
    expect(facing(1, "t1#3")).toEqual({ dx: 1, dy: 1 })
    expect(facing(2, "t1#3")).toEqual({ dx: -1, dy: -1 })
    expect(facing(3, "t1#3")).toEqual({ dx: 1, dy: -1 })

    // The knight reports its exact L-offset. Sign it and every one of these
    // collapses to a diagonal, which is the bug this pins.
    expect(facing(1, "t1#4")).toEqual({ dx: 1, dy: 2 })
    expect(facing(2, "t1#4")).toEqual({ dx: -2, dy: -1 })
    expect(facing(3, "t1#4")).toEqual({ dx: 1, dy: -2 })
    expect(facing(4, "t1#4")).toEqual({ dx: -2, dy: 1 })

    // A unit that holds keeps its facing — the queen from turn 4 (it staged
    // its own square) and all five of team two, all replay long.
    expect(facing(4, "t1")).toEqual({ dx: -1, dy: -1 })
    expect(facing(REPLAY_TURNS, "t1")).toEqual({ dx: -1, dy: -1 })
    Object.keys(START)
      .filter((id) => id.startsWith("t2"))
      .forEach((id) => {
        expect(facing(REPLAY_TURNS, id)).toEqual(START[id].facing)
      })
  })

  it("turns the pawn only by its rotation action, never by where it walked", () => {
    const stream = runReplay()
    const turnOf = (n: number): Turn => stream[n - 1]

    // Turn 1: the rotation. It staged the square to its right, did not enter
    // it, paid no movement cost — and came out facing that way.
    expect(turnOf(1).playerPieces["t1#5"]).toEqual([at(6, 10)])
    expect(turnOf(1).playerHealth["t1#5"]).toBe(100)
    expect(turnOf(1).orientation["t1#5"]).toEqual({ dx: 1, dy: 0 })

    // Turn 2: THE EXCEPTION. It moved diagonally — {1,-1} from (6,10) to
    // (7,9) — and is still facing {1,0}. Every other kind on this board would
    // report the direction it walked; the pawn reports the way it points.
    expect(turnOf(2).paths?.["t1#5"]).toEqual([FIRST_MEAL])
    expect(turnOf(2).orientation["t1#5"]).toEqual({ dx: 1, dy: 0 })

    // Turn 3: it walks straight forward and promotes in the same turn, and
    // still keeps the pawn's facing — the rewrite decided it while the unit
    // was still a pawn.
    expect(turnOf(PROMOTION_TURN).unitTypes?.["t1#5"]).toBe("queen")
    expect(turnOf(PROMOTION_TURN).orientation["t1#5"]).toEqual({ dx: 1, dy: 0 })

    // Turn 4 onward it is a queen, and reports a slider's signed facing.
    expect(turnOf(4).orientation["t1#5"]).toEqual({ dx: -1, dy: -1 })
    expect(turnOf(5).orientation["t1#5"]).toEqual({ dx: 0, dy: 1 })
  })

  it("kills nobody, so every branch above is read off a full board", () => {
    const stream = runReplay()
    stream.forEach((turn) => {
      expect(turn.deaths).toEqual({})
      expect([...turn.alivePlayers].sort()).toEqual(Object.keys(START).sort())
      expect(Object.keys(turn.orientation).sort()).toEqual(Object.keys(START).sort())
    })
  })
})
