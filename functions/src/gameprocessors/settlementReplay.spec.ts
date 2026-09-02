// THE GOLDEN REPLAY — the gate the settlement migration is measured against.
//
// `19-ENGINE-SPEC.md` moves turn settlement out of TeamSnekProcessor and into
// the vendorable engine module, one phase per step, and every step claims to
// change no behaviour. A claim like that is only worth what it is checked
// against, and the unit tests around it check phases one at a time — they
// would not notice a phase ORDER change, which is exactly what moving code
// across the boundary risks.
//
// So this file plays a whole potions-on game, turn by turn, and pins the
// complete produced turn stream as a byte-for-byte fixture. Every wire field
// of every turn is in it: boards, health, deaths, clashes, moves, scores,
// potions, tiers and the effect schedule. Move a phase past another one and
// the fixture disagrees somewhere.
//
// DETERMINISM. The processor calls `Math.random` for food spawning, potion
// spawning and spawn orientation. This replay reaches none of that: it drives
// `applyMoves` from a constructed turn (never `firstTurn`), and both spawn
// rates are zero, so the two `Math.random` calls each turn make it to no
// board state. A seeded LCG is installed over `Math.random` anyway, so the
// replay stays pinned even if a spawn path later starts consuming draws.
//
// THE GAME. A 13x13 board, four snakes, one 4x4 circuit each in its own
// quadrant so movement never crosses. Twelve cells to a circuit, so a head
// visits any given cell of it at most once in the ten replayed turns — which
// is what lets a potion be placed on a cell knowing the exact turn it is
// collected. The turn 0 wire is seeded with effects and potions arranged to
// fire every mechanic the migration moves:
//
//   turn 2  a vulnerable (tier < 0) snake drives into a wall, cancelling its
//           team's ally buffs, which then expire in the same turn;
//   turn 6  a plain effect reaches its expiry turn;
//   turn 8  a potion is collected on the same turn one of the collector's own
//           effects expires — the interleaving that E1 reorders and E2 puts
//           back, and the one place a commuting argument could be wrong;
//   turn 9  a potion is collected by a snake that still has a living ally, so
//           the collector's debuff and the ally's buff are both written.
//
// Both collections happen late enough that neither window — 3 or 8 — has
// lapsed when the replay ends, so the same replay run at `potionWindowTurns:
// 8` differs from the run at 3 in the effects' `expiryTurn` values and in
// nothing else at all.

import { readFileSync, writeFileSync } from "fs"
import { join } from "path"
import { Timestamp } from "firebase-admin/firestore"
import {
  ActiveEffect,
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
} from "@shared/types/Game"
import { expandTeams } from "../utils/expandTeams"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

// ── the board ──────────────────────────────────────────────────────────────

/** 13x13, index = y * 13 + x, perimeter wall, interior 1..11. */
const W = 13
const at = (x: number, y: number): number => y * W + x

/** A 4x4 circuit, clockwise from its top-left corner: twelve cells. */
const RING: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0],
  [3, 1], [3, 2], [3, 3],
  [2, 3], [1, 3], [0, 3],
  [0, 2], [0, 1],
]

type Block = readonly [number, number]

/** The cell a snake on `block` has its head on after `turn` steps. */
const ringCell = (block: Block, turn: number): number => {
  const [ox, oy] = RING[((turn % RING.length) + RING.length) % RING.length]
  return at(block[0] + ox, block[1] + oy)
}

/** One quadrant per unit; the quadrants share no cell and touch nowhere. */
const BLOCKS: { [playerID: string]: Block } = {
  t1: [1, 1],
  "t1#2": [6, 1],
  t2: [1, 6],
  "t2#2": [6, 6],
}

/** Head, then the two cells behind it on the circuit. */
const startOccupancy = (block: Block): number[] => [
  ringCell(block, 0),
  ringCell(block, -1),
  ringCell(block, -2),
]

// ── the script ─────────────────────────────────────────────────────────────

const REPLAY_TURNS = 10

/** t1 is vulnerable and drives into the top wall on this turn. */
const WALL_CRASH_TURN = 2
const WALL_CELL = at(2, 0)

/** Circuit cells t1#2 and t2#2 first reach on turns 8 and 9 respectively. */
const POTION_COLLECTED_AT_8 = ringCell(BLOCKS["t1#2"], 8)
const POTION_COLLECTED_AT_9 = ringCell(BLOCKS["t2#2"], 9)

const moveFor = (playerID: string, turn: number): number =>
  playerID === "t1" && turn === WALL_CRASH_TURN
    ? WALL_CELL
    : ringCell(BLOCKS[playerID], turn)

// ── the fixtures the replay starts from ────────────────────────────────────

const teams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
]

const mkSetup = (overrides: Partial<StartedGameSetup> = {}): StartedGameSetup => ({
  teams,
  snakesPerTeam: 2,
  gamePlayers: expandTeams(teams, 2),
  boardWidth: W,
  boardHeight: W,
  maxTurnTime: 5,
  startRequested: false,
  started: true,
  timeCreated: Timestamp.fromMillis(0),
  // Both spawners off: the replay's food and potions are the ones on the wire.
  foodSpawnRate: 0,
  invulnerabilityPotionEnabled: true,
  invulnerabilityPotionSpawnRate: 0,
  ...overrides,
})

