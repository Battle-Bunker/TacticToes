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
// to the single square it stands on, and its energy is clamped from the
// pawn's max of 100 to the queen's of 40. It is a queen for turns 4 and 5,
// which is how the fixture knows promotion happened at all — the two staged
// slides are legal for a queen and illegal for a pawn, so a pawn would have
// held on both.
//
// Promotion lands on the same turn as an orientation rewrite, which is the
// interleaving worth pinning: the rewrite runs FIRST, so a pawn that promotes
// this turn is still a pawn when its facing is decided and keeps it.
//
// THE SECOND RUN. Promotion is also the one settlement phase the processor
// runs AFTER the food and potion spawners, which read weight. So the same
// game is replayed a second time with a food spawning every turn, and pinned
// to its own fixture, which makes the interaction between promotion and the
// spawners checkable rather than argued.

import { join } from "path"
import { Timestamp } from "firebase-admin/firestore"
import { StartedGameSetup, Team, Turn, UnitCounts, UnitType } from "@shared/types/Game"
import { expandTeams } from "../utils/expandTeams"
import { Orientation } from "./engine/moveGrammar"
import { check, mv, runReplay as runReplayScript, serialise } from "./goldenReplay"
import { mkSetup as sharedMkSetup } from "./playTurn"

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

/** Energy caps: the pawn tops up to 100, the queen it becomes may hold 40. */
const PAWN_MAX_ENERGY = 100
const QUEEN_MAX_ENERGY = 40

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

const mkSetup = (overrides: Partial<StartedGameSetup> = {}): StartedGameSetup =>
  sharedMkSetup({
    teams,
    snakesPerTeam: 0,
    unitsPerTeam: UNITS_PER_TEAM,
    gamePlayers: expandTeams(teams, 0, UNITS_PER_TEAM),
    boardWidth: W,
    boardHeight: W,
    pawnPromotionWeight: PROMOTION_WEIGHT,
    maxEnergyPerUnit: { pawn: PAWN_MAX_ENERGY, queen: QUEEN_MAX_ENERGY },
    // The food on the board is the food on the wire; potions are off entirely.
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
    playerEnergy: Object.fromEntries(ids.map((id) => [id, 100])),
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

// ── the replay ─────────────────────────────────────────────────────────────

const REPLAY_SEED = 0x9e3779b

/** Plays REPLAY_TURNS turns and returns every turn the processor produced. */
const runReplay = (setupOverrides: Partial<StartedGameSetup> = {}): Turn[] =>
  runReplayScript({
    setup: mkSetup(setupOverrides),
    startingTurn: startingTurn(),
    moves: (turn, alive) => {
      const staged = SCRIPT[turn - 1]
      return alive.filter((id) => staged[id] !== undefined).map((id) => mv(id, staged[id]))
    },
    turns: REPLAY_TURNS,
    seed: REPLAY_SEED,
  })

const GOLDEN = join(__dirname, "pieceReplay.golden.json")
const GOLDEN_SPAWNER_ON = join(__dirname, "pieceReplay.spawner.golden.json")

/**
 * One food per turn, spawned on a free cell the seeded LCG picks. Exactly
 * one: the rate's integer part is 1 and its fraction is 0, so the count is
 * not itself a draw.
 */
const SPAWNER_ON: Partial<StartedGameSetup> = { foodSpawnRate: 1 }

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
    expect(turnOf(1).playerEnergy["t1#5"]).toBe(100)
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

  it("promotes the pawn at the threshold: weight 1, queen energy, still alive", () => {
    const stream = runReplay()
    const turnOf = (n: number): Turn => stream[n - 1]

    // It eats its way up to the threshold, one square at a time. A piece's
    // occupancy is a STACK on one square, so weight is the array's length and
    // every entry is the same cell.
    expect(turnOf(1).playerPieces["t1#5"]).toEqual([at(6, 10)])
    expect(turnOf(2).playerPieces["t1#5"]).toEqual([FIRST_MEAL, FIRST_MEAL])
    expect(turnOf(2).unitTypes?.["t1#5"]).toBe("pawn")

    // Turn 3 is the meal that reaches PROMOTION_WEIGHT. The stack collapses
    // to the single square it stands on — weight 1, never 0, so the unit is
    // not eliminated by promoting; only its score drops.
    expect(turnOf(PROMOTION_TURN).playerPieces["t1#5"]).toEqual([SECOND_MEAL])
    expect(turnOf(PROMOTION_TURN).scores["t1#5"]).toBe(1)
    expect(turnOf(PROMOTION_TURN).alivePlayers).toContain("t1#5")
    expect(turnOf(PROMOTION_TURN).deaths["t1#5"]).toBeUndefined()

    // Energy: the meal topped it up to the PAWN's max, and promotion then
    // clamped it to the QUEEN's. Nothing else in the game touches energy but
    // movement cost, so the clamp is the only way to read 40 here.
    expect(turnOf(2).playerEnergy["t1#5"]).toBe(PAWN_MAX_ENERGY)
    expect(turnOf(PROMOTION_TURN).playerEnergy["t1#5"]).toBe(QUEEN_MAX_ENERGY)

    // And it goes on playing as a queen: two rays a pawn could not have
    // staged, so a fixture where promotion silently stopped happening would
    // show the unit standing still instead.
    expect(turnOf(4).playerPieces["t1#5"]).toEqual([at(6, 7)])
    expect(turnOf(5).playerPieces["t1#5"]).toEqual([at(6, 10)])
    expect(turnOf(5).playerEnergy["t1#5"]).toBe(QUEEN_MAX_ENERGY - 5)
  })

  it("plays the same game with the food spawner running", () => {
    // Promotion is the one settlement phase the processor still runs AFTER
    // spawning, and it is about to move inside settlement — ahead of both
    // spawners. What makes that safe is what a piece's occupancy IS: N copies
    // of the one square it stands on, never a body. Collapsing a weight-3
    // pawn to weight 1 therefore frees no cell, and the free-cell set the
    // spawner draws from is the same set on either side of the phase.
    //
    // Claiming that is cheap; pinning it is not. This run has a food spawning
    // every turn, its cell drawn from that set with the replay's own seed, so
    // if the claim were wrong the promotion turn's spawn would land on a
    // different square and every turn after it would diverge.
    const stream = runReplay(SPAWNER_ON)
    const promotedStack = stream[PROMOTION_TURN - 1].playerPieces["t1#5"]
    expect(new Set(promotedStack).size).toBe(1)
    check(serialise(stream), GOLDEN_SPAWNER_ON)
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
