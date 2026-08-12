// functions/src/gameprocessors/GameProcessor.ts

import { Turn, Move, GameState, StartedGameSetup } from "@shared/types/Game"

export abstract class GameProcessor {
  protected gameSetup: StartedGameSetup
  protected gameState: GameState

  constructor(gameState: GameState) {
    this.gameSetup = gameState.setup
    this.gameState = gameState
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
