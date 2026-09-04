// PARTIAL SETTLEMENT, AGAINST THE ONE ENGINE ITSELF.
//
// `settlePartial` is a MODE of `settleTurn`, so the only oracle worth having
// is `settleTurn`. Nothing here compares two encodings of the rules: every
// assertion enumerates the CONCRETE worlds a held unit's unknown move could
// produce, settles each one with the ordinary total settlement, and asks
// whether the partial settlement said something true about all of them.
//
// The four properties, in the order they matter:
//
//   T5  with nothing held, `settlePartial` IS `settleTurn`, coordinate for
//       coordinate — the reduction that makes "one engine" a fact rather
//       than a slogan;
//   T1  every concrete world differs from the optimistic timeline only where
//       the ledger says it could, which is what makes an EMPTY LEDGER A
//       PROOF and a non-empty one a work list;
//   T2  `fates` "dead" and "alive" hold in every world; "contingent" claims
//       nothing and must be backed by a ledger entry;
//   T3  every coordinate a rule reads — survival, weight, energy, tier — is
//       inside the bracket the ledger and the claims imply.
//
// and separately, that the CLAIMS themselves contain the truth: where a held
// unit actually went, in every world, is inside what `computeClaims` said it
// could be, at every sub-step.
//
// Boards carry pieces of every kind, snakes, food, potions, hazards, effects
// and an occasional king, because a claim that is only ever tested on a bare
// board is a claim about a game nobody plays.

import { ActiveEffect, UnitType } from "@shared/types/Game"
import { Claim, computeClaims } from "./engine/claims"
import { Orientation } from "./engine/moveGrammar"
import { BoardShape, legalTargets } from "./engine/queries"
import { ResolveUnit } from "./engine/resolveTurn"
import { PartialSettleInput, settlePartial } from "./engine/settlePartial"
import { Settlement, settleTurn } from "./engine/settleTurn"
import { perimeter } from "./playTurn"
import { NO_SPAWN } from "./engine/spawn"

const W = 9
const KINDS: UnitType[] = ["snake", "pawn", "knight", "bishop", "rook", "queen", "king"]
const ORTHO: Orientation[] = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
]

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WALLS = perimeter(W, W)
const INTERIOR = (): number[] => {
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

const shapeOf = (input: PartialSettleInput): BoardShape => ({
  boardWidth: input.boardWidth,
  boardHeight: input.boardHeight,
  walls: input.walls,
  hazards: input.hazards,
  occupancy: input.units.map((u) => ({ id: u.id, cells: u.occupancy })),
  food: input.food,
})

/** Every disposition a held unit could be given: each legal cell, and none. */
export const optionsFor = (input: PartialSettleInput, id: string): (number | undefined)[] => {
  const unit = input.units.find((u) => u.id === id) as ResolveUnit
  const targets = legalTargets(unit, shapeOf(input))
  return [undefined, ...targets]
}

/** The board with every held unit's move filled in — an ordinary total turn. */
export const concrete = (
  input: PartialSettleInput,
  assignment: ReadonlyMap<string, number | undefined>,
): Settlement =>
  settleTurn(
    {
      ...input,
      units: input.units.map((u) =>
        assignment.has(u.id) ? { ...u, stagedMove: assignment.get(u.id), path: undefined } : u,
      ),
    },
    NO_SPAWN,
  )

/** Every concrete world, or null when the product is bigger than the budget. */
const worldsOf = (
  input: PartialSettleInput,
  budget: number,
): ReadonlyArray<Map<string, number | undefined>> | null => {
  const lists = input.held.map((h) => ({ id: h.id, options: optionsFor(input, h.id) }))
  const size = lists.reduce((n, l) => n * l.options.length, 1)
  if (size > budget) return null

  let out: Map<string, number | undefined>[] = [new Map()]
  lists.forEach((list) => {
    const next: Map<string, number | undefined>[] = []
    out.forEach((base) =>
      list.options.forEach((option) => {
        const copy = new Map(base)
        copy.set(list.id, option)
        next.push(copy)
      }),
    )
    out = next
  })
  return out
}

/** Head cell per sub-step, as a settlement left it. */
export const headsOf = (settlement: Settlement, unit: ResolveUnit, subSteps: number): number[] => {
  const traversed = settlement.traversed[unit.id] ?? []
  const heads = [unit.occupancy[0]]
  for (let k = 1; k <= subSteps; k++) heads.push(k <= traversed.length ? traversed[k - 1] : heads[k - 1])
  return heads
}

/**
 * The first sub-step at which two settlements disagree about one unit, or
 * null when they agree about everything a rule reads.
 */
const divergedAtFor = (
  a: Settlement,
  b: Settlement,
  unit: ResolveUnit,
  subSteps: number,
): number | null => {
  const ha = headsOf(a, unit, subSteps)
  const hb = headsOf(b, unit, subSteps)
  for (let k = 1; k <= subSteps; k++) if (ha[k] !== hb[k]) return k
  const ua = a.board[unit.id]
  const ub = b.board[unit.id]
  if (!ua !== !ub) return subSteps
  if (ua && ub) {
    if (ua.energy !== ub.energy) return subSteps
    if (ua.occupancy.length !== ub.occupancy.length) return subSteps
    if (ua.occupancy.join() !== ub.occupancy.join()) return subSteps
  }
  if ((a.tiers[unit.id] ?? 0) !== (b.tiers[unit.id] ?? 0)) return subSteps
  return null
}

export const held = (input: PartialSettleInput, ids: string[]): PartialSettleInput => ({
  ...input,
  held: ids.map((id) => ({ id, observedTurn: input.turn - 1 })),
})

// --------------------------------------------------------------- T5

describe("T5 — with nothing held, partial settlement IS settlement", () => {
  it("agrees with settleTurn coordinate for coordinate, on 300 random boards", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const input = makeBoard(seed)
      const total = settleTurn(input, NO_SPAWN)
      const partial = settlePartial(input, NO_SPAWN)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { ledger, fates, claims, ...rest } = partial
      expect(JSON.parse(JSON.stringify(rest))).toEqual(JSON.parse(JSON.stringify(total)))
      expect(ledger).toEqual([])
      expect(claims).toEqual([])
      input.units.forEach((u) => {
        expect(fates[u.id]).toBe(total.deaths[u.id] ? "dead" : "alive")
      })
    }
  })
})

// ------------------------------------------------- T1 / T2 / T3 / claims

interface Coverage {
  boards: number
  skipped: number
  worlds: number
  entries: number
  emptyLedgers: number
}

