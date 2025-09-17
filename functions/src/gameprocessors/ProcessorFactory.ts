// functions/src/gameprocessors/ProcessorFactory.ts

import { GameState, GameType, GameSetup, GamePlayer } from "@shared/types/Game"
import { ColorClashProcessor } from "./ColourClash"
import { Connect4Processor } from "./Connect4Processor"
import { GameProcessor } from "./GameProcessor"
import { LongboiProcessor } from "./LongboiProcessor"
import { ReversiProcessor } from "./Reversi"
import { SnekProcessor } from "./SnekProcessor"
import { TacticToesProcessor } from "./TacticToesProcessor"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

/**
 * Interface that defines the shape of a GameProcessor constructor.
 * This includes both the constructor signature and required static methods.
 */
interface GameProcessorConstructor {
  new (gameState: GameState): GameProcessor;
  filterActivePlayers(setup: GameSetup): GamePlayer[];
}

/**
 * Get the processor class for a given game type.
 * This returns the class constructor, not an instance.
 */
export function getProcessorClass(gameType: GameType): GameProcessorConstructor | null {
  switch (gameType) {
    case "connect4":
      return Connect4Processor
    case "longboi":
      return LongboiProcessor
    case "tactictoes":
      return TacticToesProcessor
    case "snek":
      return SnekProcessor
    case "colourclash":
      return ColorClashProcessor
    case "reversi":
      return ReversiProcessor
    case "teamsnek":
      return TeamSnekProcessor
    default:
      console.error(`Unsupported game type: ${gameType}`)
      return null
  }
}

export function getGameProcessor(gameState: GameState): GameProcessor | null {
  const ProcessorClass = getProcessorClass(gameState.setup.gameType)
  if (!ProcessorClass) {
    return null
  }
  return new ProcessorClass(gameState)
}
