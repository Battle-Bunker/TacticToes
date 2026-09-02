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
//   T3  every coordinate a rule reads — survival, weight, health, tier — is
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

const perimeter = (): number[] => {
  const walls: number[] = []
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      if (x === 0 || y === 0 || x === W - 1 || y === W - 1) walls.push(y * W + x)
    }
  }
  return walls
}
const WALLS = perimeter()
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
      health: rnd() < 0.35 ? 1 + Math.floor(rnd() * 4) : 20 + Math.floor(rnd() * 80),
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
    defaultMaxHealth: 100,
    maxHealth: { queen: 80 },
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
const worlds = (
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
const divergedAt = (
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
    if (ua.health !== ub.health) return subSteps
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
    const all = worlds(input, budget)
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
        const at = divergedAt(partial, truth, unit, subSteps)
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
        const at = divergedAt(partial, truth, unit, subSteps)
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
 * under test opens on what that left behind, food eaten and health spent
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
            health: settled.health,
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
            const at = divergedAt(partial, truth, unit, subSteps)
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
    defaultMaxHealth: 100,
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
      health: 50,
      occupancy: [at(4, 4), at(3, 4), at(2, 4)],
      orientation: { dx: 1, dy: 0 },
    }
    const rook: ResolveUnit = {
      id: "r",
      type: "rook",
      teamID: "B",
      tier: 0,
      health: 50,
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
      health: 50,
      occupancy: [at(4, 4), at(4, 5)],
      orientation: { dx: 1, dy: 0 },
    }
    const queen: ResolveUnit = {
      id: "q",
      type: "queen",
      teamID: "B",
      tier: 2,
      health: 50,
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
      health: 50,
      occupancy: [at(1, 1)],
      orientation: { dx: 1, dy: 0 },
    }
    const pawn: ResolveUnit = {
      id: "p",
      type: "pawn",
      teamID: "B",
      tier: 0,
      health: 50,
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
