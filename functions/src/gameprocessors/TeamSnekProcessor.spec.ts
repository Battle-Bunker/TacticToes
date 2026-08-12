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
