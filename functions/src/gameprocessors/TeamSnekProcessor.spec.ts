import { expandTeams } from "../utils/expandTeams"
import { DEFAULT_MAX_TURNS, TeamSnekProcessor } from "./TeamSnekProcessor"
import { REASON } from "./engine/turnEngine"
import { DEFAULT_TEAMS as teams, mkGameState, mkSetup, mkTurn, mv } from "./playTurn"

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

  it("declares the highest-scoring team the winner at the DEFAULT turn limit", () => {
    // No maxTurns in the setup at all: the engine plays it to its default
    // limit, and the game is adjudicated on arrival there like any other.
    const turn = mkTurn(
      {
        t1: [24, 23, 22],
        t2: [8, 9, 10],
      },
      { food: [25] }
    )
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup(), turn, DEFAULT_MAX_TURNS)
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

  it("plays on one turn short of the default limit", () => {
    const turn = mkTurn(
      {
        t1: [24, 23, 22],
        t2: [8, 9, 10],
      },
      { food: [25] }
    )
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup(), turn, DEFAULT_MAX_TURNS - 1)
    )

    const next = processor.applyMoves(turn, [mv("t1", 25), mv("t2", 15)])

    expect(next.winners).toEqual([])
  })

  it("settles a mutual wipe at the default limit on the previous turn's weights", () => {
    const turn = mkTurn({
      t1: [24, 23, 22, 22],
      t2: [8, 9, 10],
    })
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup(), turn, DEFAULT_MAX_TURNS)
    )

    // Both teams die on the limit turn: t1 bites its own body, t2 drives into
    // the top wall. The outcome comes off the previous turn's board, where t1
    // carried the greater weight.
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

  it("runs past the default limit only when the setup opts out with null", () => {
    const turn = mkTurn(
      {
        t1: [24, 23, 22],
        t2: [8, 9, 10],
      },
      { food: [25] }
    )
    const processor = new TeamSnekProcessor(
      mkGameState(mkSetup({ maxTurns: null }), turn, DEFAULT_MAX_TURNS * 2)
    )

    const next = processor.applyMoves(turn, [mv("t1", 25), mv("t2", 15)])

    expect(next.winners).toEqual([])
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

  it("steps a stacked-spawn snake one square along its orientation", () => {
    // Both snakes are freshly spawned ([p, p, p]); the default move is one
    // step along the orientation, which turn 0 stamps toward the centre.
    const turn = mkTurn(
      {
        t1: [24, 24, 24],
        t2: [10, 10, 10],
      },
      { orientation: { t1: { dx: 1, dy: 0 }, t2: { dx: 0, dy: 1 } } }
    )
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    const next = processor.applyMoves(turn, [])

    expect(next.playerPieces.t1).toEqual([25, 24, 24])
    expect(next.playerPieces.t2).toEqual([17, 10, 10])
    expect(next.moves).toEqual({ t1: 25, t2: 17 })
    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.clashes).toEqual([])
  })

  it("continues straight for snakes with movement history", () => {
    // Both snakes face +x (the direction they last moved); with nothing
    // staged each steps one square along that orientation.
    const turn = mkTurn(
      {
        t1: [24, 23, 22],
        t2: [10, 9, 8],
      },
      { orientation: { t1: { dx: 1, dy: 0 }, t2: { dx: 1, dy: 0 } } }
    )
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    const next = processor.applyMoves(turn, [])

    expect(next.playerPieces.t1).toEqual([25, 24, 23])
    expect(next.playerPieces.t2).toEqual([11, 10, 9])
    expect(next.moves).toEqual({ t1: 25, t2: 11 })
    expect(next.alivePlayers.sort()).toEqual(["t1", "t2"])
    expect(next.clashes).toEqual([])
  })

  it("steps along the orientation even into a fatal square — the default never re-routes", () => {
    // t2 is stacked at 8 (x=1, y=1) oriented +x, straight at t1's body on 9.
    // The default is exactly one step along the orientation, so t2 walks into
    // the body and dies there.
    const turn = mkTurn(
      {
        t1: [11, 10, 9, 16, 15, 22],
        t2: [8, 8, 8],
      },
      { orientation: { t1: { dx: 1, dy: 0 }, t2: { dx: 1, dy: 0 } } }
    )
    const processor = new TeamSnekProcessor(mkGameState(mkSetup(), turn))

    const next = processor.applyMoves(turn, [])

    expect(next.moves.t2).toBe(9) // one step along the orientation, nothing else
    expect(next.playerPieces.t1).toEqual([12, 11, 10, 9, 16, 15]) // continued straight
    expect(next.alivePlayers).toEqual(["t1"])
    const t2Reasons = next.clashes
      .filter((c) => c.playerIDs.includes("t2"))
      .map((c) => c.reason)
    expect(t2Reasons.length).toBeGreaterThan(0)
    t2Reasons.forEach((reason) =>
      expect(reason).toBe(REASON.bodyBlock)
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
