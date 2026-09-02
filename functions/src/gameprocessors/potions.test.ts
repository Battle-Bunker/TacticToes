// Golden-master tests for the invulnerability potion mechanics. These pin the
// CURRENT behavior exactly:
//   - potions only spawn/collect when invulnerabilityPotionEnabled is set;
//   - collecting a potion DECREMENTS the collector's level by 1 (a debuff on
//     themselves) and INCREMENTS each alive ally's level by 1 (a buff), all
//     expiring at gameState.turns.length + 3;
//   - effects expire when expiryTurn <= gameState.turns.length, applied AFTER
//     collision resolution — a buff expiring this turn still protects during
//     this turn's collisions;
//   - when a vulnerable (level < 0) snake collides, its allies' buffs are
//     rescheduled to expire at the current turn, i.e. at the end of this
//     applyMoves.

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
import { REASON } from "./engine/turnEngine"

// 7x7 board (index = y * 7 + x) unless a test overrides; perimeter is wall.

const teams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
]

const mkSetup = (
  overrides: Partial<StartedGameSetup> = {}
): StartedGameSetup => ({
  teams,
  snakesPerTeam: 1,
  gamePlayers: expandTeams(teams, overrides.snakesPerTeam ?? 1),
  boardWidth: 7,
  boardHeight: 7,
  maxTurnTime: 5,
  startRequested: false,
  started: true,
  timeCreated: Timestamp.fromMillis(0),
  foodSpawnRate: 0,
  ...overrides,
})

const mkTurn = (
  playerPieces: { [playerID: string]: number[] },
  overrides: Partial<Turn> = {}
): Turn => {
  const ids = Object.keys(playerPieces)
  return {
    playerEnergy: Object.fromEntries(ids.map((id) => [id, 100])),
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
    // Every unit carries an orientation; irrelevant here (every test stages all
    // moves) beyond satisfying the Turn shape.
    orientation: Object.fromEntries(ids.map((id) => [id, { dx: 1, dy: 0 }])),
    ...overrides,
  }
}

// The processor keys effect expiry off gameState.turns.length (the number of
// the turn being produced), so tests control it via the turns array length.
const mkGameState = (setup: StartedGameSetup, turns: Turn[]): GameState => ({
  setup,
  turns,
  walls: [],
  timeCreated: Timestamp.fromMillis(0),
  timeFinished: null,
})

const mv = (playerID: string, move: number): Move => ({
  gameID: "game1",
  moveNumber: 0,
  playerID,
  move,
  timestamp: Timestamp.fromMillis(0),
})

const wallCells = (width: number, height: number): Set<number> => {
  const walls = new Set<number>()
  for (let x = 0; x < width; x++) {
    walls.add(x)
    walls.add((height - 1) * width + x)
  }
  for (let y = 0; y < height; y++) {
    walls.add(y * width)
    walls.add(y * width + (width - 1))
  }
  return walls
}

describe("invulnerability potion spawning", () => {
  it("spawns exactly one potion per turn at spawn rate 1 when enabled, on a free cell", () => {
    const setup = mkSetup({
      invulnerabilityPotionEnabled: true,
      invulnerabilityPotionSpawnRate: 1,
    })
    const turn = mkTurn({ t1: [23, 16, 9], t2: [40, 39, 38] })
    const processor = new TeamSnekProcessor(mkGameState(setup, [turn]))

    const next = processor.applyMoves(turn, [mv("t1", 24), mv("t2", 33)])

    expect(next.invulnerabilityPotions).toHaveLength(1)
    const potion = (next.invulnerabilityPotions ?? [])[0]
    const walls = wallCells(7, 7)
    expect(walls.has(potion)).toBe(false)
    Object.values(next.playerPieces).forEach((snake) => {
      expect(snake).not.toContain(potion)
    })
    expect(next.food).not.toContain(potion)
    expect(next.hazards).not.toContain(potion)
  })

  it("does not spawn or collect potions when the feature is disabled", () => {
    // Spawn rate is set, but the enable flag is not: an existing potion on the
    // board is inert — stepping onto it changes nothing and it stays put.
    const setup = mkSetup({ invulnerabilityPotionSpawnRate: 1 })
    const turn = mkTurn(
      { t1: [23, 16, 9], t2: [40, 39, 38] },
      { invulnerabilityPotions: [24] }
    )
    const processor = new TeamSnekProcessor(mkGameState(setup, [turn]))

    // t1 moves straight onto the potion cell.
    const next = processor.applyMoves(turn, [mv("t1", 24), mv("t2", 33)])

    expect(next.invulnerabilityPotions).toEqual([24])
    expect(next.playerInvulnerabilityLevel).toEqual({ t1: 0, t2: 0 })
    expect(next.activeEffects).toEqual([])
    expect(next.alivePlayers).toEqual(["t1", "t2"])
  })
})