const sweep = (
  seeds: readonly number[],
  heldCount: number,
  budget: number,
  coverage: Coverage,
): string[] => {
  const failures: string[] = []
  const fail = (what: string): void => {
    if (failures.length < 4) failures.push(what)
  }
  seeds.forEach((seed) => {
    const base = makeBoard(seed)
    const ids = base.units.slice(0, heldCount).map((u) => u.id)
    if (ids.length < heldCount) return
    const input = held(base, ids)
    const all = worldsOf(input, budget)
    if (!all) {
      coverage.skipped++
      return
    }
    coverage.boards++
    coverage.worlds += all.length

    const partial = settlePartial(input, NO_SPAWN)
    coverage.entries += partial.ledger.length
    if (partial.ledger.length === 0) coverage.emptyLedgers++

    const heldIds = new Set(ids)
    const live = input.units.filter((u) => !heldIds.has(u.id))
    const liveIds = new Set(live.map((u) => u.id))

    // ATTRIBUTION. `heldId` is a held unit on every entry, whatever route the
    // uncertainty took to get there, and `via` is the route: modelled units,
    // in order, each named once and none of them the root.
    partial.ledger.forEach((entry) => {
      if (!heldIds.has(entry.heldId)) {
        fail(`CHAIN seed=${seed} entry heldId=${entry.heldId} is not held`)
      }
      if (new Set(entry.via).size !== entry.via.length) {
        fail(`CHAIN seed=${seed} via repeats a unit: ${entry.via.join(">")}`)
      }
      entry.via.forEach((link) => {
        if (!liveIds.has(link)) fail(`CHAIN seed=${seed} via link ${link} is not modelled`)
      })
    })
    const named = new Set(partial.ledger.map((e) => e.unitId))
    const subSteps = Math.max(
      partial.subStepCount,
      ...partial.claims.map((c) => c.headPossible.length - 1),
    )

    all.forEach((assignment) => {
      const truth = concrete(input, assignment)
      const world = JSON.stringify(Array.from(assignment.entries()))

      // T1 — divergence containment, and its corollary.
      live.forEach((unit) => {
        const at = divergedAtFor(partial, truth, unit, subSteps)
        if (at === null) return
        const entries = partial.ledger.filter((e) => e.unitId === unit.id)
        if (entries.length === 0) {
          fail(`T1 seed=${seed} unit=${unit.id}(${unit.type}) at=${at} world=${world} unledgered`)
          return
        }
        const first = Math.min(...entries.map((e) => e.subStep))
        if (first > at) {
          fail(`T1 seed=${seed} unit=${unit.id}(${unit.type}) at=${at} first=${first} world=${world}`)
        }
      })

      // T1, the survival half. `couldBeat: false` is the strongest thing an
      // entry says — "the contact is real but this unit wins it in every
      // world" — so a unit the optimistic timeline leaves standing that a
      // concrete world kills must be named by an entry that ADMITS it could
      // lose, at or before the sub-step it lost at. A ledger of nothing but
      // `couldBeat: false` around a unit is a survival proof, and a survival
      // proof the resolver contradicts is the one failure T1 cannot see by
      // comparing coordinates: the unit IS named, and named early enough.
      live.forEach((unit) => {
        if (!partial.board[unit.id] || truth.board[unit.id]) return
        const death = truth.deaths[unit.id]
        const beatable = partial.ledger.filter((e) => e.unitId === unit.id && e.couldBeat)
        if (beatable.length === 0) {
          fail(
            `T1b seed=${seed} unit=${unit.id}(${unit.type}) dies ` +
              `${death?.cause}@${death?.cell} world=${world}, every entry says it wins`,
          )
          return
        }
        const first = Math.min(...beatable.map((e) => e.subStep))
        if (death !== undefined && first > death.subStep) {
          fail(
            `T1b seed=${seed} unit=${unit.id}(${unit.type}) dies at ${death.subStep}, ` +
              `earliest couldBeat ${first}, world=${world}`,
          )
        }
      })

      // T2 — fates are proofs in both directions.
      live.forEach((unit) => {
        const fate = partial.fates[unit.id]
        if (fate === "dead" && truth.board[unit.id]) {
          fail(`T2 seed=${seed} unit=${unit.id} called dead but lives, world=${world}`)
        }
        if (fate === "alive" && !truth.board[unit.id]) {
          fail(`T2 seed=${seed} unit=${unit.id} called alive but dies, world=${world}`)
        }
        if (fate === "contingent" && !named.has(unit.id)) {
          fail(`T2 seed=${seed} unit=${unit.id} contingent with no entry`)
        }
      })
      partial.claims.forEach((claim) => {
        if (claim.certainlyGone && truth.board[claim.id]) {
          fail(`T2 seed=${seed} claim=${claim.id} certainlyGone but lives, world=${world}`)
        }
        if (!claim.deathPossible && !truth.board[claim.id]) {
          fail(`T2 seed=${seed} claim=${claim.id} deathPossible=false but dies, world=${world}`)
        }
      })

      // T3 — a unit no entry names is settled identically in every world.
      live.forEach((unit) => {
        if (named.has(unit.id)) return
        const at = divergedAtFor(partial, truth, unit, subSteps)
        if (at !== null) fail(`T3 seed=${seed} unit=${unit.id} unnamed but diverges at ${at}`)
      })

      // The claims contain the truth, at every sub-step.
      partial.claims.forEach((claim) => {
        const record = input.units.find((u) => u.id === claim.id) as ResolveUnit
        claimFailures(claim, record, truth, subSteps, seed, world).forEach(fail)
      })
    })
  })
  return failures
}

const claimFailures = (
  claim: Claim,
  record: ResolveUnit,
  truth: Settlement,
  subSteps: number,
  seed: number,
  world: string,
): string[] => {
  const out: string[] = []
  const tag = `seed=${seed} claim=${claim.id}(${record.type}) world=${world}`
  const heads = headsOf(truth, record, subSteps)
  for (let k = 0; k <= subSteps; k++) {
    const set = claim.headPossible[Math.min(k, claim.headPossible.length - 1)]
    if (!set.includes(heads[k])) out.push(`CLAIM head ${tag} k=${k} cell=${heads[k]} outside`)
    else if (claim.earliestSubStep[heads[k]] > k) out.push(`CLAIM early ${tag} k=${k}`)
  }
  const settled = truth.board[claim.id]
  if (!settled) return out
  if (settled.occupancy.length < claim.weightMin || settled.occupancy.length > claim.weightMax) {
    out.push(`CLAIM weight ${tag} ${settled.occupancy.length} vs [${claim.weightMin},${claim.weightMax}]`)
  }
  // Energy is a coordinate a rule reads (exhaustion), and its ceiling is now
  // arithmetic — observed energy plus what the meals in reach are worth —
  // rather than "there was food, so assume a full tank". Worth enumerating.
  if (settled.energy > claim.energyMax) {
    out.push(`CLAIM energy ${tag} ${settled.energy} vs max ${claim.energyMax}`)
  }
  const body = claim.bodyPossible[claim.bodyPossible.length - 1]
  const front = claim.headPossible[claim.headPossible.length - 1]
  settled.occupancy.forEach((cell) => {
    if (!body.includes(cell) && !front.includes(cell)) {
      out.push(`CLAIM body ${tag} cell=${cell} outside`)
    }
  })
  return out
}

const report = (label: string, coverage: Coverage): void => {
  // Printed rather than asserted: a property test whose reach nobody can see
  // is a property test nobody can size.
  process.stdout.write(
    `  ${label}: ${coverage.boards} boards, ${coverage.worlds} worlds, ` +
      `${coverage.skipped} skipped over budget, ${coverage.entries} ledger entries, ` +
      `${coverage.emptyLedgers} boards proved by an empty ledger\n`,
  )
}

describe("T1–T3 by enumeration — one held unit", () => {
  it("holds in every world of 400 boards", () => {
    const coverage: Coverage = { boards: 0, skipped: 0, worlds: 0, entries: 0, emptyLedgers: 0 }
    expect(sweep(range(1, 400), 1, 200, coverage)).toEqual([])
    report("1 held", coverage)
    expect(coverage.boards).toBeGreaterThan(350)
    expect(coverage.worlds).toBeGreaterThan(3000)
  })
})

describe("T1–T3 by enumeration — two held units", () => {
  it("holds in every world of 250 boards", () => {
    const coverage: Coverage = { boards: 0, skipped: 0, worlds: 0, entries: 0, emptyLedgers: 0 }
    expect(sweep(range(1001, 1250), 2, 1200, coverage)).toEqual([])
    report("2 held", coverage)
    expect(coverage.boards).toBeGreaterThan(120)
    expect(coverage.worlds).toBeGreaterThan(20000)
  })
})

