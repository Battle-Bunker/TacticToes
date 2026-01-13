import { GamePlayer, GameState } from "@shared/types/Game"
import { Timestamp } from "firebase/firestore"
import { SnekProcessor } from "./gameprocessors/SnekProcessor" // Adjust the import path as needed

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

describe("SnekProcessor", () => {
  function createGameState(
    width: number,
    height: number,
    playerCount: number,
  ): GameState {
    const gamePlayers: GamePlayer[] = Array.from(
      { length: playerCount },
      (_, i) => ({
        id: `p${i + 1}`,
        type: "human",
      }),
    )
    return {
      turns: [],
      setup: {
        gameType: "snek",
        gamePlayers: gamePlayers,
        boardWidth: width,
        boardHeight: height,
        playersReady: [],
        maxTurnTime: 10,
        startRequested: false,
        started: true,
        timeCreated: Timestamp.now(),
      },
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: Timestamp.fromMillis(0),
    }
  }

  function createTeamGameState(
    width: number,
    height: number,
    teamCount: number,
    playersPerTeam: number,
    gameType: "teamsnek" | "kingsnek",
  ): GameState {
    const teams = Array.from({ length: teamCount }, (_, i) => ({
      id: `t${i + 1}`,
      name: `Team ${i + 1}`,
      color: `#00${i + 1}0${i + 1}0`,
    }))
    const gamePlayers: GamePlayer[] = teams.flatMap((team) =>
      Array.from({ length: playersPerTeam }, (_, i) => ({
        id: `${team.id}p${i + 1}`,
        type: "human",
        teamID: team.id,
        isKing: gameType === "kingsnek" && i === 0,
      })),
    )

    return {
      turns: [],
      setup: {
        gameType,
        gamePlayers,
        boardWidth: width,
        boardHeight: height,
        playersReady: [],
        maxTurnTime: 10,
        startRequested: false,
        started: true,
        timeCreated: Timestamp.now(),
        teams,
        teamClustersEnabled: true,
      },
      timeCreated: Timestamp.fromMillis(0),
      timeFinished: Timestamp.fromMillis(0),
    }
  }

  function getRingPositions(
    boardWidth: number,
    boardHeight: number,
    inset: number,
  ): { x: number; y: number }[] {
    const minX = inset
    const minY = inset
    const maxX = boardWidth - inset - 1
    const maxY = boardHeight - inset - 1
    if (minX >= maxX || minY >= maxY) {
      return []
    }

    const positions: { x: number; y: number }[] = []
    for (let x = minX; x <= maxX; x++) {
      positions.push({ x, y: minY })
    }
    for (let y = minY + 1; y <= maxY; y++) {
      positions.push({ x: maxX, y })
    }
    for (let x = maxX - 1; x >= minX; x--) {
      positions.push({ x, y: maxY })
    }
    for (let y = maxY - 1; y > minY; y--) {
      positions.push({ x: minX, y })
    }

    return positions
  }

  function getManhattanDistance(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }

  function getPositionMap(
    gameState: GameState,
    initializedGame: ReturnType<SnekProcessor["initializeGame"]>,
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
    const game = new SnekProcessor(gameState)
    const initializedGame = game.initializeGame()
    const board = game.visualizeBoard(initializedGame)
    const lines = board.split("\n")
    expect(lines.length).toBe(7)
    expect(lines[0].split(" ").length).toBe(7)
  })

  test("places correct number of players", () => {
    const gameState = createGameState(9, 9, 4)
    const game = new SnekProcessor(gameState)
    const initializedGame = game.initializeGame()
    const board = game.visualizeBoard(initializedGame)
    const playerCount = (board.match(/[1-4]/g) || []).length
    expect(playerCount).toBe(4)
  })

  test("places players on even squares", () => {
    const gameState = createGameState(11, 11, 8)
    const game = new SnekProcessor(gameState)
    const initializedGame = game.initializeGame()
    const board = game.visualizeBoard(initializedGame)
    const lines = board.split("\n")
    for (let y = 0; y < lines.length; y++) {
      const squares = lines[y].split(" ")
      for (let x = 0; x < squares.length; x++) {
        if (squares[x].match(/[1-8]/)) {
          expect((x + y) % 2).toBe(0)
        }
      }
    }
  })

  test("places players near edges for small number of players", () => {
    const gameState = createGameState(7, 7, 2)
    const game = new SnekProcessor(gameState)
    const initializedGame = game.initializeGame()
    const board = game.visualizeBoard(initializedGame)
    const lines = board.split("\n")
    const playerPositions = []
    for (let y = 0; y < lines.length; y++) {
      const squares = lines[y].split(" ")
      for (let x = 0; x < squares.length; x++) {
        if (squares[x].match(/[1-2]/)) {
          playerPositions.push({ x, y })
        }
      }
    }
    playerPositions.forEach((pos) => {
      expect(
        pos.x === 1 || pos.x === 5 || pos.y === 1 || pos.y === 5,
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
      const game = new SnekProcessor(gameState)
      const initializedGame = game.initializeGame()
      const board = game.visualizeBoard(initializedGame)
      const lines = board.split("\n")

      expect(lines.length).toBe(height)
      expect(lines[0].split(" ").length).toBe(width)

      let playerCount = 0
      lines.forEach((line) => {
        line.split(" ").forEach((token) => {
          if (/^\d+$/.test(token)) {
            playerCount += 1
          }
        })
      })
      expect(playerCount).toBe(players)
    })
  })

  test.each(["teamsnek", "kingsnek"] as const)(
    "spawns %s team clusters with teammate proximity and separation",
    (gameType) => {
      const originalRandom = Math.random
      Math.random = () => 0
      try {
        const intraTeamSpacing = 2
        const gameState = createTeamGameState(17, 17, 3, 2, gameType)
        const game = new SnekProcessor(gameState)
        const initializedGame = game.initializeGame()
        const positions = getPositionMap(gameState, initializedGame)

        const teamMap = new Map<string, string[]>()
        gameState.setup.gamePlayers.forEach((player) => {
          if (!player.teamID) return
          const list = teamMap.get(player.teamID) || []
          list.push(player.id)
          teamMap.set(player.teamID, list)
        })

        teamMap.forEach((playerIDs) => {
          if (playerIDs.length < 2) return
          playerIDs.forEach((playerID) => {
            const position = positions.get(playerID)
            expect(position).toBeDefined()
            if (!position) return
            const teammateDistances = playerIDs
              .filter((id) => id !== playerID)
              .map((id) => getManhattanDistance(position, positions.get(id)!))
            const closestTeammate = Math.min(...teammateDistances)
            expect(closestTeammate).toBeLessThanOrEqual(10)
          })
        })

        const players = gameState.setup.gamePlayers
        for (let i = 0; i < players.length; i++) {
          for (let j = i + 1; j < players.length; j++) {
            const a = players[i]
            const b = players[j]
            const posA = positions.get(a.id)!
            const posB = positions.get(b.id)!
            expect(getManhattanDistance(posA, posB)).toBeGreaterThanOrEqual(2)
          }
        }

        const inset = Math.max(
          2,
          Math.floor(
            Math.min(gameState.setup.boardWidth, gameState.setup.boardHeight) /
              2,
          ) - 6,
        )
        const ringPositions = getRingPositions(
          gameState.setup.boardWidth,
          gameState.setup.boardHeight,
          inset,
        )
        const ringIndex = new Map(
          ringPositions.map((pos, index) => [`${pos.x},${pos.y}`, index]),
        )

        positions.forEach((pos) => {
          expect(ringIndex.has(`${pos.x},${pos.y}`)).toBeTruthy()
          expect((pos.x + pos.y) % 2).toBe(0)
        })

        const teamRanges = Array.from(teamMap.entries()).map(([teamID, ids]) => {
          const indices = ids
            .map(
              (id) =>
                ringIndex.get(
                  `${positions.get(id)!.x},${positions.get(id)!.y}`,
                )!,
            )
            .sort((a, b) => a - b)
          return {
            teamID,
            min: indices[0],
            max: indices[indices.length - 1],
            size: ids.length,
            indices,
          }
        })

        teamRanges.forEach((range) => {
          for (let i = 1; i < range.indices.length; i++) {
            expect(range.indices[i] - range.indices[i - 1]).toBe(
              intraTeamSpacing,
            )
          }
        })

        const sortedRanges = [...teamRanges].sort((a, b) => a.min - b.min)
        for (let i = 0; i < sortedRanges.length; i++) {
          const current = sortedRanges[i]
          const next = sortedRanges[(i + 1) % sortedRanges.length]
          const gap =
            i === sortedRanges.length - 1
              ? ringPositions.length - 1 - current.max + next.min
              : next.min - current.max - 1
          expect(gap).toBeGreaterThanOrEqual(2)
        }

        const playerIDs = gameState.setup.gamePlayers.map((player) => player.id)
        for (let i = 0; i < playerIDs.length; i++) {
          for (let j = i + 1; j < playerIDs.length; j++) {
            const posA = positions.get(playerIDs[i])!
            const posB = positions.get(playerIDs[j])!
            expect(getManhattanDistance(posA, posB) % 2).toBe(0)
          }
        }
      } finally {
        Math.random = originalRandom
      }
    },
  )
})
