import { Clash, GameState, Move, Turn, Winner } from "@shared/types/Game"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "../logger"
import { GameProcessor } from "./GameProcessor"

interface SnakeGameState {
  // Input data
  boardWidth: number
  boardHeight: number
  
  // Mutable game state
  newSnakes: { [playerID: string]: number[] }
  newFood: number[]
  newHazards: number[]
  newPlayerHealth: { [playerID: string]: number }
  newAlivePlayers: string[]
  
  // Processing data
  playerMoves: { [playerID: string]: number }
  deadPlayers: Set<string>
  clashes: Clash[]
  
  // Computed data
  newAllowedMoves: { [playerID: string]: number[] }
  newScores: { [playerID: string]: number }
}

export class SnekProcessor extends GameProcessor {
  private foodSpawnChance: number = 0.5 // 50% chance to spawn food
  private maxTurns?: number

  constructor(gameState: GameState) {
    super(gameState)
    this.maxTurns = gameState.setup.maxTurns
  }

  firstTurn(): Turn {
    try {
      const initialTurn = this.initializeTurn()
      logger.info(`Snek: First turn created for game.`)
      return initialTurn
    } catch (error) {
      logger.error(`Snek: Error initializing first turn:`, error)
      throw error
    }
  }

  initializeGame(): Turn {
    try {
      const initialTurn = this.initializeTurn()
      logger.info(`Snek: Turn 1 created for game.`)
      return initialTurn
    } catch (error) {
      logger.error(`Snek: Error initializing game:`, error)
      throw error
    }
  }

