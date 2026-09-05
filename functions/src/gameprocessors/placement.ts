import { GamePlayer, StartedGameSetup } from "@shared/types/Game"
import { ORTHOGONALS, isPieceType } from "./engine/moveGrammar"
import { freeCells } from "./engine/spawn"
import { assignCellsToSlices, sliceDistance } from "../utils/radialSlices"

/**
 * Where everything starts: the board a game is built on, once, before the
 * first turn is played.
 *
 * None of this is a rule. `engine/VENDOR.md` is explicit that placement stays
 * with the caller — a client predicting a turn is handed the board, it does
 * not choose one — so the Perlin hazard field, the connectivity repair, the
 * radial team slices, the spawn geometry and the opening food all live here
 * rather than in the vendored module. They were private methods of
 * TeamSnekProcessor, which meant eight hundred lines of one-time setup sat
 * inside the class that resolves turns and was reachable only through it.
 *
 * The class holds the setup and the perimeter it implies, so nothing is
 * threaded: every method reads the same fixed geometry the constructor was
 * handed, exactly as it did before the move.
 */
export class BoardPlacement {
  private readonly gameSetup: StartedGameSetup
  /** The board perimeter, fixed for the life of the game — built once. */
  readonly walls: number[]

  constructor(gameSetup: StartedGameSetup) {
    this.gameSetup = gameSetup
    this.walls = this.getWallPositions()
  }

  // The board build, in the one order the lobby preview and turn 0 both use:
  // positions, hazards, fertile tiles, food. A preset overrides its step, and
  // only when it is non-empty. Assigning this.fertileTiles is the caller's
  // business, not this method's — the preview must not.
  buildBoard(
    presets: {
      positions?: { [playerID: string]: number }
      hazards?: number[]
      fertileTiles?: number[]
      food?: number[]
    } = {},
  ): {
    playerPieces: { [playerID: string]: number[] }
    hazards: number[]
    fertileTiles: number[]
    food: number[]
    teamClusterFallback: boolean
  } {
    const { gamePlayers } = this.gameSetup

    let playerPieces: { [playerID: string]: number[] }
    let teamClusterFallback: boolean
    const presetPositions = presets.positions
    if (presetPositions && Object.keys(presetPositions).length === gamePlayers.length) {
      playerPieces = {}
      teamClusterFallback = false
      gamePlayers.forEach((player) => {
        const pos = presetPositions[player.id]
        if (pos !== undefined) {
          playerPieces[player.id] = isPieceType(player.unitType) ? [pos] : [pos, pos, pos]
        }
      })
      if (Object.keys(playerPieces).length !== gamePlayers.length) {
        const result = this.initializeSnakes()
        playerPieces = result.playerPieces
        teamClusterFallback = result.teamClusterFallback
      }
    } else {
      const result = this.initializeSnakes()
      playerPieces = result.playerPieces
      teamClusterFallback = result.teamClusterFallback
    }

    const hazards = presets.hazards && presets.hazards.length > 0
      ? presets.hazards
      : this.generateHazardPositions(playerPieces)

    const fertileTiles = presets.fertileTiles && presets.fertileTiles.length > 0
      ? presets.fertileTiles
      : this.generateFertileTiles(hazards)

    const food = presets.food && presets.food.length > 0
      ? presets.food
      : this.initializeFood(playerPieces, hazards)

    return { playerPieces, hazards, fertileTiles, food, teamClusterFallback }
  }

  private initializeSnakes(): {
    playerPieces: { [playerID: string]: number[] }
    teamClusterFallback: boolean
  } {
    const { boardWidth, boardHeight, gamePlayers } = this.gameSetup
    const { positions, teamClusterFallback } = this.generateStartingPositions()
    const playerPieces: { [playerID: string]: number[] } = {}

    // A board can be asked for more units than it has squares — the lobby
    // allows a 5x5 and 26 units a team, and a 5x5 has nine interior cells.
    // Every path above stops when it runs out of cells rather than inventing
    // one, so say so here: a unit per cell is the constraint, and the failure
    // is the board, not the arithmetic that reads the position off the end of
    // the list.
    if (positions.length < gamePlayers.length) {
      throw new Error(
        `Board too small to start: ${boardWidth}x${boardHeight} has ${positions.length} ` +
          `spawn cells for ${gamePlayers.length} units.`,
      )
    }

    gamePlayers.forEach((player, index) => {
      const { x, y } = positions[index]
      const startIndex = y * boardWidth + x
      // Snakes spawn as a stacked triple; chess pieces as a single square (weight 1)
      playerPieces[player.id] = isPieceType(player.unitType)
        ? [startIndex]
        : [startIndex, startIndex, startIndex]
    })

    return { playerPieces, teamClusterFallback }
  }

