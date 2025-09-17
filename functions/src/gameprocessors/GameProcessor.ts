// functions/src/gameprocessors/GameProcessor.ts

import { Turn, Move, GameSetup, GameState, GamePlayer } from "@shared/types/Game"

/**
 * Abstract base class for all game processors.
 * Defines the required methods each processor must implement.
 */
export abstract class GameProcessor {
  protected gameSetup: GameSetup
  protected gameState: GameState

  constructor(gameState: GameState) {
    this.gameSetup = gameState.setup
    this.gameState = gameState
  }

  /**
   * Filters the list of players who will actively participate in the game.
   * Players not returned by this method become observers.
   * Override in subclasses to implement game-specific filtering.
   * @param setup The game setup configuration
   * @returns Array of players who should actively participate
   */
  static filterActivePlayers(setup: GameSetup): GamePlayer[] {
    // Default: all players are active
    return setup.gamePlayers
  }

  /**
   * Determines the unit by which scores are calculated and winners determined
   * Override in subclasses for team-based scoring
   * @param setup The game setup configuration
   * @returns 'individual' for player-based scoring, 'team' for team-based scoring
   */
  static getScoringUnit(setup: GameSetup): 'individual' | 'team' {
    // Default: individual scoring for all games
    return 'individual'
  }

  /**
   * Initializes the game by setting up the board and creating the first turn.
   */
  abstract firstTurn(): Turn

  /**
   * Applies the latest moves to the gameState.
   * Returns the latest turn so it can be added to the doc
   */
  abstract applyMoves(currentTurn: Turn, moves: Move[]): Turn
}
