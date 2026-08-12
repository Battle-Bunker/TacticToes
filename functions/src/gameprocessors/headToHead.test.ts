import { Timestamp } from "firebase-admin/firestore"
import {
  GameState,
  Move,
  StartedGameSetup,
  Team,
  Turn,
} from "@shared/types/Game"
import { expandTeams } from "../utils/expandTeams"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

// 7x7 board: index = y * 7 + x, perimeter is wall. Collision cell is 24.

const twoTeams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
]

const threeTeams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#00ff00" },
  { id: "t3", name: "Team Three", color: "#0000ff" },
]

const mkSetup = (
  teams: Team[],
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
    playerHealth: Object.fromEntries(ids.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(ids.map((id) => [id, playerPieces[id].length])),
    alivePlayers: ids,
    food: [],
    hazards: [],
    playerPieces,
    allowedMoves: {},
    walls: [],
    clashes: [],
    moves: {},
    winners: [],
    ...overrides,
  }
}

const mkGameState = (setup: StartedGameSetup, turn: Turn): GameState => ({
  setup,
  turns: [turn],
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

const occupantsOf = (turn: Turn, cell: number): string[] =>
  Object.entries(turn.playerPieces)
    .filter(([, body]) => body.includes(cell))
    .map(([id]) => id)

describe("head-to-head collision resolution", () => {
  // Three snakes converging on cell 24:
  // t1 [23,16,9] (len 3, from the left), t2 [25,26,19,12] (len 4, from the
  // right), t3 [31,38,37,36,29] (len 5, from below).

  it("(a) three snakes of distinct lengths: only the unique longest survives", () => {
    const turn = mkTurn({
      t1: [23, 16, 9],
      t2: [25, 26, 19, 12],
      t3: [31, 38, 37, 36, 29],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(threeTeams), turn))

    const next = processor.applyMoves(turn, [
      mv("t1", 24),
      mv("t2", 24),
      mv("t3", 24),
    ])

    expect(next.alivePlayers).toEqual(["t3"])
    expect(next.playerPieces).toEqual({ t3: [24, 31, 38, 37, 36] })
    expect(occupantsOf(next, 24)).toEqual(["t3"])
    const deathReasons = next.clashes.map((c) => c.reason)
    expect(deathReasons).toContain("Head-on collision (shortest snake(s) died)")
  })

  it("(a2) three snakes with a tie for longest: all die", () => {
    const turn = mkTurn({
      t1: [23, 16, 9],
      t2: [25, 26, 19, 12, 11],
      t3: [31, 38, 37, 36, 29],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(threeTeams), turn))

    const next = processor.applyMoves(turn, [
      mv("t1", 24),
      mv("t2", 24),
      mv("t3", 24),
    ])

    expect(next.alivePlayers).toEqual([])
    expect(next.playerPieces).toEqual({})
  })

  it("(b) only the longest snake holds an invulnerability potion: it survives", () => {
    const turn = mkTurn(
      {
        t1: [23, 16, 9],
        t2: [25, 26, 19, 12],
        t3: [31, 38, 37, 36, 29],
      },
      { playerInvulnerabilityLevel: { t1: 0, t2: 0, t3: 1 } }
    )
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(threeTeams), turn))

    const next = processor.applyMoves(turn, [
      mv("t1", 24),
      mv("t2", 24),
      mv("t3", 24),
    ])

    expect(next.alivePlayers).toEqual(["t3"])
    expect(next.playerPieces).toEqual({ t3: [24, 31, 38, 37, 36] })
    expect(occupantsOf(next, 24)).toEqual(["t3"])
    const deathReasons = next.clashes.map((c) => c.reason)
    expect(deathReasons).toContain(
      "Head-on collision (lower invulnerability level died)"
    )
  })

  it("(b2) all snakes at the same elevated tier: only the unique longest survives", () => {
    const turn = mkTurn(
      {
        t1: [23, 16, 9],
        t2: [25, 26, 19, 12],
        t3: [31, 38, 37, 36, 29],
      },
      { playerInvulnerabilityLevel: { t1: 1, t2: 1, t3: 1 } }
    )
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(threeTeams), turn))

    const next = processor.applyMoves(turn, [
      mv("t1", 24),
      mv("t2", 24),
      mv("t3", 24),
    ])

    expect(next.alivePlayers).toEqual(["t3"])
    expect(next.playerPieces).toEqual({ t3: [24, 31, 38, 37, 36] })
    expect(occupantsOf(next, 24)).toEqual(["t3"])
    const deathReasons = next.clashes.map((c) => c.reason)
    expect(deathReasons).toContain("Head-on collision (shortest snake(s) died)")
  })

  it("(c) two equal-length snakes head-on: both die", () => {
    const turn = mkTurn({
      t1: [23, 16, 9],
      t2: [25, 26, 19],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(twoTeams), turn))

    const next = processor.applyMoves(turn, [mv("t1", 24), mv("t2", 24)])

    expect(next.alivePlayers).toEqual([])
    expect(next.playerPieces).toEqual({})
  })

  it("(d) moving into the vacated tail cell with food there: survives and eats", () => {
    const turn = mkTurn(
      {
        t1: [9, 8, 15, 16],
        t2: [40, 39, 38],
      },
      { food: [16] }
    )
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(twoTeams), turn))

    const next = processor.applyMoves(turn, [mv("t1", 16), mv("t2", 33)])

    expect(next.alivePlayers).toEqual(["t1", "t2"])
    expect(next.playerPieces.t1).toEqual([16, 9, 8, 15, 15])
    expect(next.playerHealth.t1).toBe(100)
    expect(next.food).toEqual([])
  })

  it("(d2) moving into a stacked tail cell: dies from self collision", () => {
    const turn = mkTurn({
      t1: [9, 8, 15, 16, 16],
      t2: [40, 39, 38],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(twoTeams), turn))

    const next = processor.applyMoves(turn, [mv("t1", 16), mv("t2", 33)])

    expect(next.alivePlayers).toEqual(["t2"])
    expect(next.playerPieces.t1).toBeUndefined()
    const t1Clashes = next.clashes.filter((c) => c.playerIDs.includes("t1"))
    expect(t1Clashes.length).toBeGreaterThan(0)
    t1Clashes.forEach((c) => {
      expect(c.reason).toBe("Collided with own body")
    })
  })
})
