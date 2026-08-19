import { ActiveEffect, Clash, GamePlayer, GameState, Move, StartedGameSetup, Turn, UnitType, Winner } from "@shared/types/Game"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "../logger"
import {
  DEFAULT_PAWN_PROMOTION_WEIGHT,
  Orientation,
  ORTHOGONALS,
  isPieceType,
  planPieceAction,
  spawnOrientation,
  toXY,
} from "./chess/pieceMoves"
import { SimUnit, runChessTurnSim } from "./chess/chessTurnSim"
import { assignCellsToSlices, sliceDistance } from "../utils/radialSlices"

export interface SnakeGameState {
  // Input data
  boardWidth: number
  boardHeight: number
  
  // Mutable game state
  newSnakes: { [playerID: string]: number[] }
  newFood: number[]
  newHazards: number[]
  newPlayerHealth: { [playerID: string]: number }
  newAlivePlayers: string[]
  newInvulnerabilityPotions: number[]
  playerInvulnerabilityLevel: { [playerID: string]: number }
  activeEffects: ActiveEffect[]
  
  // Processing data
  playerMoves: { [playerID: string]: number }
  deadPlayers: Set<string>
  clashes: Clash[]
  vulnerableSnakesCollided: Set<string>
  
  // Computed data
  newScores: { [playerID: string]: number }

  // Per-unit orientation, seeded from the current turn and rewritten by
  // updateOrientation once the turn's movement and deaths have resolved.
  orientation: { [playerID: string]: Orientation }

  // Chess-piece games only (see docs/chess-pieces.md)
  unitTypes?: { [playerID: string]: UnitType }
  piecePaths?: { [playerID: string]: number[] } // squares traversed this turn
  pieceMoveCosts?: { [playerID: string]: number }
}

// The board projection the team scoring/win logic works on. Built either from
// the in-flight SnakeGameState or from a committed Turn.
interface TeamBoardView {
  alive: string[]
  pieces: Record<string, number[]>
}

export class TeamSnekProcessor {
  protected gameSetup: StartedGameSetup
  protected gameState: GameState
  private foodSpawnRate: number
  protected maxTurns?: number
  private fertileTiles: number[] = []

  constructor(gameState: GameState) {
    this.gameSetup = gameState.setup
    this.gameState = gameState
    this.maxTurns = gameState.setup.maxTurns
    const rawRate = gameState.setup.foodSpawnRate ?? 0.5
    this.foodSpawnRate = rawRate > 5 ? rawRate / 100 : rawRate
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

  // Walls never change after game start (they are the board perimeter), so
  // they are stored once on the game document rather than on every turn.
  getWalls(): number[] {
    const { boardWidth, boardHeight } = this.gameSetup
    return this.getWallPositions(boardWidth, boardHeight)
  }

  generatePreviewBoard(): {
    fertileTiles: number[]
    hazards: number[]
    playerPositions: { [playerID: string]: number }
    food: number[]
  } {
    const { boardWidth, boardHeight, gamePlayers } = this.gameSetup

    const { playerPieces } = this.initializeSnakes()

    const walls = this.getWallPositions(boardWidth, boardHeight)
    const hazards = this.generateHazardPositions(boardWidth, boardHeight, playerPieces)
    const fertileTiles = this.generateFertileTiles(boardWidth, boardHeight, walls, hazards, playerPieces)
    const food = this.initializeFood(boardWidth, boardHeight, playerPieces, hazards)

    const playerPositions: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      const snake = playerPieces[player.id]
      if (snake && snake.length > 0) {
        playerPositions[player.id] = snake[0]
      }
    })

