// The grammar, asked questions.
//
// `engine/queries.ts` answers the inverse of the question the server asks:
// not "what does this staged cell mean" but "which cells may be staged, what
// would the unit walk, and what can it contest from here". Three consumers
// used to derive those for themselves and got three different answers, so
// these tests state the answer once, per kind, including the three the
// re-derivations kept getting wrong: a trail unit may stage a WALL, a hazard
// blocks NOTHING, and a pawn's cover is its diagonals rather than its step.

import { UnitType } from "@shared/types/Game"
import { Orientation } from "./engine/moveGrammar"
import {
  BoardShape,
  GrammarUnit,
  actionOf,
  coverOf,
  legalTargets,
  pathOf,
  rotationTargets,
  stagedAction,
} from "./engine/queries"

// 9x9 board: index = y * 9 + x, perimeter is wall (interior 1..7).
const W = 9
const at = (x: number, y: number): number => y * W + x

const perimeter = (): number[] => {
  const walls = new Set<number>()
  for (let x = 0; x < W; x++) {
    walls.add(at(x, 0))
    walls.add(at(x, W - 1))
  }
  for (let y = 0; y < W; y++) {
    walls.add(at(0, y))
    walls.add(at(W - 1, y))
  }
  return Array.from(walls).sort((a, b) => a - b)
}

const board = (overrides: Partial<BoardShape> = {}): BoardShape => ({
  boardWidth: W,
  boardHeight: W,
  walls: perimeter(),
  hazards: [],
  occupancy: [],
  food: [],
  ...overrides,
})

const unit = (
  type: UnitType,
  cell: number,
  orientation: Orientation = { dx: 1, dy: 0 },
  length = 1,
): GrammarUnit => ({
  type,
  occupancy: Array(length).fill(cell),
  orientation,
})

/** A body standing on `cells`, for blocking and pawn-target tests. */
const body = (id: string, ...cells: number[]) => ({ id, cells })

describe("legalTargets, per kind", () => {
  it("gives a trail unit its four orthogonal steps — the wall included", () => {
    // The one kind allowed to stage a wall: walking into the perimeter is a
    // legal move and a fatal one, and a caller that filtered walls out here
    // would be writing a narrower grammar than the server enforces.
    const snake = unit("snake", at(1, 1))
    expect(legalTargets(snake, board())).toEqual(
      [at(1, 0), at(0, 1), at(2, 1), at(1, 2)].sort((a, b) => a - b),
    )
  })

  it("does not let a trail unit hold", () => {
    // No "stay" for a snake: staging its own square is not a move at all, and
    // the default — one step along the orientation — takes over.
    const snake = unit("snake", at(4, 4))
    expect(legalTargets(snake, board())).not.toContain(at(4, 4))
    expect(stagedAction(snake, at(4, 4), board())).toEqual({
      kind: "move",
      path: [at(5, 4)],
    })
  })

  it("gives a rook its rank and file, and its own square to hold on", () => {
    const rook = unit("rook", at(4, 4))
    const targets = legalTargets(rook, board())

    expect(targets).toContain(at(4, 4)) // hold
    expect(targets).toContain(at(1, 4))
    expect(targets).toContain(at(7, 4))
    expect(targets).toContain(at(4, 1))
    expect(targets).toContain(at(4, 7))
    expect(targets).not.toContain(at(5, 5)) // no diagonal
    expect(targets).not.toContain(at(0, 4)) // no wall for a piece
    expect(targets).toHaveLength(1 + 6 + 6)
  })

  it("gives a bishop its diagonals only", () => {
    const bishop = unit("bishop", at(4, 4))
    const targets = legalTargets(bishop, board())

    expect(targets).toContain(at(1, 1))
    expect(targets).toContain(at(7, 7))
    expect(targets).toContain(at(7, 1))
    expect(targets).not.toContain(at(4, 1))
    expect(targets).toHaveLength(1 + 3 + 3 + 3 + 3)
  })

  it("gives a queen both, and a king one step of each", () => {
    const queen = unit("queen", at(4, 4))
    const king = unit("king", at(4, 4))

    expect(legalTargets(queen, board())).toHaveLength(1 + 12 + 12)
    expect(legalTargets(king, board())).toHaveLength(1 + 8)
    expect(legalTargets(king, board())).toContain(at(3, 3))
    expect(legalTargets(king, board())).not.toContain(at(2, 2))
  })

  it("gives a knight its eight jumps, and does not care what is in between", () => {
    // A jump crosses no cells, so a ring of bodies around it changes nothing.
    const knight = unit("knight", at(4, 4))
    const crowded = board({
      occupancy: [
        body("wall-of-flesh", at(3, 3), at(4, 3), at(5, 3), at(3, 4), at(5, 4), at(3, 5), at(4, 5), at(5, 5)),
      ],
    })

    expect(legalTargets(knight, board())).toHaveLength(1 + 8)
    expect(legalTargets(knight, crowded)).toEqual(legalTargets(knight, board()))
    expect(legalTargets(knight, board())).toContain(at(6, 5))
    expect(legalTargets(knight, board())).toContain(at(2, 3))
  })

  it("keeps a knight's jumps inside the board", () => {
    const knight = unit("knight", at(1, 1))
    // Only the four landings that stay in the interior.
    expect(legalTargets(knight, board())).toEqual([
      at(1, 1),
      at(3, 2),
      at(2, 3),
    ].sort((a, b) => a - b))
  })
})