describe("T1–T3 by enumeration — three held units", () => {
  it("holds in every world it can afford of 200 boards", () => {
    const coverage: Coverage = { boards: 0, skipped: 0, worlds: 0, entries: 0, emptyLedgers: 0 }
    expect(sweep(range(2001, 2200), 3, 4000, coverage)).toEqual([])
    report("3 held", coverage)
    expect(coverage.boards + coverage.skipped).toBe(200)
    expect(coverage.worlds).toBeGreaterThan(20000)
  })
})

// ------------------------------------------------- the n-turn premise

/**
 * A unit observed a turn ago has TWO unknown moves to answer for, and the
 * plan's `Hist(h)` says exactly what the second one is played on: the board as
 * `h` ALONE would have moved on it. So the first move is settled with `h` and
 * nobody else — the same `settleTurn`, over a roster of one — and the turn
 * under test opens on what that left behind, food eaten and energy spent
 * included.
 *
 * Potions are switched off for this sweep. A pickup during the unknown turn
 * rewrites an effect schedule that a roster of one cannot rewrite honestly,
 * and the tier interval it produces is tested where it belongs, in the claim.
 */
const advanceAlone = (
  input: PartialSettleInput,
  id: string,
  staged: number | undefined,
): PartialSettleInput | null => {
  const record = input.units.find((u) => u.id === id) as ResolveUnit
  const solo = settleTurn(
    {
      ...input,
      units: [{ ...record, stagedMove: staged, path: undefined }],
      regicideTeamIDs: [],
      turn: input.turn - 1,
    },
    NO_SPAWN,
  )
  const settled = solo.board[id]
  const others = input.units.filter((u) => u.id !== id)
  const next = {
    ...input,
    food: solo.food,
    units: settled
      ? [
          ...others,
          {
            ...record,
            type: solo.unitTypes[id],
            occupancy: settled.occupancy,
            energy: settled.energy,
            orientation: solo.orientation[id],
          },
        ]
      : others,
  }
  return settled || others.length > 0 ? next : null
}

describe("T1–T3 by enumeration — a unit observed a turn ago", () => {
  it("holds over every two-move history on 400 boards", () => {
    const coverage: Coverage = { boards: 0, skipped: 0, worlds: 0, entries: 0, emptyLedgers: 0 }
    const failures: string[] = []
    for (let seed = 3001; seed <= 3400; seed++) {
      const base: PartialSettleInput = { ...makeBoard(seed), potions: [], potionsEnabled: false }
      const id = base.units[0].id
      const input: PartialSettleInput = {
        ...base,
        held: [{ id, observedTurn: base.turn - 2 }],
      }
      const first = optionsFor(input, id)
      if (first.length > 14) {
        coverage.skipped++
        continue
      }
      coverage.boards++
      const partial = settlePartial(input, NO_SPAWN)
      coverage.entries += partial.ledger.length
      if (partial.ledger.length === 0) coverage.emptyLedgers++
      const live = input.units.filter((u) => u.id !== id)
      const named = new Set(partial.ledger.map((e) => e.unitId))
      const subSteps = Math.max(
        partial.subStepCount,
        ...partial.claims.map((c) => c.headPossible.length - 1),
      )
      const claim = partial.claims[0]

      first.forEach((a1) => {
        const mid = advanceAlone(input, id, a1)
        if (!mid) return
        const second = mid.units.some((u) => u.id === id) ? optionsFor(mid, id) : [undefined]
        second.forEach((a2) => {
          coverage.worlds++
          const truth = settleTurn(
            {
              ...mid,
              units: mid.units.map((u) =>
                u.id === id ? { ...u, stagedMove: a2, path: undefined } : u,
              ),
            },
            NO_SPAWN,
          )
          const world = `${a1}/${a2}`
          live.forEach((unit) => {
            const at = divergedAtFor(partial, truth, unit, subSteps)
            if (at === null) return
            if (!named.has(unit.id) && failures.length < 4) {
              failures.push(`SPAN2 seed=${seed} unit=${unit.id}(${unit.type}) at=${at} ${world}`)
            }
          })
          const record = mid.units.find((u) => u.id === id)
          if (!record) {
            if (claim.certainlyGone === false && !claim.deathPossible && failures.length < 4) {
              failures.push(`SPAN2 seed=${seed} claim dies but deathPossible=false ${world}`)
            }
            return
          }
          claimFailures(claim, record, truth, subSteps, seed, world).forEach((f) => {
            if (failures.length < 4) failures.push(f)
          })
        })
      })
    }
    expect(failures).toEqual([])
    report("span 2", coverage)
    expect(coverage.boards).toBeGreaterThan(200)
    expect(coverage.worlds).toBeGreaterThan(15000)
  })
})

// ----------------------------------------- the causal chain, by enumeration
//
// The cascade property, on the shape the search actually meets: OUR units,
// modelled, and ONE enemy nobody modelled. Three things are asked of it, and
// the third is the one the bot cannot work without.
//
//   · T1/T2/T3 as ever, over every concrete world;
//   · CERTAINTY BEFORE THE FIRST ENTRY. Everything a modelled ally did
//     strictly before the earliest sub-step the ledger names it at is what it
//     did in every world. A cascade that wrote every unit off from sub-step 1
//     would leave nothing here to check, which is exactly how it went unnoticed;
//   · ATTRIBUTION ALL THE WAY DOWN. However many modelled allies the
//     uncertainty travelled through, `heldId` is the held enemy — so a caller
//     partitions by ITS options, not by our own roster — and `via` is the road
//     it came by.

interface ChainCoverage extends Coverage {
  chained: number
  certainCells: number
  contingent: number
}

