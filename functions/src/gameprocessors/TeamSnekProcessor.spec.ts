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

const teams: Team[] = [
  { id: "t1", name: "Team One", color: "#ff0000" },
  { id: "t2", name: "Team Two", color: "#0000ff" },
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
  const playerIDs = Object.keys(playerPieces)
  return {
    playerHealth: Object.fromEntries(playerIDs.map((id) => [id, 100])),
    startTime: Timestamp.fromMillis(0),
    endTime: Timestamp.fromMillis(5000),
    scores: Object.fromEntries(
      playerIDs.map((id) => [id, playerPieces[id].length])
    ),
    alivePlayers: playerIDs,
    food: [],
    hazards: [],
    playerPieces,
    clashes: [],
    moves: {},
    winners: [],
    ...overrides,
  }
}

const mkGameState = (setup: StartedGameSetup, turn: Turn): GameState => ({
  setup,
  turns: [turn],
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

describe("expandTeams", () => {
  it("generates one snake per team slot with derived ids and letters", () => {
    const result = expandTeams(teams, 3)
    expect(result).toEqual([
      { id: "t1", teamID: "t1", letter: "A" },
      { id: "t1#2", teamID: "t1", letter: "B" },
      { id: "t1#3", teamID: "t1", letter: "C" },
      { id: "t2", teamID: "t2", letter: "A" },
      { id: "t2#2", teamID: "t2", letter: "B" },
      { id: "t2#3", teamID: "t2", letter: "C" },
    ])
  })

  it("expands no teams to no snakes", () => {
    expect(expandTeams([], 3)).toEqual([])
  })
})

describe("TeamSnekProcessor win conditions", () => {
  // 7x7 board: index = y * 7 + x, perimeter is wall.

  it("declares the last team standing the winner", () => {
    const turn = mkTurn({
      t1: [24, 23, 22],
      t2: [8, 9, 10],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    // t2 drives into the top wall; t1 moves into open space.
    const next = processor.applyMoves(turn, [mv("t1", 25), mv("t2", 1)])

    expect(next.winners).toEqual([
      {
        playerID: "t1",
        score: 3,
        winningSquares: [25, 24, 23],
        teamID: "t1",
        teamScore: 3,
      },
    ])
    expect(next.alivePlayers).toEqual(["t1"])
  })

  it("declares the highest-scoring team the winner at the turn limit", () => {
    const turn = mkTurn(
      {
        t1: [24, 23, 22],
        t2: [8, 9, 10],
      },
      { food: [25] }
    )
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup({ maxTurns: 1 }), turn)
    )

    // t1 eats and grows to 4; t2 survives at length 3.
    const next = processor.applyMoves(turn, [mv("t1", 25), mv("t2", 15)])

    expect(next.winners).toEqual([
      {
        playerID: "t1",
        score: 4,
        winningSquares: [25, 24, 23, 23],
        teamID: "t1",
        teamScore: 4,
      },
    ])
  })

  it("declares a draw between tied teams at the turn limit", () => {
    const turn = mkTurn({
      t1: [24, 23, 22],
      t2: [8, 9, 10],
    })
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup({ maxTurns: 1 }), turn)
    )

    const next = processor.applyMoves(turn, [mv("t1", 25), mv("t2", 15)])

    expect(next.winners).toHaveLength(2)
    const byTeam = Object.fromEntries(next.winners.map((w) => [w.teamID, w]))
    expect(byTeam.t1.teamScore).toBe(3)
    expect(byTeam.t2.teamScore).toBe(3)
  })

  it("falls back to the previous turn's outcome when every team dies at once", () => {
    const turn = mkTurn({
      t1: [24, 23, 22, 22],
      t2: [8, 9, 10],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    // t1 bites its own body; t2 drives into the top wall.
    const next = processor.applyMoves(turn, [mv("t1", 23), mv("t2", 1)])

    expect(next.alivePlayers).toEqual([])
    expect(next.winners).toEqual([
      {
        playerID: "t1",
        score: 4,
        winningSquares: [24, 23, 22, 22],
        teamID: "t1",
        teamScore: 4,
      },
    ])
  })
})

describe("TeamSnekProcessor default moves (nothing staged at resolution)", () => {
  // 7x7 board: index = y * 7 + x, perimeter (x=0|6, y=0|6) is wall.
  const W = 7
  const walls = new Set<number>()
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 7; x++) {
      if (x === 0 || x === 6 || y === 0 || y === 6) walls.add(y * W + x)
    }
  }
  const adjacent = (i: number) =>
    [i - W, i + W, i - 1, i + 1].filter((n) => n >= 0 && n < 49)

  it("moves a stacked-spawn snake to a legal adjacent cell instead of its own square", () => {
    // Both snakes are freshly spawned ([p, p, p]) with no movement history.
    // The engine default must NOT derive a {dx:0, dy:0} "direction" (which
    // targets the snake's own square and self-collides); it must pick an
    // adjacent non-wall, unoccupied cell so both survive turn 0.
    const spawns = { t1: 24, t2: 10 }
    const turn = mkTurn({
      t1: [24, 24, 24],
      t2: [10, 10, 10],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    const next = processor.applyMoves(turn, [])

    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.clashes).toEqual([])
    for (const [id, spawn] of Object.entries(spawns)) {
      const head = next.playerPieces[id][0]
      expect(head).not.toBe(spawn) // not its own square
      expect(adjacent(spawn)).toContain(head) // a single legal step
      expect(walls.has(head)).toBe(false) // not into a wall
      expect(next.playerPieces[id]).toEqual([head, spawn, spawn])
      expect(next.moves[id]).toBe(head)
    }
  })

  it("keeps continuing straight for snakes with movement history", () => {
    // Both snakes are travelling +x; with nothing staged they must keep doing
    // exactly that (pre-existing default-move behavior, unchanged).
    const turn = mkTurn({
      t1: [24, 23, 22],
      t2: [10, 9, 8],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    const next = processor.applyMoves(turn, [])

    expect(next.playerPieces.t1).toEqual([25, 24, 23])
    expect(next.playerPieces.t2).toEqual([11, 10, 9])
    expect(next.moves).toEqual({ t1: 25, t2: 11 })
    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.clashes).toEqual([])
  })

  it("resolves a fully-boxed stacked snake by stepping into a neighbor, not itself", () => {
    // t2 spawns stacked in the corner pocket at 8 (x=1, y=1): up (1) and left
    // (7) are walls, and t1's body covers down (15) and right (9) before AND
    // after t1's own move. With no open cell the fallback takes the first
    // non-wall neighbor (15), so t2 dies to t1's body there — a real
    // collision, never a self-collision on its own square.
    const turn = mkTurn({
      t1: [11, 10, 9, 16, 15, 22],
      t2: [8, 8, 8],
    })
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    const next = processor.applyMoves(turn, [])

    expect(next.moves.t2).toBe(15) // first non-wall neighbor, not 8 (own square)
    expect(next.playerPieces.t1).toEqual([12, 11, 10, 9, 16, 15]) // continued straight
    expect(next.alivePlayers).toEqual(["t1"])
    const t2Reasons = next.clashes
      .filter((c) => c.playerIDs.includes("t2"))
      .map((c) => c.reason)
    expect(t2Reasons.length).toBeGreaterThan(0)
    t2Reasons.forEach((reason) =>
      expect(reason).toBe("Collided with another snake's body")
    )
  })
})

describe("TeamSnekProcessor per-turn scoring", () => {
  it("writes team scores and individual scores", () => {
    // 9x9 board: index = y * 9 + x.
    const setup = mkSetup({
      snakesPerTeam: 2,
      boardWidth: 9,
      boardHeight: 9,
    })
    const turn = mkTurn(
      {
        t1: [10, 11, 12],
        "t1#2": [28, 29, 30],
        t2: [16, 15, 14],
        "t2#2": [34, 33, 32],
      },
      { food: [19] }
    )
    const processor = new TeamSnekProcessor(mkGameState(setup, turn))

    const next = processor.applyMoves(turn, [
      mv("t1", 19),
      mv("t1#2", 37),
      mv("t2", 25),
      mv("t2#2", 43),
    ])

    expect(next.winners).toEqual([])
    expect(next.scores).toEqual({ t1: 4, "t1#2": 3, t2: 3, "t2#2": 3 })
    expect(next.teamScores).toEqual({ t1: 7, t2: 6 })
  })
})
