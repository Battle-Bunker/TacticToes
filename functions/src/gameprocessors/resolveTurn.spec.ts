// resolveTurn called DIRECTLY, the way the Chris-Centaur bot will call it
// after vendoring engine/. No processor, no Turn, no Firestore — a board and a
// roster in, the settled board and the death registry out. If these pass, a
// client reading `board` and `deaths` is reading the same verdict the server
// writes to the wire.

import { ResolveUnit, resolveTurn } from "./engine/resolveTurn"

// 11x11 board: index = y * 11 + x, perimeter is wall (interior 1..9).
const W = 11
const at = (x: number, y: number): number => y * W + x

const walls = (): number[] => {
  const cells = new Set<number>()
  for (let x = 0; x < W; x++) {
    cells.add(at(x, 0))
    cells.add(at(x, W - 1))
  }
  for (let y = 0; y < W; y++) {
    cells.add(at(0, y))
    cells.add(at(W - 1, y))
  }
  return Array.from(cells)
}

const unit = (over: Partial<ResolveUnit> & Pick<ResolveUnit, "id" | "occupancy">): ResolveUnit => ({
  type: "rook",
  teamID: over.id,
  tier: 0,
  energy: 100,
  orientation: { dx: 1, dy: 0 },
  ...over,
})

const settle = (
  units: ResolveUnit[],
  extra: Partial<Parameters<typeof resolveTurn>[0]> = {}
): ReturnType<typeof resolveTurn> =>
  resolveTurn({
    units,
    boardWidth: W,
    boardHeight: W,
    walls: walls(),
    hazards: [],
    hazardDamage: 100,
    food: [],
    ...extra,
  })

