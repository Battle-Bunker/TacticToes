import { GameState, Turn, UnitType } from "@shared/types/Game"
import { teamColorMap } from "../hooks/useTeamColors"
import {
  BoardClash,
  BoardModel,
  BoardUnit,
  Cell,
  DeathMark,
  RosterUnit,
  UnitIconKey,
} from "./renderer"

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
 * The weight a unit was last seen carrying, at or before the turn being shown:
 * the roster's memory of a unit the board has dropped. Scanning back from the
 * displayed turn (never forward) is what keeps a replay honest — a unit killed
 * on turn 40 shows the weight it died with when turn 41 is on screen, and shows
 * its live weight when turn 39 is.
 */
const lastKnownWeight = (
  gameState: GameState,
  turnIndex: number,
  playerID: string,
): number => {
  for (let i = Math.min(turnIndex, gameState.turns.length - 1); i >= 0; i--) {
    const pieces = gameState.turns[i]?.playerPieces?.[playerID]
    if (pieces && pieces.length > 0) return pieces.length
  }
  return 0
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
  // The team's display NAME is the one the game setup snapshotted from the
  // controlling centaur — never the team's document id, which is a key rather
  // than a name.
  const teamNames = new Map(gameState.setup.teams.map((t) => [t.id, t.name]))
  const colorFor = (playerID: string): string => {
    const teamID = gameState.setup.gamePlayers.find((gp) => gp.id === playerID)
      ?.teamID
    return (teamID !== undefined ? teamColors.get(teamID) : undefined) ?? NEUTRAL_COLOR
  }

  // The ROSTER is walked in setup order rather than the turn document's key
  // order, so units (and, downstream, the teams and rows of the scoreboard)
  // come out in one deterministic order: team by team, letters ascending.
  const units: BoardUnit[] = []
  const deadUnits: RosterUnit[] = []
  const occupied = new Set<number>()
  gameState.setup.gamePlayers.forEach((gamePlayer) => {
    const playerID = gamePlayer.id
    const positions = turn.playerPieces[playerID]
    const unitType = unitTypeFor(gameState, turn, playerID)
    const identity = {
      id: playerID,
      letter: gamePlayer.letter ?? "?",
      teamID: gamePlayer.teamID,
      teamName: teamNames.get(gamePlayer.teamID) ?? gamePlayer.teamID,
      color: teamColors.get(gamePlayer.teamID) ?? NEUTRAL_COLOR,
      unitType: unitType as UnitIconKey,
    }
    // A unit the board has dropped is dead. It stays in the roster at its
    // last-known state so a scoreboard can keep listing it — struck through,
    // scoring nothing — instead of letting it silently vanish from its team.
    if (!positions || positions.length === 0) {
      deadUnits.push({
        ...identity,
        weight: lastKnownWeight(gameState, turnIndex, playerID),
      })
      return
    }
    positions.forEach((index) => occupied.add(index))
    const isPiece = unitType !== "snake"
    const body = (isPiece ? positions.slice(0, 1) : positions).map((i) =>
      indexToCell(i, width, height),
    )
    units.push({
      ...identity,
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

  // Every collision the server recorded this turn, mapped into renderer
  // coordinates once, here: the rings on the board and the clash inspector both
  // read these, so neither has to know how the wire numbers a square.
  const clashes: BoardClash[] = (turn.clashes ?? []).map((clash) => ({
    cell: indexToCell(clash.index, width, height),
    playerIDs: clash.playerIDs,
    reason: clash.reason,
    subStep: clash.subStep,
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
    teams: gameState.setup.teams.map((team) => ({
      id: team.id,
      name: team.name,
      color: team.color,
    })),
    units,
    deaths,
    clashes,
    deadUnits,
  }
}
