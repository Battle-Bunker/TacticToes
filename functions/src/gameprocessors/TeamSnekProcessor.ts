import {
  ActiveEffect,
  Clash,
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
import { DEFAULT_FOOD_ENERGY } from "./engine/resolveTurn"
import {
  Spawner,
  randomSpawner,
  resolveFoodSpawnRate,
  resolvePotionSpawnRate,
} from "./engine/spawn"
import { BoardPlacement } from "./placement"

export interface SnakeGameState {
  // Input data
  boardWidth: number
  boardHeight: number

  // Mutable game state
  newSnakes: { [playerID: string]: number[] }
  newFood: number[]
  newPlayerEnergy: { [playerID: string]: number }
  newAlivePlayers: string[]
  newInvulnerabilityPotions: number[]
  playerInvulnerabilityLevel: { [playerID: string]: number }
  activeEffects: ActiveEffect[]

  // Processing data
  playerMoves: { [playerID: string]: number }
  clashes: Clash[]

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
  // Where the board comes from. Every cell chosen before turn 1 — spawn
  // geometry, hazards, fertile ground, opening food and the perimeter they
  // are all measured against — is this object's, not this class's.
  private readonly placement: BoardPlacement
  // Unit id → team id, for every configured unit. The roster is fixed at game
  // start, so the map is built once here rather than rescanned per unit per
  // turn. This is the shape the engine asks for too, so it goes straight in.
  private readonly teamOf: { [playerID: string]: string }

  constructor(gameState: GameState) {
    this.gameSetup = gameState.setup
    this.gameState = gameState
    this.maxTurns = resolveMaxTurns(gameState.setup.maxTurns)
    this.foodSpawnRate = resolveFoodSpawnRate(gameState.setup.foodSpawnRate)
    this.placement = new BoardPlacement(gameState.setup)
    this.teamOf = Object.fromEntries(gameState.setup.gamePlayers.map((p) => [p.id, p.teamID]))
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
    return this.placement.walls
  }


  generatePreviewBoard(): {
    fertileTiles: number[]
    hazards: number[]
    playerPositions: { [playerID: string]: number }
    food: number[]
  } {
    const { gamePlayers } = this.gameSetup

    const { playerPieces, hazards, fertileTiles, food } = this.placement.buildBoard()

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

    const { playerPieces, hazards, fertileTiles, teamClusterFallback, food } = this.placement.buildBoard(
      usePreview
        ? {
          positions: this.gameSetup.presetPlayerPositions,
          hazards: this.gameSetup.presetHazards,
          fertileTiles: this.gameSetup.presetFertileTiles,
          food: this.gameSetup.presetFood,
        }
        : {},
    )
    this.fertileTiles = fertileTiles

    // Initialize player energy (per-type configurable max, default 100)
    const initialEnergy: { [playerID: string]: number } = {}
    gamePlayers.forEach((player) => {
      initialEnergy[player.id] = this.maxEnergyFor(player.unitType)
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
      playerEnergy: initialEnergy,
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
      const settled = settleTurn(this.settleInput(gameState, currentTurn.hazards), this.spawner())
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
  private settleInput(gameState: SnakeGameState, hazards: number[]): SettleInput {
    const kings = new Set(
      this.gameSetup.gamePlayers.filter((p) => p.unitType === "king").map((p) => p.id),
    )
    return {
      turn: this.gameState.turns.length,
      teamOf: this.teamOf,
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
        teamID: this.teamOf[playerID] ?? "",
        isKing: kings.has(playerID),
        tier: gameState.playerInvulnerabilityLevel[playerID] ?? 0,
        energy: gameState.newPlayerEnergy[playerID],
        occupancy: gameState.newSnakes[playerID],
        orientation: gameState.orientation[playerID],
        stagedMove: gameState.playerMoves[playerID],
      })),
      boardWidth: gameState.boardWidth,
      boardHeight: gameState.boardHeight,
      walls: this.placement.walls,
      hazards,
      hazardDamage: this.hazardDamage(),
      food: gameState.newFood,
      maxEnergy: this.gameSetup.maxEnergyPerUnit,
      foodEnergy: this.foodEnergy(),
      regicideTeamIDs: this.regicideTeamIDs(),
    }
  }

  // Folds the settled turn back into the game-level state. Everything the
  // module reports is authoritative: occupancy, energy, food, applied moves,
  // the death registry, severed cells, the clash stream, and now the effect
  // schedule and the tiers the next turn starts from.
  private applySettlement(gameState: SnakeGameState, resolution: Settlement): void {
    gameState.clashes.push(...resolution.clashes)
    gameState.deaths = resolution.deaths
    gameState.traversed = resolution.traversed
    gameState.severedCells = resolution.severedCells
    gameState.newFood = resolution.food

    // The applied move is the cell the unit actually ended on — a truncated
    // slider its stop cell, anything that died the cell it died on.
    Object.entries(resolution.finalCell).forEach(([playerID, cell]) => {
      gameState.playerMoves[playerID] = cell
    })
    // resolution.deaths is the turn's single death registry — the survivors'
    // board and energy the module hands back next already omit them, so
    // pruning here is the only bookkeeping this class still owns.
    const dead = new Set(Object.keys(resolution.deaths))
    gameState.newAlivePlayers = gameState.newAlivePlayers.filter((id) => !dead.has(id))
    dead.forEach((id) => {
      delete gameState.newSnakes[id]
      delete gameState.newPlayerEnergy[id]
    })
    Object.entries(resolution.board).forEach(([playerID, unit]) => {
      gameState.newSnakes[playerID] = unit.occupancy
      gameState.newPlayerEnergy[playerID] = unit.energy
    })

    // The settled schedule and tiers replace the ones just pruned above: the
    // module has already dropped the dead, cancelled the ally buffs a
    // vulnerable collision voids, and given back every lapsed level.
    gameState.activeEffects = resolution.effects
    gameState.playerInvulnerabilityLevel = resolution.tiers
    gameState.newInvulnerabilityPotions = resolution.potions
    // Facing likewise: the module rewrote it for every unit still standing,
    // rotations folded in, the dead dropped. Patching the previous turn's map
    // here instead would be the same rule written a second time.
    gameState.orientation = resolution.orientation

    // Promotion arrives already applied to the board and the energy above;
    // what is left is the kind map, which the processor keeps for every
    // CONFIGURED unit rather than only the standing ones, so the settled kinds
    // are folded in rather than swapped for.
    resolution.promoted.forEach((playerID) => {
      gameState.unitTypes[playerID] = resolution.unitTypes[playerID]
      logger.info(`Snek: Pawn ${playerID} promoted to queen at weight 1.`)
    })

    resolution.vulnerableCollided.forEach((playerID) => {
      const teamID = this.teamOf[playerID]
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

  // Max energy for a unit type: per-type config with a universal default of
  // 100. An absent type means "snake".
  private maxEnergyFor(type: UnitType | undefined): number {
    return this.gameSetup.maxEnergyPerUnit?.[type ?? "snake"] ?? 100
  }

  // Energy one food replenishes. Default 100 — the default max energy — so an
  // unconfigured game keeps food's old meaning: one meal fills the tank, and
  // filling the tank is what grows the eater.
  private foodEnergy(): number {
    return this.gameSetup.foodEnergy ?? DEFAULT_FOOD_ENERGY
  }

  // Energy lost per hazard square entered (and per turn spent sitting on
  // one, for stationary pieces). Default 100: usually lethal.
  private hazardDamage(): number {
    return this.gameSetup.hazardDamage ?? 100
  }

  private initializeGameState(currentTurn: Turn): SnakeGameState {
    const {
      playerPieces,
      food,
      alivePlayers,
      playerEnergy,
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
      newPlayerEnergy: { ...playerEnergy },
      newAlivePlayers: [...alivePlayers],
      newInvulnerabilityPotions: [...(currentTurn.invulnerabilityPotions ?? [])],
      playerInvulnerabilityLevel,
      activeEffects: (currentTurn.activeEffects ?? []).map(e => ({ ...e })),
      playerMoves: {},
      clashes: [],
      orientation: { ...currentTurn.orientation },
      unitTypes,
      traversed: {},
      deaths: {},
      severedCells: {},
    }
  }

  // The winner ROWS the wire wants, built from the outcome settlement already
  // adjudicated. The rule — which teams won, on which board, at what weight —
  // is the engine's (engine/adjudicate.ts); what is left here is the shape:
  // one row per configured player of a winning team, carrying the squares it
  // held on the board that decided the game.
  protected winnerRows(gameState: SnakeGameState, outcome: Outcome | null): Winner[] {
    if (!outcome) return []

    // Only occupancy is wanted here, and the in-flight state already holds
    // the settled board applySettlement folded in — projecting it through a
    // second BoardView would be that board written twice.
    const pieces =
      outcome.decidedOn === "previous" ? this.previousBoard()?.pieces : gameState.newSnakes
    if (!pieces) return []

    return outcome.winners.flatMap((teamID) =>
      this.gameSetup.gamePlayers
        .filter((player) => player.teamID === teamID)
        .map((player) => ({
          playerID: player.id,
          score: pieces[player.id]?.length || 0,
          winningSquares: pieces[player.id] || [],
          teamID,
          teamScore: outcome.weightByTeam[teamID] ?? 0,
        })),
    )
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

  protected createNewTurn(currentTurn: Turn, gameState: SnakeGameState, winners: Winner[]): Turn {
    // Per-player score: current occupancy weight, or 0 for a unit that has
    // none — which reads the same whether it died this turn or three turns
    // ago, since applySettlement has already pruned the dead from newSnakes.
    const playerScores: { [playerID: string]: number } = {}
    this.gameSetup.gamePlayers.forEach((player) => {
      playerScores[player.id] = gameState.newSnakes[player.id]?.length ?? 0
    })

    // No startTime/endTime here: the spread carries the previous turn's
    // window through, and the committing caller (processTurn) is the single
    // writer of the real deadline.
    const newTurn: Turn = {
      ...currentTurn,
      playerEnergy: gameState.newPlayerEnergy,
      scores: playerScores,
      alivePlayers: gameState.newAlivePlayers,
      food: gameState.newFood,
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

    // Team score: a sum over playerScores, which is already per-player —
    // not a second computation of the same expression.
    const teamScores: { [teamID: string]: number } = {}
    this.gameSetup.gamePlayers.forEach((player) => {
      if (!player.teamID) return
      teamScores[player.teamID] = (teamScores[player.teamID] ?? 0) + playerScores[player.id]
    })
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
}