describe("the causal chain — two modelled allies and one held enemy", () => {
  it("attributes every divergence to the enemy, and keeps the rest certain", () => {
    const coverage: ChainCoverage = {
      boards: 0,
      skipped: 0,
      worlds: 0,
      entries: 0,
      emptyLedgers: 0,
      chained: 0,
      certainCells: 0,
      contingent: 0,
    }
    const failures: string[] = []
    const fail = (what: string): void => {
      if (failures.length < 6) failures.push(what)
    }

    for (let seed = 4001; seed <= 4400; seed++) {
      const base = makeBoard(seed)
      const allies = base.units.filter((u) => u.teamID === "A")
      const enemies = base.units.filter((u) => u.teamID === "B")
      if (allies.length < 2 || enemies.length < 1) continue
      const enemy = enemies[0].id
      const input = held(base, [enemy])
      const all = worldsOf(input, 200)
      if (!all) {
        coverage.skipped++
        continue
      }
      coverage.boards++
      coverage.worlds += all.length

      const partial = settlePartial(input, NO_SPAWN)
      coverage.entries += partial.ledger.length
      if (partial.ledger.length === 0) coverage.emptyLedgers++
      if (partial.ledger.some((e) => e.via.length > 0)) coverage.chained++

      const live = input.units.filter((u) => u.id !== enemy)
      const named = new Set(partial.ledger.map((e) => e.unitId))
      const subSteps = Math.max(
        partial.subStepCount,
        ...partial.claims.map((c) => c.headPossible.length - 1),
      )

      // ATTRIBUTION. One held unit, so every entry — direct, cascaded through
      // an ally, or carried by the regicide rule — must name it and nothing else.
      partial.ledger.forEach((entry) => {
        if (entry.heldId !== enemy) {
          fail(`CHAIN seed=${seed} heldId=${entry.heldId} via=[${entry.via.join(">")}] not ${enemy}`)
        }
        if (entry.via.includes(enemy)) {
          fail(`CHAIN seed=${seed} the root appears in its own via chain`)
        }
      })

      // CERTAINTY. The sub-step each modelled unit is first named at is the
      // frontier: before it, this timeline is a statement about every world.
      const frontier = new Map<string, number>()
      partial.ledger.forEach((e) => {
        const known = frontier.get(e.unitId)
        if (known === undefined || e.subStep < known) frontier.set(e.unitId, e.subStep)
      })
      live.forEach((unit) => {
        const first = frontier.get(unit.id)
        if (first === undefined) return
        coverage.contingent++
        coverage.certainCells += Math.max(0, first)
      })

      all.forEach((assignment) => {
        const truth = concrete(input, assignment)
        const world = JSON.stringify(Array.from(assignment.entries()))

        live.forEach((unit) => {
          const first = frontier.get(unit.id) ?? Infinity
          const here = headsOf(partial, unit, subSteps)
          const there = headsOf(truth, unit, subSteps)
          for (let k = 0; k < Math.min(first, subSteps + 1); k++) {
            if (here[k] !== there[k]) {
              fail(
                `CERTAIN seed=${seed} unit=${unit.id}(${unit.type}) k=${k} ` +
                  `first=${first} ${here[k]} vs ${there[k]} world=${world}`,
              )
            }
          }

          // T1/T2/T3, restated on this shape.
          const at = divergedAtFor(partial, truth, unit, subSteps)
          if (at !== null && !named.has(unit.id)) {
            fail(`T1 seed=${seed} unit=${unit.id} diverges at ${at} unledgered, world=${world}`)
          }
          const fate = partial.fates[unit.id]
          if (fate === "dead" && truth.board[unit.id]) {
            fail(`T2 seed=${seed} unit=${unit.id} called dead but lives, world=${world}`)
          }
          if (fate === "alive" && !truth.board[unit.id]) {
            fail(`T2 seed=${seed} unit=${unit.id} called alive but dies, world=${world}`)
          }
        })
      })
    }

    expect(failures).toEqual([])
    process.stdout.write(
      `  chain: ${coverage.boards} boards, ${coverage.worlds} worlds, ` +
        `${coverage.skipped} skipped over budget, ${coverage.entries} ledger entries, ` +
        `${coverage.chained} boards whose ledger carries a via chain, ` +
        `${coverage.contingent} contingent units holding ` +
        `${coverage.certainCells} certain pre-divergence sub-steps\n`,
    )
    expect(coverage.boards).toBeGreaterThan(150)
    expect(coverage.worlds).toBeGreaterThan(2000)
    // The cascade must actually travel, or the attribution proves nothing.
    expect(coverage.chained).toBeGreaterThan(0)
    // And it must stop somewhere, or there is nothing certain left to keep.
    expect(coverage.certainCells).toBeGreaterThan(0)
  })
})

function range(from: number, to: number): number[] {
  const out: number[] = []
  for (let i = from; i <= to; i++) out.push(i)
  return out
}

// --------------------------------------------------------------- T4

describe("T4 — narrowing may only tighten", () => {
  it("a narrowed held set produces a subset of the ledger it had unnarrowed", () => {
    const key = (e: { cell: number; subStep: number; unitId: string; kind: string }): string =>
      `${e.subStep}|${e.cell}|${e.kind}|${e.unitId}`
    let compared = 0
    for (let seed = 501; seed <= 600; seed++) {
      const base = makeBoard(seed)
      const id = base.units[0].id
      const wide = held(base, [id])
      const options = legalTargets(base.units[0], shapeOf(base))
      if (options.length < 2) continue
      const narrow: PartialSettleInput = {
        ...base,
        held: [{ id, observedTurn: base.turn - 1, options: options.slice(0, 1) }],
      }
      const outer = new Set(settlePartial(wide, NO_SPAWN).ledger.map(key))
      settlePartial(narrow, NO_SPAWN).ledger.forEach((entry) => {
        expect({ seed, entry: key(entry), inside: outer.has(key(entry)) }).toEqual({
          seed,
          entry: key(entry),
          inside: true,
        })
      })
      compared++
    }
    expect(compared).toBeGreaterThan(50)
  })

  it("marks every entry a narrowing licensed", () => {
    const base = makeBoard(7)
    const options = legalTargets(base.units[0], shapeOf(base))
    const narrow: PartialSettleInput = {
      ...base,
      held: [{ id: base.units[0].id, observedTurn: base.turn - 1, options }],
    }
    settlePartial(narrow, NO_SPAWN).ledger.forEach((entry) => expect(entry.narrowed).toBe(true))
  })
})

// -------------------------------------------------------- claims alone

describe("computeClaims", () => {
  it("is a pure function of its input — two calls, the same answer", () => {
    const input = held(makeBoard(11), ["u0"])
    expect(JSON.stringify(computeClaims(input))).toEqual(JSON.stringify(computeClaims(input)))
  })

  it("is what settlePartial uses when it is handed one", () => {
    const input = held(makeBoard(13), ["u0", "u1"])
    const hoisted = computeClaims(input)
    expect(settlePartial(input, NO_SPAWN, hoisted).ledger).toEqual(
      settlePartial(input, NO_SPAWN).ledger,
    )
  })

  it("gives a held trail unit the neck it cannot vacate, and a piece none", () => {
    const base = makeBoard(3)
    const snake = base.units.find((u) => u.type === "snake" && u.occupancy.length > 1)
    if (snake) {
      const claim = computeClaims(held(base, [snake.id]))[0]
      expect(claim.certainIfAlive).toEqual(
        snake.occupancy.slice(0, snake.occupancy.length - 1).sort((a, b) => a - b),
      )
    }
    const piece = base.units.find((u) => u.type !== "snake")
    if (piece) {
      expect(computeClaims(held(base, [piece.id]))[0].certainIfAlive).toEqual([])
    }
  })

  it("prices a held unit's meal at `foodEnergy`, not at a full tank", () => {
    // The ceiling on what a held unit could be carrying is what it was seen
    // with plus every meal it could reach, clamped to its kind's max. Under a
    // lean food that is well short of the tank the old rule assumed.
    const snake: ResolveUnit = {
      id: "s",
      type: "snake",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [at(4, 4), at(3, 4), at(2, 4)],
      orientation: { dx: 1, dy: 0 },
    }
    const fed = bench([snake], {
      food: [at(5, 4)],
      held: [{ id: "s", observedTurn: 3 }],
    })
    expect(computeClaims(fed)[0].energyMax).toBe(100) // default food = a tank
    expect(computeClaims({ ...fed, foodEnergy: 5 })[0].energyMax).toBe(55)
    expect(computeClaims({ ...fed, foodEnergy: 5, food: [] })[0].energyMax).toBe(50)
  })

  it("forks a pawn's kinds at the promotion threshold and nowhere else", () => {
    const base = makeBoard(5)
    const light: PartialSettleInput = {
      ...base,
      pawnPromotionWeight: 99,
      units: base.units.map((u, i) => (i === 0 ? { ...u, type: "pawn" as UnitType } : u)),
      held: [{ id: base.units[0].id, observedTurn: base.turn - 1 }],
    }
    expect(computeClaims(light)[0].kinds).toEqual(["pawn"])
    expect(computeClaims({ ...light, pawnPromotionWeight: 1 })[0].kinds).toEqual(["pawn", "queen"])
  })
})


// ----------------------------------------------------- worked examples
//
// The sweeps above prove the properties; these three say what the ledger
// MEANS, on boards small enough to read.

const at = (x: number, y: number): number => y * W + x

const bench = (units: ResolveUnit[], overrides: Partial<PartialSettleInput> = {}) => {
  const teamOf: { [unitID: string]: string } = {}
  units.forEach((u) => {
    teamOf[u.id] = u.teamID
  })
  const input: PartialSettleInput = {
    units,
    boardWidth: W,
    boardHeight: W,
    walls: WALLS,
    hazards: [],
    hazardDamage: 5,
    food: [],
    defaultMaxEnergy: 100,
    turn: 4,
    teamOf,
    effects: [],
    potions: [],
    potionsEnabled: false,
    potionWindowTurns: 3,
    pawnPromotionWeight: 10,
    maxTurns: null,
    held: [],
    ...overrides,
  }
  return input
}