describe("invulnerability potion collection", () => {
  it("debuffs the collector by 1 and buffs each alive ally by 1, expiring 3 turns out", () => {
    // 9x9 board, two snakes per team: t1 collects, ally t1#2 gets the buff.
    const setup = mkSetup({
      snakesPerTeam: 2,
      boardWidth: 9,
      boardHeight: 9,
      invulnerabilityPotionEnabled: true,
      invulnerabilityPotionSpawnRate: 0,
    })
    const turn = mkTurn(
      {
        t1: [10, 11, 12],
        "t1#2": [28, 29, 30],
        t2: [16, 15, 14],
        "t2#2": [34, 33, 32],
      },
      { invulnerabilityPotions: [19] }
    )
    // turns.length = 1, so effects created now expire at turn 1 + 3 = 4.
    const processor = new TeamSnekProcessor(mkGameState(setup, [turn]))

    const next = processor.applyMoves(turn, [
      mv("t1", 19), // onto the potion
      mv("t1#2", 37),
      mv("t2", 25),
      mv("t2#2", 43),
    ])

    expect(next.invulnerabilityPotions).toEqual([])
    expect(next.playerInvulnerabilityLevel).toEqual({
      t1: -1,
      "t1#2": 1,
      t2: 0,
      "t2#2": 0,
    })
    expect(next.activeEffects).toEqual([
      {
        playerID: "t1",
        type: "invulnerability_debuff",
        level: -1,
        expiryTurn: 4,
        sourcePlayerID: "t1",
      },
      {
        playerID: "t1#2",
        type: "invulnerability_buff",
        level: 1,
        expiryTurn: 4,
        sourcePlayerID: "t1",
      },
    ])
    expect(next.alivePlayers).toEqual(["t1", "t1#2", "t2", "t2#2"])
  })
})

describe("invulnerability effect expiry", () => {
  const buff = (overrides: Partial<ActiveEffect> = {}): ActiveEffect => ({
    playerID: "t1",
    type: "invulnerability_buff",
    level: 1,
    expiryTurn: 4,
    sourcePlayerID: "t1",
    ...overrides,
  })

  it("keeps an effect whose expiryTurn is still in the future", () => {
    const turn = mkTurn(
      { t1: [23, 16, 9], t2: [40, 39, 38] },
      {
        playerInvulnerabilityLevel: { t1: 1, t2: 0 },
        activeEffects: [buff({ expiryTurn: 4 })],
      }
    )
    // turns.length = 3 -> producing turn 3; expiry at 4 is not due yet.
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup(), [turn, turn, turn])
    )

    const next = processor.applyMoves(turn, [mv("t1", 24), mv("t2", 33)])

    expect(next.playerInvulnerabilityLevel).toEqual({ t1: 1, t2: 0 })
    expect(next.activeEffects).toEqual([buff({ expiryTurn: 4 })])
  })

  it("expires at turns.length == expiryTurn, AFTER collisions resolve at the buffed level", () => {
    // t1 (level 1, buff expiring this turn) meets equal-length t2 (level 0)
    // head-on: the collision is resolved while t1 is still buffed, so only t2
    // dies — and the produced turn then shows t1 back at level 0 with the
    // effect gone.
    const turn = mkTurn(
      { t1: [23, 16, 9], t2: [25, 26, 19] },
      {
        playerInvulnerabilityLevel: { t1: 1, t2: 0 },
        activeEffects: [buff({ expiryTurn: 4 })],
      }
    )
    // turns.length = 4 -> expiry due exactly now.
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup(), [turn, turn, turn, turn])
    )

    const next = processor.applyMoves(turn, [mv("t1", 24), mv("t2", 24)])

    expect(next.alivePlayers).toEqual(["t1"])
    expect(next.playerPieces).toEqual({ t1: [24, 23, 16] })
    expect(next.clashes.map((c) => c.reason)).toContain(
      REASON.tier
    )
    expect(next.playerInvulnerabilityLevel).toEqual({ t1: 0 })
    expect(next.activeEffects).toEqual([])
    // Sole surviving team wins.
    expect(next.winners.map((w) => w.teamID)).toEqual(["t1"])
  })

  it("expires ally buffs at the end of the turn in which a vulnerable teammate collides", () => {
    // t1 collected a potion earlier: t1 is at level -1 (debuff), ally t1#2 at
    // level 1 (buff), both nominally lasting until turn 3. t1 drives into the
    // wall on turn 1 — a vulnerable collision — so t1#2's buff is rescheduled
    // to expire immediately at the end of this turn.
    const setup = mkSetup({
      snakesPerTeam: 2,
      boardWidth: 9,
      boardHeight: 9,
      invulnerabilityPotionEnabled: true,
      invulnerabilityPotionSpawnRate: 0,
    })
    const turn = mkTurn(
      {
        t1: [10, 11, 12],
        "t1#2": [28, 29, 30],
        t2: [16, 15, 14],
        "t2#2": [34, 33, 32],
      },
      {
        playerInvulnerabilityLevel: { t1: -1, "t1#2": 1, t2: 0, "t2#2": 0 },
        activeEffects: [
          {
            playerID: "t1",
            type: "invulnerability_debuff",
            level: -1,
            expiryTurn: 3,
            sourcePlayerID: "t1",
          },
          buff({ playerID: "t1#2", expiryTurn: 3 }),
        ],
      }
    )
    const processor = new TeamSnekProcessor(mkGameState(setup, [turn]))

    const next = processor.applyMoves(turn, [
      mv("t1", 1), // into the top wall — vulnerable collision
      mv("t1#2", 37),
      mv("t2", 25),
      mv("t2#2", 43),
    ])

    expect(next.alivePlayers).toEqual(["t1#2", "t2", "t2#2"])
    expect(next.playerInvulnerabilityLevel).toEqual({
      "t1#2": 0,
      t2: 0,
      "t2#2": 0,
    })
    expect(next.activeEffects).toEqual([])
  })
})
