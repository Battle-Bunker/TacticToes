import { UnitType } from "@shared/types/Game"
import { Orientation, UnitAction, defaultAction, planUnitAction } from "./moveGrammar"

/**
 * The grammar itself, re-exported so a consumer has ONE place to import the
 * whole movement surface from: `planUnitAction` plans a staged cell,
 * `defaultAction` says what happens when nothing legal was staged, and
 * `legalOrientations` is the facing set a kind can ever hold.
 */
export { defaultAction, legalOrientations, planUnitAction } from "./moveGrammar"

/**
 * The grammar, asked questions instead of applied.
 *
 * `moveGrammar.ts` answers one question — "here is a staged cell, what does
 * this unit do with it?" — because that is the only question the server ever
 * had. Everybody else needs the inverse: WHICH cells may be staged, what the
 * unit would walk to reach one, and what it could contest from where it
 * stands. Three consumers were left to derive those for themselves: a client
 * choosing a move (which got hazard terrain, trail-unit walls and pawn cover
 * wrong, three separate ways), the human interface (which derives nothing at
 * all, so a player clicks a square and the server silently substitutes the
 * default action), and anything constructing the set of moves an opponent
 * might plausibly make.
 *
 * So the inverse questions are answered here, in terms of the same
 * `planUnitAction` the server itself runs — not beside it. `stagedAction` IS
 * the server's own staging step, called by `resolveTurn`, which is what keeps
 * this file from becoming the fourth mirror it exists to delete.
 */

/** The board a query is asked against: terrain, bodies and food. */
export interface BoardShape {
  readonly boardWidth: number
  readonly boardHeight: number
  /** The perimeter. Nothing but a trail unit may ever stage one. */
  readonly walls: ReadonlyArray<number>
  /**
   * Hazard cells. They damage, they do NOT block: every query treats a hazard
   * as open ground, because the grammar does and so does the collision engine.
   */
  readonly hazards: ReadonlyArray<number>
  /** Every unit standing at the start of the turn, with its whole body. */
  readonly occupancy: ReadonlyArray<{
    readonly id: string
    readonly cells: ReadonlyArray<number>
  }>
  /** Food on the board — half of what a pawn is allowed to take diagonally. */
  readonly food: ReadonlyArray<number>
}

/**
 * What a query needs to know about a unit: its kind, where it stands and
 * which way it faces. A `ResolveUnit` satisfies this, so a caller that
 * already has a roster passes its entries straight in.
 */
export interface GrammarUnit {
  readonly type: UnitType
  /** Board occupancy, index 0 = head. */
  readonly occupancy: ReadonlyArray<number>
  readonly orientation: Orientation
}

/**
 * A pawn's diagonal step is an attack or a meal, never a stroll: the cells it
 * may take that way are the ones holding food or a body when the turn opens.
 * Every body, its own included — the grammar makes no exception and neither
 * does this.
 */
const pawnTargetsOf = (board: BoardShape): Set<number> => {
  const targets = new Set<number>(board.food)
  board.occupancy.forEach((unit) => unit.cells.forEach((cell) => targets.add(cell)))
  return targets
}

/**
 * The action a staged cell actually produces — the server's own staging step,
 * default substitution included. An illegal or missing destination falls back
 * to the kind's default: trail units continue straight, wherever that leads,
 * and pieces hold. This is what the interface needs in order to show a player
 * what their click will really do.
 */
export const stagedAction = (
  unit: GrammarUnit,
  staged: number | undefined,
  board: BoardShape,
): UnitAction => {
  const origin = unit.occupancy[0]
  const planned =
    staged === undefined
      ? null
      : planUnitAction(
          unit.type,
          origin,
          staged,
          board.boardWidth,
          board.boardHeight,
          unit.orientation,
          pawnTargetsOf(board),
        )
  return (
    planned ??
    defaultAction(unit.type, origin, board.boardWidth, board.boardHeight, unit.orientation)
  )
}

/**
 * The action a staged cell produces, or null when the kind cannot be staged
 * there at all. The same call as `stagedAction` without the default: a caller
 * enumerating moves wants the null, a caller previewing a click wants the
 * default.
 */