    return { fertileTiles, hazards, playerPositions, food }
  }

  private initializeTurn(): Turn {
    const { boardWidth, boardHeight, gamePlayers } = this.gameSetup

    const usePreview = this.gameSetup.usePreviewBoard === true

    let playerPieces: { [playerID: string]: number[] }
    let teamClusterFallback: boolean
    const presetPositions = this.gameSetup.presetPlayerPositions
    if (usePreview && presetPositions && Object.keys(presetPositions).length === gamePlayers.length) {
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

    const walls = this.getWallPositions(boardWidth, boardHeight)

    const hazards = usePreview && this.gameSetup.presetHazards && this.gameSetup.presetHazards.length > 0
      ? this.gameSetup.presetHazards
      : this.generateHazardPositions(boardWidth, boardHeight, playerPieces)

    this.fertileTiles = usePreview && this.gameSetup.presetFertileTiles && this.gameSetup.presetFertileTiles.length > 0
      ? this.gameSetup.presetFertileTiles
      : this.generateFertileTiles(boardWidth, boardHeight, walls, hazards, playerPieces)

    const food = usePreview && this.gameSetup.presetFood && this.gameSetup.presetFood.length > 0
      ? this.gameSetup.presetFood
      : this.initializeFood(boardWidth, boardHeight, playerPieces, hazards)

    // Initialize player health (per-type configurable max, default 100)
    const initialHealth: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      initialHealth[player.id] = this.maxHealthFor(player.unitType)
    })

    // Initialize scores (score = length/weight: snakes spawn at 3, pieces at 1)
    const initialScores: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      initialScores[player.id] = isPieceType(player.unitType) ? 1 : 3
    })

    const initialInvulnerabilityLevel: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      initialInvulnerabilityLevel[player.id] = 0
    })

    // Spawn orientation: every unit faces toward the board centre, chosen
    // from its type's legal orientation set (ties resolve uniformly at
    // random).
    const orientation: { [playerID: string]: Orientation } = {}
    gamePlayers.forEach((player) => {
      orientation[player.id] = spawnOrientation(
        player.unitType ?? "snake",
        playerPieces[player.id][0],
        boardWidth,
        boardHeight,
      )
    })

    const firstTurn: Turn = {
      playerHealth: initialHealth,
      // Placeholder window. The turn deadline has exactly one writer: the
      // caller that commits the turn (startGame for turn 0, processTurn for
      // turns 1..n) stamps the real startTime/endTime — that is where the
      // firstTurnTime-vs-maxTurnTime distinction lives.
      startTime: Timestamp.fromMillis(0),
      endTime: Timestamp.fromMillis(0),
      scores: initialScores,
      alivePlayers: gamePlayers.map((player) => player.id),
      food: food,
      hazards: hazards,
      playerPieces: playerPieces,
      clashes: [],
      moves: {},
      winners: [],
      teamClusterFallback,
      ...(this.fertileTiles.length > 0 ? { fertileTiles: this.fertileTiles } : {}),
      invulnerabilityPotions: [],
      playerInvulnerabilityLevel: initialInvulnerabilityLevel,
      activeEffects: [],
      orientation,
    }

    if (this.hasPieceUnits()) {
      const unitTypes: { [playerID: string]: UnitType } = {}
      gamePlayers.forEach((player) => {
        unitTypes[player.id] = player.unitType ?? "snake"
      })
      firstTurn.unitTypes = unitTypes
      firstTurn.paths = {}
    }

    return firstTurn
  }

  applyMoves(currentTurn: Turn, moves: Move[]): Turn {
    try {
      if (currentTurn.fertileTiles && currentTurn.fertileTiles.length > 0) {
        this.fertileTiles = currentTurn.fertileTiles
      }
      const currentTurnNumber = this.gameState.turns.length

      // Games with chess pieces resolve through the within-turn sub-step
      // simulation; snake-only games keep the original single-pass path.
      if (this.hasPieceUnits()) {
        return this.applyMovesChess(currentTurn, moves, currentTurnNumber)
      }

      // 1. Setup
      const gameState = this.initializeGameState(currentTurn)
      const originSquares = this.captureOriginSquares(gameState)

      // 2. Process moves
      this.processPlayerMoves(gameState, moves)

      // 3. Handle collisions (tiered by invulnerability level)
      this.detectAndHandleCollisions(gameState)

      // 4. Process food and health
      this.processFoodAndHealth(gameState)

      // Orientation rewrites after the last phase that can kill, so the map it
      // rebuilds holds exactly the units still on the board.
      this.updateOrientation(gameState, originSquares)

      // 5. Process invulnerability potion collection
      this.processInvulnerabilityPotionCollection(gameState, currentTurnNumber)
      
      // 6. Generate new food
      this.generateNewFood(gameState)

      // 7. Generate new invulnerability potions
      this.generateNewInvulnerabilityPotions(gameState)

      // 8. Expire effects (end of turn so visual state matches next turn's collisions)
      this.expireEffects(gameState, currentTurnNumber)
      
      // 9. Calculate winners
      const winners = this.calculateWinners(gameState)
      
      // 10. Create new turn
      return this.createNewTurn(currentTurn, gameState, winners)
      
    } catch (error) {
      logger.error(`Snek: Error applying moves:`, error)
      throw error
    }
  }

  protected hasPieceUnits(): boolean {
    return this.gameSetup.gamePlayers.some((p) => isPieceType(p.unitType))
  }

  // Max health for a unit type: per-type config with a universal default of
  // 100. An absent type means "snake".
  private maxHealthFor(type: UnitType | undefined): number {
    return this.gameSetup.maxHealthPerUnit?.[type ?? "snake"] ?? 100
  }

  // Health lost per hazard square entered (and per turn spent sitting on
  // one, for stationary pieces). Default 100: usually lethal.
  private hazardDamage(): number {
    return this.gameSetup.hazardDamage ?? 100
  }

  // Turn resolution for games that include chess pieces. Same phase order as
  // the snake-only path, with movement + collisions handled by the within-turn
  // sub-step simulation, plus movement health costs, regicide and promotion.
  private applyMovesChess(currentTurn: Turn, moves: Move[], currentTurnNumber: number): Turn {
    const gameState = this.initializeGameState(currentTurn)

    // Current unit types, carried turn to turn.
    const unitTypes: { [playerID: string]: UnitType } = {}
    this.gameSetup.gamePlayers.forEach((p) => {
      unitTypes[p.id] = currentTurn.unitTypes?.[p.id] ?? p.unitType ?? "snake"
    })
    gameState.unitTypes = unitTypes
    const originSquares = this.captureOriginSquares(gameState)

    // 2. Validate staged moves into per-unit paths (no board mutation yet)
    const plannedPaths = this.planChessMoves(gameState, moves)

    // 3. Within-turn simulation: movement + all collisions
    this.runChessSimulation(gameState, plannedPaths)
    this.scheduleVulnerableCollisionBuffExpiry(gameState)
    this.removeDeadPlayers(gameState)

    // 4. Food and health (movement costs resolve here, at end of turn)
    this.processFoodAndHealth(gameState)

    // 5. Regicide: a team configured with kings dies with its last king
    this.applyRegicide(gameState)

    // Orientation rewrites after the last phase that can kill, so the map it
    // rebuilds holds exactly the units still on the board — and before
    // promotion, so a pawn that promotes this turn keeps its pawn orientation.
    this.updateOrientation(gameState, originSquares)

    // 6-8. Potions, spawns, effect expiry (unchanged phases)
    this.processInvulnerabilityPotionCollection(gameState, currentTurnNumber)
    this.generateNewFood(gameState)
    this.generateNewInvulnerabilityPotions(gameState)
    this.expireEffects(gameState, currentTurnNumber)

    // Pawns that grew to the threshold promote after the food phase, so a pawn
    // that eats into the threshold promotes the same turn. The weight reset it
    // applies lands after every phase that reads weight (collisions, regicide)
    // and before winners and turn assembly, so scores and adjudication see the
    // promoted queen at weight 1.
    this.applyPawnPromotions(gameState)

    // 9-10. Winners and turn assembly
    const winners = this.calculateWinners(gameState)
    return this.createNewTurn(currentTurn, gameState, winners)
  }

  // Head squares before movement resolves, threaded into updateOrientation
  // once it has.
  private captureOriginSquares(gameState: SnakeGameState): { [playerID: string]: number } {
    const originSquares: { [playerID: string]: number } = {}
    gameState.newAlivePlayers.forEach((playerID) => {
      originSquares[playerID] = gameState.newSnakes[playerID][0]
    })
    return originSquares
  }

  // Rewrites orientation for the turn. The map is rebuilt from the units
  // still on the board, so dead units drop out. A unit that moved faces its
  // movement direction — sliders and kings the unit step (e.g. {1,0},
  // {1,1}), knights their exact L-offset (e.g. {1,-2}), snakes head minus
  // the origin square the head left (the neck position at move time, so the
  // rule holds even for a snake severed down to its head or one that grew
  // this turn). Pawns change orientation only via their rotation action, which
  // planChessMoves already applied. Units that held keep their orientation.
  private updateOrientation(
    gameState: SnakeGameState,
    originSquares: { [playerID: string]: number },
  ): void {
    const orientation: { [playerID: string]: Orientation } = {}
    const { boardWidth } = gameState
    Object.keys(gameState.newSnakes).forEach((playerID) => {
      orientation[playerID] = gameState.orientation[playerID]
      const type = gameState.unitTypes?.[playerID] ?? "snake"
      if (type === "pawn") return

      let from: number
      let to: number
      if (type === "snake") {
        from = originSquares[playerID]
        to = gameState.newSnakes[playerID][0]
      } else {
        const traversed = gameState.piecePaths?.[playerID]
        if (!traversed || traversed.length === 0) return // held
        from = originSquares[playerID]
        to = traversed[0]
      }
      if (from === to) return

      const f = toXY(from, boardWidth)
      const t = toXY(to, boardWidth)
      const dx = t.x - f.x
      const dy = t.y - f.y
      orientation[playerID] =
        type === "knight" ? { dx, dy } : { dx: Math.sign(dx), dy: Math.sign(dy) }
    })
    gameState.orientation = orientation
  }

  private planChessMoves(
    gameState: SnakeGameState,
    moves: Move[],
  ): { [playerID: string]: number[] } {
    moves.forEach((move) => {
      gameState.playerMoves[move.playerID] = move.move
    })

    // Squares a pawn may step to diagonally: food or any unit, at turn start.
    const pawnTargets = new Set<number>(gameState.newFood)
    Object.values(gameState.newSnakes).forEach((body) => {
      body.forEach((pos) => pawnTargets.add(pos))
    })

    const plannedPaths: { [playerID: string]: number[] } = {}
    gameState.newAlivePlayers.forEach((playerID) => {
      const type = gameState.unitTypes?.[playerID] ?? "snake"
      if (type === "snake") {
        const moveIndex = this.resolveSnakeMoveIndex(gameState, playerID)
        gameState.playerMoves[playerID] = moveIndex
        plannedPaths[playerID] = [moveIndex]
        return
      }

      const origin = gameState.newSnakes[playerID][0]
      const staged = gameState.playerMoves[playerID]
      const action =
        staged === undefined
          ? { kind: "stay" as const }
          : planPieceAction(
              type,
              origin,
              staged,
              gameState.boardWidth,
              gameState.boardHeight,
              gameState.orientation[playerID],
              pawnTargets,
            ) ?? { kind: "stay" as const } // illegal destination → stay

      if (action.kind === "move") {
        plannedPaths[playerID] = action.path
        gameState.playerMoves[playerID] = action.path[action.path.length - 1]
      } else {
        if (action.kind === "rotate") {
          gameState.orientation[playerID] = action.orientation
        }
        plannedPaths[playerID] = []
        gameState.playerMoves[playerID] = origin
      }
    })
    return plannedPaths
  }

  private runChessSimulation(
    gameState: SnakeGameState,
    plannedPaths: { [playerID: string]: number[] },
  ): void {
    const simUnits: SimUnit[] = gameState.newAlivePlayers.map((playerID) => {
      const type = gameState.unitTypes?.[playerID] ?? "snake"
      return {
        id: playerID,
        type,
        isSnake: type === "snake",
        body: gameState.newSnakes[playerID],
        tier: gameState.playerInvulnerabilityLevel[playerID] ?? 0,
        path: plannedPaths[playerID] ?? [],
        health: gameState.newPlayerHealth[playerID],
      }
    })

    const result = runChessTurnSim(
      simUnits,
      gameState.boardWidth,
      gameState.boardHeight,
      gameState.newHazards,
      this.getWallPositions(gameState.boardWidth, gameState.boardHeight),
      this.hazardDamage(),
    )

    gameState.clashes.push(...result.clashes)
    // Hazard entry doses were deducted inside the sim; carry the post-hazard
    // healths forward so the food phase settles movement costs on top.
    result.healths.forEach((health, playerID) => {
      gameState.newPlayerHealth[playerID] = health
    })
    result.deadIDs.forEach((playerID) => {
      gameState.deadPlayers.add(playerID)
      if ((result.deadTiers.get(playerID) ?? 0) < 0) {
        gameState.vulnerableSnakesCollided.add(playerID)
      }
    })

    gameState.piecePaths = {}
    gameState.pieceMoveCosts = {}
    result.traversed.forEach((squares, playerID) => {
      if (squares.length > 0) gameState.piecePaths![playerID] = squares
      gameState.pieceMoveCosts![playerID] = squares.length
    })
    // The applied move is the square the piece actually ended on (a truncated
    // slider records its stop square; a dead piece the square it died on).
    result.finalSquare.forEach((square, playerID) => {
      gameState.playerMoves[playerID] = square
    })
  }

  // Kings never change type (promotion only creates queens), so the setup's
  // unitType is authoritative for which teams play under regicide.
  private applyRegicide(gameState: SnakeGameState): void {
    const players = this.gameSetup.gamePlayers
    const kingTeams = new Set(
      players.filter((p) => p.unitType === "king").map((p) => p.teamID),
    )
    let anyEliminated = false
    kingTeams.forEach((teamID) => {
      const kingAlive = players.some(
        (p) =>
          p.teamID === teamID &&
          p.unitType === "king" &&
          gameState.newAlivePlayers.includes(p.id) &&
          !gameState.deadPlayers.has(p.id),
      )
      if (kingAlive) return

      players
        .filter((p) => p.teamID === teamID)
        .forEach((p) => {
          if (!gameState.newAlivePlayers.includes(p.id) || gameState.deadPlayers.has(p.id)) return
          gameState.deadPlayers.add(p.id)
          anyEliminated = true
          new Set(gameState.newSnakes[p.id] ?? []).forEach((index) => {
            gameState.clashes.push({
              index,
              playerIDs: [p.id],
              reason: "Team eliminated: king fell",
            })
          })
        })
      logger.info(`Snek: Team ${teamID} eliminated — its last king fell.`)
    })
    if (anyEliminated) this.removeDeadPlayers(gameState)
  }

  private applyPawnPromotions(gameState: SnakeGameState): void {
    if (!gameState.unitTypes) return
    const threshold = this.gameSetup.pawnPromotionWeight ?? DEFAULT_PAWN_PROMOTION_WEIGHT
    gameState.newAlivePlayers.forEach((playerID) => {
      if (
        gameState.unitTypes![playerID] === "pawn" &&
        (gameState.newSnakes[playerID]?.length ?? 0) >= threshold
      ) {
        gameState.unitTypes![playerID] = "queen"
        // Promotion trades the accumulated mass for the queen's mobility: the
        // stack collapses to the single square the unit occupies, weight 1.
        // The unit stays on the board (weight 1, not 0), so it is never
        // eliminated by promoting — only its score drops.
        gameState.newSnakes[playerID] = [gameState.newSnakes[playerID][0]]
        // A promoted pawn may carry more health than a queen is allowed:
        // clamp to the queen's configured max. Health is not otherwise
        // touched — only eating restores it.
        const queenMax = this.maxHealthFor("queen")
        if (gameState.newPlayerHealth[playerID] > queenMax) {
          gameState.newPlayerHealth[playerID] = queenMax
        }
        logger.info(`Snek: Pawn ${playerID} promoted to queen at weight 1.`)
      }
    })
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

    const playerInvulnerabilityLevel: { [playerID: string]: number } = {}
    alivePlayers.forEach((playerID) => {
      playerInvulnerabilityLevel[playerID] = currentTurn.playerInvulnerabilityLevel?.[playerID] ?? 0
    })

    return {
      boardWidth,
      boardHeight,
      newSnakes,
      newFood: [...food],
      newHazards: [...hazards],
      newPlayerHealth: { ...playerHealth },
      newAlivePlayers: [...alivePlayers],
      newInvulnerabilityPotions: [...(currentTurn.invulnerabilityPotions ?? [])],
      playerInvulnerabilityLevel,
      activeEffects: (currentTurn.activeEffects ?? []).map(e => ({ ...e })),
      playerMoves: {},
      deadPlayers: new Set(),
      clashes: [],
      vulnerableSnakesCollided: new Set(),
      newScores: {},
      orientation: { ...currentTurn.orientation },
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
    const moveIndex = this.resolveSnakeMoveIndex(gameState, playerID)

    // Record the move actually applied (submitted or default) so the turn's
    // `moves` map is complete for every player. Clients — including centaurs
    // inferring finalized moves — can rely on it as the authoritative applied
    // move rather than reconstructing defaults.
    gameState.playerMoves[playerID] = moveIndex

    // Move the snake
    this.moveSnake(gameState.newSnakes[playerID], moveIndex)
  }

  // Validates a snake's staged move and substitutes the default (continue
  // straight) when missing or illegal. Does not mutate the board.
  private resolveSnakeMoveIndex(gameState: SnakeGameState, playerID: string): number {
    const moveIndex = gameState.playerMoves[playerID]
    const snake = gameState.newSnakes[playerID]
    const allowedMoves = this.getAdjacentIndices(
      snake[0],
      gameState.boardWidth,
      gameState.boardHeight,
    )

    // Player didn't submit a valid move or move is invalid
    if (!moveIndex || !allowedMoves.includes(moveIndex)) {
      return this.getDefaultMove(gameState, playerID)
    }
    return moveIndex
  }

  // The default move is one step along the snake's orientation: the
  // direction it last moved, or — on its first move — its spawn orientation,
  // which points toward the board centre from an interior square and is
  // therefore always in-bounds.
  private getDefaultMove(gameState: SnakeGameState, playerID: string): number {
    const { boardWidth } = gameState
    const orientation = gameState.orientation[playerID]
    const headIndex = gameState.newSnakes[playerID][0]
    const newX = (headIndex % boardWidth) + orientation.dx
    const newY = Math.floor(headIndex / boardWidth) + orientation.dy
    return newY * boardWidth + newX
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
    
    // Snake-to-snake collisions (tiered by invulnerability level)
    this.checkSnakeCollisionsTiered(gameState)

    // Schedule ally buff expiry for any vulnerable snakes that collided
    this.scheduleVulnerableCollisionBuffExpiry(gameState)
    
    // Remove dead players
    this.removeDeadPlayers(gameState)
  }

  // Hazards deal a configurable dose on head entry (default 100 — usually
  // lethal). A snake dies here only when the dose leaves it at zero or
  // below; a survivor carries its reduced health into the later collision
  // passes and the food phase. Snakes always move, so the entry dose is the
  // only hazard charge they ever pay.
  private checkHazardCollisions(gameState: SnakeGameState): void {
    if (!gameState.newHazards.length) return

    gameState.newAlivePlayers.forEach((playerID) => {
      const snake = gameState.newSnakes[playerID]
      const headIndex = snake[0]

      if (gameState.newHazards.includes(headIndex)) {
        gameState.newPlayerHealth[playerID] -= this.hazardDamage()
        if (gameState.newPlayerHealth[playerID] > 0) {
          logger.info(
            `Snek: Player ${playerID} entered hazard at position ${headIndex} and survived with ${gameState.newPlayerHealth[playerID]} health.`,
          )
          return
        }
        gameState.deadPlayers.add(playerID)
        if ((gameState.playerInvulnerabilityLevel[playerID] ?? 0) < 0) {
          gameState.vulnerableSnakesCollided.add(playerID)
        }
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
        if ((gameState.playerInvulnerabilityLevel[playerID] ?? 0) < 0) {
          gameState.vulnerableSnakesCollided.add(playerID)
        }
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
        if ((gameState.playerInvulnerabilityLevel[playerID] ?? 0) < 0) {
          gameState.vulnerableSnakesCollided.add(playerID)
        }
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

  private checkSnakeCollisionsTiered(gameState: SnakeGameState): void {
    const alivePlayers = gameState.newAlivePlayers.filter(id => !gameState.deadPlayers.has(id))
    if (alivePlayers.length === 0) return

    const levels = new Set<number>()
    alivePlayers.forEach(id => {
      levels.add(gameState.playerInvulnerabilityLevel[id] ?? 0)
    })
    const sortedLevels = Array.from(levels).sort((a, b) => b - a)

    const allHaveZero = sortedLevels.length === 1 && sortedLevels[0] === 0
    if (allHaveZero) {
      this.checkSnakeCollisionsNormal(gameState)
      return
    }

    const severedPositions = new Set<number>()

    for (const currentLevel of sortedLevels) {
      const playersAtThisLevel = alivePlayers.filter(id =>
        !gameState.deadPlayers.has(id) && (gameState.playerInvulnerabilityLevel[id] ?? 0) === currentLevel
      )
      if (playersAtThisLevel.length === 0) continue

      const bodyPositions: { [position: number]: { playerID: string; segmentIndex: number }[] } = {}
      alivePlayers.forEach(playerID => {
        if (gameState.deadPlayers.has(playerID)) return
        const snake = gameState.newSnakes[playerID]
        if (!snake) return
        snake.forEach((pos, idx) => {
          if (idx > 0) {
            if (!bodyPositions[pos]) bodyPositions[pos] = []
            bodyPositions[pos].push({ playerID, segmentIndex: idx })
          }
        })
      })

      const headPositions: { [position: number]: string[] } = {}
      playersAtThisLevel.forEach(playerID => {
        const snake = gameState.newSnakes[playerID]
        if (!snake) return
        const headPos = snake[0]
        if (!headPositions[headPos]) headPositions[headPos] = []
        headPositions[headPos].push(playerID)
      })

      Object.keys(headPositions).forEach(posStr => {
        const position = parseInt(posStr)
        const headsHere = headPositions[position]

        const allHeadsAtPosition: string[] = []
        alivePlayers.forEach(id => {
          if (!gameState.deadPlayers.has(id) && gameState.newSnakes[id]?.[0] === position) {
            allHeadsAtPosition.push(id)
          }
        })

        if (allHeadsAtPosition.length > 1) {
          const maxLevel = Math.max(...allHeadsAtPosition.map(id => gameState.playerInvulnerabilityLevel[id] ?? 0))

          allHeadsAtPosition.forEach(playerID => {
            const playerLevel = gameState.playerInvulnerabilityLevel[playerID] ?? 0
            if (playerLevel < maxLevel) {
              gameState.deadPlayers.add(playerID)
              if (playerLevel < 0) gameState.vulnerableSnakesCollided.add(playerID)
              gameState.newSnakes[playerID]?.forEach(pos => {
                gameState.clashes.push({
                  index: pos,
                  playerIDs: allHeadsAtPosition,
                  reason: "Head-on collision (lower invulnerability level died)",
                })
              })
            }
          })

          const survivorsAtMaxLevel = allHeadsAtPosition.filter(id =>
            !gameState.deadPlayers.has(id) && (gameState.playerInvulnerabilityLevel[id] ?? 0) === maxLevel
          )
          if (survivorsAtMaxLevel.length > 1) {
            // At most one snake survives a head-on collision: the unique
            // longest snake at the top tier. Any tie for longest kills them all.
            const maxLength = Math.max(...survivorsAtMaxLevel.map(id => gameState.newSnakes[id]?.length ?? 0))
            const longest = survivorsAtMaxLevel.filter(id => (gameState.newSnakes[id]?.length ?? 0) === maxLength)
            const survivor = longest.length === 1 ? longest[0] : null
            survivorsAtMaxLevel.forEach(playerID => {
              if (playerID === survivor) return
              gameState.deadPlayers.add(playerID)
              const playerLevel = gameState.playerInvulnerabilityLevel[playerID] ?? 0
              if (playerLevel < 0) gameState.vulnerableSnakesCollided.add(playerID)
              gameState.newSnakes[playerID]?.forEach(pos => {
                gameState.clashes.push({
                  index: pos,
                  playerIDs: survivorsAtMaxLevel,
                  reason: "Head-on collision (shortest snake(s) died)",
                })
              })
            })
          }
        }

        headsHere.forEach(playerID => {
          if (gameState.deadPlayers.has(playerID)) return
          const snake = gameState.newSnakes[playerID]
          if (!snake) return
          const headPos = snake[0]

          const bodiesAtPos = bodyPositions[headPos]
          if (!bodiesAtPos) return

          bodiesAtPos.forEach(({ playerID: bodyOwnerID }) => {
            if (bodyOwnerID === playerID) return
            if (gameState.deadPlayers.has(bodyOwnerID)) return
            const bodyOwnerLevel = gameState.playerInvulnerabilityLevel[bodyOwnerID] ?? 0

            if (currentLevel > bodyOwnerLevel) {
              const targetSnake = gameState.newSnakes[bodyOwnerID]
              if (!targetSnake) return
              const currentSegIdx = targetSnake.indexOf(headPos, 1)
              if (currentSegIdx === -1) return

              const severedSegments = targetSnake.splice(currentSegIdx)
              severedSegments.forEach(pos => {
                severedPositions.add(pos)
                gameState.clashes.push({
                  index: pos,
                  playerIDs: [playerID, bodyOwnerID],
                  reason: `Body severed by invulnerable snake`,
                })
              })
              logger.info(
                `Snek: Player ${playerID} (level ${currentLevel}) severed player ${bodyOwnerID} (level ${bodyOwnerLevel}) at segment ${currentSegIdx}, removing ${severedSegments.length} segments.`,
              )
              if (bodyOwnerLevel < 0) gameState.vulnerableSnakesCollided.add(bodyOwnerID)
            } else if (currentLevel === bodyOwnerLevel) {
              gameState.deadPlayers.add(playerID)
              if (currentLevel < 0) gameState.vulnerableSnakesCollided.add(playerID)
              gameState.newSnakes[playerID]?.forEach(pos => {
                gameState.clashes.push({
                  index: pos,
                  playerIDs: [playerID, bodyOwnerID],
                  reason: "Collided with another snake's body",
                })
              })
            } else {
              gameState.deadPlayers.add(playerID)
              if (currentLevel < 0) gameState.vulnerableSnakesCollided.add(playerID)
              gameState.newSnakes[playerID]?.forEach(pos => {
                gameState.clashes.push({
                  index: pos,
                  playerIDs: [playerID, bodyOwnerID],
                  reason: "Collided with higher invulnerability snake's body",
                })
              })
            }
          })
        })
      })
    }
  }

  private checkSnakeCollisionsNormal(gameState: SnakeGameState): void {
    const newOccupiedPositions: { [position: number]: string[] } = {}
    const headPositions: { [position: number]: string[] } = {}

    Object.keys(gameState.newSnakes).forEach((playerID) => {
      if (gameState.deadPlayers.has(playerID)) return
      const snake = gameState.newSnakes[playerID]
      snake.forEach((pos, index) => {
        if (!newOccupiedPositions[pos]) {
          newOccupiedPositions[pos] = []
        }
        newOccupiedPositions[pos].push(playerID)

        if (index === 0) {
          if (!headPositions[pos]) {
            headPositions[pos] = []
          }
          headPositions[pos].push(playerID)
        }
      })
    })

    Object.keys(headPositions).forEach((posStr) => {
      const position = parseInt(posStr)
      const playersAtHead = headPositions[position]

      if (playersAtHead.length > 1) {
        // At most one snake survives a head-on collision: the unique longest
        // snake. Any tie for longest kills every colliding snake.
        const maxLength = Math.max(...playersAtHead.map((id) => gameState.newSnakes[id].length))
        const longest = playersAtHead.filter((id) => gameState.newSnakes[id].length === maxLength)
        const survivor = longest.length === 1 ? longest[0] : null

        playersAtHead.forEach((playerID) => {
          if (playerID === survivor) return
          gameState.deadPlayers.add(playerID)
          gameState.newSnakes[playerID].forEach((pos) => {
            gameState.clashes.push({
              index: pos,
              playerIDs: playersAtHead,
              reason: "Head-on collision (shortest snake(s) died)",
            })
          })
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

  private scheduleVulnerableCollisionBuffExpiry(gameState: SnakeGameState): void {
    if (gameState.vulnerableSnakesCollided.size === 0) return
    const currentTurnNumber = this.gameState.turns.length

    gameState.vulnerableSnakesCollided.forEach(vulnerablePlayerID => {
      const vulnerablePlayer = this.gameSetup.gamePlayers.find(p => p.id === vulnerablePlayerID)
      if (!vulnerablePlayer?.teamID) return

      const teamID = vulnerablePlayer.teamID
      const allies = this.gameSetup.gamePlayers.filter(
        p => p.teamID === teamID && p.id !== vulnerablePlayerID
      )

      allies.forEach(ally => {
        gameState.activeEffects.forEach(effect => {
          if (effect.playerID === ally.id && effect.type === 'invulnerability_buff') {
            effect.expiryTurn = currentTurnNumber
          }
        })
      })

      logger.info(
        `Snek: Vulnerable snake ${vulnerablePlayerID} collided; ally invulnerability buffs on team ${teamID} set to expire next turn.`,
      )
    })
  }

  private expireEffects(gameState: SnakeGameState, currentTurnNumber: number): void {
    const expiring = gameState.activeEffects.filter(e => e.expiryTurn <= currentTurnNumber)
    if (expiring.length === 0) return

    expiring.forEach(effect => {
      if (gameState.playerInvulnerabilityLevel[effect.playerID] !== undefined) {
        gameState.playerInvulnerabilityLevel[effect.playerID] -= effect.level
      }
    })

    gameState.activeEffects = gameState.activeEffects.filter(e => e.expiryTurn > currentTurnNumber)

    gameState.activeEffects = gameState.activeEffects.filter(e =>
      gameState.newAlivePlayers.includes(e.playerID)
    )

    logger.info(`Snek: Expired ${expiring.length} effects at turn ${currentTurnNumber}.`)
  }

  private processInvulnerabilityPotionCollection(gameState: SnakeGameState, currentTurnNumber: number): void {
    if (!this.gameSetup.invulnerabilityPotionEnabled) return

    const collectors: { playerID: string; potionIndex: number }[] = []

    gameState.newAlivePlayers.forEach(playerID => {
      const snake = gameState.newSnakes[playerID]
      if (!snake) return
      const headPos = snake[0]
      const potionIdx = gameState.newInvulnerabilityPotions.indexOf(headPos)
      if (potionIdx !== -1) {
        collectors.push({ playerID, potionIndex: potionIdx })
      }
    })

    const indicesToRemove = new Set<number>()
    collectors.forEach(({ playerID, potionIndex }) => {
      indicesToRemove.add(potionIndex)

      gameState.playerInvulnerabilityLevel[playerID] = (gameState.playerInvulnerabilityLevel[playerID] ?? 0) - 1
      gameState.activeEffects.push({
        playerID,
        type: 'invulnerability_debuff',
        level: -1,
        expiryTurn: currentTurnNumber + 3,
        sourcePlayerID: playerID,
      })

      const collector = this.gameSetup.gamePlayers.find(p => p.id === playerID)
      if (collector?.teamID) {
        const allies = gameState.newAlivePlayers.filter(allyID => {
          if (allyID === playerID) return false
          const allyPlayer = this.gameSetup.gamePlayers.find(p => p.id === allyID)
          return allyPlayer?.teamID === collector.teamID
        })

        allies.forEach(allyID => {
          gameState.playerInvulnerabilityLevel[allyID] = (gameState.playerInvulnerabilityLevel[allyID] ?? 0) + 1
          gameState.activeEffects.push({
            playerID: allyID,
            type: 'invulnerability_buff',
            level: 1,
            expiryTurn: currentTurnNumber + 3,
            sourcePlayerID: playerID,
          })
        })
      }

      logger.info(
        `Snek: Player ${playerID} collected invulnerability potion. Level now ${gameState.playerInvulnerabilityLevel[playerID]}.`,
      )
    })

    gameState.newInvulnerabilityPotions = gameState.newInvulnerabilityPotions.filter(
      (_, idx) => !indicesToRemove.has(idx)
    )
  }

  private generateNewInvulnerabilityPotions(gameState: SnakeGameState): void {
    if (!this.gameSetup.invulnerabilityPotionEnabled) return

    const spawnRate = this.gameSetup.invulnerabilityPotionSpawnRate ?? 0.15
    const guaranteed = Math.floor(spawnRate)
    const fractional = spawnRate - guaranteed
    const total = guaranteed + (Math.random() < fractional ? 1 : 0)

    for (let i = 0; i < total; i++) {
      const freePositions = this.getFreePositions(
        gameState.boardWidth,
        gameState.boardHeight,
        gameState.newSnakes,
        [...gameState.newFood, ...gameState.newInvulnerabilityPotions],
        gameState.newHazards,
      )
      if (freePositions.length > 0) {
        const randomIndex = Math.floor(Math.random() * freePositions.length)
        gameState.newInvulnerabilityPotions.push(freePositions[randomIndex])
      }
    }
  }

  private removeDeadPlayers(gameState: SnakeGameState): void {
    gameState.deadPlayers.forEach((playerID) => {
      const index = gameState.newAlivePlayers.indexOf(playerID)
        if (index !== -1) {
        gameState.newAlivePlayers.splice(index, 1)
      }
      delete gameState.newSnakes[playerID]
      delete gameState.newPlayerHealth[playerID]
      delete gameState.playerInvulnerabilityLevel[playerID]
      gameState.activeEffects = gameState.activeEffects.filter(e => e.playerID !== playerID)
    })
  }

  // Central health accounting, shared by the snake-only path and the chess
  // sub-step path. Per alive unit: eating at its final square restores health
  // to the unit type's max and adds one weight/length; otherwise it pays its
  // movement cost — a snake always travels exactly 1 cell per turn, a piece
  // pays 1 per square actually traversed (knight jump = 1; stay/rotate = 0,
  // so a stationary piece spends nothing) — plus one hazardDamage dose if it
  // is a piece that stayed put on a hazard square (movers already paid their
  // per-square entry doses inside the sub-step sim, so a mover that stopped
  // on a hazard square pays nothing extra here). Health at or below zero
  // kills on the spot. Called with no chess state (snake-only path) this
  // reduces exactly to the original 1/turn starvation tick.
  private processFoodAndHealth(gameState: SnakeGameState): void {
    Object.keys(gameState.newSnakes).forEach((playerID) => {
      const unit = gameState.newSnakes[playerID]
      const headPosition = unit[0]
      const type = gameState.unitTypes?.[playerID] ?? "snake"
      const isSnake = type === "snake"

      const foodIndex = gameState.newFood.indexOf(headPosition)
      if (foodIndex !== -1) {
        // Eating restores health in full (to the unit's CURRENT type's max)
        // and adds one weight/length
        gameState.newFood.splice(foodIndex, 1)
        unit.push(unit[unit.length - 1])
        gameState.newPlayerHealth[playerID] = this.maxHealthFor(type)
        return
      }

      const movementCost = isSnake ? 1 : gameState.pieceMoveCosts?.[playerID] ?? 0
      const stationaryHazardDose =
        !isSnake && movementCost === 0 && gameState.newHazards.includes(headPosition)
          ? this.hazardDamage()
          : 0

      gameState.newPlayerHealth[playerID] -= movementCost + stationaryHazardDose
      if (gameState.newPlayerHealth[playerID] <= 0) {
        gameState.deadPlayers.add(playerID)
        new Set(unit).forEach((pos) => {
          gameState.clashes.push({
            index: pos,
            playerIDs: [playerID],
            reason: "Died due to zero health",
          })
        })
      }
    })

    // Remove players who died from starvation
    this.removeDeadPlayers(gameState)
  }

  private generateNewFood(gameState: SnakeGameState): void {
      const guaranteedFood = Math.floor(this.foodSpawnRate)
      const fractional = this.foodSpawnRate - guaranteedFood
      const totalFood = guaranteedFood + (Math.random() < fractional ? 1 : 0)
      for (let i = 0; i < totalFood; i++) {
        let freePositions = this.getFreePositions(
          gameState.boardWidth,
          gameState.boardHeight,
          gameState.newSnakes,
          [...gameState.newFood, ...gameState.newInvulnerabilityPotions],
          gameState.newHazards,
        )
        if (this.gameSetup.fertileGroundEnabled && this.fertileTiles.length > 0) {
          const fertileSet = new Set(this.fertileTiles)
          freePositions = freePositions.filter(pos => fertileSet.has(pos))
        }
        if (freePositions.length > 0) {
          const randomIndex = Math.floor(Math.random() * freePositions.length)
          gameState.newFood.push(freePositions[randomIndex])
        }
      }
  }

  // Team-based end conditions
  protected calculateWinners(gameState: SnakeGameState): Winner[] {
    const currentTurnNumber = this.gameState.turns.length
    const reachedTurnLimit = this.maxTurns !== undefined && currentTurnNumber >= this.maxTurns

    const board = TeamSnekProcessor.liveBoard(gameState)
    const aliveTeams = this.getAliveTeams(board)

    if (aliveTeams.length === 0) {
      return this.calculatePreviousTurnTeamOutcome()
    }

    if (aliveTeams.length === 1) {
      return this.calculateTeamWinners(aliveTeams[0], board)
    }

    if (reachedTurnLimit) {
      const teamScores = this.getTeamScores(board)
      const maxScore = Math.max(...teamScores.values())
      const topTeams = Array.from(teamScores.entries())
        .filter(([, score]) => score === maxScore)
        .map(([teamID]) => teamID)

      if (topTeams.length === 1) {
        return this.calculateTeamWinners(topTeams[0], board)
      }

      // Tie at the turn limit results in a draw between the top teams
      return this.calculateTeamDrawWinners(topTeams, board)
    }

    return []
  }

  /** The in-flight state of the turn being resolved. */
  private static liveBoard(gameState: SnakeGameState): TeamBoardView {
    return { alive: gameState.newAlivePlayers, pieces: gameState.newSnakes }
  }

  /** A committed turn, as stored on the game document. */
  private static turnBoard(turn: Turn): TeamBoardView {
    return { alive: turn.alivePlayers, pieces: turn.playerPieces }
  }

  private getAliveTeams(board: TeamBoardView): string[] {
    const aliveTeams = new Set<string>()

    board.alive.forEach((playerID) => {
      const player = this.gameSetup.gamePlayers.find(p => p.id === playerID)
      if (player?.teamID) {
        aliveTeams.add(player.teamID)
      }
    })

    return Array.from(aliveTeams)
  }

  private calculateTeamWinners(teamID: string, board: TeamBoardView): Winner[] {
    const teamScore = this.getTeamScore(teamID, board)

    return this.gameSetup.gamePlayers
      .filter(player => player.teamID === teamID)
      .map(player => ({
        playerID: player.id,
        score: board.pieces[player.id]?.length || 0,
        winningSquares: board.pieces[player.id] || [],
        teamID,
        teamScore,
      }))
  }

  private calculateTeamDrawWinners(teamIDs: string[], board: TeamBoardView): Winner[] {
    return teamIDs.flatMap(teamID => this.calculateTeamWinners(teamID, board))
  }

  private getTeamScore(teamID: string, board: TeamBoardView): number {
    return this.gameSetup.gamePlayers
      .filter(player => player.teamID === teamID)
      .reduce((total, player) => total + (board.pieces[player.id]?.length || 0), 0)
  }

  private getTeamScores(board: TeamBoardView): Map<string, number> {
    const teamScores = new Map<string, number>()

    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID) {
        const currentScore = teamScores.get(player.teamID) || 0
        teamScores.set(player.teamID, currentScore + (board.pieces[player.id]?.length || 0))
      }
    })

    return teamScores
  }

  // When every remaining team died at once, the outcome is settled from the
  // previous committed turn's board.
  private calculatePreviousTurnTeamOutcome(): Winner[] {
    const previousTurn = this.gameState.turns[this.gameState.turns.length - 1]

    if (!previousTurn) {
      return []
    }

    const board = TeamSnekProcessor.turnBoard(previousTurn)
    const aliveTeams = this.getAliveTeams(board)

    if (aliveTeams.length === 1) {
      return this.calculateTeamWinners(aliveTeams[0], board)
    }

    const teamScores = this.getTeamScores(board)

    if (teamScores.size === 0) {
      return []
    }

    const maxScore = Math.max(...teamScores.values())
    const topTeams = Array.from(teamScores.entries())
      .filter(([, score]) => score === maxScore)
      .map(([teamID]) => teamID)

    if (topTeams.length === 1) {
      return this.calculateTeamWinners(topTeams[0], board)
    }

    return this.calculateTeamDrawWinners(topTeams, board)
  }

  protected createNewTurn(currentTurn: Turn, gameState: SnakeGameState, winners: Winner[]): Turn {
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

    // No startTime/endTime here: the spread carries the previous turn's
    // window through, and the committing caller (processTurn) is the single
    // writer of the real deadline.
    const newTurn: Turn = {
      ...currentTurn,
      playerHealth: gameState.newPlayerHealth,
      scores: gameState.newScores,
      alivePlayers: validAlivePlayers,
      food: gameState.newFood,
      hazards: gameState.newHazards,
      playerPieces: gameState.newSnakes,
      clashes: gameState.clashes,
      moves: gameState.playerMoves,
      winners: winners,
      ...(this.fertileTiles.length > 0 ? { fertileTiles: this.fertileTiles } : {}),
      invulnerabilityPotions: gameState.newInvulnerabilityPotions,
      playerInvulnerabilityLevel: gameState.playerInvulnerabilityLevel,
      activeEffects: gameState.activeEffects,
      orientation: gameState.orientation,
      // Chess-piece games: these must be rewritten every turn (the spread
      // above would otherwise freeze the previous turn's values).
      ...(gameState.unitTypes
        ? {
            unitTypes: gameState.unitTypes,
            paths: gameState.piecePaths ?? {},
          }
        : {}),
    }

    // Team-based scores
    const teamScores: { [teamID: string]: number } = {}
    const playerScores: { [playerID: string]: number } = {}

    // First pass: calculate team totals
    this.gameSetup.gamePlayers.forEach(player => {
      if (player.teamID) {
        if (!teamScores[player.teamID]) {
          teamScores[player.teamID] = 0
        }
        // If player is dead, they contribute 0 to team score
        const playerScore = gameState.deadPlayers.has(player.id) ? 0 : (gameState.newSnakes[player.id]?.length || 0)
        teamScores[player.teamID] += playerScore
      }
    })

    // Second pass: assign individual scores to each player
    this.gameSetup.gamePlayers.forEach(player => {
      // Dead players get score 0, alive players get their snake length
      playerScores[player.id] = gameState.deadPlayers.has(player.id) ? 0 : (gameState.newSnakes[player.id]?.length || 0)
    })

    // Update the turn with new scores
    newTurn.scores = playerScores
    newTurn.teamScores = teamScores

    return newTurn
  }

  // Helper methods that were in the original implementation
  private initializeSnakes(): {
    playerPieces: { [playerID: string]: number[] }
    teamClusterFallback: boolean
  } {
    const { boardWidth, gamePlayers } = this.gameSetup
    const { positions, teamClusterFallback } = this.generateStartingPositions()
    const playerPieces: { [playerID: string]: number[] } = {}

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

  private generateFertileTiles(
    boardWidth: number,
    boardHeight: number,
    walls: number[],
    hazards: number[],
    _playerPieces: { [playerID: string]: number[] },
  ): number[] {
    if (!this.gameSetup.fertileGroundEnabled) return []
    const density = Math.max(0, Math.min(100, this.gameSetup.fertileGroundDensity ?? 30))
    if (density === 0) return []

    const clustering = Math.max(1, Math.min(20, this.gameSetup.fertileGroundClustering ?? 10))

    const wallSet = new Set(walls)
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

  private getAdjacentIndices(
    index: number,
    boardWidth: number,
    boardHeight: number,
  ): number[] {
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
    const spawnCells = this.getSpawnCells(boardWidth, boardHeight)
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
  private getSpawnCells(
    boardWidth: number,
    boardHeight: number,
  ): { x: number; y: number }[] {
    const cells: { x: number; y: number }[] = []
    for (let y = 1; y < boardHeight - 1; y++) {
      for (let x = 1; x < boardWidth - 1; x++) {
        if (this.isValidSpawnPosition({ x, y }, true, boardWidth, boardHeight)) {
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
    boardWidth: number,
    boardHeight: number,
  ): boolean {
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