/**
 * The effect schedule the replay starts on. Between them these reach every
 * branch the migration moves: a debuff whose owner dies (dropped with the
 * unit), a buff that the vulnerable collision cancels, a debuff that expires
 * on the same turn its owner collects a potion, and a plain mid-replay expiry.
 */
const startingEffects = (): ActiveEffect[] => [
  { playerID: "t1", type: "invulnerability_debuff", level: -1, expiryTurn: 5, sourcePlayerID: "t1" },
  { playerID: "t1#2", type: "invulnerability_buff", level: 1, expiryTurn: 5, sourcePlayerID: "t1" },
  { playerID: "t1#2", type: "invulnerability_debuff", level: -1, expiryTurn: 8, sourcePlayerID: "t1#2" },
  { playerID: "t2", type: "invulnerability_buff", level: 1, expiryTurn: 6, sourcePlayerID: "t2#2" },
]

const startingTurn = (): Turn => {
  const playerPieces: { [playerID: string]: number[] } = {}
  Object.keys(BLOCKS).forEach((id) => {
    playerPieces[id] = startOccupancy(BLOCKS[id])
  })
  const ids = Object.keys(playerPieces)
  return {
    playerHealth: Object.fromEntries(ids.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(ids.map((id) => [id, playerPieces[id].length])),
    alivePlayers: ids,
    food: [],
    hazards: [],
    playerPieces,
    clashes: [],
    deaths: {},
    moves: {},
    winners: [],
    orientation: Object.fromEntries(ids.map((id) => [id, { dx: 0, dy: -1 }])),
    invulnerabilityPotions: [POTION_COLLECTED_AT_8, POTION_COLLECTED_AT_9],
    playerInvulnerabilityLevel: { t1: -1, "t1#2": 0, t2: 1, "t2#2": 0 },
    activeEffects: startingEffects(),
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

const REPLAY_SEED = 0x5eed1a5

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
      const processor = new TeamSnekProcessor(mkGameState(setup, turns))
      const moves = current.alivePlayers.map((id) => mv(id, moveFor(id, turn)))
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
 * the clash stream and the effect schedule are both ordered — and is kept.
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

const GOLDEN = join(__dirname, "settlementReplay.golden.json")

/** Set UPDATE_GOLDEN=1 to re-record. Only ever legitimate before a move. */
const check = (actual: string, path: string): void => {
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, actual)
  expect(actual).toBe(readFileSync(path, "utf8"))
}

describe("golden settlement replay", () => {
  it("replays a potions-on game turn by turn, byte for byte", () => {
    check(serialise(runReplay()), GOLDEN)
  })

  it("fires every mechanic the migration moves, so the fixture is not vacuous", () => {
    const stream = runReplay()
    const turnOf = (n: number): Turn => stream[n - 1]

    // The vulnerable wall death, and the ally buff it cancels, both landing in
    // the same turn: t1 is gone and t1#2 keeps only its own debuff.
    expect(turnOf(WALL_CRASH_TURN).alivePlayers).not.toContain("t1")
    expect(turnOf(WALL_CRASH_TURN).deaths.t1.cause).toBe("wall")
    expect(turnOf(WALL_CRASH_TURN).activeEffects).toEqual([
      { playerID: "t1#2", type: "invulnerability_debuff", level: -1, expiryTurn: 8, sourcePlayerID: "t1#2" },
      { playerID: "t2", type: "invulnerability_buff", level: 1, expiryTurn: 6, sourcePlayerID: "t2#2" },
    ])
    expect(turnOf(WALL_CRASH_TURN).playerInvulnerabilityLevel).toEqual({
      "t1#2": -1,
      t2: 1,
      "t2#2": 0,
    })

    // A plain expiry mid-replay: t2's buff lapses and its tier comes home.
    expect(turnOf(5).playerInvulnerabilityLevel?.t2).toBe(1)
    expect(turnOf(6).playerInvulnerabilityLevel?.t2).toBe(0)
    expect(turnOf(6).activeEffects?.some((e) => e.playerID === "t2")).toBe(false)

    // Turn 8: a collection and an expiry on the same unit in the same turn.
    // Net tier: -1 held, +1 back from the lapsed debuff, -1 for the pickup.
    expect(turnOf(7).invulnerabilityPotions).toContain(POTION_COLLECTED_AT_8)
    expect(turnOf(8).invulnerabilityPotions).not.toContain(POTION_COLLECTED_AT_8)
    expect(turnOf(8).playerInvulnerabilityLevel?.["t1#2"]).toBe(-1)
    expect(turnOf(8).activeEffects).toEqual([
      { playerID: "t1#2", type: "invulnerability_debuff", level: -1, expiryTurn: 11, sourcePlayerID: "t1#2" },
    ])

    // Turn 9: a collector that still has a living ally, so both halves of the
    // pickup rule are written — the collector's debuff and the ally's buff.
    expect(turnOf(9).invulnerabilityPotions).toEqual([])
    expect(turnOf(9).playerInvulnerabilityLevel).toEqual({
      "t1#2": -1,
      t2: 1,
      "t2#2": -1,
    })

    // Nothing collected reaches its expiry before the replay ends, which is
    // what makes the window sweep a difference in expiry turns and nothing else.
    expect(
      (turnOf(REPLAY_TURNS).activeEffects ?? []).every((e) => e.expiryTurn > REPLAY_TURNS),
    ).toBe(true)
  })
})