// ------------------------------------------------------- the cost of a node
//
// A caller sweeping candidates pays for one `settlePartial` per node, so the
// per-call allocation is a search parameter and not a detail. Printed rather
// than asserted: a number that fails the build on a shared runner is a number
// nobody can keep, and ts-jest's instrumentation inflates all three by about
// five times over the same code run plainly.
//
// The allocation pass that removed the per-sub-step ghost sets, the per-pair
// reach sets, the per-cell pawn-target rebuild and the coordinate objects in
// `planUnitAction` moved these, on this board and this machine:
//
//                        under ts-jest        plain node
//   settlePartial        3.10 -> 2.01 ms      —
//   ...claims hoisted    1.11 -> 0.48 ms      0.173 -> 0.110 ms
//   computeClaims        1.70 -> 1.39 ms      0.210 -> 0.100 ms
//
// The hoisted line is the one a search pays per node; the rest of that call
// is `settleTurn` itself, which was 0.098 ms of it before and is untouched.

describe("what a settlement costs", () => {
  it("prints the per-call time on a twelve-unit board", () => {
    const units: ResolveUnit[] = []
    const teamOf: { [unitID: string]: string } = {}
    const kinds: UnitType[] = ["queen", "rook", "bishop", "knight", "pawn", "snake"]
    for (let i = 0; i < 12; i++) {
      const type = kinds[i % kinds.length]
      const teamID = i % 2 === 0 ? "A" : "B"
      const x = 1 + (i % 7)
      const y = 1 + Math.floor(i / 7) * 2
      const occupancy = type === "snake" ? [at(x, y), at(x, y + 1)] : [at(x, y), at(x, y)]
      const id = `n${i}`
      teamOf[id] = teamID
      units.push({
        id,
        type,
        teamID,
        isKing: false,
        tier: (i % 3) - 1,
        energy: 40 + i,
        occupancy,
        orientation: i % 2 === 0 ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 },
        stagedMove: at(1 + ((i + 3) % 7), 5),
      })
    }
    const input: PartialSettleInput = {
      ...bench(units, {
        food: [at(3, 5), at(6, 3)],
        potions: [at(5, 6)],
        potionsEnabled: true,
        hazards: [at(2, 5)],
      }),
      teamOf,
      held: [
        { id: "n1", observedTurn: 3 },
        { id: "n3", observedTurn: 3 },
      ],
    }

    const time = (runs: number, run: () => void): number => {
      for (let i = 0; i < 20; i++) run() // warm
      const started = process.hrtime.bigint()
      for (let i = 0; i < runs; i++) run()
      return Number(process.hrtime.bigint() - started) / 1e6 / runs
    }

    const hoisted = computeClaims(input)
    const whole = time(400, () => settlePartial(input, NO_SPAWN))
    const reused = time(400, () => settlePartial(input, NO_SPAWN, hoisted))
    const claimsOnly = time(400, () => computeClaims(input))
    process.stdout.write(
      `  12 units, 2 held: settlePartial ${whole.toFixed(3)} ms/call, ` +
        `${reused.toFixed(3)} ms/call with claims hoisted, ` +
        `computeClaims ${claimsOnly.toFixed(3)} ms/call\n`,
    )
    expect(settlePartial(input, NO_SPAWN, hoisted).ledger).toEqual(
      settlePartial(input, NO_SPAWN).ledger,
    )
  })
})

describe("the regicide cascade is conditional on the king", () => {
  // A team that plays under regicide loses everything with its last king, so
  // every unit of it CAN be taken off the board by a king it never met. That
  // is a conditional, and pricing it as an unconditional is what made the
  // material fold blind: it says exactly the same thing about the plan that
  // takes a shot at the king and the plan that walks past it.
  //
  // The two halves of the conditional, on one board with the attacker moved.
  //
  //   bK  a held enemy KING, alone in the middle, nothing near it
  //   bT  its held team-mate, out of everybody's reach — its OWN peril is nil,
  //       so whatever `deathPossible` says about it is the cascade talking
  //   bM  a modelled team-mate, so there is somebody for the ledger to name
  //   ar  our rook, whose file either bears on the king or does not

  const board = (rookAt: number, rookTo: number): PartialSettleInput => {
    const king: ResolveUnit = {
      id: "bK",
      type: "king",
      teamID: "B",
      isKing: true,
      tier: 0,
      energy: 50,
      occupancy: [at(4, 4)],
      orientation: { dx: 1, dy: 0 },
    }
    const mate: ResolveUnit = {
      id: "bT",
      type: "pawn",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(2, 6)],
      orientation: { dx: 0, dy: 1 },
    }
    const modelled: ResolveUnit = {
      id: "bM",
      type: "pawn",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(7, 7)],
      orientation: { dx: 0, dy: -1 },
      stagedMove: at(7, 6),
    }
    const rook: ResolveUnit = {
      id: "ar",
      type: "rook",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [rookAt],
      orientation: { dx: 0, dy: 1 },
      stagedMove: rookTo,
    }
    return bench([king, mate, modelled, rook], {
      regicideTeamIDs: ["A", "B"],
      held: [
        { id: "bK", observedTurn: 3 },
        { id: "bT", observedTurn: 3 },
      ],
    })
  }

  const claimOf = (settled: { claims: ReadonlyArray<Claim> }, id: string): Claim =>
    settled.claims.find((c) => c.id === id) as Claim

  it("a king nothing can touch takes nobody with it", () => {
    // The rook sits on the first file: its cover never crosses the king.
    const input = board(at(1, 1), at(1, 2))
    const settled = settlePartial(input, NO_SPAWN)

    expect(claimOf(settled, "bK").deathPossible).toBe(false)
    expect(claimOf(settled, "bT")).toMatchObject({
      selfDeathPossible: false,
      deathPossible: false,
      regicideKingId: null,
    })
    expect(settled.fates.bT).toBe("alive")
    expect(settled.ledger.filter((e) => e.kind === "regicide")).toEqual([])

    // And "alive" is a proof: every world agrees, and it is the whole product
    // of both held units' options, not a sample of it.
    let worlds = 0
    optionsFor(input, "bK").forEach((kingMove) => {
      optionsFor(input, "bT").forEach((mateMove) => {
        worlds++
        const truth = concrete(
          input,
          new Map([
            ["bK", kingMove],
            ["bT", mateMove],
          ]),
        )
        expect({ world: `${kingMove}/${mateMove}`, alive: truth.board.bT !== undefined }).toEqual({
          world: `${kingMove}/${mateMove}`,
          alive: true,
        })
      })
    })
    expect(worlds).toBeGreaterThan(8)
  })

  it("a king our rook bears on puts its whole team in doubt, and names the shot", () => {
    // The same board with the rook on the king's file. Nothing else moved.
    const input = board(at(4, 1), at(4, 2))
    const settled = settlePartial(input, NO_SPAWN)

    expect(claimOf(settled, "bK").deathPossible).toBe(true)
    expect(claimOf(settled, "bT")).toMatchObject({
      // Its own peril is still nil — everything below is the cascade.
      selfDeathPossible: false,
      deathPossible: true,
      regicideKingId: "bK",
    })
    expect(settled.fates.bT).toBe("contingent")

    // The modelled team-mate is where the LEDGER can say it, and it says it
    // keyed to the king: the divergence is charged to the held unit at the
    // root, and `via` ends at the one unit whose fall carries the team.
    const regicide = settled.ledger.filter((e) => e.kind === "regicide")
    expect(regicide.length).toBeGreaterThan(0)
    regicide.forEach((entry) => {
      expect(entry.heldId).toBe("bK")
      expect(entry.via[entry.via.length - 1] ?? entry.heldId).toBe("bK")
    })
    expect(regicide.map((e) => e.unitId)).toContain("bM")
  })
})

