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
   * Initializes the game by setting up the board and creating the first turn.
   */
  abstract firstTurn(): Turn

  /**
   * Applies the latest moves to the gameState.
   * Returns the latest turn so it can be added to the doc
   */
  abstract applyMoves(currentTurn: Turn, moves: Move[]): Turn
}