export const actionOf = (
  unit: GrammarUnit,
  target: number,
  board: BoardShape,
): UnitAction | null =>
  planUnitAction(
    unit.type,
    unit.occupancy[0],
    target,
    board.boardWidth,
    board.boardHeight,
    unit.orientation,
    pawnTargetsOf(board),
  )

/**
 * Every cell this unit may legally be staged to, in board order.
 *
 * Staging legality, which is not the same as arriving: a slider may be staged
 * clean through a body and the collision engine will stop it where it meets
 * one, and a trail unit may be staged into the perimeter, which is a legal
 * move and a fatal one. Both belong in the set — they are moves the server
 * accepts — and a caller that wants only the safe ones filters this, rather
 * than writing a narrower grammar of its own.
 *
 * A piece's own square is in the set (staging it is "hold"); a trail unit's is
 * not (it has no hold, so staging its own square is simply not a move). A
 * pawn's two side squares are in it as rotations, which is why a target here
 * does not always mean the unit goes anywhere.
 */
export const legalTargets = (unit: GrammarUnit, board: BoardShape): number[] => {
  const pawnTargets = pawnTargetsOf(board)
  const origin = unit.occupancy[0]
  const targets: number[] = []
  const cells = board.boardWidth * board.boardHeight
  for (let cell = 0; cell < cells; cell++) {
    const action = planUnitAction(
      unit.type,
      origin,
      cell,
      board.boardWidth,
      board.boardHeight,
      unit.orientation,
      pawnTargets,
    )
    if (action) targets.push(cell)
  }
  return targets
}

/**
 * The cells the unit would walk to reach a target, in the order it enters
 * them — a slider's whole ray, its destination included — or null when the
 * target is not legal for this kind. An action that moves the unit nowhere
 * (a piece holding, a pawn turning) walks no cells and returns an empty path,
 * which is a legal answer and not a refusal.
 *
 * This is the path the engine is HANDED, so it is untruncated: what the unit
 * meets on the way is the collision phase's business, not the grammar's.
 */
export const pathOf = (
  unit: GrammarUnit,
  target: number,
  board: BoardShape,
): number[] | null => {
  const action = actionOf(unit, target, board)
  if (!action) return null
  return action.kind === "move" ? [...action.path] : []
}

/**
 * The cells this unit could contest next turn: the union of its legal targets'
 * paths, in board order, each path cut where the board would stop it.
 *
 * The cut is what makes this cover rather than a reachability fantasy. A ray
 * ends at the first cell holding a body — that cell INCLUDED, because it is
 * exactly the cell a capture happens on, and the engine stops the winner
 * there — and a wall is excluded, because a unit that stages one dies on it
 * rather than contesting it. Hazards cut nothing: they cost health, and a
 * unit crossing one still arrives.
 *
 * A jump is a single cell, so nothing between the knight and its landing
 * square matters; a pawn covers the two diagonals it may take THIS turn and
 * the square in front, and never the sides it can only turn towards.
 */
export const coverOf = (unit: GrammarUnit, board: BoardShape): number[] => {
  const walls = new Set(board.walls)
  const bodies = new Set<number>()
  board.occupancy.forEach((u) => u.cells.forEach((cell) => bodies.add(cell)))

  const covered = new Set<number>()
  legalTargets(unit, board).forEach((target) => {
    const path = pathOf(unit, target, board) ?? []
    for (const cell of path) {
      if (walls.has(cell)) break
      covered.add(cell)
      if (bodies.has(cell)) break
    }
  })
  return Array.from(covered).sort((a, b) => a - b)
}

/**
 * The turns this unit could spend rotating instead of moving: the cell to
 * stage, and the facing it would end up with. Only a pawn has any — every
 * other kind takes its facing from where it walked — and a pawn has them even
 * with its back to a wall, because the side square is signalling and is never
 * entered.
 */
export const rotationTargets = (
  unit: GrammarUnit,
  board: BoardShape,
): { target: number; orientation: Orientation }[] => {
  const rotations: { target: number; orientation: Orientation }[] = []
  legalTargets(unit, board).forEach((target) => {
    const action = actionOf(unit, target, board)
    if (action?.kind === "rotate") rotations.push({ target, orientation: action.orientation })
  })
  return rotations
}