describe("what an entry says", () => {
  it("marks a held trail unit's neck as present in every world it survives", () => {
    // A snake must step and its body follows, so the cells behind its head
    // are there whatever it chose: `assumedPresent` is true, and it is the
    // BEST case that rides on the entry rather than the worst.
    const snake: ResolveUnit = {
      id: "s",
      type: "snake",
      teamID: "A",
      tier: 1,
      energy: 50,
      occupancy: [at(4, 4), at(3, 4), at(2, 4)],
      orientation: { dx: 1, dy: 0 },
    }
    const rook: ResolveUnit = {
      id: "r",
      type: "rook",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(7, 4)],
      orientation: { dx: -1, dy: 0 },
      stagedMove: at(1, 4),
    }
    const input = bench([snake, rook], { held: [{ id: "s", observedTurn: 3 }] })
    const settled = settlePartial(input, NO_SPAWN)
    const neck = settled.ledger.filter((e) => e.cell === at(3, 4) && e.kind === "bodyBlock")
    expect(neck.length).toBe(1)
    expect(neck[0]).toMatchObject({ unitId: "r", heldId: "s", assumedPresent: true, couldBeat: true })
    expect(settled.fates.r).toBe("contingent")
  })

  it("says a contact is about timing, not survival, when the unit wins it everywhere", () => {
    // The queen outranks the claim at every strength its interval permits, so
    // the claim can change where the queen stops and never whether it lives.
    const snake: ResolveUnit = {
      id: "s",
      type: "snake",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [at(4, 4), at(4, 5)],
      orientation: { dx: 1, dy: 0 },
    }
    const queen: ResolveUnit = {
      id: "q",
      type: "queen",
      teamID: "B",
      tier: 2,
      energy: 50,
      occupancy: [at(7, 4), at(7, 4), at(7, 4)],
      orientation: { dx: -1, dy: 0 },
      stagedMove: at(1, 4),
    }
    const input = bench([snake, queen], { held: [{ id: "s", observedTurn: 3 }] })
    const settled = settlePartial(input, NO_SPAWN)
    expect(settled.ledger.length).toBeGreaterThan(0)
    settled.ledger.forEach((entry) => expect(entry.couldBeat).toBe(false))
  })

  it("proves the held set did not matter when the ledger comes back empty", () => {
    // The corollary, in one board: nothing the knight could have chosen
    // reaches the pawn, so the pawn's turn is settled, not guessed — and
    // every concrete world agrees, coordinate for coordinate.
    const knight: ResolveUnit = {
      id: "k",
      type: "knight",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [at(1, 1)],
      orientation: { dx: 1, dy: 0 },
    }
    const pawn: ResolveUnit = {
      id: "p",
      type: "pawn",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(7, 7)],
      orientation: { dx: -1, dy: 0 },
      stagedMove: at(6, 7),
    }
    const input = bench([knight, pawn], { held: [{ id: "k", observedTurn: 3 }] })
    const settled = settlePartial(input, NO_SPAWN)
    expect(settled.ledger).toEqual([])
    expect(settled.fates.p).toBe("alive")

    optionsFor(input, "k").forEach((option) => {
      const truth = concrete(input, new Map([["k", option]]))
      expect(truth.board.p).toEqual(settled.board.p)
      expect(truth.traversed.p).toEqual(settled.traversed.p)
      expect(truth.tiers.p).toEqual(settled.tiers.p)
    })
  })
})

// ------------------------------------------- the sever that is not survivable
//
// The composition the trail branch of `entangle` used to miss, on the
// smallest board that shows it. A cut is a weight loss and never a death, so
// a `sever` entry says `couldBeat: false` — and that is right for ONE
// arrival. It is not right for two, because the OTHER branch of the same
// tier interval is a death ON the segment, a death removes nothing from the
// board, and the batch that records it enters the segment's OWNER into the
// cell's durable pile. The next arrival there is contested against that whole
// pile, and everything in it that is not the unique strict maximum dies.
//
// Both halves are asserted: the board where the second arrival exists, where
// the ledger has to admit the mover can lose; and the same board with that
// arrival taken away, where the original reasoning is exactly right and a
// ledger that cried danger would be selling a caller a pile that cannot form.

const severPileBoard = (drop: string[] = []): PartialSettleInput => {
  const roster: ResolveUnit[] = [
    {
      id: "rs",
      type: "snake",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [at(3, 2), at(4, 2), at(5, 2)],
      orientation: { dx: -1, dy: 0 },
      stagedMove: at(2, 2),
    },
    {
      id: "rq",
      type: "queen",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [at(4, 3), at(4, 3), at(4, 3)],
      orientation: { dx: 0, dy: -1 },
    },
    {
      id: "bs",
      type: "snake",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(4, 6), at(5, 6), at(6, 6)],
      orientation: { dx: -1, dy: 0 },
    },
    {
      id: "br",
      type: "rook",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(3, 6), at(3, 6), at(3, 6)],
      orientation: { dx: 0, dy: -1 },
    },
  ]
  const units = roster.filter((u) => !drop.includes(u.id))
  return bench(units, {
    turn: 4,
    held: units.filter((u) => u.id !== "rs").map((u) => ({ id: u.id, observedTurn: 4 })),
  })
}

/** The trail cell the pile forms on: the mover's own neck, once it has gone west. */
const PILE = at(3, 2)

