// The crowded board corpus the engine is exercised against.
//
// `settlePartial.spec.ts` enumerates every concrete world of these boards and
// `engineBench.sim.ts` times the engine on them, so the two speak about the
// same positions rather than about two generators that drifted apart. Boards
// carry pieces of every kind, snakes, food, potions, hazards, effects and an
// occasional king, because a claim that is only ever tested — or timed — on a
// bare board is a claim about a game nobody plays.
//
// Not part of the vendorable engine: this is a fixture, and the module under
// `engine/` may not import it (see engine/VENDOR.md).

import { ActiveEffect, UnitType } from "@shared/types/Game"
import { Orientation } from "./engine/moveGrammar"
import { ResolveUnit } from "./engine/resolveTurn"
import { PartialSettleInput } from "./engine/settlePartial"
import { perimeter } from "./playTurn"

export const W = 9
export const KINDS: UnitType[] = ["snake", "pawn", "knight", "bishop", "rook", "queen", "king"]
export const ORTHO: Orientation[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
]

export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const WALLS = perimeter(W, W)
export const INTERIOR = (): number[] => {
  const cells: number[] = []
  for (let y = 1; y < W - 1; y++) for (let x = 1; x < W - 1; x++) cells.push(y * W + x)
  return cells
}

/** A crowded 9x9 with every kind, a trail or two, items, hazards and effects. */
export const makeBoard = (seed: number): PartialSettleInput => {
  const rnd = mulberry32(seed)
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const free = new Set(INTERIOR())
  const take = (): number => {
    const options = Array.from(free)
    const cell = options[Math.floor(rnd() * options.length)]
    free.delete(cell)
    return cell
  }

  const unitCount = 3 + Math.floor(rnd() * 5)
  const units: ResolveUnit[] = []
  const teamOf: { [unitID: string]: string } = {}
  for (let i = 0; i < unitCount; i++) {
    const type = pick(KINDS)
    const teamID = i % 2 === 0 ? "A" : "B"
    const head = take()
    const occupancy = [head]
    if (type === "snake") {
      const length = 2 + Math.floor(rnd() * 3)
      let at = head
      for (let j = 1; j < length; j++) {
        const step = pick(ORTHO)
        const next = at + step.dx + step.dy * W
        if (!free.has(next)) break
        free.delete(next)
        occupancy.push(next)
        at = next
      }
    } else {
      const stack = 1 + Math.floor(rnd() * 3)
      for (let j = 1; j < stack; j++) occupancy.push(head)
    }
    const id = `u${i}`
    teamOf[id] = teamID
    units.push({
      id,
      type,
      teamID,
      isKing: type === "king",
      tier: Math.floor(rnd() * 3) - 1,
      energy: rnd() < 0.35 ? 1 + Math.floor(rnd() * 4) : 20 + Math.floor(rnd() * 80),
      occupancy,
      orientation: pick(ORTHO),
      stagedMove: Math.floor(rnd() * W * W),
    })
  }

  const food: number[] = []
  for (let i = 0; i < 2 + Math.floor(rnd() * 4); i++) if (free.size) food.push(take())
  const potions: number[] = []
  for (let i = 0; i < Math.floor(rnd() * 3); i++) if (free.size) potions.push(take())
  const hazards: number[] = []
  for (let i = 0; i < Math.floor(rnd() * 4); i++) if (free.size) hazards.push(take())

  const turn = 7
  const effects: ActiveEffect[] = []
  units.forEach((u) => {
    if (rnd() > 0.25) return
    effects.push({
      playerID: u.id,
      type: rnd() < 0.5 ? "invulnerability_buff" : "invulnerability_debuff",
      level: rnd() < 0.5 ? 1 : -1,
      expiryTurn: turn - 1 + Math.floor(rnd() * 4),
      sourcePlayerID: u.id,
    })
  })

  return {
    units,
    boardWidth: W,
    boardHeight: W,
    walls: WALLS,
    hazards,
    hazardDamage: pick([1, 5, 40]),
    food,
    defaultMaxEnergy: 100,
    maxEnergy: { queen: 80 },
    // A third of the boards play a food worth far less than a tank, where a
    // meal feeds without growing and an exhausted unit's rescue is not
    // automatic. Derived from the seed rather than drawn, so every board's
    // units, items and terrain are the ones they always were.
    foodEnergy: seed % 3 === 0 ? 5 : 100,
    regicideTeamIDs: units.some((u) => u.isKing) ? ["A", "B"] : [],
    turn,
    teamOf,
    effects,
    potions,
    potionsEnabled: potions.length > 0,
    potionWindowTurns: 3,
    pawnPromotionWeight: 4,
    maxTurns: null,
    held: [],
  }
}

/**
 * The same board with some units' moves taken away — a search's own shape.
 *
 * `staleness` is how many turns ago the held units were last observed, which
 * is the span a claim dilates over: 1 is a unit seen on this very board, and
 * anything more sends the reach BFS through the permissive shape.
 */
export const held = (
  input: PartialSettleInput,
  ids: string[],
  staleness = 1,
): PartialSettleInput => ({
  ...input,
  held: ids.map((id) => ({ id, observedTurn: input.turn - staleness })),
})