describe("the pawn exception", () => {
  const forward = { dx: 0, dy: -1 }
  const pawn = unit("pawn", at(4, 4), forward)

  it("walks straight ahead, turns to the sides, and never backwards", () => {
    const targets = legalTargets(pawn, board())

    expect(targets).toContain(at(4, 3)) // the step it faces
    expect(targets).toContain(at(3, 4)) // a rotation
    expect(targets).toContain(at(5, 4)) // the other rotation
    expect(targets).toContain(at(4, 4)) // hold
    expect(targets).not.toContain(at(4, 5)) // behind: never
    expect(targets).toHaveLength(4)
  })

  it("takes a diagonal only when there is something on it", () => {
    // The diagonal is an attack or a meal, never a stroll — and the same
    // square is illegal when it is empty, which is the rule a re-derivation
    // that treated the pawn as "moves like a chess pawn" gets wrong.
    expect(actionOf(pawn, at(3, 3), board())).toBeNull()
    expect(actionOf(pawn, at(3, 3), board({ food: [at(3, 3)] }))).toEqual({
      kind: "move",
      path: [at(3, 3)],
    })
    expect(
      actionOf(pawn, at(5, 3), board({ occupancy: [body("victim", at(5, 3))] })),
    ).toEqual({ kind: "move", path: [at(5, 3)] })
  })

  it("may still turn with its back to the wall, because it never enters the side", () => {
    const cornered = unit("pawn", at(1, 1), { dx: -1, dy: 0 })
    const rotations = rotationTargets(cornered, board())

    // Facing the left wall from x=1: the sides are up and down, and the one
    // above is a wall square the pawn signals towards without entering.
    expect(rotations).toEqual([
      { target: at(1, 0), orientation: { dx: 0, dy: -1 } },
      { target: at(1, 2), orientation: { dx: 0, dy: 1 } },
    ])
    expect(pathOf(cornered, at(1, 0), board())).toEqual([])
  })

  it("covers the diagonals it may take and the square in front, not the sides", () => {
    const occupied = board({
      food: [at(3, 3)],
      occupancy: [body("victim", at(5, 3))],
    })
    expect(coverOf(pawn, occupied)).toEqual([at(3, 3), at(4, 3), at(5, 3)])
    // With both diagonals empty, only the step in front is covered.
    expect(coverOf(pawn, board())).toEqual([at(4, 3)])
  })
})

describe("pathOf", () => {
  it("walks a slider's whole ray, in the order it enters the cells", () => {
    const rook = unit("rook", at(1, 4))
    expect(pathOf(rook, at(5, 4), board())).toEqual([
      at(2, 4),
      at(3, 4),
      at(4, 4),
      at(5, 4),
    ])
  })

  it("hands back the untruncated ray, because stopping is the engine's job", () => {
    // The collision phase stops a slider where it meets a body; the grammar
    // still plans the whole ray, and this is the path the engine is handed.
    const rook = unit("rook", at(1, 4))
    const blocked = board({ occupancy: [body("blocker", at(3, 4))] })
    expect(pathOf(rook, at(5, 4), blocked)).toEqual(pathOf(rook, at(5, 4), board()))
  })

  it("walks one cell for a jump, however far it lands", () => {
    const knight = unit("knight", at(4, 4))
    expect(pathOf(knight, at(6, 5), board())).toEqual([at(6, 5)])
  })

  it("walks nowhere for a hold or a turn, and refuses an illegal target", () => {
    expect(pathOf(unit("rook", at(4, 4)), at(4, 4), board())).toEqual([])
    expect(pathOf(unit("pawn", at(4, 4), { dx: 0, dy: -1 }), at(3, 4), board())).toEqual([])
    expect(pathOf(unit("rook", at(4, 4)), at(5, 5), board())).toBeNull()
  })
})

