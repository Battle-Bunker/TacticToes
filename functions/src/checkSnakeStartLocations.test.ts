import { GameState } from "@shared/types/Game"
import { TeamSnekProcessor } from "./gameprocessors/TeamSnekProcessor"
import { mkGameState, mkSetup } from "./gameprocessors/playTurn"
import { assignCellsToSlices } from "./utils/radialSlices"

// Mock Timestamp.now() to return a consistent value
jest.mock("firebase/firestore", () => ({
  Timestamp: {
    now: jest.fn(() => ({ seconds: 1234567890, nanoseconds: 0 })),
    fromMillis: jest.fn((ms: number) => ({
      seconds: Math.floor(ms / 1000),
      nanoseconds: 0,
      toMillis: () => ms,
    })),
  },
}))

describe("snake start locations", () => {
  function createGameState(
    width: number,
    height: number,
    playerCount: number,
  ): GameState {
    const teams = Array.from({ length: playerCount }, (_, i) => ({
      id: `p${i + 1}`,
      name: `Team ${i + 1}`,
      color: "#ff0000",
    }))
    return mkGameState(
      mkSetup({ teams, boardWidth: width, boardHeight: height, maxTurnTime: 10 }),
      [],
    )
  }

  function createTeamGameState(
    width: number,
    height: number,
    teamCount: number,
    snakesPerTeam: number,
  ): GameState {
    const teams = Array.from({ length: teamCount }, (_, i) => ({
      id: `t${i + 1}`,
      name: `Team ${i + 1}`,
      color: `#00${i + 1}0${i + 1}0`,
    }))
    return mkGameState(
      mkSetup({
        teams,
        snakesPerTeam,
        boardWidth: width,
        boardHeight: height,
        maxTurnTime: 10,
        teamClustersEnabled: true,
      }),
      [],
    )
  }

  function getManhattanDistance(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }

  function getPositionMap(
    gameState: GameState,
    initializedGame: ReturnType<TeamSnekProcessor["firstTurn"]>,
  ): Map<string, { x: number; y: number }> {
    const positions = new Map<string, { x: number; y: number }>()
    gameState.setup.gamePlayers.forEach((player) => {
      const headIndex = initializedGame.playerPieces[player.id]?.[0]
      if (headIndex === undefined) return
      const x = headIndex % gameState.setup.boardWidth
      const y = Math.floor(headIndex / gameState.setup.boardWidth)
      positions.set(player.id, { x, y })
    })
    return positions
  }

  test("initializes game with correct board size", () => {
    const gameState = createGameState(7, 7, 4)
    const game = new TeamSnekProcessor(gameState)
    const initializedGame = game.firstTurn()
    const positions = getPositionMap(gameState, initializedGame)
    positions.forEach((pos) => {
      expect(pos.x).toBeGreaterThanOrEqual(0)
      expect(pos.x).toBeLessThan(gameState.setup.boardWidth)
      expect(pos.y).toBeGreaterThanOrEqual(0)
      expect(pos.y).toBeLessThan(gameState.setup.boardHeight)
    })
  })

  test("places correct number of players", () => {
    const gameState = createGameState(9, 9, 4)
    const game = new TeamSnekProcessor(gameState)
    const initializedGame = game.firstTurn()
    expect(Object.keys(initializedGame.playerPieces).length).toBe(4)
  })

  test("places players on even squares", () => {
    const gameState = createGameState(11, 11, 8)
    const game = new TeamSnekProcessor(gameState)
    const initializedGame = game.firstTurn()
    const positions = getPositionMap(gameState, initializedGame)
    positions.forEach((pos) => {
      expect((pos.x + pos.y) % 2).toBe(0)
    })
  })

  // The board's capacity is its interior, one unit to a cell: a 5x5 holds
  // nine. `firestore.rules` allows a 5x5 board and up to 26 units a team, so
  // the lobby can ask for more than the board has — and every spawn path stops
  // when it runs out of cells rather than inventing one. The tenth unit on a
  // 5x5 used to read a position off the end of the list and fail with
  // `Cannot destructure property 'x' of 'positions[index]'`.
  test("fills a 5x5 to its capacity, and says which board is too small past it", () => {
    const full = createGameState(5, 5, 9)
    const placed = new TeamSnekProcessor(full).firstTurn()
    expect(Object.keys(placed.playerPieces).length).toBe(9)

    const crowded = createGameState(5, 5, 10)
    expect(() => new TeamSnekProcessor(crowded).firstTurn()).toThrow(
      "Board too small to start: 5x5 has 9 spawn cells for 10 units.",
    )
  })

  test("places players near edges for small number of players", () => {
    const gameState = createGameState(7, 7, 2)
    const game = new TeamSnekProcessor(gameState)
    const initializedGame = game.firstTurn()
    const positions = getPositionMap(gameState, initializedGame)
    const { boardWidth, boardHeight } = gameState.setup
    positions.forEach((pos) => {
      expect(
        pos.x === 1 ||
          pos.x === boardWidth - 2 ||
          pos.y === 1 ||
          pos.y === boardHeight - 2,
      ).toBeTruthy()
    })
  })

  test("handles different board sizes and player counts", () => {
    const testCases = [
      { width: 5, height: 5, players: 2 },
      { width: 7, height: 7, players: 4 },
      { width: 9, height: 9, players: 8 },
      { width: 13, height: 13, players: 12 },
    ]

    testCases.forEach(({ width, height, players }) => {
      const gameState = createGameState(width, height, players)
      const game = new TeamSnekProcessor(gameState)
      const initializedGame = game.firstTurn()
      const positions = getPositionMap(gameState, initializedGame)

      positions.forEach((pos) => {
        expect(pos.x).toBeGreaterThanOrEqual(0)
        expect(pos.x).toBeLessThan(width)
        expect(pos.y).toBeGreaterThanOrEqual(0)
        expect(pos.y).toBeLessThan(height)
      })
      expect(Object.keys(initializedGame.playerPieces).length).toBe(players)
    })
  })

  const TAU = Math.PI * 2

  // Same enumeration order as the processor's spawn cells: interior only, on
  // the spawn parity, row-major.
  function getSpawnCells(
    boardWidth: number,
    boardHeight: number,
  ): { x: number; y: number }[] {
    const cells: { x: number; y: number }[] = []
    for (let y = 1; y < boardHeight - 1; y++) {
      for (let x = 1; x < boardWidth - 1; x++) {
        if ((x + y) % 2 === 0) cells.push({ x, y })
      }
    }
    return cells
  }

  // Constraints every spawn must satisfy: interior of the board, spawn parity,
  // a distinct cell per unit, and at least minDistance between any two units.
  function expectSpawnConstraints(
    gameState: GameState,
    positions: Map<string, { x: number; y: number }>,
    minDistance = 2,
  ): void {
    const { boardWidth, boardHeight, gamePlayers } = gameState.setup
    expect(positions.size).toBe(gamePlayers.length)

    positions.forEach((pos) => {
      expect(pos.x).toBeGreaterThanOrEqual(1)
      expect(pos.y).toBeGreaterThanOrEqual(1)
      expect(pos.x).toBeLessThanOrEqual(boardWidth - 2)
      expect(pos.y).toBeLessThanOrEqual(boardHeight - 2)
      expect((pos.x + pos.y) % 2).toBe(0)
    })

    const ids = [...positions.keys()]
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const distance = getManhattanDistance(
          positions.get(ids[i])!,
          positions.get(ids[j])!,
        )
        expect(distance).toBeGreaterThanOrEqual(minDistance)
      }
    }
  }

  // The slice each spawn cell belongs to, recomputed exactly as the processor
  // does. Valid only while Math.random is stubbed to a constant, which fixes
  // both the rotation and the tie-breaking.
  function getSliceOfCell(
    gameState: GameState,
    sliceCount: number,
    draw: number,
  ): Map<string, number> {
    const { boardWidth, boardHeight } = gameState.setup
    const slices = assignCellsToSlices(
      getSpawnCells(boardWidth, boardHeight),
      boardWidth,
      boardHeight,
      sliceCount,
      draw * TAU,
      () => draw,
    )
    const sliceOfCell = new Map<string, number>()
    slices.forEach((cells, sliceIndex) => {
      cells.forEach((cell) => sliceOfCell.set(`${cell.x},${cell.y}`, sliceIndex))
    })
    return sliceOfCell
  }

  function withStubbedRandom(draw: number, run: () => void): void {
    const originalRandom = Math.random
    Math.random = () => draw
    try {
      run()
    } finally {
      Math.random = originalRandom
    }
  }

  test("spawns every team inside its own radial slice", () => {
    const teamCount = 4
    const snakesPerTeam = 3
    ;[0, 0.13, 0.5, 0.77, 0.99].forEach((draw) => {
      withStubbedRandom(draw, () => {
        const gameState = createTeamGameState(21, 21, teamCount, snakesPerTeam)
        const game = new TeamSnekProcessor(gameState)
        const initializedGame = game.firstTurn()
        expect(initializedGame.teamClusterFallback).toBe(false)

        const positions = getPositionMap(gameState, initializedGame)
        expectSpawnConstraints(gameState, positions)

        const sliceOfCell = getSliceOfCell(gameState, teamCount, draw)
        const sliceOfTeam = new Map<string, number>()
        gameState.setup.gamePlayers.forEach((player) => {
          const pos = positions.get(player.id)!
          const slice = sliceOfCell.get(`${pos.x},${pos.y}`)
          expect(slice).toBeDefined()
          const known = sliceOfTeam.get(player.teamID!)
          if (known === undefined) {
            sliceOfTeam.set(player.teamID!, slice!)
          } else {
            expect(slice).toBe(known)
          }
        })
        // One slice per team, and no two teams share one.
        expect(sliceOfTeam.size).toBe(teamCount)
        expect(new Set(sliceOfTeam.values()).size).toBe(teamCount)
      })
    })
  })

  test("places units in different cells across games", () => {
    const layouts = new Set<string>()
    for (let run = 0; run < 20; run++) {
      const gameState = createTeamGameState(21, 21, 3, 2)
      const game = new TeamSnekProcessor(gameState)
      const positions = getPositionMap(gameState, game.firstTurn())
      expectSpawnConstraints(gameState, positions)
      layouts.add(
        gameState.setup.gamePlayers
          .map((player) => {
            const pos = positions.get(player.id)!
            return `${player.id}:${pos.x},${pos.y}`
          })
          .join("|"),
      )
    }
    // A random rotation per game, and random cells within each slice: repeats
    // across 20 runs of a 21x21 board are vanishingly unlikely.
    expect(layouts.size).toBeGreaterThanOrEqual(15)
  })

  test("relaxes outside a slice too small to hold its team", () => {
    // A wide, shallow board: the slices pointing up and down hold far fewer
    // cells than the teams assigned to them need.
    withStubbedRandom(0.31, () => {
      const teamCount = 4
      const gameState = createTeamGameState(33, 7, teamCount, 6)
      const game = new TeamSnekProcessor(gameState)
      const initializedGame = game.firstTurn()
      expect(initializedGame.teamClusterFallback).toBe(false)

      const positions = getPositionMap(gameState, initializedGame)
      expectSpawnConstraints(gameState, positions)

      const sliceOfCell = getSliceOfCell(gameState, teamCount, 0.31)
      const slicesPerTeam = new Map<string, Set<number>>()
      gameState.setup.gamePlayers.forEach((player) => {
        const pos = positions.get(player.id)!
        const slices = slicesPerTeam.get(player.teamID!) || new Set<number>()
        slices.add(sliceOfCell.get(`${pos.x},${pos.y}`)!)
        slicesPerTeam.set(player.teamID!, slices)
      })
      // Some team has spilled past its own slice, and every unit still holds
      // to the spawn constraints checked above.
      expect(
        [...slicesPerTeam.values()].some((slices) => slices.size > 1),
      ).toBe(true)
    })
  })

  test("falls back to the default spread when the board cannot seat the teams", () => {
    // 20 units, but a 7x7 board offers only 13 parity spawn cells.
    const gameState = createTeamGameState(7, 7, 4, 5)
    const game = new TeamSnekProcessor(gameState)
    const initializedGame = game.firstTurn()

    expect(initializedGame.teamClusterFallback).toBe(true)
    const positions = getPositionMap(gameState, initializedGame)
    expect(positions.size).toBe(gameState.setup.gamePlayers.length)
    const cells = new Set(
      [...positions.values()].map((pos) => `${pos.x},${pos.y}`),
    )
    expect(cells.size).toBe(gameState.setup.gamePlayers.length)
  })

  test("preview board spawns match the engine's spawns", () => {
    withStubbedRandom(0.42, () => {
      const gameState = createTeamGameState(21, 21, 3, 2)
      const engineTurn = new TeamSnekProcessor(gameState).firstTurn()
      const preview = new TeamSnekProcessor(gameState).generatePreviewBoard()

      gameState.setup.gamePlayers.forEach((player) => {
        expect(preview.playerPositions[player.id]).toBe(
          engineTurn.playerPieces[player.id][0],
        )
      })
      // The preview's purpose is to show the board the game is built on, so
      // the whole build must agree, not just where the units stand.
      expect(preview.hazards).toEqual(engineTurn.hazards)
      expect(preview.fertileTiles).toEqual(engineTurn.fertileTiles ?? [])
      expect(preview.food).toEqual(engineTurn.food)
    })
  })
})