  private initializeTurn(): Turn {
    const { boardWidth, boardHeight, gamePlayers, maxTurnTime } = this.gameSetup
    const now = Date.now()

    // Initialize playerPieces
    const playerPieces = this.initializeSnakes()

    // Initialize walls
    const walls = this.getWallPositions(boardWidth, boardHeight)

    // Initialize hazards
    const hazards = this.generateHazardPositions(
      boardWidth,
      boardHeight,
      playerPieces,
    )

    // Initialize food positions
    const food = this.initializeFood(
      boardWidth,
      boardHeight,
      playerPieces,
      hazards,
    )

    // Initialize allowed moves
    const allowedMoves = this.calculateAllowedMoves(
      playerPieces,
      boardWidth,
      boardHeight,
    )

    // Initialize player health
    const initialHealth: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      initialHealth[player.id] = 100
    })

    // Initialize scores
    const initialScores: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      initialScores[player.id] = 3 // Initial snake length is 3
    })

    const firstTurn: Turn = {
      playerHealth: initialHealth,
      startTime: Timestamp.fromMillis(now),
      endTime: Timestamp.fromMillis(now + maxTurnTime * 1000),
      scores: initialScores,
      alivePlayers: gamePlayers.map((player) => player.id),
      food: food,
      hazards: hazards,
      playerPieces: playerPieces,
      allowedMoves: allowedMoves,
      walls: walls,
      clashes: [],
      moves: {},
      winners: [],
    }

    return firstTurn
  }

  applyMoves(currentTurn: Turn, moves: Move[]): Turn {
    try {
      // 1. Setup
      const gameState = this.initializeGameState(currentTurn)
      
      // 2. Process moves
      this.processPlayerMoves(gameState, moves)
      
      // 3. Handle collisions
      this.detectAndHandleCollisions(gameState)
      
      // 4. Process food and health
      this.processFoodAndHealth(gameState)
      
      // 5. Generate new food
      this.generateNewFood(gameState)
      
      // 6. Calculate winners
      const winners = this.calculateWinners(gameState)
      
      // 7. Create new turn
      return this.createNewTurn(currentTurn, gameState, winners)
      
    } catch (error) {
      logger.error(`Snek: Error applying moves:`, error)
      throw error
    }
  }

  private initializeGameState(currentTurn: Turn): SnakeGameState {
    const {
      playerPieces,
      food,
      hazards,
      alivePlayers,
      playerHealth,
    } = currentTurn
      const { boardWidth, boardHeight } = this.gameSetup

      // Deep copy playerPieces and other mutable objects
      const newSnakes: { [playerID: string]: number[] } = {}
      Object.keys(playerPieces).forEach((playerID) => {
        newSnakes[playerID] = [...playerPieces[playerID]]
      })

    return {
      boardWidth,
      boardHeight,
      newSnakes,
      newFood: [...food],
      newHazards: [...hazards],
      newPlayerHealth: { ...playerHealth },
      newAlivePlayers: [...alivePlayers],
      playerMoves: {},
      deadPlayers: new Set(),
      clashes: [],
      newAllowedMoves: {},
      newScores: {}
    }
  }

  private processPlayerMoves(gameState: SnakeGameState, moves: Move[]): void {
      // Process latest moves
      moves.forEach((move) => {
      gameState.playerMoves[move.playerID] = move.move
    })

    // Apply moves to each player
    gameState.newAlivePlayers.forEach((playerID) => {
      this.processSinglePlayerMove(gameState, playerID)
    })
  }

  private processSinglePlayerMove(gameState: SnakeGameState, playerID: string): void {
    let moveIndex = gameState.playerMoves[playerID]
    const snake = gameState.newSnakes[playerID]
        const headIndex = snake[0]
        const allowedMoves = this.getAdjacentIndices(
          headIndex,
      gameState.boardWidth,
      gameState.boardHeight,
        )

        // Player didn't submit a valid move or move is invalid
        if (!moveIndex || !allowedMoves.includes(moveIndex)) {
      moveIndex = this.getDefaultMove(snake, allowedMoves, gameState.boardWidth, playerID)
    }

    // Move the snake
    this.moveSnake(snake, moveIndex)
  }

  private getDefaultMove(snake: number[], allowedMoves: number[], boardWidth: number, playerID: string): number {
          const direction = this.getLastDirection(snake, boardWidth)

          if (direction) {
      const headIndex = snake[0]
            const newX = (headIndex % boardWidth) + direction.dx
            const newY = Math.floor(headIndex / boardWidth) + direction.dy
      return newY * boardWidth + newX
          } else {
            // No previous direction, choose a default move
            if (allowedMoves.length > 0) {
        return allowedMoves[0]
            } else {
              // No valid moves, eliminate the player
            logger.warn(
              `Snek: Player ${playerID} did not submit a move and has no previous direction.`,
            )
        return snake[0] + 1
      }
    }
  }

  private moveSnake(snake: number[], moveIndex: number): void {
    // Remove the last element of the snake (tail)
    snake.pop()
    // Add the latest move index to the start of the snake (new head position)
    snake.unshift(moveIndex)
  }

  private detectAndHandleCollisions(gameState: SnakeGameState): void {
    // Wall collisions
    this.checkWallCollisions(gameState)
    
    // Hazard collisions
    this.checkHazardCollisions(gameState)
    
    // Self collisions
    this.checkSelfCollisions(gameState)
    
    // Snake-to-snake collisions
    this.checkSnakeCollisions(gameState)
    
    // Remove dead players
    this.removeDeadPlayers(gameState)
  }

  private checkHazardCollisions(gameState: SnakeGameState): void {
    if (!gameState.newHazards.length) return

    gameState.newAlivePlayers.forEach((playerID) => {
      const snake = gameState.newSnakes[playerID]
      const headIndex = snake[0]

      if (gameState.newHazards.includes(headIndex)) {
        gameState.deadPlayers.add(playerID)
        snake.forEach((position) => {
          gameState.clashes.push({
            index: position,
            playerIDs: [playerID],
            reason: "Entered hazard",
          })
        })
        logger.info(
          `Snek: Player ${playerID} entered hazard at position ${headIndex}.`,
        )
      }
    })
  }

  private checkWallCollisions(gameState: SnakeGameState): void {
    const walls = this.getWallPositions(gameState.boardWidth, gameState.boardHeight)
    
    gameState.newAlivePlayers.forEach((playerID) => {
      const snake = gameState.newSnakes[playerID]
      const headIndex = snake[0]
      
      if (walls.includes(headIndex)) {
        gameState.deadPlayers.add(playerID)
          snake.forEach((position) => {
          gameState.clashes.push({
              index: position,
              playerIDs: [playerID],
              reason: "Collided with wall",
            })
          })
          logger.info(
          `Snek: Player ${playerID} collided with a wall at position ${headIndex}.`,
        )
      }
    })
  }

  private checkSelfCollisions(gameState: SnakeGameState): void {
    gameState.newAlivePlayers.forEach((playerID) => {
      const snake = gameState.newSnakes[playerID]
      const headIndex = snake[0]
      
      // Self-collision check (snake hits its own body)
      if (snake.slice(1).includes(headIndex)) {
        gameState.deadPlayers.add(playerID)
          snake.forEach((position) => {
          gameState.clashes.push({
              index: position,
              playerIDs: [playerID],
              reason: "Collided with own body",
            })
          })
          logger.info(
          `Snek: Player ${playerID} collided with its own body at position ${headIndex}.`,
        )
      }
    })
  }

  private checkSnakeCollisions(gameState: SnakeGameState): void {
    // Build occupied positions and head positions
      const newOccupiedPositions: { [position: number]: string[] } = {}
      const headPositions: { [position: number]: string[] } = {}

    Object.keys(gameState.newSnakes).forEach((playerID) => {
      const snake = gameState.newSnakes[playerID]
        snake.forEach((pos, index) => {
          if (!newOccupiedPositions[pos]) {
            newOccupiedPositions[pos] = []
          }
          newOccupiedPositions[pos].push(playerID)

          if (index === 0) {
            // Head position
            if (!headPositions[pos]) {
              headPositions[pos] = []
            }
            headPositions[pos].push(playerID)
          }
        })
      })

      // Detect head-to-head and head-to-body collisions
      Object.keys(headPositions).forEach((posStr) => {
        const position = parseInt(posStr)
        const playersAtHead = headPositions[position]

        if (playersAtHead.length > 1) {
          // Head-on collision
          let minLength = Infinity
          playersAtHead.forEach((playerID) => {
          minLength = Math.min(minLength, gameState.newSnakes[playerID].length)
          })

          playersAtHead.forEach((playerID) => {
          if (gameState.newSnakes[playerID].length === minLength) {
            gameState.deadPlayers.add(playerID)
            gameState.newSnakes[playerID].forEach((pos) => {
              gameState.clashes.push({
                  index: pos,
                  playerIDs: playersAtHead,
                  reason: "Head-on collision (shortest snake(s) died)",
                })
              })
            }
          })
        } else {
          const playerID = playersAtHead[0]
          const otherPlayersAtPosition = newOccupiedPositions[position].filter(
            (id) => id !== playerID,
          )

          if (otherPlayersAtPosition.length > 0) {
          gameState.deadPlayers.add(playerID)
          gameState.newSnakes[playerID].forEach((pos) => {
            gameState.clashes.push({
                index: pos,
                playerIDs: [playerID, ...otherPlayersAtPosition],
                reason: "Collided with another snake's body",
              })
            })
          }
        }
      })
  }

  private removeDeadPlayers(gameState: SnakeGameState): void {
    gameState.deadPlayers.forEach((playerID) => {
      const index = gameState.newAlivePlayers.indexOf(playerID)
        if (index !== -1) {
        gameState.newAlivePlayers.splice(index, 1)
      }
      delete gameState.newSnakes[playerID]
      delete gameState.newPlayerHealth[playerID]
    })
  }

  private processFoodAndHealth(gameState: SnakeGameState): void {
    Object.keys(gameState.newSnakes).forEach((playerID) => {
      this.processPlayerFoodAndHealth(gameState, playerID)
    })
    
    // Remove players who died from starvation
    this.removeDeadPlayers(gameState)
  }

  private processPlayerFoodAndHealth(gameState: SnakeGameState, playerID: string): void {
    const snake = gameState.newSnakes[playerID]
        const headPosition = snake[0]

    const foodIndex = gameState.newFood.indexOf(headPosition)
        if (foodIndex !== -1) {
      // Player ate food
      gameState.newFood.splice(foodIndex, 1)
      snake.push(snake[snake.length - 1]) // Grow snake (duplicate tail)
      gameState.newPlayerHealth[playerID] = 100 // Restore health
        } else {
      // Player didn't eat food, lose health
      gameState.newPlayerHealth[playerID] -= 1
      if (gameState.newPlayerHealth[playerID] <= 0) {
        gameState.deadPlayers.add(playerID)
            snake.forEach((pos) => {
          gameState.clashes.push({
                index: pos,
                playerIDs: [playerID],
                reason: "Died due to zero health",
              })
            })
          }
        }
  }

  private generateNewFood(gameState: SnakeGameState): void {
      if (Math.random() < this.foodSpawnChance) {
        const freePositions = this.getFreePositions(
        gameState.boardWidth,
        gameState.boardHeight,
        gameState.newSnakes,
        gameState.newFood,
        gameState.newHazards,
        )
        if (freePositions.length > 0) {
          const randomIndex = Math.floor(Math.random() * freePositions.length)
        gameState.newFood.push(freePositions[randomIndex])
      }
    }
  }

  protected calculateWinners(gameState: SnakeGameState): Winner[] {
    const currentTurnNumber = this.gameState.turns.length

    if (this.maxTurns !== undefined && currentTurnNumber >= this.maxTurns) {
      return this.calculateSurvivalWinners(gameState)
    }

    if (gameState.newAlivePlayers.length <= 1) {
      return this.calculateSurvivalWinners(gameState)
    }
    return []
  }

  protected calculateSurvivalWinners(gameState: SnakeGameState): Winner[] {
        // Get the latest turn scores (game-specific scores like snake lengths) instead of counting survival turns
        const latestTurn = this.gameState.turns[this.gameState.turns.length - 1]
        const latestScores = latestTurn?.scores || {}

        // Create winners array using actual game scores from turn data
        const winners = this.gameSetup.gamePlayers.map(player => ({
          playerID: player.id,
          score: latestScores[player.id] || 0,  // Use game-specific score (snake length)
          winningSquares: gameState.newSnakes[player.id] ?? []
        }))

        // Sort winners by actual game scores in descending order
        winners.sort((a, b) => b.score - a.score)
    
        return winners
  }

  protected createNewTurn(currentTurn: Turn, gameState: SnakeGameState, winners: Winner[]): Turn {
    // Update allowed moves
    gameState.newAllowedMoves = this.calculateAllowedMoves(
      gameState.newSnakes,
      gameState.boardWidth,
      gameState.boardHeight,
    )

    // Update scores based on current snake lengths
    Object.keys(gameState.newSnakes).forEach((playerID) => {
      // If player is dead, score should be 0
      if (gameState.deadPlayers.has(playerID)) {
        gameState.newScores[playerID] = 0;
      } else {
        gameState.newScores[playerID] = gameState.newSnakes[playerID].length;
      }
    })

    // Ensure alivePlayers only contains players who actually have snakes
    const validAlivePlayers = gameState.newAlivePlayers.filter(playerID => {
      return gameState.newSnakes[playerID] && gameState.newSnakes[playerID].length > 0;
    });

    const now = Date.now()
    return {
      ...currentTurn,
      playerHealth: gameState.newPlayerHealth,
      startTime: Timestamp.fromMillis(now),
      endTime: Timestamp.fromMillis(now + this.gameSetup.maxTurnTime * 1000),
      scores: gameState.newScores,
      alivePlayers: validAlivePlayers,
      food: gameState.newFood,
      hazards: gameState.newHazards,
      playerPieces: gameState.newSnakes,
      allowedMoves: gameState.newAllowedMoves,
      clashes: gameState.clashes,
      moves: gameState.playerMoves,
      winners: winners,
    }
  }

  // Helper methods that were in the original implementation
  private initializeSnakes(): { [playerID: string]: number[] } {
    const { boardWidth, gamePlayers } = this.gameSetup
    const positions = this.generateStartingPositions()
    const playerPieces: { [playerID: string]: number[] } = {}

    gamePlayers.forEach((player, index) => {
      const { x, y } = positions[index]
      const startIndex = y * boardWidth + x
      const snake = [startIndex, startIndex, startIndex]
      playerPieces[player.id] = snake
    })

    return playerPieces
  }

  private initializeFood(
    boardWidth: number,
    boardHeight: number,
    playerPieces: { [playerID: string]: number[] },
    hazards: number[],
  ): number[] {
    const occupiedPositions = new Set<number>()

    // Add snake positions to occupied positions
    Object.values(playerPieces).forEach((snake) => {
      snake.forEach((position) => occupiedPositions.add(position))
    })

    // Add hazard positions
    hazards.forEach((position) => occupiedPositions.add(position))

    // Add wall positions to the occupied set
    const wallPositions = this.getWallPositions(boardWidth, boardHeight)
    wallPositions.forEach((position) => occupiedPositions.add(position))

    const foodPositions: number[] = []

    // Place food in the center of the board
    const centerX = Math.floor(boardWidth / 2)
    const centerY = Math.floor(boardHeight / 2)
    const centerPosition = centerY * boardWidth + centerX
    if (!occupiedPositions.has(centerPosition)) {
      foodPositions.push(centerPosition)
      occupiedPositions.add(centerPosition)
    } else {
      // Fallback: choose any free space that is not hazard/wall/snake
      const fallbackPositions = this.getFreePositions(
        boardWidth,
        boardHeight,
        playerPieces,
        foodPositions,
        hazards,
      )
      if (fallbackPositions.length > 0) {
        foodPositions.push(fallbackPositions[0])
        occupiedPositions.add(fallbackPositions[0])
      }
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
          if (!occupiedPositions.has(foodPosition)) {
            foodPositions.push(foodPosition)
            occupiedPositions.add(foodPosition)
            break
          }
        }
      }
    })

    return foodPositions
  }

  private getWallPositions(boardWidth: number, boardHeight: number): number[] {
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

  private calculateAllowedMoves(
    playerPieces: { [playerID: string]: number[] },
    boardWidth: number,
    boardHeight: number,
  ): { [playerID: string]: number[] } {
    const allowedMoves: { [playerID: string]: number[] } = {}

    Object.keys(playerPieces).forEach((playerID) => {
      const snake = playerPieces[playerID]
      const headIndex = snake[0]
      const adjacentIndices = this.getAdjacentIndices(
        headIndex,
        boardWidth,
        boardHeight,
      )

      // Allow all adjacent moves, including potentially unsafe ones
      allowedMoves[playerID] = adjacentIndices
    })

    return allowedMoves
  }

  private getAdjacentIndices(
    index: number,
    boardWidth: number,
    boardHeight: number,
  ): number[] {
    const x = index % boardWidth
    const y = Math.floor(index / boardWidth)
    const indices: number[] = []

    const directions = [
      { dx: 0, dy: -1 }, // Up
      { dx: 0, dy: 1 }, // Down
      { dx: -1, dy: 0 }, // Left
      { dx: 1, dy: 0 }, // Right
    ]

    directions.forEach(({ dx, dy }) => {
      const newX = x + dx
      const newY = y + dy
      if (newX >= 0 && newX < boardWidth && newY >= 0 && newY < boardHeight) {
        indices.push(newY * boardWidth + newX)
      }
    })

    return indices
  }

  private getLastDirection(
    snake: number[],
    boardWidth: number,
  ): { dx: number; dy: number } | null {
    if (snake.length < 2) return null
    const head = snake[0]
    const neck = snake[1]

    const headX = head % boardWidth
    const headY = Math.floor(head / boardWidth)
    const neckX = neck % boardWidth
    const neckY = Math.floor(neck / boardWidth)

    const dx = headX - neckX
    const dy = headY - neckY

    return { dx, dy }
  }

  private getFreePositions(
    boardWidth: number,
    boardHeight: number,
    playerPieces: { [playerID: string]: number[] },
    food: number[],
    hazards: number[],
  ): number[] {
    const totalCells = boardWidth * boardHeight
    const occupied = new Set<number>()

    // Add snake positions
    Object.values(playerPieces).forEach((snake) => {
      snake.forEach((pos) => occupied.add(pos))
    })

    // Add food positions
    food.forEach((pos) => occupied.add(pos))

    // Add hazard positions
    hazards.forEach((pos) => occupied.add(pos))

    // Add wall positions
    const wallPositions = this.getWallPositions(boardWidth, boardHeight)
    wallPositions.forEach((pos) => occupied.add(pos))

    const freePositions: number[] = []
    for (let i = 0; i < totalCells; i++) {
      if (!occupied.has(i)) {
        freePositions.push(i)
      }
    }

    return freePositions
  }

  private generateHazardPositions(
    boardWidth: number,
    boardHeight: number,
    playerPieces: { [playerID: string]: number[] },
  ): number[] {
    const hazardPercentage = Math.max(
      0,
      Math.min(100, this.gameSetup.hazardPercentage ?? 0),
    )
    if (hazardPercentage <= 0) return []

    const candidatePositions = this.getFreePositions(
      boardWidth,
      boardHeight,
      playerPieces,
      [],
      [],
    )

    if (candidatePositions.length === 0) return []

    const targetCount = Math.floor(
      (candidatePositions.length * hazardPercentage) / 100,
    )
    if (targetCount <= 0) return []

    // Shuffle candidate positions for randomness
    for (let i = candidatePositions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[candidatePositions[i], candidatePositions[j]] = [
        candidatePositions[j],
        candidatePositions[i],
      ]
    }

    const initialHazards = candidatePositions.slice(0, targetCount)
    const safeHazards = this.ensureInitialSafeMoves(
      initialHazards,
      playerPieces,
      boardWidth,
      boardHeight,
    )
    return this.ensureConnectedBoard(
      safeHazards,
      playerPieces,
      boardWidth,
      boardHeight,
    )
  }

  // Ensure each player has at least one safe adjacent move on turn 0
  private ensureInitialSafeMoves(
    hazards: number[],
    playerPieces: { [playerID: string]: number[] },
    boardWidth: number,
    boardHeight: number,
  ): number[] {
    const hazardSet = new Set(hazards)
    const walls = new Set(this.getWallPositions(boardWidth, boardHeight))

    const occupied = new Set<number>()
    Object.values(playerPieces).forEach((snake) => {
      snake.forEach((pos) => occupied.add(pos))
    })

    Object.values(playerPieces).forEach((snake) => {
      const head = snake[0]
      const neighbors = this.getAdjacentIndices(head, boardWidth, boardHeight)
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
              boardWidth,
              boardHeight,
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
    boardWidth: number,
    boardHeight: number,
  ): number[] {
    const hazardSet = new Set(hazards)
    const walls = new Set(this.getWallPositions(boardWidth, boardHeight))
    const occupied = new Set<number>()
    Object.values(playerPieces).forEach((snake) => {
      snake.forEach((pos) => occupied.add(pos))
    })

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
        const neighbors = this.getAdjacentIndices(
          current,
          boardWidth,
          boardHeight,
        )
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
          boardWidth,
          boardHeight,
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

  private generateStartingPositions(): { x: number; y: number }[] {
    const { boardWidth, boardHeight, gamePlayers } = this.gameSetup
    const positions: { x: number; y: number }[] = []

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
    positions.push(
      { x: startX, y: startY },
      { x: endX, y: startY },
      { x: startX, y: endY },
      { x: endX, y: endY },
    )

    let depth = 0
    while (positions.length < gamePlayers.length) {
      const newPositions: { x: number; y: number }[] = []
      for (const edge of edges) {
        const midpoints = this.getMidpoints(edge.start, edge.end, depth)
        newPositions.push(...midpoints)
      }

      // Filter out duplicates and add new positions
      newPositions.forEach((pos) => {
        if (!positions.some((p) => p.x === pos.x && p.y === pos.y)) {
          positions.push(pos)
        }
      })

      depth++

      // If we can't add more positions on the edges, break the loop
      if (newPositions.length === 0) break
    }

    // If we still need more positions, fill the inner part
    if (positions.length < gamePlayers.length) {
      this.fillInnerPositions(positions)
    }

    return positions.slice(0, gamePlayers.length)
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

  // Method for testing/visualization
  visualizeBoard(turn: Turn): string {
    const { boardWidth, boardHeight } = this.gameSetup
    const board: string[][] = Array(boardHeight).fill(null).map(() => Array(boardWidth).fill("."))
    
    // Add walls
    const walls = this.getWallPositions(boardWidth, boardHeight)
    walls.forEach(pos => {
      const x = pos % boardWidth
      const y = Math.floor(pos / boardWidth)
      board[y][x] = "#"
    })
    
    // Add food
    turn.food.forEach(pos => {
      const x = pos % boardWidth
      const y = Math.floor(pos / boardWidth)
      board[y][x] = "F"
    })
    
    // Add snakes
    Object.entries(turn.playerPieces).forEach(([playerID, snake]) => {
      const playerNumber = this.gameSetup.gamePlayers.findIndex(p => p.id === playerID) + 1
      snake.forEach(pos => {
        const x = pos % boardWidth
        const y = Math.floor(pos / boardWidth)
        board[y][x] = playerNumber.toString()
      })
    })
    
    return board.map(row => row.join(" ")).join("\n")
  }
}
