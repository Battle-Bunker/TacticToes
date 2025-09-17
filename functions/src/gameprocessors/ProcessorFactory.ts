// functions/src/gameprocessors/ProcessorFactory.ts

import { GameState, GameType } from "@shared/types/Game"
import { ColorClashProcessor } from "./ColourClash"
import { Connect4Processor } from "./Connect4Processor"
import { GameProcessor } from "./GameProcessor"
import { LongboiProcessor } from "./LongboiProcessor"
import { ReversiProcessor } from "./Reversi"
import { SnekProcessor } from "./SnekProcessor"
import { TacticToesProcessor } from "./TacticToesProcessor"
import { TeamSnekProcessor } from "./TeamSnekProcessor"

/**
 * Get the processor class for a given game type.
 * This returns the class constructor, not an instance.
 */
export function getProcessorClass(gameType: GameType): typeof GameProcessor | null {
  switch (gameType) {
    case "connect4":
      return Connect4Processor as any
    case "longboi":
      return LongboiProcessor as any
    case "tactictoes":
      return TacticToesProcessor as any
    case "snek":
      return SnekProcessor as any
    case "colourclash":
      return ColorClashProcessor as any
    case "reversi":
      return ReversiProcessor as any
    case "teamsnek":
      return TeamSnekProcessor as any
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
  return new (ProcessorClass as any)(gameState)
}
