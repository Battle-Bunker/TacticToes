import {
  ActiveEffect,
  Clash,
  GamePlayer,
  GameState,
  Move,
  StartedGameSetup,
  Turn,
  UnitDeath,
  UnitType,
  Winner,
} from "@shared/types/Game"
import { Timestamp } from "firebase-admin/firestore"
import { logger } from "../logger"
import { BoardView, Outcome, resolveMaxTurns } from "./engine/adjudicate"
import {
  DEFAULT_PAWN_PROMOTION_WEIGHT,
  Orientation,
  ORTHOGONALS,
  isPieceType,
  leavesTrail,
  pickSpawnOrientation,
} from "./engine/moveGrammar"
import {
  DEFAULT_POTION_WINDOW_TURNS,
  SettleInput,
  Settlement,
  settleTurn,
} from "./engine/settleTurn"
import {
  Spawner,
  freeCells,
  randomSpawner,
  resolveFoodSpawnRate,
  resolvePotionSpawnRate,
} from "./engine/spawn"
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

  // Computed data
  newScores: { [playerID: string]: number }

  // Per-unit orientation, seeded from the current turn and replaced wholesale
  // by the settlement's rewritten map once the turn has resolved.
  orientation: { [playerID: string]: Orientation }

  // Current kind per unit. Every game carries this internally — the movement
  // grammar, spawn config, regicide and promotion are the only things that
  // still care — but only piece games put it on the wire.
  unitTypes: { [playerID: string]: UnitType }
  // Cells each unit actually entered this turn, in order (Turn.paths for
  // pieces; the orientation rewrite reads the first entry for every unit).
  traversed: { [playerID: string]: number[] }
  // The turn's authoritative death registry, and the cells cut from surviving
  // trail units, both straight off the engine's typed events.
  deaths: { [playerID: string]: UnitDeath }
  severedCells: { [playerID: string]: number[] }
  // Sub-steps the engine ran, so end-of-turn removals can still name one.
  subStepCount: number
}

// The board projection adjudication works on, with the mutable arrays the
// wire wants: the engine's BoardView reads it, and the winner rows are built
// from the same object. Made either from the in-flight SnakeGameState or from
// a committed Turn.
interface TeamBoardView extends BoardView {
  alive: string[]
  pieces: Record<string, number[]>
}

// The turn limit is a rule, so it is the engine's: re-exported here because
// callers have always asked the processor for it.
export { DEFAULT_MAX_TURNS, resolveMaxTurns } from "./engine/adjudicate"

export class TeamSnekProcessor {
  protected gameSetup: StartedGameSetup
  protected gameState: GameState
  private foodSpawnRate: number
  /** Turns this game is adjudicated at, or null when it runs unlimited. */
  protected maxTurns: number | null
  private fertileTiles: number[] = []