describe("coverOf", () => {
  it("stops a ray at the cell it would capture on, and covers no further", () => {
    // The gate for this whole query: a rook facing a body three squares away
    // covers the three cells up to and including it, and nothing behind it.
    const rook = unit("rook", at(1, 4))
    const blocked = board({ occupancy: [body("blocker", at(4, 4))] })
    const covered = coverOf(rook, blocked)

    expect(covered).toContain(at(2, 4))
    expect(covered).toContain(at(3, 4))
    expect(covered).toContain(at(4, 4)) // the capture square itself
    expect(covered).not.toContain(at(5, 4)) // behind the body
    expect(covered).not.toContain(at(6, 4))
  })

  it("covers the whole rank and file when nothing is in the way", () => {
    const rook = unit("rook", at(4, 4))
    expect(coverOf(rook, board())).toEqual(
      [
        at(1, 4), at(2, 4), at(3, 4), at(5, 4), at(6, 4), at(7, 4),
        at(4, 1), at(4, 2), at(4, 3), at(4, 5), at(4, 6), at(4, 7),
      ].sort((a, b) => a - b),
    )
  })

  it("treats a hazard as open ground, because the engine does", () => {
    // Hazards cost health; they do not block, and a cover set that stopped at
    // one would under-report every square behind it.
    const rook = unit("rook", at(1, 4))
    const hazardous = board({ hazards: [at(3, 4)] })
    expect(coverOf(rook, hazardous)).toEqual(coverOf(rook, board()))
  })

  it("does not cover the wall a trail unit may walk into", () => {
    // A snake may STAGE the perimeter — it is a legal, fatal move — but it
    // contests nothing there, so the wall is not cover.
    const snake = unit("snake", at(1, 1))
    // In the corner of the interior it may stage two wall squares — up and
    // left — and covers only the two open ones.
    expect(legalTargets(snake, board())).toContain(at(1, 0))
    expect(legalTargets(snake, board())).toContain(at(0, 1))
    expect(coverOf(snake, board())).toEqual([at(2, 1), at(1, 2)].sort((a, b) => a - b))
  })

  it("covers a knight's landing squares regardless of what stands between", () => {
    const knight = unit("knight", at(4, 4))
    const crowded = board({
      occupancy: [body("ring", at(4, 3), at(5, 3), at(5, 4))],
    })
    expect(coverOf(knight, crowded)).toEqual(coverOf(knight, board()))
    expect(coverOf(knight, board())).toHaveLength(8)
  })

  it("covers a stacked piece's squares from the square it stands on", () => {
    // Weight is a stack of one cell, so a heavy queen covers exactly what a
    // light one does — the mistake a re-derivation makes when it treats
    // occupancy as a body.
    const heavy = unit("queen", at(4, 4), { dx: 1, dy: 0 }, 5)
    const light = unit("queen", at(4, 4))
    expect(coverOf(heavy, board())).toEqual(coverOf(light, board()))
  })
})

describe("stagedAction, the click preview", () => {
  it("substitutes the default when nothing legal was staged", () => {
    // What the human interface never derived: the server silently replaces an
    // illegal click, and a trail unit's replacement is momentum.
    const snake = unit("snake", at(4, 4), { dx: 0, dy: 1 })
    expect(stagedAction(snake, at(7, 7), board())).toEqual({
      kind: "move",
      path: [at(4, 5)],
    })
    expect(stagedAction(snake, undefined, board())).toEqual({
      kind: "move",
      path: [at(4, 5)],
    })
  })

  it("holds a piece that staged nothing legal, because a piece has no momentum", () => {
    expect(stagedAction(unit("bishop", at(4, 4)), at(4, 1), board())).toEqual({
      kind: "stay",
    })
  })

  it("is the same call resolveTurn makes, so a preview cannot drift from the turn", () => {
    // Not a claim about equivalence: resolveTurn imports this function. The
    // test is here so that a change which forked them fails somewhere.
    const pawn = unit("pawn", at(4, 4), { dx: 0, dy: -1 })
    expect(stagedAction(pawn, at(3, 4), board())).toEqual({
      kind: "rotate",
      orientation: { dx: -1, dy: 0 },
    })
  })
})