describe("a sever the resolver can make fatal", () => {
  it("admits the mover can lose the cell its own tail is on", () => {
    const input = severPileBoard()
    const settled = settlePartial(input, NO_SPAWN)

    // The optimistic timeline: the snake steps west, whole and alive, and its
    // tail still lies across the cell two held units can reach.
    expect(settled.board.rs).toMatchObject({ occupancy: [at(2, 2), PILE, at(4, 2)] })
    expect(settled.deaths.rs).toBeUndefined()

    // THE PROPERTY, FIRST: worlds in which the mover dies do exist, and every
    // one of them must be admitted by an entry that says it could lose, at or
    // before the sub-step it lost at. This is T1's survival half on the board
    // it was written for, and it is what a ledger of nothing but
    // `couldBeat: false` gets wrong.
    const all = worldsOf(input, 4000) as ReadonlyArray<Map<string, number | undefined>>
    expect(all).not.toBeNull()
    const beatable = settled.ledger.filter((e) => e.unitId === "rs" && e.couldBeat)
    const deadly: string[] = []
    all.forEach((assignment) => {
      const truth = concrete(input, assignment)
      if (truth.board.rs) return
      const death = truth.deaths.rs
      deadly.push(`${death.cause}@${death.cell}`)
      expect(beatable.length).toBeGreaterThan(0)
      expect(Math.min(...beatable.map((e) => e.subStep))).toBeLessThanOrEqual(death.subStep)
    })
    expect(deadly.length).toBeGreaterThan(0)
    expect([...new Set(deadly)]).toEqual([`contest@${PILE}`])

    // And the shape of the answer, so the entry a caller reads is the one the
    // property was proved against. The cut itself is still a weight loss: no
    // `sever` entry claims a death.
    const severs = settled.ledger.filter((e) => e.unitId === "rs" && e.kind === "sever")
    expect(severs.length).toBeGreaterThan(0)
    expect(severs.some((e) => e.couldBeat)).toBe(false)

    // The pile is a SECOND entry at the same cell and sub-step, and it names
    // both held units that can be there — the one that dies on the segment
    // and the one that arrives onto what its death left behind.
    const pile = settled.ledger.filter(
      (e) => e.unitId === "rs" && e.cell === PILE && e.kind === "contest",
    )
    expect(pile.length).toBeGreaterThan(0)
    pile.forEach((e) => expect(e.couldBeat).toBe(true))
    expect([...new Set(pile.map((e) => e.heldId))].sort()).toEqual(["br", "rq"])
    pile.forEach((e) => {
      expect(severs.some((s) => s.cell === e.cell && s.subStep === e.subStep)).toBe(true)
    })
  })

  it("and admits it again when the pile is already there, at any claim tier", () => {
    // The same composition reached the other way round, and the reason the
    // tier interval is only half the condition. Here a MODELLED unit dies on
    // the tail in the optimistic timeline itself, so the cell is durable and
    // holds the owner before any claim moves. The held rook outranks the
    // snake outright — it severs the tail rather than dying on it — and it
    // is still fatal, because the arrival tier runs before the body tier: it
    // contests the standing pile the moment it lands, and the owner is in it.
    const snake: ResolveUnit = {
      id: "rs",
      type: "snake",
      teamID: "A",
      tier: 0,
      energy: 50,
      occupancy: [at(3, 2), at(4, 2), at(5, 2)],
      orientation: { dx: -1, dy: 0 },
      stagedMove: at(2, 2),
    }
    const knight: ResolveUnit = {
      id: "bn",
      type: "knight",
      teamID: "B",
      tier: 0,
      energy: 50,
      occupancy: [at(4, 4)],
      orientation: { dx: 0, dy: -1 },
      stagedMove: PILE,
    }
    const rook: ResolveUnit = {
      id: "br",
      type: "rook",
      teamID: "B",
      tier: 1,
      energy: 50,
      occupancy: [at(3, 6), at(3, 6), at(3, 6)],
      orientation: { dx: 0, dy: -1 },
    }
    const input = bench([snake, knight, rook], {
      turn: 4,
      held: [{ id: "br", observedTurn: 4 }],
    })
    const settled = settlePartial(input, NO_SPAWN)

    // The premise: the knight died on the tail, and that is what made the
    // cell durable with the snake in it.
    expect(settled.deaths.bn).toMatchObject({ cell: PILE, cause: "bodyBlock" })
    expect(settled.board.rs).toBeDefined()

    const all = worldsOf(input, 4000) as ReadonlyArray<Map<string, number | undefined>>
    const beatable = settled.ledger.filter((e) => e.unitId === "rs" && e.couldBeat)
    let deadly = 0
    all.forEach((assignment) => {
      const truth = concrete(input, assignment)
      if (truth.board.rs) return
      deadly++
      expect(beatable.length).toBeGreaterThan(0)
      expect(Math.min(...beatable.map((e) => e.subStep))).toBeLessThanOrEqual(
        truth.deaths.rs.subStep,
      )
    })
    expect(deadly).toBeGreaterThan(0)
    expect(beatable.every((e) => e.cell === PILE && e.kind === "contest")).toBe(true)
  })

  it("and still proves survival when only one claim can reach the segment", () => {
    // Take the rook away and no second arrival is possible at that cell. The
    // queen either dies on the tail or cuts it, the owner lives either way,
    // and the ledger goes back to saying so — anti-vacuity for the entry
    // above, and the reason the fix is a condition rather than a constant.
    const input = severPileBoard(["br"])
    const settled = settlePartial(input, NO_SPAWN)

    const mine = settled.ledger.filter((e) => e.unitId === "rs")
    expect(mine.filter((e) => e.cell === PILE && e.kind === "sever").length).toBeGreaterThan(0)
    expect(mine.some((e) => e.couldBeat)).toBe(false)

    const all = worldsOf(input, 4000) as ReadonlyArray<Map<string, number | undefined>>
    expect(all).not.toBeNull()
    all.forEach((assignment) => expect(concrete(input, assignment).board.rs).toBeDefined())
  })
})

// ------------------------------- a staged action whose legality reads the board
//
// EVERY OTHER RULE IN THE GRAMMAR IS GEOMETRY. A pawn's diagonal step is the
// one that is not: `planUnitAction` admits it only onto a cell in
// `pawnTargetsOf` — the food, plus every body standing on the board as the
// turn OPENS. So another unit's own square is what makes the capture a legal
// move at all.
//
// `settlePartial` settles its optimistic timeline over the units whose moves
// are known, and `resolveTurn` re-reads every staged cell through the grammar
// against THAT roster. Take the held rook off it and the capture stops being
// a legal action: `stagedAction` substitutes the kind's default, a piece
// holds, and the timeline settles a pawn standing still with an empty ledger
// — a proof that the turn is world-invariant, published for a turn whose
// outcome is decided by the very unit that was removed to reach it.
//
// The board is the smallest one that shows it. Neither unit is decoration:
// drop the rook and the diagonal is not a legal target for the pawn to stage
// at all, and give the rook one square instead of two and the contest is a
// tie that kills them both rather than one the pawn loses.

const P = 5
const pat = (x: number, y: number): number => y * P + x
const P_WALLS = ((): number[] => {
  const walls: number[] = []
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      if (x === 0 || y === 0 || x === P - 1 || y === P - 1) walls.push(pat(x, y))
    }
  }
  return walls
})()

/** Our pawn facing -y, and one square diagonally forward a held enemy rook. */
const pawnCaptureBoard = (): PartialSettleInput => {
  const turn = 4
  return {
    units: [
      {
        id: "p",
        type: "pawn",
        teamID: "A",
        tier: 0,
        energy: 50,
        occupancy: [pat(2, 3)],
        orientation: { dx: 0, dy: -1 },
        stagedMove: pat(3, 2),
      },
      {
        id: "r",
        type: "rook",
        teamID: "B",
        tier: 0,
        energy: 50,
        occupancy: [pat(3, 2), pat(3, 2)],
        orientation: { dx: 0, dy: -1 },
      },
    ],
    boardWidth: P,
    boardHeight: P,
    walls: P_WALLS,
    hazards: [],
    hazardDamage: 5,
    food: [],
    defaultMaxEnergy: 100,
    turn,
    teamOf: { p: "A", r: "B" },
    effects: [],
    potions: [],
    potionsEnabled: false,
    potionWindowTurns: 3,
    pawnPromotionWeight: 10,
    maxTurns: null,
    held: [{ id: "r", observedTurn: turn - 1 }],
  }
}