  constructor(gameState: GameState) {
    this.gameSetup = gameState.setup
    this.gameState = gameState
    this.maxTurns = resolveMaxTurns(gameState.setup.maxTurns)
    this.foodSpawnRate = resolveFoodSpawnRate(gameState.setup.foodSpawnRate)
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
      orientation[player.id] = this.spawnOrientation(
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
      deaths: {},
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

  // One turn, one encoding. Movement, every collision and the whole end-of-turn
  // settlement live in engine/settleTurn.ts — the same pure module a client
  // vendors to predict a turn. This method is the game-level shell around it:
  // Firestore state in, spawns/orientation/promotion/scoring/wire out.
  applyMoves(currentTurn: Turn, moves: Move[]): Turn {
    try {
      if (currentTurn.fertileTiles && currentTurn.fertileTiles.length > 0) {
        this.fertileTiles = currentTurn.fertileTiles
      }
      // 1. Setup
      const gameState = this.initializeGameState(currentTurn)
      moves.forEach((move) => {
        gameState.playerMoves[move.playerID] = move.move
      })

      // 2. Settle the turn: grammar, collision phase, collision deaths, food
      //    and growth, exhaustion deaths, sever truncation, regicide — then
      //    the ally-buff cancel for vulnerable units that died or were
      //    severed, potion collection, effect expiry, the orientation rewrite
      //    and pawn promotion, all of which the module now owns.
      //    Spawning runs inside it too, as the last board phase: the rules
      //    for where an item may land are the module's, and the only thing
      //    this class still supplies is the die.
      const settled = settleTurn(this.settleInput(gameState), this.spawner())
      this.applySettlement(gameState, settled)

      // 3. Winners and turn assembly. Settlement has already adjudicated the
      //    game on the board it settled.
      return this.createNewTurn(currentTurn, gameState, this.winnerRows(gameState, settled.outcome))
    } catch (error) {
      logger.error(`Snek: Error applying moves:`, error)
      throw error
    }
  }

  // Teams that play under regicide: those configured with at least one king,
  // whether or not one is still standing. Kings never change kind (promotion
  // only creates queens), so the setup is authoritative.
  private regicideTeamIDs(): string[] {
    return Array.from(
      new Set(
        this.gameSetup.gamePlayers
          .filter((p) => p.unitType === "king")
          .map((p) => p.teamID),
      ),
    )
  }

  // The turn's die. Item spawning is the game's only nondeterminism, and the
  // rules around it — the free-cell set, the rate arithmetic, the fertile
  // filter — are the module's; this hands it the randomness those rules
  // consume, and nothing else. A client predicting a turn passes NO_SPAWN
  // instead and reads a barer board.
  private spawner(): Spawner {
    return randomSpawner(
      {
        foodSpawnRate: this.foodSpawnRate,
        potionsEnabled: this.gameSetup.invulnerabilityPotionEnabled === true,
        potionSpawnRate: resolvePotionSpawnRate(
          this.gameSetup.invulnerabilityPotionSpawnRate,
        ),
        fertileTiles: this.gameSetup.fertileGroundEnabled ? this.fertileTiles : [],
      },
      { next: () => Math.random() },
    )
  }

  // The board, roster and effect schedule as the pure module wants them. Tier
  // is passed in per unit AND read back out of the settlement: the module owns
  // effect expiry now, so it owns the tier changes expiry causes.
  private settleInput(gameState: SnakeGameState): SettleInput {
    const kings = new Set(
      this.gameSetup.gamePlayers.filter((p) => p.unitType === "king").map((p) => p.id),
    )
    return {
      turn: this.gameState.turns.length,
      teamOf: this.teamOf(),
      maxTurns: this.maxTurns,
      previous: this.previousBoard(),
      effects: gameState.activeEffects,
      potions: gameState.newInvulnerabilityPotions,
      potionsEnabled: this.gameSetup.invulnerabilityPotionEnabled === true,
      potionWindowTurns:
        this.gameSetup.invulnerabilityPotionWindowTurns ?? DEFAULT_POTION_WINDOW_TURNS,
      pawnPromotionWeight:
        this.gameSetup.pawnPromotionWeight ?? DEFAULT_PAWN_PROMOTION_WEIGHT,
      units: gameState.newAlivePlayers.map((playerID) => ({
        id: playerID,
        type: gameState.unitTypes[playerID],
        teamID: this.gameSetup.gamePlayers.find((p) => p.id === playerID)?.teamID ?? "",
        isKing: kings.has(playerID),
        tier: gameState.playerInvulnerabilityLevel[playerID] ?? 0,
        health: gameState.newPlayerHealth[playerID],
        occupancy: gameState.newSnakes[playerID],
        orientation: gameState.orientation[playerID],
        stagedMove: gameState.playerMoves[playerID],
      })),
      boardWidth: gameState.boardWidth,
      boardHeight: gameState.boardHeight,
      walls: this.getWallPositions(gameState.boardWidth, gameState.boardHeight),
      hazards: gameState.newHazards,
      hazardDamage: this.hazardDamage(),
      food: gameState.newFood,
      maxHealth: this.gameSetup.maxHealthPerUnit,
      regicideTeamIDs: this.regicideTeamIDs(),
    }
  }

  // Folds the settled turn back into the game-level state. Everything the
  // module reports is authoritative: occupancy, health, food, applied moves,
  // the death registry, severed cells, the clash stream, and now the effect
  // schedule and the tiers the next turn starts from.
  private applySettlement(gameState: SnakeGameState, resolution: Settlement): void {
    gameState.clashes.push(...resolution.clashes)
    gameState.deaths = resolution.deaths
    gameState.traversed = resolution.traversed
    gameState.severedCells = resolution.severedCells
    gameState.subStepCount = resolution.subStepCount
    gameState.newFood = resolution.food

    // The applied move is the cell the unit actually ended on — a truncated
    // slider its stop cell, anything that died the cell it died on.
    Object.entries(resolution.finalCell).forEach(([playerID, cell]) => {
      gameState.playerMoves[playerID] = cell
    })
    Object.keys(resolution.deaths).forEach((playerID) => gameState.deadPlayers.add(playerID))
    this.removeDeadPlayers(gameState)
    Object.entries(resolution.board).forEach(([playerID, unit]) => {
      gameState.newSnakes[playerID] = unit.occupancy
      gameState.newPlayerHealth[playerID] = unit.health
    })

    // The settled schedule and tiers replace the ones removeDeadPlayers just
    // pruned: the module has already dropped the dead, cancelled the ally
    // buffs a vulnerable collision voids, and given back every lapsed level.
    gameState.activeEffects = resolution.effects
    gameState.playerInvulnerabilityLevel = resolution.tiers
    gameState.newInvulnerabilityPotions = resolution.potions
    // Facing likewise: the module rewrote it for every unit still standing,
    // rotations folded in, the dead dropped. Patching the previous turn's map
    // here instead would be the same rule written a second time.
    gameState.orientation = resolution.orientation

    // Promotion arrives already applied to the board and the health above;
    // what is left is the kind map, which the processor keeps for every
    // CONFIGURED unit rather than only the standing ones, so the settled kinds
    // are folded in rather than swapped for.
    resolution.promoted.forEach((playerID) => {
      gameState.unitTypes[playerID] = resolution.unitTypes[playerID]
      logger.info(`Snek: Pawn ${playerID} promoted to queen at weight 1.`)
    })

    resolution.vulnerableCollided.forEach((playerID) => {
      const teamID = this.gameSetup.gamePlayers.find((p) => p.id === playerID)?.teamID
      if (!teamID) return
      logger.info(
        `Snek: Vulnerable snake ${playerID} collided; ally invulnerability buffs on team ${teamID} set to expire next turn.`,
      )
    })

    resolution.eliminatedTeamIDs.forEach((teamID) => {
      logger.info(`Snek: Team ${teamID} eliminated — its last king fell.`)
    })
  }

  // Piece-only wire fields (Turn.unitTypes, Turn.paths) are written only for
  // games that field pieces. The engine itself never asks.
  protected hasPieceUnits(): boolean {
    return this.gameSetup.gamePlayers.some((p) => isPieceType(p.unitType))
  }

  // Spawn orientation, assigned once at turn 0: toward the board centre, ties
  // resolved uniformly at random among the tied candidates. Both halves are
  // the module's (engine/moveGrammar.ts) — the candidate set because it is a
  // rule, the draw because the module takes its randomness as an input.
  private spawnOrientation(
    type: UnitType,
    index: number,
    boardWidth: number,
    boardHeight: number,
  ): Orientation {
    return pickSpawnOrientation(type, index, boardWidth, boardHeight, {
      next: () => Math.random(),
    })
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

    // Current kind per unit, carried turn to turn. Absent means "snake", so
    // snake-only games get a complete map without ever storing one.
    const unitTypes: { [playerID: string]: UnitType } = {}
    this.gameSetup.gamePlayers.forEach((p) => {
      unitTypes[p.id] = currentTurn.unitTypes?.[p.id] ?? p.unitType ?? "snake"
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
      newScores: {},
      orientation: { ...currentTurn.orientation },
      unitTypes,
      traversed: {},
      deaths: {},
      severedCells: {},
      subStepCount: 1,
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

  // The winner ROWS the wire wants, built from the outcome settlement already
  // adjudicated. The rule — which teams won, on which board, at what weight —
  // is the engine's (engine/adjudicate.ts); what is left here is the shape:
  // one row per configured player of a winning team, carrying the squares it
  // held on the board that decided the game.
  protected winnerRows(gameState: SnakeGameState, outcome: Outcome | null): Winner[] {
    if (!outcome) return []

    const board =
      outcome.decidedOn === "previous"
        ? this.previousBoard()
        : TeamSnekProcessor.liveBoard(gameState)
    if (!board) return []

    return outcome.winners.flatMap((teamID) =>
      this.gameSetup.gamePlayers
        .filter((player) => player.teamID === teamID)
        .map((player) => ({
          playerID: player.id,
          score: board.pieces[player.id]?.length || 0,
          winningSquares: board.pieces[player.id] || [],
          teamID,
          teamScore: outcome.weightByTeam[teamID] ?? 0,
        })),
    )
  }

  /** The in-flight state of the turn being resolved. */
  private static liveBoard(gameState: SnakeGameState): TeamBoardView {
    return { alive: gameState.newAlivePlayers, pieces: gameState.newSnakes }
  }

  /** A committed turn, as stored on the game document. */
  private static turnBoard(turn: Turn): TeamBoardView {
    return { alive: turn.alivePlayers, pieces: turn.playerPieces }
  }

  /**
   * The last committed turn's board — the one a mutual wipe is settled on.
   * Undefined only before any turn has been committed, which no game reaches.
   */
  private previousBoard(): TeamBoardView | undefined {
    const previousTurn = this.gameState.turns[this.gameState.turns.length - 1]
    return previousTurn ? TeamSnekProcessor.turnBoard(previousTurn) : undefined
  }

  /** Unit id → team id, for every configured unit. */
  private teamOf(): { [playerID: string]: string } {
    const teamOf: { [playerID: string]: string } = {}
    this.gameSetup.gamePlayers.forEach((p) => {
      teamOf[p.id] = p.teamID
    })
    return teamOf
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
      deaths: gameState.deaths,
      moves: gameState.playerMoves,
      winners: winners,
      ...(this.fertileTiles.length > 0 ? { fertileTiles: this.fertileTiles } : {}),
      invulnerabilityPotions: gameState.newInvulnerabilityPotions,
      playerInvulnerabilityLevel: gameState.playerInvulnerabilityLevel,
      activeEffects: gameState.activeEffects,
      orientation: gameState.orientation,
    }

    // Per-turn fields the spread above would otherwise freeze at the previous
    // turn's values: each is rewritten or dropped every turn.
    if (Object.keys(gameState.severedCells).length > 0) {
      newTurn.severedCells = gameState.severedCells
    } else {
      delete newTurn.severedCells
    }
    if (this.hasPieceUnits()) {
      newTurn.unitTypes = gameState.unitTypes
      newTurn.paths = this.wirePaths(gameState)
    } else {
      delete newTurn.unitTypes
      delete newTurn.paths
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

  // Turn.paths: the cells each PIECE actually entered this turn, for
  // animation and inspection. Trail units are excluded (their whole occupancy
  // is already on the wire), and so is any unit that entered nothing.
  private wirePaths(gameState: SnakeGameState): { [playerID: string]: number[] } {
    const paths: { [playerID: string]: number[] } = {}
    Object.entries(gameState.traversed).forEach(([playerID, cells]) => {
      if (cells.length === 0) return
      if (leavesTrail(gameState.unitTypes[playerID])) return
      paths[playerID] = cells
    })
    return paths
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

  // Where an item may be placed, which is the module's rule (engine/spawn.ts)
  // — asked here for the placement pass that builds the board, since the
  // per-turn spawners now ask it from inside settlement.
  private getFreePositions(
    boardWidth: number,
    boardHeight: number,
    playerPieces: { [playerID: string]: number[] },
    food: number[],
    hazards: number[],
  ): number[] {
    return freeCells({
      boardWidth,
      boardHeight,
      walls: this.getWallPositions(boardWidth, boardHeight),
      hazards,
      occupancy: Object.values(playerPieces),
      food,
      potions: [],
    })
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
