import { GameState, Turn, UnitType } from "@shared/types/Game"

/** A unit is a chess PIECE when it has a type and that type is not "snake". */
export const isPieceType = (
  unitType: UnitType | undefined,
): unitType is Exclude<UnitType, "snake"> =>
  unitType !== undefined && unitType !== "snake"

/**
 * A unit's CURRENT type: the turn's live map (promotion changes it mid-game)
 * first, then the setup's initial type, then "snake".
 */
export const unitTypeFor = (
  gameState: GameState,
  turn: Turn,
  playerID: string,
): UnitType =>
  turn.unitTypes?.[playerID] ??
  gameState.setup.gamePlayers.find((gp) => gp.id === playerID)?.unitType ??
  "snake"