  private generateFertileTiles(hazards: number[]): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    if (!this.gameSetup.fertileGroundEnabled) return []
    const density = Math.max(0, Math.min(100, this.gameSetup.fertileGroundDensity ?? 30))
    if (density === 0) return []

    const clustering = Math.max(1, Math.min(20, this.gameSetup.fertileGroundClustering ?? 10))

    const wallSet = new Set(this.walls)
    const hazardSet = new Set(hazards)

    const seedX = Math.random() * 1000
    const seedY = Math.random() * 1000

    const baseFrequency = this.clusteringToFrequency(clustering)

    const noiseValues: { pos: number; value: number }[] = []
    for (let y = 1; y < boardHeight - 1; y++) {
      for (let x = 1; x < boardWidth - 1; x++) {
        const pos = y * boardWidth + x
        if (wallSet.has(pos) || hazardSet.has(pos)) continue
        const value = this.fractalNoise(x + seedX, y + seedY, 4, baseFrequency)
        noiseValues.push({ pos, value })
      }
    }

    if (noiseValues.length === 0) return []

    noiseValues.sort((a, b) => b.value - a.value)
    const targetCount = Math.max(1, Math.floor((noiseValues.length * density) / 100))
    return noiseValues.slice(0, targetCount).map(n => n.pos)
  }

  private clusteringToFrequency(clustering: number): number {
    const t = (clustering - 1) / 19
    return 0.7553 + t * (0.0662 - 0.7553)
  }

  private fractalNoise(x: number, y: number, octaves: number, baseFrequency = 0.3): number {
    let value = 0
    let amplitude = 1
    let frequency = baseFrequency
    let maxAmplitude = 0
    for (let i = 0; i < octaves; i++) {
      value += this.perlinNoise(x * frequency, y * frequency) * amplitude
      maxAmplitude += amplitude
      amplitude *= 0.5
      frequency *= 2.0
    }
    return value / maxAmplitude
  }

  private perlinNoise(x: number, y: number): number {
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const dx = x - x0
    const dy = y - y0
    const sx = dx * dx * (3 - 2 * dx)
    const sy = dy * dy * (3 - 2 * dy)

    const n00 = this.dotGridGradient(x0, y0, x, y)
    const n10 = this.dotGridGradient(x0 + 1, y0, x, y)
    const n01 = this.dotGridGradient(x0, y0 + 1, x, y)
    const n11 = this.dotGridGradient(x0 + 1, y0 + 1, x, y)

    const ix0 = n00 + sx * (n10 - n00)
    const ix1 = n01 + sx * (n11 - n01)
    return ix0 + sy * (ix1 - ix0)
  }

  private dotGridGradient(ix: number, iy: number, x: number, y: number): number {
    const hash = this.hashCoord(ix, iy)
    const angle = hash * 2.0 * Math.PI
    const gx = Math.cos(angle)
    const gy = Math.sin(angle)
    return gx * (x - ix) + gy * (y - iy)
  }

  private hashCoord(x: number, y: number): number {
    let h = (x * 374761393 + y * 668265263 + 1013904223) & 0x7fffffff
    h = ((h >> 13) ^ h) & 0x7fffffff
    h = (h * 1274126177 + 1013904223) & 0x7fffffff
    return (h & 0xffff) / 0xffff
  }

  private initializeFood(
    playerPieces: { [playerID: string]: number[] },
    hazards: number[],
  ): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    // What a cell may hold is the module's rule, not this method's: `free` is
    // every cell an item could land on, in board order, and a cell leaves it
    // as food takes it. Writing the wall/hazard/unit set out again here was
    // that rule stated a second time, in a method that already called
    // `getFreePositions` for its own fallback branch.
    const free = new Set(this.getFreePositions(playerPieces, [], hazards))

    const foodPositions: number[] = []
    const take = (cell: number): void => {
      foodPositions.push(cell)
      free.delete(cell)
    }

    // Centre of the board if it is open, else the first open cell.
    const centerX = Math.floor(boardWidth / 2)
    const centerY = Math.floor(boardHeight / 2)
    const centerPosition = centerY * boardWidth + centerX
    if (free.has(centerPosition)) take(centerPosition)
    else {
      const [fallback] = free
      if (fallback !== undefined) take(fallback)
    }

    // Place additional food for each snake
    Object.values(playerPieces).forEach((snake) => {
      const snakeHead = snake[0]
      const headX = snakeHead % boardWidth
      const headY = Math.floor(snakeHead / boardWidth)

      const diagonalDirections = [
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: -1 },
      ]

      for (const { dx, dy } of diagonalDirections) {
        const foodX = headX + dx
        const foodY = headY + dy

        if (
          foodX >= 1 &&
          foodX < boardWidth - 1 &&
          foodY >= 1 &&
          foodY < boardHeight - 1
        ) {
          const foodPosition = foodY * boardWidth + foodX
          if (free.has(foodPosition)) {
            take(foodPosition)
            break
          }
        }
      }
    })

    return foodPositions
  }

  private getWallPositions(): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    const wallPositions: Set<number> = new Set()

    // Top and bottom walls
    for (let x = 0; x < boardWidth; x++) {
      wallPositions.add(x) // Top wall
      wallPositions.add((boardHeight - 1) * boardWidth + x) // Bottom wall
    }

    // Left and right walls
    for (let y = 0; y < boardHeight; y++) {
      wallPositions.add(y * boardWidth) // Left wall
      wallPositions.add(y * boardWidth + (boardWidth - 1)) // Right wall
    }

    return Array.from(wallPositions)
  }

  private getAdjacentIndices(index: number): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    const x = index % boardWidth
    const y = Math.floor(index / boardWidth)
    const indices: number[] = []

    ORTHOGONALS.forEach(({ dx, dy }) => {
      const newX = x + dx
      const newY = y + dy
      if (newX >= 0 && newX < boardWidth && newY >= 0 && newY < boardHeight) {
        indices.push(newY * boardWidth + newX)
      }
    })

    return indices
  }

  // Where an item may be placed, which is the module's rule (engine/spawn.ts)
  // — asked here for the placement pass that builds the board, since the
  // per-turn spawners now ask it from inside settlement.
  private getFreePositions(
    playerPieces: { [playerID: string]: number[] },
    food: number[],
    hazards: number[],
  ): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    return freeCells({
      boardWidth,
      boardHeight,
      walls: this.walls,
      hazards,
      occupancy: Object.values(playerPieces),
      food,
      potions: [],
    })
  }

  private generateHazardPositions(
    playerPieces: { [playerID: string]: number[] },
  ): number[] {
    const hazardPercentage = Math.max(
      0,
      Math.min(100, this.gameSetup.hazardPercentage ?? 0),
    )
    if (hazardPercentage <= 0) return []

    const candidatePositions = this.getFreePositions(
      playerPieces,
      [],
      [],
    )

    if (candidatePositions.length === 0) return []

    const targetCount = Math.floor(
      (candidatePositions.length * hazardPercentage) / 100,
    )
    if (targetCount <= 0) return []

    const initialHazards = this.shuffleArray(candidatePositions).slice(0, targetCount)
    const safeHazards = this.ensureInitialSafeMoves(
      initialHazards,
      playerPieces,
    )
    return this.ensureConnectedBoard(
      safeHazards,
      playerPieces,
    )
  }

  // Every cell any placed unit occupies, folded from its whole body/stack.
  private occupancyOf(playerPieces: { [playerID: string]: number[] }): Set<number> {
    const occupied = new Set<number>()
    Object.values(playerPieces).forEach((snake) => {
      snake.forEach((pos) => occupied.add(pos))
    })
    return occupied
  }

  // Ensure each player has at least one safe adjacent move on turn 0
  private ensureInitialSafeMoves(
    hazards: number[],
    playerPieces: { [playerID: string]: number[] },
  ): number[] {
    const hazardSet = new Set(hazards)
    const walls = new Set(this.walls)
    const occupied = this.occupancyOf(playerPieces)

    Object.values(playerPieces).forEach((snake) => {
      const head = snake[0]
      const neighbors = this.getAdjacentIndices(head)
      const safeNeighbors = neighbors.filter(
        (n) => !walls.has(n) && !hazardSet.has(n) && !occupied.has(n),
      )

      if (safeNeighbors.length === 0) {
        // Move or remove one blocking hazard to free a move
        for (const n of neighbors) {
          if (!walls.has(n) && !occupied.has(n) && hazardSet.has(n)) {
            const hazardsWithoutCurrent = new Set(hazardSet)
            hazardsWithoutCurrent.delete(n)

            const relocationCandidates = this.getFreePositions(
              playerPieces,
              [],
              Array.from(hazardsWithoutCurrent),
            )

            let relocated = false
            for (const candidate of relocationCandidates) {
              if (candidate === n || hazardSet.has(candidate)) continue

              hazardSet.delete(n)
              hazardSet.add(candidate)

              const updatedSafeNeighbors = neighbors.filter(
                (neighbor) =>
                  !walls.has(neighbor) &&
                  !hazardSet.has(neighbor) &&
                  !occupied.has(neighbor),
              )

              if (updatedSafeNeighbors.length > 0) {
                relocated = true
                break
              }

              hazardSet.delete(candidate)
              hazardSet.add(n)
            }

            if (!relocated) {
              hazardSet.delete(n)
            }
            break
          }
        }
      }
    })

    return Array.from(hazardSet)
  }

  private ensureConnectedBoard(
    hazards: number[],
    playerPieces: { [playerID: string]: number[] },
  ): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    const hazardSet = new Set(hazards)
    const walls = new Set(this.walls)
    const occupied = this.occupancyOf(playerPieces)

    const isConnected = (hazardsToCheck: Set<number>): boolean => {
      const visited = new Set<number>()
      let start: number | null = null

      for (let i = 0; i < boardWidth * boardHeight; i++) {
        if (!walls.has(i) && !hazardsToCheck.has(i) && !occupied.has(i)) {
          start = i
          break
        }
      }

      if (start === null) return true // nothing to connect

      const queue: number[] = [start]
      visited.add(start)

      while (queue.length > 0) {
        const current = queue.shift() as number
        const neighbors = this.getAdjacentIndices(current)
        neighbors.forEach((n) => {
          if (
            !visited.has(n) &&
            !walls.has(n) &&
            !hazardsToCheck.has(n) &&
            !occupied.has(n)
          ) {
            visited.add(n)
            queue.push(n)
          }
        })
      }

      // All free cells should be reachable
      for (let i = 0; i < boardWidth * boardHeight; i++) {
        if (!walls.has(i) && !hazardsToCheck.has(i) && !occupied.has(i)) {
          if (!visited.has(i)) {
            return false
          }
        }
      }
      return true
    }

    if (isConnected(hazardSet)) return Array.from(hazardSet)

    // Greedily remove hazards until the board is connected
    for (const hazard of Array.from(hazardSet)) {
      hazardSet.delete(hazard)
      if (isConnected(hazardSet)) {
        const availablePositions = this.getFreePositions(
          playerPieces,
          [],
          Array.from(hazardSet),
        )

        let relocated = false
        for (const candidate of availablePositions) {
          if (hazardSet.has(candidate)) continue

          hazardSet.add(candidate)
          if (isConnected(hazardSet)) {
            relocated = true
            break
          }
          hazardSet.delete(candidate)
        }

        if (!relocated) {
          // Hazard stays removed
        }
        break
      }
      hazardSet.add(hazard)
    }

    return Array.from(hazardSet)
  }

  private generateStartingPositions(): {
    positions: { x: number; y: number }[]
    teamClusterFallback: boolean
  } {
    let teamClusterFallback = false
    if (this.shouldUseTeamClusters()) {
      const clusteredPositions = this.generateTeamClusterStartingPositions()
      if (clusteredPositions.length === this.gameSetup.gamePlayers.length) {
        return { positions: clusteredPositions, teamClusterFallback }
      }
      teamClusterFallback = true
    }

    const { boardWidth, boardHeight, gamePlayers } = this.gameSetup
    const positions: { x: number; y: number }[] = []
    const addUniquePosition = (pos: { x: number; y: number }): void => {
      if (!positions.some((p) => p.x === pos.x && p.y === pos.y)) {
        positions.push(pos)
      }
    }

    // Calculate the outermost position that allows odd spacing
    const startX = (boardWidth - 1) % 4 === 0 ? 2 : 1
    const startY = (boardHeight - 1) % 4 === 0 ? 2 : 1
    const endX = boardWidth - startX - 1
    const endY = boardHeight - startY - 1

    // Define edges
    const edges = [
      { start: { x: startX, y: startY }, end: { x: endX, y: startY } }, // Top
      { start: { x: endX, y: startY }, end: { x: endX, y: endY } }, // Right
      { start: { x: endX, y: endY }, end: { x: startX, y: endY } }, // Bottom
      { start: { x: startX, y: endY }, end: { x: startX, y: startY } }, // Left
    ]

    // Add corner positions
    addUniquePosition({ x: startX, y: startY })
    addUniquePosition({ x: endX, y: startY })
    addUniquePosition({ x: startX, y: endY })
    addUniquePosition({ x: endX, y: endY })

    let depth = 0
    while (positions.length < gamePlayers.length) {
      const newPositions: { x: number; y: number }[] = []
      for (const edge of edges) {
        const midpoints = this.getMidpoints(edge.start, edge.end, depth)
        newPositions.push(...midpoints)
      }

      // Filter out duplicates and add new positions
      const beforeCount = positions.length
      newPositions.forEach((pos) => addUniquePosition(pos))

      depth++

      // If we can't add more unique positions on the edges, break the loop
      if (positions.length === beforeCount) break
    }

    // If we still need more positions, fill the inner part
    if (positions.length < gamePlayers.length) {
      this.fillInnerPositions(positions)
    }

    if (positions.length < gamePlayers.length) {
      for (let y = 1; y < boardHeight - 1; y++) {
        for (let x = 1; x < boardWidth - 1; x++) {
          addUniquePosition({ x, y })
          if (positions.length >= gamePlayers.length) {
            break
          }
        }
        if (positions.length >= gamePlayers.length) {
          break
        }
      }
    }

    return { positions: positions.slice(0, gamePlayers.length), teamClusterFallback }
  }

  private shouldUseTeamClusters(): boolean {
    return !!this.gameSetup.teamClustersEnabled
  }

  // Radial team spawns: the board is cut from its centre into one equal-angle
  // pie slice per team, the whole partition sitting at a random rotation so
  // wedges differ between games. Each team's units then take random legal
  // cells inside the team's own slice.
  private generateTeamClusterStartingPositions(): { x: number; y: number }[] {
    const { boardWidth, boardHeight, gamePlayers, teams } = this.gameSetup
    const minDistance = 2

    const teamMap = new Map<string, GamePlayer[]>()
    gamePlayers.forEach((player) => {
      if (!player.teamID) return
      const existing = teamMap.get(player.teamID) || []
      existing.push(player)
      teamMap.set(player.teamID, existing)
    })

    const teamIDs = this.getOrderedTeamIDs(teamMap, teams)
    const sliceCount = teamIDs.length
    if (sliceCount === 0) {
      return []
    }

    // Board capacity guard: every unit needs a legal spawn cell of its own.
    const spawnCells = this.getSpawnCells()
    if (spawnCells.length < gamePlayers.length) {
      return []
    }

    const maxAttempts = 8
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const rotation = Math.random() * Math.PI * 2
      const slices = assignCellsToSlices(
        spawnCells,
        boardWidth,
        boardHeight,
        sliceCount,
        rotation,
      )

      // Teams draw slices at random, so a team is not tied to one wedge.
      const sliceForTeam = this.shuffleArray(slices.map((_cells, index) => index))
      const orderedTeams = this.shuffleArray(teamIDs)

      const placed = new Map<string, { x: number; y: number }>()
      const occupied: { x: number; y: number }[] = []
      let failed = false

      for (let index = 0; index < orderedTeams.length; index++) {
        const players = teamMap.get(orderedTeams[index]) || []
        const candidates = this.orderSliceCandidates(slices, sliceForTeam[index])
        for (const player of players) {
          // The minimum distance also keeps spawns distinct, since a cell is
          // zero away from itself.
          const spot = candidates.find((cell) =>
            this.isFarFromAllSnakes(cell, occupied, minDistance),
          )
          if (!spot) {
            failed = true
            break
          }
          placed.set(player.id, spot)
          occupied.push(spot)
        }
        if (failed) {
          break
        }
      }

      if (!failed && placed.size === gamePlayers.length) {
        return gamePlayers
          .map((player) => placed.get(player.id))
          .filter((pos): pos is { x: number; y: number } => !!pos)
      }
    }

    return []
  }

  // Every cell a unit may spawn on: board interior only, and on the spawn
  // parity so any two spawns sit an even Manhattan distance apart.
  private getSpawnCells(): { x: number; y: number }[] {
    const { boardWidth, boardHeight } = this.gameSetup
    const cells: { x: number; y: number }[] = []
    for (let y = 1; y < boardHeight - 1; y++) {
      for (let x = 1; x < boardWidth - 1; x++) {
        if (this.isValidSpawnPosition({ x, y }, true)) {
          cells.push({ x, y })
        }
      }
    }
    return cells
  }

  // Cells a team may spawn on, best first: its own slice in random order,
  // then — the fallback for a slice too small to hold the team under the
  // spacing constraints — the nearest other slices, also randomly ordered.
  private orderSliceCandidates(
    slices: { x: number; y: number }[][],
    sliceIndex: number,
  ): { x: number; y: number }[] {
    return this.shuffleArray(slices.map((cells, index) => ({ cells, index })))
      .sort(
        (a, b) =>
          sliceDistance(a.index, sliceIndex, slices.length) -
          sliceDistance(b.index, sliceIndex, slices.length),
      )
      .flatMap((slice) => this.shuffleArray(slice.cells))
  }

  private getOrderedTeamIDs(
    teamMap: Map<string, GamePlayer[]>,
    teams: { id: string }[] | undefined,
  ): string[] {
    const ordered: string[] = []
    if (teams) {
      teams.forEach((team) => {
        if (teamMap.has(team.id)) {
          ordered.push(team.id)
        }
      })
    }
    teamMap.forEach((_players, teamID) => {
      if (!ordered.includes(teamID)) {
        ordered.push(teamID)
      }
    })
    return ordered
  }

  private isFarFromAllSnakes(
    position: { x: number; y: number },
    occupied: { x: number; y: number }[],
    minDistance: number,
  ): boolean {
    return occupied.every(
      (other) => this.getManhattanDistance(position, other) >= minDistance,
    )
  }

  private shuffleArray<T>(items: T[]): T[] {
    const copy = [...items]
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      const temp = copy[i]
      copy[i] = copy[j]
      copy[j] = temp
    }
    return copy
  }

  private isValidSpawnPosition(
    position: { x: number; y: number },
    requireParity: boolean,
  ): boolean {
    const { boardWidth, boardHeight } = this.gameSetup
    if (
      position.x < 1 ||
      position.y < 1 ||
      position.x > boardWidth - 2 ||
      position.y > boardHeight - 2
    ) {
      return false
    }
    if (requireParity && (position.x + position.y) % 2 !== 0) {
      return false
    }
    return true
  }

  private getManhattanDistance(
    a: { x: number; y: number },
    b: { x: number; y: number },
  ): number {
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }

  private getMidpoints(
    start: { x: number; y: number },
    end: { x: number; y: number },
    depth: number,
  ): { x: number; y: number }[] {
    const positions: { x: number; y: number }[] = []
    const segments = Math.pow(2, depth + 1)
    for (let i = 1; i < segments; i += 2) {
      const x = Math.round(start.x + ((end.x - start.x) * i) / segments)
      const y = Math.round(start.y + ((end.y - start.y) * i) / segments)
      positions.push({ x, y })
    }
    return positions
  }

  private fillInnerPositions(positions: { x: number; y: number }[]): void {
    const { boardWidth, boardHeight, gamePlayers } = this.gameSetup
    let innerStartX = 3
    let innerStartY = 3
    let innerEndX = boardWidth - 4
    let innerEndY = boardHeight - 4

    while (
      positions.length < gamePlayers.length &&
      innerStartX < innerEndX &&
      innerStartY < innerEndY
    ) {
      // Add corner positions for this inner layer
      const innerPositions = [
        { x: innerStartX, y: innerStartY },
        { x: innerEndX, y: innerStartY },
        { x: innerStartX, y: innerEndY },
        { x: innerEndX, y: innerEndY },
      ]

      // Add midpoints for this inner layer
      if (innerEndX - innerStartX > 2) {
        innerPositions.push({
          x: Math.floor((innerStartX + innerEndX) / 2),
          y: innerStartY,
        })
        innerPositions.push({
          x: Math.floor((innerStartX + innerEndX) / 2),
          y: innerEndY,
        })
      }
      if (innerEndY - innerStartY > 2) {
        innerPositions.push({
          x: innerStartX,
          y: Math.floor((innerStartY + innerEndY) / 2),
        })
        innerPositions.push({
          x: innerEndX,
          y: Math.floor((innerStartY + innerEndY) / 2),
        })
      }

      // Add new positions if they don't already exist
      innerPositions.forEach((pos) => {
        if (!positions.some((p) => p.x === pos.x && p.y === pos.y)) {
          positions.push(pos)
        }
      })

      // Move to the next inner layer
      innerStartX += 2
      innerStartY += 2
      innerEndX -= 2
      innerEndY -= 2
    }
  }
}