describe("resolveTurn, called from outside the processor", () => {
  it("reports an edge kill: who survives, where the loser died, and on which cell", () => {
    // Two rooks trade cells through one edge. Weight 2 beats weight 1: the
    // winner completes into the loser's cell, the loser is squashed at home.
    const heavy = at(4, 5)
    const light = at(5, 5)
    const settled = settle([
      unit({ id: "heavy", occupancy: [heavy, heavy], stagedMove: light }),
      unit({ id: "light", occupancy: [light], stagedMove: heavy }),
    ])

    expect(Object.keys(settled.board)).toEqual(["heavy"])
    expect(settled.board.heavy.occupancy).toEqual([light, light])
    expect(settled.board.heavy.energy).toBe(99) // one cell entered

    expect(settled.deaths).toEqual({
      light: { cell: light, subStep: 1, cause: "edge" },
    })
    expect(settled.finalCell.light).toBe(light)
    expect(settled.clashes).toEqual([
      expect.objectContaining({
        index: light,
        kind: "edge",
        playerIDs: ["heavy", "light"],
        victimIDs: ["light"],
        survivorID: "heavy",
      }),
    ])
  })

  it("reports an exhaustion recovery: halted, alive, and fed", () => {
    // A rook with 2 energy starts a long ray and runs dry on the second cell.
    // Food is waiting exactly there, so it eats, grows and survives — halted
    // well short of the cell it staged.
    const halt = at(3, 5)
    const settled = settle(
      [unit({ id: "r", occupancy: [at(1, 5)], energy: 2, stagedMove: at(9, 5) })],
      { food: [halt] }
    )

    expect(settled.deaths).toEqual({})
    expect(settled.board.r).toEqual({ occupancy: [halt, halt], energy: 100 })
    expect(settled.finalCell.r).toBe(halt)
    expect(settled.traversed.r).toEqual([at(2, 5), halt])
    expect(settled.food).toEqual([])
    // The halt is still on the wire, in the non-fatal shape.
    expect(settled.exhaustions).toHaveLength(1)
    expect(settled.exhaustions[0]).toMatchObject({ unitID: "r", cell: halt, subStep: 2 })
    expect(settled.exhaustions[0].record.victimIDs).toEqual([])
  })

  it("takes the same ray away when nothing is waiting at the halt cell", () => {
    const halt = at(3, 5)
    const settled = settle([
      unit({ id: "r", occupancy: [at(1, 5)], energy: 2, stagedMove: at(9, 5) }),
    ])

    expect(settled.board).toEqual({})
    expect(settled.deaths).toEqual({
      r: { cell: halt, subStep: 2, cause: "exhaustion" },
    })
    expect(settled.exhaustions[0].record.victimIDs).toEqual(["r"])
  })

  it("reports regicide off the returned board: the whole team goes with the king", () => {
    // Red's queen captures Blue's king. Blue also fields a rook far away and a
    // pawn that never moves — regicide takes both, and the caller can see the
    // entire outcome without knowing the rule exists.
    const kingAt = at(5, 5)
    const settled = settle(
      [
        unit({
          id: "blueKing",
          teamID: "blue",
          type: "king",
          isKing: true,
          occupancy: [kingAt],
        }),
        unit({ id: "blueRook", teamID: "blue", occupancy: [at(2, 8)] }),
        unit({ id: "bluePawn", teamID: "blue", type: "pawn", occupancy: [at(8, 2)] }),
        unit({
          id: "redQueen",
          teamID: "red",
          type: "queen",
          occupancy: [at(5, 2), at(5, 2), at(5, 2)],
          stagedMove: kingAt,
        }),
      ],
      { regicideTeamIDs: ["blue"] }
    )

    expect(Object.keys(settled.board)).toEqual(["redQueen"])
    expect(settled.eliminatedTeamIDs).toEqual(["blue"])
    expect(settled.deaths.blueKing).toEqual({
      cell: kingAt,
      subStep: 3,
      cause: "contest",
    })
    // The survivors of the sweep die where they stood, not where the king did.
    expect(settled.deaths.blueRook).toMatchObject({ cell: at(2, 8), cause: "regicide" })
    expect(settled.deaths.bluePawn).toMatchObject({ cell: at(8, 2), cause: "regicide" })
    expect(
      settled.clashes.filter((c) => c.kind === "regicide").map((c) => c.playerIDs[0]).sort()
    ).toEqual(["bluePawn", "blueRook"])
  })

  it("leaves a team alone while its king still stands", () => {
    const settled = settle(
      [
        unit({
          id: "blueKing",
          teamID: "blue",
          type: "king",
          isKing: true,
          occupancy: [at(5, 5), at(5, 5), at(5, 5), at(5, 5)],
        }),
        unit({ id: "blueRook", teamID: "blue", occupancy: [at(2, 8)] }),
        unit({
          id: "redQueen",
          teamID: "red",
          type: "queen",
          occupancy: [at(5, 2)],
          stagedMove: at(5, 5),
        }),
      ],
      { regicideTeamIDs: ["blue"] }
    )

    // The weight-4 king wins the contest; red's queen dies on it.
    expect(Object.keys(settled.board).sort()).toEqual(["blueKing", "blueRook"])
    expect(settled.eliminatedTeamIDs).toEqual([])
    expect(settled.deaths).toEqual({
      redQueen: { cell: at(5, 5), subStep: 3, cause: "contest" },
    })
  })

  it("mutates nothing the caller passed in", () => {
    const occupancy = [at(1, 5)]
    const food = [at(4, 5)]
    const units = [unit({ id: "r", occupancy, stagedMove: at(4, 5) })]

    const settled = settle(units, { food })

    expect(occupancy).toEqual([at(1, 5)]) // the rook moved, the input did not
    expect(food).toEqual([at(4, 5)]) // it ate, but from a copy
    expect(settled.board.r.occupancy).toEqual([at(4, 5), at(4, 5)])
    expect(settled.food).toEqual([])
  })

  it("accepts a pre-planned path instead of a staged cell", () => {
    const settled = settle([
      unit({ id: "r", occupancy: [at(1, 5)], path: [at(2, 5), at(3, 5)] }),
    ])

    expect(settled.board.r.occupancy).toEqual([at(3, 5)])
    expect(settled.traversed.r).toEqual([at(2, 5), at(3, 5)])
    expect(settled.board.r.energy).toBe(98)
  })

  it("reports a rotation rather than applying it", () => {
    // A pawn staged onto its side cell spends the turn turning: it does not
    // move, and the caller is handed the new facing to store how it likes.
    const pawnAt = at(3, 5)
    const settled = settle([
      unit({ id: "p", type: "pawn", occupancy: [pawnAt], stagedMove: at(3, 4) }),
    ])

    expect(settled.rotations).toEqual({ p: { dx: 0, dy: -1 } })
    expect(settled.board.p.occupancy).toEqual([pawnAt])
    expect(settled.board.p.energy).toBe(100) // rotating is free
  })
})
