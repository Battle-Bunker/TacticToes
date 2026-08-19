import { GameState, Turn, UnitType } from "@shared/types/Game"
import { teamColorMap } from "../hooks/useTeamColors"
import { BoardModel, BoardUnit, Cell, DeathMark, UnitIconKey } from "./renderer"

const NEUTRAL_COLOR = "#888888"

/**
 * A full-board index to a renderer cell. The wire numbers squares row-major
 * over the WHOLE board (perimeter wall included) with y growing downward; the
 * renderer's cells grow upward, so the row is flipped and nothing else moves.
 */
export const indexToCell = (
  index: number,
  width: number,
  height: number,
): Cell => ({
  x: index % width,
  y: height - 1 - Math.floor(index / width),
})

/** The inverse: a renderer cell back to the full-board index the wire uses. */
export const cellToIndex = (cell: Cell, width: number, height: number): number =>
  (height - 1 - cell.y) * width + cell.x

const mapIndices = (
  indices: number[] | undefined,
  width: number,
  height: number,
): Cell[] => (indices ?? []).map((i) => indexToCell(i, width, height))

/**
 * A unit's CURRENT type: the turn's live map (promotion changes it mid-game)
 * first, then the setup's initial type, then "snake".
 */
const unitTypeFor = (
  gameState: GameState,
  turn: Turn,
  playerID: string,
): UnitType =>
  turn.unitTypes?.[playerID] ??
  gameState.setup.gamePlayers.find((gp) => gp.id === playerID)?.unitType ??
  "snake"

/**
 * The earliest turn on which any of a unit's invulnerability effects lapses —
 * the aggregate level holds only until the first of them expires, so that is
 * the turn the board's countdown measures against. Null when the turn carries
 * no effects schedule at all, which is what tells the renderer it has no
 * countdown to write.
 */
const invulnerabilityExpiryTurn = (
  turn: Turn,
  playerID: string,
): number | undefined => {
  if (!turn.activeEffects) return undefined
  let earliest: number | undefined
  for (const effect of turn.activeEffects) {
    if (effect.playerID !== playerID) continue
    if (earliest === undefined || effect.expiryTurn < earliest) {
      earliest = effect.expiryTurn
    }
  }
  return earliest
}

/**
 * One Firestore turn document as the board model the renderer draws. Chess
 * pieces arrive as a weight-stack — N copies of ONE square — so they collapse
 * to a single body cell carrying N as their weight; snakes keep their whole
 * body, head first.
 */
export const turnToBoard = (
  gameState: GameState,
  turnIndex: number,
  options?: { showWinningSquares?: boolean },
): BoardModel | null => {
  const turn = gameState.turns[turnIndex]
  if (!turn) return null

  const width = gameState.setup.boardWidth
  const height = gameState.setup.boardHeight
  const teamColors = teamColorMap(gameState.setup.teams)
  const colorFor = (playerID: string): string => {
    const teamID = gameState.setup.gamePlayers.find((gp) => gp.id === playerID)
      ?.teamID
    return (teamID !== undefined ? teamColors.get(teamID) : undefined) ?? NEUTRAL_COLOR
  }

  const units: BoardUnit[] = []
  const occupied = new Set<number>()
  Object.entries(turn.playerPieces).forEach(([playerID, positions]) => {
    if (!positions || positions.length === 0) return
    positions.forEach((index) => occupied.add(index))
    const unitType = unitTypeFor(gameState, turn, playerID)
    const isPiece = unitType !== "snake"
    const body = (isPiece ? positions.slice(0, 1) : positions).map((i) =>
      indexToCell(i, width, height),
    )
    units.push({
      id: playerID,
      letter:
        gameState.setup.gamePlayers.find((gp) => gp.id === playerID)?.letter ??
        "?",
      color: colorFor(playerID),
      unitType: unitType as UnitIconKey,
      body,
      // A piece's weight is the height of its stack; a snake's is its length.
      weight: positions.length,
      health: turn.playerHealth[playerID] ?? 0,
      maxHealth: gameState.setup.maxHealthPerUnit?.[unitType] ?? 100,
      orientation: turn.orientation?.[playerID],
      invulnerabilityLevel: turn.playerInvulnerabilityLevel?.[playerID] ?? 0,
      invulnerabilityExpiryTurn: invulnerabilityExpiryTurn(turn, playerID),
    })
  })

  // A clash marks the square units died on. Where a survivor is standing there,
  // the square is theirs to show — the marker would only bury a living unit.
  const deaths: DeathMark[] = (turn.clashes ?? [])
    .filter((clash) => !occupied.has(clash.index))
    .map((clash) => ({
      cell: indexToCell(clash.index, width, height),
      color: clash.playerIDs.length ? colorFor(clash.playerIDs[0]) : NEUTRAL_COLOR,
    }))

  const winningSquares = options?.showWinningSquares
    ? mapIndices(
        turn.winners.flatMap((winner) => winner.winningSquares),
        width,
        height,
      )
    : []

  return {
    width,
    height,
    turn: turnIndex,
    // Walls are static for the whole game and live on the game doc, not the turn.
    walls: mapIndices(gameState.walls, width, height),
    hazards: mapIndices(turn.hazards, width, height),
    fertileTiles: mapIndices(turn.fertileTiles, width, height),
    winningSquares,
    food: mapIndices(turn.food, width, height),
    invulnerabilityPotions: mapIndices(
      turn.invulnerabilityPotions,
      width,
      height,
    ),
    units,
    deaths,
  }
}