describe("a staged action a HOLD would make illegal is still the staged action", () => {
  it("walks the capture the staged cell names, on the board the turn opens on", () => {
    const input = pawnCaptureBoard()
    // Anti-vacuity: the capture has to be a legal staged action on the
    // OBSERVED board, or this board is not the fixture it claims to be.
    expect(legalTargets(input.units[0], shapeOf(input))).toContain(pat(3, 2))

    const settled = settlePartial(input, NO_SPAWN)
    expect(settled.traversed.p).toEqual([pat(3, 2)])
  })

  it("holds T1 and T2 over every one of the rook's replies", () => {
    const input = pawnCaptureBoard()
    const settled = settlePartial(input, NO_SPAWN)
    const all = worldsOf(input, 4000) as ReadonlyArray<Map<string, number | undefined>>
    expect(all).not.toBeNull()
    expect(all.length).toBeGreaterThan(4)

    const pawn = input.units[0]
    const subSteps = Math.max(
      settled.subStepCount,
      ...settled.claims.map((c) => c.headPossible.length - 1),
    )
    const named = settled.ledger.filter((e) => e.unitId === "p")
    const beatable = named.filter((e) => e.couldBeat)

    const failures: string[] = []
    let deadly = 0
    all.forEach((assignment) => {
      const truth = concrete(input, assignment)
      const world = JSON.stringify(Array.from(assignment.entries()))

      // T1 — a world that differs from the timeline differs where the ledger
      // said it could, and no earlier.
      const at = divergedAtFor(settled, truth, pawn, subSteps)
      if (at !== null) {
        if (named.length === 0) failures.push(`T1 pawn diverges at ${at} unledgered, ${world}`)
        else if (Math.min(...named.map((e) => e.subStep)) > at) {
          failures.push(`T1 pawn diverges at ${at}, earliest entry later, ${world}`)
        }
      }

      // T1b — a world that kills the pawn is admitted by an entry that says
      // it could lose, at or before the sub-step it lost at.
      if (settled.board.p && !truth.board.p) {
        deadly++
        const death = truth.deaths.p
        if (beatable.length === 0) {
          failures.push(`T1b pawn dies ${death.cause}@${death.cell} ${world}, every entry wins`)
        } else if (Math.min(...beatable.map((e) => e.subStep)) > death.subStep) {
          failures.push(`T1b pawn dies at ${death.subStep}, earliest couldBeat later, ${world}`)
        }
      }

      // T2 — the fates are proofs in both directions.
      if (settled.fates.p === "dead" && truth.board.p) failures.push(`T2 pawn lives, ${world}`)
      if (settled.fates.p === "alive" && !truth.board.p) failures.push(`T2 pawn dies, ${world}`)
      if (settled.fates.p === "contingent" && named.length === 0) {
        failures.push("T2 pawn contingent with no entry")
      }
      settled.claims.forEach((claim) => {
        if (claim.certainlyGone && truth.board[claim.id]) {
          failures.push(`T2 claim ${claim.id} certainlyGone but lives, ${world}`)
        }
        if (!claim.deathPossible && !truth.board[claim.id]) {
          failures.push(`T2 claim ${claim.id} deathPossible=false but dies, ${world}`)
        }
      })
    })

    expect(failures).toEqual([])
    // Anti-vacuity: the worlds that kill the pawn exist, so T1b was asked.
    expect(deadly).toBeGreaterThan(0)
  })
})

// A unit observed on THIS board is standing where the record says when the
// turn opens — staging happens before anything moves — so reading the staged
// cells against it is a fact and not a guess. A unit observed a turn EARLIER
// is the other case: it has had a move since, its record cell may be empty by
// now, and whether our pawn's capture is a legal action at all is then a
// question the worlds answer differently. That is a divergence like any
// other, and it is written down rather than settled by picking a world.

describe("a claim that may have left the square the staged action reads", () => {
  // The rook is observed a COLUMN AWAY, so its own square is nowhere near the
  // pawn and the cell the pawn stages is empty ground on the observed board:
  // the capture is not a legal action there, and the optimistic timeline
  // holds the pawn. It is the rook's UNKNOWN TURN that can put a body on that
  // square, and the narrowing says it does exactly that. Nothing else in the
  // ledger can cover this: the rook is a piece, so it drags no trail, and
  // from the square it lands on it can never reach the pawn's own cell —
  // `entangle` compares a claim against the cells a unit WALKED, and this
  // pawn walks nowhere. Take the grammar entry away and the pawn's whole
  // turn, its death included, is unledgered.
  const CAPTURE = at(3, 2)
  const spanTwoBoard = (observedTurn: number): PartialSettleInput =>
    bench(
      [
        {
          id: "p",
          type: "pawn",
          teamID: "A",
          tier: 0,
          energy: 50,
          occupancy: [at(2, 3)],
          orientation: { dx: 0, dy: -1 },
          stagedMove: CAPTURE,
        },
        {
          id: "r",
          type: "rook",
          teamID: "B",
          tier: 0,
          energy: 50,
          occupancy: [at(3, 5), at(3, 5)],
          orientation: { dx: 0, dy: -1 },
        },
      ],
      { turn: 4, held: [{ id: "r", observedTurn, options: [CAPTURE] }] },
    )

  it("ledgers the legality itself, and holds over every two-move history", () => {
    const input = spanTwoBoard(2)
    const settled = settlePartial(input, NO_SPAWN)

    // The timeline reads the staged cell against the board the turn opens on,
    // where it is empty, so the pawn holds — and the ledger says which held
    // unit that reading rides on, and that the pawn could lose on it.
    expect(settled.traversed.p ?? []).toEqual([])
    expect(settled.ledger.filter((e) => e.kind === "grammar")).toEqual([
      {
        cell: CAPTURE,
        subStep: 1,
        unitId: "p",
        heldId: "r",
        via: [],
        kind: "grammar",
        assumedPresent: true,
        couldBeat: true,
        narrowed: true,
      },
    ])
    expect(settled.fates.p).toBe("contingent")
    // Anti-vacuity for the paragraph above: no contact entry names the pawn,
    // because nothing the rook could do ever touches the square it stands on.
    expect(settled.ledger.filter((e) => e.unitId === "p" && e.kind !== "grammar")).toEqual([])

    // The enumeration the entry is there for: the rook takes its one narrowed
    // move alone, the turn under test opens on what that left behind, and the
    // staged capture is a legal action after all.
    const pawn = input.units[0]
    const subSteps = Math.max(
      settled.subStepCount,
      ...settled.claims.map((c) => c.headPossible.length - 1),
    )
    const named = settled.ledger.filter((e) => e.unitId === "p")
    const beatable = named.filter((e) => e.couldBeat)
    const failures: string[] = []
    let captured = 0
    let deadly = 0
    ;(input.held[0].options as ReadonlyArray<number>).forEach((a1) => {
      const mid = advanceAlone(input, "r", a1) as PartialSettleInput
      expect(mid).not.toBeNull()
      optionsFor(mid, "r").forEach((a2) => {
        const truth = settleTurn(
          {
            ...mid,
            units: mid.units.map((u) => (u.id === "r" ? { ...u, stagedMove: a2 } : u)),
          },
          NO_SPAWN,
        )
        const world = `${a1}/${a2}`
        if ((truth.traversed.p ?? []).length > 0) captured++
        const when = divergedAtFor(settled, truth, pawn, subSteps)
        if (when !== null) {
          if (named.length === 0) failures.push(`SPAN2 pawn diverges at ${when} unledgered, ${world}`)
          else if (Math.min(...named.map((e) => e.subStep)) > when) {
            failures.push(`SPAN2 pawn diverges at ${when}, earliest entry later, ${world}`)
          }
        }
        if (!truth.board.p) {
          deadly++
          if (settled.fates.p === "alive") failures.push(`SPAN2 pawn called alive, ${world}`)
          if (beatable.length === 0) failures.push(`SPAN2 pawn dies ${world}, every entry wins`)
          else if (Math.min(...beatable.map((e) => e.subStep)) > truth.deaths.p.subStep) {
            failures.push(`SPAN2 pawn dies at ${truth.deaths.p.subStep}, entry later, ${world}`)
          }
        }
      })
    })
    expect(failures).toEqual([])
    // Both halves happened: worlds where the capture is legal after all, and
    // worlds where taking it kills the pawn.
    expect(captured).toBeGreaterThan(0)
    expect(deadly).toBeGreaterThan(0)
  })

  it("says nothing at all when the claim was observed on this very board", () => {
    // The other half, and the reason the entry is a condition rather than a
    // constant: a unit whose record is this turn's IS on its square when the
    // staged cells are read, so the reading is world-invariant and a ledger
    // that cried doubt would be selling a caller a world that cannot exist.
    const settled = settlePartial(spanTwoBoard(3), NO_SPAWN)
    expect(settled.ledger.filter((e) => e.kind === "grammar")).toEqual([])
    expect(settled.traversed.p ?? []).toEqual([])
  })
})
