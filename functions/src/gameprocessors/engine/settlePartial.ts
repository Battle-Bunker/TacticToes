import { Clash, ClashKind } from "@shared/types/Game"
import { BoardView, adjudicate } from "./adjudicate"
import { Claim, PartialSettleInput, computeClaims } from "./claims"
import { UnitAction, leavesTrail, traversesEdges } from "./moveGrammar"
import { BoardShape, stagedAction } from "./queries"
import { ResolveUnit } from "./resolveTurn"
import { Settlement, settleTurn } from "./settleTurn"
import { SpawnState, Spawner } from "./spawn"
import { outranks } from "./turnEngine"

/**
 * The whole turn, with some movers unknown — `settleTurn`'s exact phases over
 * a board where some units are held.
 *
 * This is a MODE of the one engine, not a second engine. It writes no
 * resolver, no grammar and no contest rule of its own: it calls `settleTurn`,
 * and it asks `claims.ts` — which asks `queries.ts`, which asks the grammar —
 * where the units nobody modelled could be. The alternative, an uncertainty
 * engine that re-encodes the rules so it can run them over a set of boards,
 * is a rules mirror, and a mirror desynchronises. There is one encoding.
 *
 * ## The optimistic timeline, and what "optimistic" costs
 *
 * `settlePartial` settles the turn with the held units ABSENT from the board:
 * a merely-possible occupant is read as empty ground. That is the optimistic
 * reading for everybody who IS modelled, and it is a reading and not an
 * assumption, because every cell at which it could be wrong is written down.
 * The held units are not modelled inside the collision engine at all, and
 * deliberately so: a claim has a tier INTERVAL and a weight interval, and
 * standing one on the board would mean choosing a scalar for each — an
 * assumption a caller could mistake for a proof, which is the failure mode
 * this whole design is built against.
 *
 * ## The ledger
 *
 * `ledger` is every (cell, sub-step, unit, kind) at which a concrete world
 * could disagree with this timeline: a contest, an edge exchange, a body
 * block, a sever, a corpse pile, a meal taken first, a potion taken first, and
 * the two verdicts those change downstream — an exhaustion and a promotion.
 * Deduplicated, and ordered by (subStep, cell, kind, heldId, unitId), because
 * a ledger that is part of a bound's identity may not depend on iteration
 * order.
 *
 * **An empty ledger is a PROOF; a non-empty one is a work list.** With no
 * entries, every modelled unit's disposition — where it went, whether it
 * lived, its energy, its weight, what it ate — is what it is in every world
 * the held units could have chosen, and so is the game's `outcome`. With
 * entries, the entries name every place a world could differ and nothing
 * else does.
 *
 * The held units' OWN positions are not in the ledger. They are inherently
 * unknown, and what is known about them is the `Claim`: its intervals bracket
 * every coordinate a rule reads, and `certainlyGone`/`deathPossible` bracket
 * its survival. A caller reading the ledger for a held unit's whereabouts has
 * the wrong object in hand.
 *
 * ## Contingency propagates, and it propagates ALONG A PATH
 *
 * A unit a claim could have halted did not go on to kill what it killed here,
 * and a unit a claim could have killed was not standing where this timeline
 * has it standing. So contingency spreads: a modelled unit whose own outcome
 * is contingent becomes, for the rest of the turn, a second source of
 * unknown presence — and a second source of unknown absence, at every clash it
 * took part in afterwards. The ledger is closed under that spread before it is
 * returned.
 *
 * Two things bound the spread, and both matter to a caller that has to
 * discriminate between plans rather than merely stay sound.
 *
 *   · IN SPACE AND TIME. A modelled unit that becomes contingent at sub-step
 *     `s` is contingent THERE and from `s` on, along ITS OWN traversal: the
 *     cells it walked, not the board. Everything it did strictly before `s` is
 *     what it is in every world, which is what lets a caller keep a unit's
 *     pre-divergence cells as certain instead of writing the unit off.
 *
 *   · IN ATTRIBUTION. `heldId` is always the HELD unit at the root of the
 *     chain — never a modelled one. When the uncertainty travelled through
 *     modelled units to get here, `via` lists them in order, so a caller can
 *     still partition the worlds by the held unit's OPTIONS. A ledger that
 *     named our own roster as the cause would ask a searcher to enumerate the
 *     moves it already knows, and every candidate would carry the same answer.
 *
 * ## Purity
 *
 * No clock, no RNG, no allocation that outlives the call. Items come from the
 * injected `Spawner`, and the normal choice in partial mode is `NO_SPAWN`:
 * a caller that would rather under-model the item supply than invent cells.
 * A spawner that does place items is handed a board on which every cell a
 * claim could be standing on is already taken, so nothing is dropped under a
 * unit that this timeline merely failed to draw.
 */

export type { Claim, HeldUnit, PartialSettleInput } from "./claims"

/** Why a concrete world could disagree with the optimistic timeline here. */
export type DivergenceKind =
  | "contest" // a cell this unit holds could be contested against a claim
  | "edge" // a claim could cross the same edge the other way
  | "bodyBlock" // a claim's trail could hold this cell
  | "sever" // a claim could sever this unit, or be severed by it
  | "durable" // a claim could have DIED here, leaving a pile
  | "food" // a claim could have eaten the food this unit ate
  | "potion" // a claim could have taken the potion this unit took
  | "exhaustion" // energy spent here depends on whether a claim halted it
  | "promotion" // the weight the threshold is read against could differ
  | "regicide" // a king that could fall takes this team-mate off the board
  | "grammar" // whether this unit's staged action is legal at all reads a claim

export interface Divergence {
  readonly cell: number
  readonly subStep: number
  /**
   * The unit whose outcome could differ from this timeline. A MODELLED unit
   * for every entry: what is known about a held unit is its `Claim`.
   */
  readonly unitId: string
  /**
   * The HELD unit whose unknown move is the root cause. Always one of
   * `input.held`, so a caller can partition the worlds by its options.
   */
  readonly heldId: string
  /**
   * The modelled units the uncertainty travelled through to reach `unitId`,
   * in order — empty when `heldId` acts on `unitId` directly. Each is a unit
   * whose own outcome is contingent, and each is contingent only from its own
   * first divergence on, along its own traversal.
   *
   * For a `regicide` entry the last link is the KING whose fall carries the
   * team, so `via[via.length - 1] ?? heldId` names it and a caller can price
   * the shot at that one unit.
   */
  readonly via: ReadonlyArray<string>
  readonly kind: DivergenceKind
  /**
   * WHICH ENDPOINT RIDES ON IT.
   * `false` — the timeline read the cell EMPTY and the claim has only to have
   *   moved there for this to bite; it is `worst` that is exposed.
   * `true`  — the claim holds this cell in EVERY world in which it is alive
   *   and unsevered (the neck argument), so the contact happens in all but
   *   those worlds; it is `best` that is exposed.
   * Getting the two backwards is invisible in every aggregate and wrong
   * exactly where a human reads the ledger.
   */
  readonly assumedPresent: boolean
  /**
   * Whether `unitId` could FAIL to survive this contact — at any strength the
   * claim's interval permits, including the tie that kills everyone in it.
   * False means the contact is real but this unit wins it in every world: a
   * divergence in timing and energy, not in survival.
   *
   * It is a property of the CONTACT, not of the cell, and one cell at one
   * sub-step can carry two: a claim landing on a trail cell either cuts it,
   * which is a weight loss (`sever`, false), or dies on it and leaves a pile
   * the owner is in, which is not (`contest`, true). A caller asking "can
   * this unit lose anything here" must read every entry at the cell, not the
   * first.
   */
  readonly couldBeat: boolean
  /** True when this entry exists only because a caller's narrowing admitted
   *  the world. The basis, carried on the entry. */
  readonly narrowed: boolean
}

/** `dead` and `alive` are proofs; `contingent` is a work list. */
export type Fate = "alive" | "dead" | "contingent"

export interface PartialSettlement extends Settlement {
  /** Every point at which a concrete world could differ from this timeline. */
  readonly ledger: ReadonlyArray<Divergence>
  /** Per unit, held ones included. The ledger names why anything is contingent. */
  readonly fates: Readonly<Record<string, Fate>>
  /** The claims this settlement adjudicated against, so a caller need not
   *  recompute what it is about to price. */
  readonly claims: ReadonlyArray<Claim>
}

/**
 * Anything whose presence at a cell is unknown: a claim, or a contingent unit.
 *
 * The three occupancy questions are PREDICATES rather than sets, and that is a
 * cost decision rather than a taste one. `entangle` asks each of them once per
 * modelled unit per sub-step, and a ghost that answered with a set rebuilt the
 * same set for every unit on the board — which was the single largest line in
 * this mode's profile. Both ghosts can answer the predicate off an index they
 * build once: a claim's head set is cumulative, so `Claim.earliestSubStep`
 * already IS the answer and no set is built at all.
 */
interface Ghost {
  readonly id: string
  /** The held unit at the root of this ghost's uncertainty. */
  readonly origin: string
  /** The modelled units between `origin` and this ghost, in order. */
  readonly via: ReadonlyArray<string>
  readonly narrowed: boolean
  readonly leavesTrail: boolean
  readonly traversesEdges: boolean
  readonly tierMin: number
  readonly tierMax: number
  readonly weightMax: number
  readonly deathPossible: boolean
  /** Sub-step from which this ghost's disposition is unknown. */
  readonly from: number
  /** Does it hold this cell in every world where it is alive and unsevered? */
  certain(cell: number): boolean
  /** Could its head be here after `subStep` sub-steps? */
  head(cell: number, subStep: number): boolean
  /** Could its trail hold this cell after `subStep` sub-steps? */
  body(cell: number, subStep: number): boolean
  /** Could any part of it have held this cell at a STRICTLY earlier sub-step? */
  before(cell: number, subStep: number): boolean
}

/** One modelled unit, as the optimistic timeline left it. */
interface Track {
  readonly id: string
  readonly tier: number
  readonly weight: number
  readonly leavesTrail: boolean
  readonly traversesEdges: boolean
  /** Head cell at each sub-step; index 0 is the board as the turn opened. */
  readonly head: number[]
  /** Trail cells, head excluded, at each sub-step. Empty for a stack. */
  readonly body: Set<number>[]
  /** Whether it entered `head[k]` on sub-step k, rather than standing there. */
  readonly moved: boolean[]
  /**
   * Cells this unit is already in the DURABLE PILE of without standing on
   * them, and the sub-step it joined each from. Only `bodyBlock` puts a
   * survivor in a pile it is not standing on: the arrival dies on the
   * segment and the batch enters the segment's owners with it. A `contest`
   * or `edge` survivor capture-stops, so its head IS the cell and the
   * contest branch below already watches it.
   */
  readonly piled: ReadonlyMap<number, number>
  readonly lastSubStep: number
  readonly alive: boolean
}

const setOf = (cells: Iterable<number>): Set<number> => new Set(cells)
const NO_VIA: ReadonlyArray<string> = []

/**
 * One modelled unit's contingency, as one held unit caused it. Keyed by the
 * PAIR, because a unit two held units could each have changed must be
 * partitionable by either of them, and a single slot would keep only one.
 */
interface Contingency {
  readonly unitId: string
  /** The held unit at the root. */
  readonly origin: string
  /** Sub-step from which this unit's disposition is unknown, for that root. */
  readonly subStep: number
  readonly narrowed: boolean
  /** The modelled units between `origin` and `unitId`, in order. */
  readonly via: ReadonlyArray<string>
}

/** The chain, extended by one link — and never through the same unit twice. */
const through = (via: ReadonlyArray<string>, id: string): ReadonlyArray<string> =>
  via.includes(id) ? via : [...via, id]

/**
 * Settle a turn some of whose movers are unknown.
 *
 * `claims` is the hoist: it is a pure function of the held records and the
 * board, so a caller sweeping many plans over one held set computes it once
 * and hands it back here rather than paying for it per plan.
 */
export const settlePartial = (
  input: PartialSettleInput,
  spawn: Spawner,
  claims?: ReadonlyArray<Claim>,
): PartialSettlement => {
  const claimList = claims ?? computeClaims(input)
  const held = new Set(input.held.map((h) => h.id))
  const byId = new Map(input.units.map((u) => [u.id, u]))
  const live = input.units.filter((u) => !held.has(u.id))

  // The optimistic timeline: the same settlement, over the units whose moves
  // are known. Nothing below re-runs a phase of it.
  //
  // One team-level correction goes in rather than out: regicide takes a whole
  // team off the board the moment its last king falls, and a king nobody
  // modelled has not fallen — it is merely absent from this timeline. So a
  // team whose king is held is not played under regicide here, and the whole
  // of it is ledgered as contingent below instead.
  const heldKings = new Set(
    input.units.filter((u) => u.isKing && held.has(u.id)).map((u) => u.teamID),
  )
  const regicideTeamIDs = (input.regicideTeamIDs ?? []).filter((team) => !heldKings.has(team))
  const hidden = new Set<number>()
  claimList.forEach((claim) => claim.everPossible.forEach((cell) => hidden.add(cell)))

  // THE BOARD THE STAGED CELLS ARE READ AGAINST is the board the turn OPENS
  // on, held units included. `resolveTurn` re-reads every staged cell through
  // the grammar, and one rule in the grammar reads the board rather than the
  // mover: a pawn's diagonal step is legal only onto food or a body standing
  // there as the turn opens. Read against a roster the held units have been
  // taken out of, a capture staged onto one of their squares is not a legal
  // action at all — the kind's default is substituted, a piece HOLDS, and the
  // optimistic timeline settles a different move from the one it was handed,
  // with nothing in the ledger, because a unit that never left its square ran
  // into nothing to name. `presence` is the repair: the held bodies are on the
  // board for LEGALITY and absent from the collision phase, which is exactly
  // the split this mode is built on — a claim is not a unit, but it is a body
  // the staging rule already saw when the turn opened.
  const presence: number[] = [...(input.presence ?? [])]
  input.held.forEach((h) => {
    const record = byId.get(h.id)
    if (record) record.occupancy.forEach((cell) => presence.push(cell))
  })
  const settlement = settleTurn(
    { ...input, units: live, regicideTeamIDs, presence },
    shield(spawn, Array.from(hidden)),
  )

  const subSteps = Math.max(
    settlement.subStepCount,
    ...claimList.map((claim) => claim.headPossible.length - 1),
  )
  const tracks = live.map((unit) => trackOf(unit, settlement, subSteps))
  const trackById = new Map(tracks.map((t) => [t.id, t]))

  const entries = new Map<string, Divergence>()
  // The same entries in insertion order, so the closure below can resume where
  // it left off instead of re-reading the whole ledger on every pass.
  const order: Divergence[] = []
  const add = (entry: Divergence): void => {
    const key = `${entry.subStep}|${entry.cell}|${entry.kind}|${entry.heldId}|${entry.unitId}`
    if (entries.has(key)) return
    entries.set(key, entry)
    order.push(entry)
  }

  // Who could still be ENTERING a cell, and when. `entangle` is asked about
  // one unknown presence at a time, and the pile composition below takes two:
  // the claim that dies on a trail cell, and whatever arrives there after it.
  const arrivals = arrivalsOf(claimList, tracks, subSteps)

  claimList.forEach((claim) => entangle(ghostOfClaim(claim), tracks, subSteps, arrivals, add))
  itemDivergences(input, settlement, claimList, tracks, add)
  grammarDivergences(input, live, claimList, add)

  // Contingency closure. A unit whose own outcome is unknown is, from that
  // sub-step on, exactly the same kind of unknown presence a claim is — and
  // exactly the same kind of unknown ABSENCE at every clash it took part in
  // afterwards. Both directions, to a fixpoint.
  //
  // The state is keyed by (unit, HELD ROOT) rather than by unit: the whole
  // point of the closure is to hand a caller a work list of held units, and a
  // unit that two held units could each have changed is two pieces of work,
  // not one. The chain that got here rides along so every entry the expansion
  // adds can name the root and the route.
  const contingent = new Map<string, Contingency>()
  // A state's sub-step only ever falls, and an entry already read was compared
  // against a state no LATER than the current one — so it can never open
  // anything a second time. The watermark is that argument, spent.
  let read = 0
  const seed = (): boolean => {
    let grew = false
    for (; read < order.length; read++) {
      const entry = order[read]
      if (!trackById.has(entry.unitId)) continue
      const key = `${entry.unitId}|${entry.heldId}`
      const known = contingent.get(key)
      if (known && known.subStep <= entry.subStep) continue
      contingent.set(key, {
        unitId: entry.unitId,
        origin: entry.heldId,
        subStep: entry.subStep,
        narrowed: entry.narrowed,
        via: entry.via,
      })
      grew = true
    }
    return grew
  }

  const expanded = new Set<string>()
  for (let pass = 0; pass < tracks.length + 1; pass++) {
    if (!seed()) break
    let opened = false
    contingent.forEach((state, key) => {
      const stamp = `${key}@${state.subStep}`
      if (expanded.has(stamp)) return
      expanded.add(stamp)
      opened = true
      const track = trackById.get(state.unitId) as Track
      entangle(ghostOfTrack(track, state), tracks, subSteps, arrivals, add)
      absences(track, state, settlement.clashes, trackById, add)
    })
    if (!opened) break
  }
  regicideSpread(input, settlement, claimList, contingent, trackById, add)
  scheduleSpread(input, settlement, contingent, trackById, add)
  seed()

  derivedDivergences(input, settlement, tracks, byId, entries, add)

  const ledger = order.slice().sort(byLedgerOrder)
  const named = new Set<string>()
  ledger.forEach((entry) => named.add(entry.unitId))

  const fates: Record<string, Fate> = {}
  tracks.forEach((track) => {
    fates[track.id] = named.has(track.id)
      ? "contingent"
      : settlement.deaths[track.id]
        ? "dead"
        : "alive"
  })

  // The regicide cascade, discharged now that the kings have fates.
  const settledClaims = dischargeRegicide(input, claimList, fates)
  settledClaims.forEach((claim) => {
    fates[claim.id] = claim.certainlyGone
      ? "dead"
      : claim.deathPossible
        ? "contingent"
        : "alive"
  })

  // The tiers a held unit carries into the next turn are the ones it carries
  // into this one: settlement never saw it, so nothing charged it. The claim's
  // interval is what brackets the truth.
  const tiers = { ...settlement.tiers }
  settledClaims.forEach((claim) => {
    tiers[claim.id] = claim.tierAtArrival
  })

  return {
    ...settlement,
    tiers,
    outcome: outcomeOf(input, settlement, settledClaims, byId),
    ledger,
    fates,
    claims: settledClaims,
  }
}

/**
 * A claim's regicide term, discharged against the settlement.
 *
 * `claims.ts` is a pure function of the board and settles nothing, so it
 * cannot tell whether a MODELLED king survives; it leaves that half of
 * `deathPossible` conservative and names the king in `regicideKingId`. Here
 * the king has a `fate`, and "alive" is a proof over every world. A team whose
 * every king is proved alive loses nobody to the rule, and the claims that
 * were possibly-dead only by cascade come back alive.
 *
 * The ledger above was built against the wider reading. That is sound in the
 * one direction that matters: a ledger may name a world the claims go on to
 * prove impossible; it may never miss one.
 */
const dischargeRegicide = (
  input: PartialSettleInput,
  claims: ReadonlyArray<Claim>,
  fates: Readonly<Record<string, Fate>>,
): ReadonlyArray<Claim> => {
  if (!claims.some((claim) => claim.regicideKingId !== null)) return claims
  const claimById = new Map(claims.map((claim) => [claim.id, claim]))
  const safe = new Map<string, boolean>()
  const teamIsSafe = (teamID: string): boolean => {
    const known = safe.get(teamID)
    if (known !== undefined) return known
    const answer = input.units.every((unit) => {
      if (!unit.isKing || unit.teamID !== teamID) return true
      const claim = claimById.get(unit.id)
      return claim ? !claim.selfDeathPossible : fates[unit.id] === "alive"
    })
    safe.set(teamID, answer)
    return answer
  }
  return claims.map((claim) =>
    claim.regicideKingId !== null && teamIsSafe(claim.teamID)
      ? { ...claim, deathPossible: claim.selfDeathPossible, regicideKingId: null }
      : claim,
  )
}

const byLedgerOrder = (a: Divergence, b: Divergence): number =>
  a.subStep - b.subStep ||
  a.cell - b.cell ||
  (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
  (a.heldId < b.heldId ? -1 : a.heldId > b.heldId ? 1 : 0) ||
  (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0)

/**
 * A spawner that cannot drop an item on a cell a claim could be standing on.
 * The free-cell rule is `spawn.ts`'s and is not restated: the claim's cells
 * are handed to it as occupancy, which is what they are.
 */
const shield = (spawn: Spawner, hidden: ReadonlyArray<number>): Spawner => {
  if (hidden.length === 0) return spawn
  const veil = (state: SpawnState): SpawnState => ({
    ...state,
    occupancy: [...state.occupancy, hidden],
  })
  return {
    food: (state) => spawn.food(veil(state)),
    potions: (state) => spawn.potions(veil(state)),
  }
}

/**
 * One modelled unit's whole turn, read off the settlement rather than
 * recomputed: `traversed` is the cells it entered, in order, and its
 * occupancy trails behind that exactly as the engine dragged it.
 */
const trackOf = (unit: ResolveUnit, settlement: Settlement, subSteps: number): Track => {
  const traversed = settlement.traversed[unit.id] ?? []
  const trail = leavesTrail(unit.type)
  const head: number[] = [unit.occupancy[0]]
  const moved: boolean[] = [false]
  for (let k = 1; k <= subSteps; k++) {
    const entered = k <= traversed.length
    head.push(entered ? traversed[k - 1] : head[k - 1])
    moved.push(entered)
  }

  const settled = settlement.board[unit.id]
  const body: Set<number>[] = []
  if (!trail) {
    // A stack drags nothing, so one empty set stands for every sub-step: the
    // array is only ever read.
    const none = new Set<number>()
    for (let k = 0; k <= subSteps; k++) body.push(none)
  } else {
    const kept = settled?.occupancy
    const length = unit.occupancy.length
    for (let k = 0; k <= subSteps; k++) {
      // Occupancy after k steps is the last k heads followed by the record's
      // kept prefix; the settled occupancy covers what growth and severing did.
      const cells = new Set<number>()
      for (let j = Math.max(1, k - length + 1); j <= k; j++) cells.add(head[j])
      for (let j = 0; j < length - k; j++) cells.add(unit.occupancy[j])
      if (kept !== undefined) for (let j = 0; j < kept.length; j++) cells.add(kept[j])
      cells.delete(head[k])
      body.push(cells)
    }
  }

  const piled = new Map<number, number>()
  settlement.clashes.forEach((clash) => {
    if (clash.kind !== "bodyBlock") return
    if (!clash.playerIDs.includes(unit.id) || clash.victimIDs.includes(unit.id)) return
    const known = piled.get(clash.index)
    if (known === undefined || clash.subStep < known) piled.set(clash.index, clash.subStep)
  })

  const death = settlement.deaths[unit.id]
  return {
    id: unit.id,
    tier: unit.tier,
    weight: unit.occupancy.length,
    leavesTrail: trail,
    traversesEdges: traversesEdges(unit.type),
    head,
    body,
    moved,
    piled,
    lastSubStep: death ? Math.min(death.subStep, subSteps) : subSteps,
    alive: !death,
  }
}

const ghostOfClaim = (claim: Claim): Ghost => {
  // The head. `headPossible` is cumulative — a unit stopped short of its ray
  // stays where it was stopped — so "could its head be at this cell by k" is
  // "was this cell reachable at or before k", which `earliestSubStep` answers
  // in one typed-array read. Nothing is allocated for it.
  const earliest = claim.earliestSubStep
  const span = claim.headPossible.length
  const head = (cell: number, k: number): boolean =>
    cell >= 0 && cell < earliest.length && earliest[cell] <= Math.max(0, k)

  // The trail. `bodyPossible` repeats ONE array for every sub-step after the
  // first, so the sets are built per distinct array rather than per sub-step.
  const bodies: Set<number>[] = []
  const built = new Map<ReadonlyArray<number>, Set<number>>()
  claim.bodyPossible.forEach((cells) => {
    let set = built.get(cells)
    if (set === undefined) {
      set = setOf(cells)
      built.set(cells, set)
    }
    bodies.push(set)
  })
  const body = (cell: number, k: number): boolean =>
    bodies.length !== 0 && bodies[Math.min(Math.max(0, k), bodies.length - 1)].has(cell)

  // The pile. Everything it could have held STRICTLY earlier is the head half
  // — cumulative again — plus the first sub-step each trail cell appears at.
  const firstBody = new Map<number, number>()
  let previous: Set<number> | undefined
  bodies.forEach((set, k) => {
    if (set === previous) return
    previous = set
    set.forEach((cell) => {
      if (!firstBody.has(cell)) firstBody.set(cell, k)
    })
  })
  const before = (cell: number, k: number): boolean => {
    if (k <= 0) return false
    const bound = Math.min(k, span - 1)
    if (bound <= 0) return false
    const trail = firstBody.get(cell)
    return head(cell, bound - 1) || (trail !== undefined && trail < bound)
  }

  const certain = setOf(claim.certainIfAlive)
  return {
    id: claim.id,
    origin: claim.id,
    via: NO_VIA,
    narrowed: claim.narrowed,
    leavesTrail: claim.leavesTrail,
    traversesEdges: claim.traversesEdges,
    tierMin: claim.tierMin,
    tierMax: claim.tierMax,
    weightMax: claim.weightMax,
    deathPossible: claim.deathPossible,
    from: 0,
    certain: (cell) => certain.has(cell),
    head,
    body,
    before,
  }
}

/**
 * A modelled unit whose own outcome is contingent, read as an unknown
 * presence: from the sub-step its outcome became unknown, it could be halted
 * on any cell of its own traversal rather than the one this timeline has it
 * on. Its strength is not an interval — it is a unit, and its tier and weight
 * are frozen and known.
 */
const ghostOfTrack = (track: Track, state: Contingency): Ghost => {
  const from = state.subStep
  const last = track.head.length - 1
  // Its own traversal, indexed ONCE by the earliest sub-step each cell was
  // walked at or after the divergence. The predicate then costs a map lookup
  // instead of rebuilding the walk for every unit on the board.
  const walked = new Map<number, number>()
  for (let j = Math.max(0, from - 1); j <= last; j++) {
    const cell = track.head[j]
    if (!walked.has(cell)) walked.set(cell, j)
  }
  const possible = (cell: number, k: number): boolean => {
    if (cell === track.head[Math.min(Math.max(0, k), last)]) return false
    const first = walked.get(cell)
    return first !== undefined && first < Math.min(Math.max(0, k), track.head.length)
  }
  return {
    id: track.id,
    origin: state.origin,
    via: through(state.via, track.id),
    narrowed: state.narrowed,
    leavesTrail: track.leavesTrail,
    traversesEdges: track.traversesEdges,
    tierMin: track.tier,
    tierMax: track.tier,
    weightMax: track.weight,
    deathPossible: true,
    from,
    certain: () => false,
    head: possible,
    body: () => false,
    before: possible,
  }
}

/**
 * Could anything other than `exceptId` ENTER `cell` at a sub-step strictly
 * after `after`?
 *
 * The one question a pairwise entanglement cannot answer for itself.
 * `entangle` is handed ONE unknown presence and asked what it could do to a
 * modelled unit; the pile composition in the trail branch below needs a
 * SECOND arrival, and the second one is not the ghost.
 */
type Arrivals = (cell: number, after: number, exceptId: string) => boolean

/**
 * Every unit that could enter a cell, as the LAST sub-step it could enter it
 * at — which is what `after` has to be compared against, and which the two
 * sources answer differently.
 *
 * A track's traversal is settled, so its entries are the sub-steps it
 * actually walked in. A claim's `headPossible` is CUMULATIVE and so cannot
 * separate an arrival at k from an arrival earlier that stopped there, which
 * means a cell a claim can reach at all is a cell it could still be entering
 * at the last sub-step of the turn. Over-wide in the one direction a ledger
 * is allowed to be over-wide in: it may name a world the claims go on to
 * prove impossible; it may never miss one.
 */
const arrivalsOf = (
  claims: ReadonlyArray<Claim>,
  tracks: ReadonlyArray<Track>,
  subSteps: number,
): Arrivals => {
  const byCell = new Map<number, { id: string; last: number }[]>()
  const note = (cell: number, id: string, at: number): void => {
    const entries = byCell.get(cell)
    if (entries === undefined) {
      byCell.set(cell, [{ id, last: at }])
      return
    }
    const known = entries.find((entry) => entry.id === id)
    if (known === undefined) entries.push({ id, last: at })
    else if (known.last < at) known.last = at
  }
  tracks.forEach((track) => {
    const until = Math.min(subSteps, track.lastSubStep)
    for (let k = 1; k <= until; k++) if (track.moved[k]) note(track.head[k], track.id, k)
  })
  claims.forEach((claim) => {
    claim.headPossible.forEach((cells) => cells.forEach((cell) => note(cell, claim.id, subSteps)))
  })
  return (cell, after, exceptId) => {
    const entries = byCell.get(cell)
    if (entries === undefined) return false
    return entries.some((entry) => entry.id !== exceptId && entry.last > after)
  }
}

/** Could `track` fail to survive a contact with `ghost` — a tie included? */
const couldLose = (track: Track, ghost: Ghost): boolean => {
  const beatsEverything =
    outranks(track, { tier: ghost.tierMin, weight: 1 }) &&
    outranks(track, { tier: ghost.tierMax, weight: ghost.weightMax })
  return !beatsEverything
}

/**
 * Every point at which one unknown presence could change one modelled unit's
 * turn. The five adjudication tiers the collision engine already has, asked
 * of a claim instead of a unit — edges, arrivals, living bodies, the corpse
 * piles a death leaves behind, and the sever that is the body rule's other
 * half.
 */
const entangle = (
  ghost: Ghost,
  tracks: ReadonlyArray<Track>,
  subSteps: number,
  arrivals: Arrivals,
  add: (entry: Divergence) => void,
): void => {
  tracks.forEach((track) => {
    if (track.id === ghost.id) return
    const base = {
      unitId: track.id,
      heldId: ghost.origin,
      via: ghost.via,
      narrowed: ghost.narrowed,
    }
    // The contest comparison reads only the two frozen strengths, so it is the
    // same answer at every sub-step of this pairing.
    const couldBeat = couldLose(track, ghost)
    const until = Math.min(subSteps, track.lastSubStep)
    for (let k = Math.max(1, ghost.from); k <= until; k++) {
      const cell = track.head[k]
      let contacted = false

      if (ghost.head(cell, k)) {
        contacted = true
        add({
          ...base,
          cell,
          subStep: k,
          kind: "contest",
          assumedPresent: ghost.certain(cell),
          couldBeat,
        })
      }

      // The body rule: equal-or-lower tier dies on the segment, strictly
      // higher tier severs it and capture-stops. Both halves can be live at
      // once when the claim's tier interval straddles this unit's.
      if (ghost.leavesTrail && ghost.body(cell, k)) {
        contacted = true
        const assumedPresent = ghost.certain(cell)
        if (ghost.tierMax >= track.tier) {
          add({
            ...base,
            cell,
            subStep: k,
            kind: "bodyBlock",
            assumedPresent,
            couldBeat: true,
          })
        }
        if (ghost.tierMin < track.tier) {
          add({ ...base, cell, subStep: k, kind: "sever", assumedPresent, couldBeat: false })
        }
      }

      // An edge exchange: the claim could be crossing the very edge this unit
      // crossed, the other way. A jump traverses no edge, so it never contests
      // one.
      if (
        track.moved[k] &&
        track.traversesEdges &&
        ghost.traversesEdges &&
        ghost.head(cell, k - 1) &&
        ghost.head(track.head[k - 1], k)
      ) {
        add({
          ...base,
          cell,
          subStep: k,
          kind: "edge",
          assumedPresent: ghost.certain(cell),
          couldBeat,
        })
      }

      // A death never removes anything from the board, so a claim that could
      // have died earlier is a pile this arrival joins.
      if (!contacted && ghost.deathPossible && track.moved[k] && ghost.before(cell, k)) {
        add({
          ...base,
          cell,
          subStep: k,
          kind: "durable",
          assumedPresent: false,
          couldBeat,
        })
      }

      // The other half of the body rule: this unit's own trail is what the
      // claim could be arriving on, and a cut is a weight loss rather than a
      // death — FOR ONE ARRIVAL.
      //
      // For two it is not, and the sever alone cannot say so. The claim's
      // tier interval straddles this unit's here too: at a tier this unit
      // matches or beats, the arrival does not cut the segment, it DIES on
      // it — and a death removes nothing from the board. The cell becomes
      // durable holding the corpse and, by the same batch, the SEGMENT'S
      // OWNER. Anything arriving there afterwards is contested against that
      // whole pile, and every member of it that is not the unique strict
      // maximum is condemned; the owner is a member. So the owner can be
      // killed at a cell it merely had a tail on, by a contact its own
      // ledger entry called survivable.
      //
      // The two outcomes are two entries, because they are two different
      // things a world can do at one cell: `sever` is the cut, which is a
      // weight loss and never fatal, and `contest` is the pile. The owner is
      // priced against that pile at the weight it carries ALL TURN — severs
      // truncate only once the collision phase is over — so `couldLose` is
      // not the question and the entry does not ask it: a pile of three
      // whose top is an interval has no unique strict maximum to prove.
      //
      // The owner gets into the pile two ways, and the tier interval only
      // opens the first:
      //
      //   · THIS claim dies on the segment, which needs a tier it does not
      //     outrank the owner at, and then a SECOND arrival to contest what
      //     the death left. `arrivals` is that second one, and it has to
      //     enter strictly later — the sub-step of the death has already run
      //     its arrival tier by the time the body tier kills anybody.
      //   · The owner is in the pile ALREADY, because this timeline settled a
      //     body block at the cell and entered it there. Then the claim needs
      //     no tier argument at all and is itself the arrival: it contests
      //     the standing pile the moment it lands, at any strength, and the
      //     tier that severs the segment is exactly the tier that wins that
      //     contest and leaves the owner condemned in it.
      if (track.leavesTrail) {
        track.body[k].forEach((segment) => {
          if (!ghost.head(segment, k)) return
          const assumedPresent = ghost.certain(segment)
          add({
            ...base,
            cell: segment,
            subStep: k,
            kind: "sever",
            assumedPresent,
            couldBeat: false,
          })
          const makesPile = ghost.tierMin <= track.tier && arrivals(segment, k, ghost.id)
          const alreadyPiled = (track.piled.get(segment) ?? subSteps + 1) < k
          if (makesPile || alreadyPiled) {
            add({
              ...base,
              cell: segment,
              subStep: k,
              kind: "contest",
              assumedPresent,
              couldBeat: true,
            })
          }
        })
      }
    }
  })
}

/**
 * Unknown ABSENCE. A unit whose outcome is contingent from sub-step `s` did
 * not necessarily take part in the clashes this timeline has it taking part
 * in afterwards, and everyone else at those clashes is contingent with it.
 */
const absences = (
  track: Track,
  state: Contingency,
  clashes: ReadonlyArray<Clash>,
  trackById: Map<string, Track>,
  add: (entry: Divergence) => void,
): void => {
  const via = through(state.via, track.id)
  clashes.forEach((clash) => {
    if (clash.subStep < state.subStep) return
    if (!clash.playerIDs.includes(track.id)) return
    clash.playerIDs.forEach((other) => {
      if (other === track.id || !trackById.has(other)) return
      const kind = ABSENCE_KIND[clash.kind]
      if (!kind) return
      add({
        cell: clash.index,
        subStep: clash.subStep,
        unitId: other,
        heldId: state.origin,
        via,
        kind,
        assumedPresent: true,
        couldBeat: clash.victimIDs.includes(other),
        narrowed: state.narrowed,
      })
    })
  })
}

/** How a clash this timeline recorded reads once a participant may be missing. */
const ABSENCE_KIND: { [K in ClashKind]?: DivergenceKind } = {
  contest: "contest",
  edge: "edge",
  bodyBlock: "bodyBlock",
  sever: "sever",
  hazard: "exhaustion",
  exhaustion: "exhaustion",
}

/**
 * Regicide is a team-wide verdict off one unit's death, so a king that could
 * fall makes its whole team contingent — the one place a divergence travels
 * without a cell to travel through.
 *
 * TWO THINGS KEEP IT FROM SWALLOWING THE BOARD.
 *
 * It fires only for a king whose death is actually in doubt. A held king's is
 * its claim's own `deathPossible`, which no longer carries the cascade term it
 * would be reading about itself; a modelled king's is in doubt exactly when
 * something made it contingent. A king nothing can touch takes nobody with it,
 * and a caller sweeping candidates gets to see that.
 *
 * And it is attributed to the HELD unit at the root rather than to the king.
 * A modelled king is one of ours: keying the entry to it would tell a searcher
 * to enumerate our own move, which it already knows, and every candidate would
 * come back with the same work list. `via` ends at the king, so the entry
 * still says which one unit's fall is being priced.
 */
const regicideSpread = (
  input: PartialSettleInput,
  settlement: Settlement,
  claims: ReadonlyArray<Claim>,
  contingent: Map<string, Contingency>,
  trackById: Map<string, Track>,
  add: (entry: Divergence) => void,
): void => {
  const regicide = new Set(input.regicideTeamIDs ?? [])
  if (regicide.size === 0) return
  const claimById = new Map(claims.map((claim) => [claim.id, claim]))
  input.units.forEach((king) => {
    if (!king.isKing || !regicide.has(king.teamID)) return

    // Who the fall would be charged to, and by what route. A held king is its
    // own root; a modelled one is a link in every chain that reached it, and
    // each of those chains is a separate partition of the worlds.
    const routes: { origin: string; via: ReadonlyArray<string>; narrowed: boolean }[] = []
    const claim = claimById.get(king.id)
    if (claim) {
      if (!claim.deathPossible) return
      routes.push({ origin: king.id, via: NO_VIA, narrowed: claim.narrowed })
    } else {
      contingent.forEach((state) => {
        if (state.unitId !== king.id) return
        routes.push({
          origin: state.origin,
          via: through(state.via, king.id),
          narrowed: state.narrowed,
        })
      })
    }
    if (routes.length === 0) return

    input.units.forEach((unit) => {
      if (unit.teamID !== king.teamID || unit.id === king.id) return
      const track = trackById.get(unit.id)
      if (!track) return
      const cell = settlement.deaths[unit.id]?.cell ?? track.head[track.lastSubStep]
      routes.forEach((route) =>
        add({
          cell,
          subStep: settlement.subStepCount,
          unitId: unit.id,
          heldId: route.origin,
          via: route.via,
          kind: "regicide",
          assumedPresent: true,
          couldBeat: true,
          narrowed: route.narrowed,
        }),
      )
    })
  })
}

/**
 * The invulnerability schedule is a TEAM object, so a contingent unit moves
 * its team-mates' tiers without anything touching them. Two rules do it, and
 * both reach across the board from one unit's own turn:
 *
 *   · the ally-buff cancel. A unit that was VULNERABLE when it collided —
 *     killed, or severed and still standing — takes its team's borrowed
 *     invulnerability down with it, so a contingent unit below tier zero puts
 *     every ally buff on its team in doubt.
 *   · the pickup. A unit halted one cell short of where this timeline has it
 *     did not collect the potion it collected here — or collected one it did
 *     not — and the collector takes -1 while each living ally takes +1.
 *
 * The same two a claim triggers from the other side (`itemDivergences`),
 * reached from this one.
 */
const scheduleSpread = (
  input: PartialSettleInput,
  settlement: Settlement,
  contingent: Map<string, Contingency>,
  trackById: Map<string, Track>,
  add: (entry: Divergence) => void,
): void => {
  const potions = new Set(input.potionsEnabled ? input.potions : [])
  contingent.forEach((state) => {
    const id = state.unitId
    const track = trackById.get(id)
    if (!track) return
    const teamID = input.teamOf[id]
    const via = through(state.via, id)
    const where = settlement.deaths[id]?.cell ?? track.head[track.lastSubStep]
    const spread = (unitId: string, cell: number): void =>
      add({
        cell,
        subStep: settlement.subStepCount,
        unitId,
        heldId: state.origin,
        via,
        kind: "potion",
        assumedPresent: true,
        couldBeat: false,
        narrowed: state.narrowed,
      })

    if (track.tier < 0) {
      input.effects.forEach((effect) => {
        if (effect.type !== "invulnerability_buff") return
        if (effect.playerID === id || input.teamOf[effect.playerID] !== teamID) return
        if (!trackById.has(effect.playerID)) return
        spread(effect.playerID, where)
      })
    }

    const touched = track.head.find((cell) => potions.has(cell))
    if (touched === undefined) return
    input.units.forEach((ally) => {
      if (ally.id === id || input.teamOf[ally.id] !== teamID) return
      if (!trackById.has(ally.id)) return
      spread(ally.id, touched)
    })
  })
}

/**
 * Whether a staged action is LEGAL AT ALL, where the answer reads a claim.
 *
 * The grammar reads the board in exactly one place — a pawn's diagonal step
 * is an attack or a meal, so `planUnitAction` admits it only onto a cell in
 * `pawnTargetsOf`: the food, plus every body standing there as the turn
 * opens. The optimistic timeline reads that question against the board with
 * every held unit at its OBSERVED cell (see `presence`), which is the right
 * board and the only one, for a unit observed on THIS board: staging happens
 * before anything moves, so a unit whose record is this turn's is standing
 * where the record says whatever it goes on to choose. There is nothing to
 * ledger, and the entries a caller reads stay about contact.
 *
 * A unit observed EARLIER is another matter. Its record cell is where it was
 * a turn ago; by the time this turn opens it may have left, and it may be
 * standing somewhere the timeline reads as empty ground. Either way the
 * question "is this staged cell a legal target" can be answered differently
 * in different worlds, and the whole action turns over on it — a capture in
 * one world, the kind's default in another. That is a divergence like any
 * other and it is written down like any other, keyed to the held unit whose
 * whereabouts decide it, rather than settled by picking a world.
 *
 * The test is the grammar's own, asked twice: once against the board with
 * every cell the claim could be on treated as occupied, once with its
 * observed cells taken away. `pawnTargetsOf` is a union, so those two bracket
 * every world's answer, and an action that survives both is an action this
 * claim cannot touch. Nothing here knows WHICH rule read the board, so a
 * second occupancy-reading rule is covered the day it is written.
 */
const grammarDivergences = (
  input: PartialSettleInput,
  live: ReadonlyArray<ResolveUnit>,
  claims: ReadonlyArray<Claim>,
  add: (entry: Divergence) => void,
): void => {
  // Observed on this very board: present at its observed cells when the turn
  // opens, in every world. Only a longer span puts the presence in doubt.
  const doubted = claims.filter((claim) => {
    const record = input.held.find((h) => h.id === claim.id)
    return record !== undefined && input.turn - record.observedTurn > 1
  })
  if (doubted.length === 0) return

  const staged = live.filter((u) => u.path === undefined && u.stagedMove !== undefined)
  if (staged.length === 0) return

  const shapeOf = (occupancy: BoardShape["occupancy"]): BoardShape => ({
    boardWidth: input.boardWidth,
    boardHeight: input.boardHeight,
    walls: input.walls,
    hazards: input.hazards,
    occupancy,
    food: input.food,
  })
  const observed = input.units.map((u) => ({ id: u.id, cells: u.occupancy }))

  doubted.forEach((claim) => {
    const absent = shapeOf(observed.filter((entry) => entry.id !== claim.id))
    const present = shapeOf([
      ...absent.occupancy,
      { id: claim.id, cells: [...claim.headPossible[0], ...claim.bodyPossible[0]] },
    ])
    staged.forEach((unit) => {
      const most = stagedAction(unit, unit.stagedMove, present)
      const least = stagedAction(unit, unit.stagedMove, absent)
      if (sameAction(most, least)) return
      add({
        // The staged destination: the cell whose reading is what turned over.
        cell: unit.stagedMove as number,
        // The action decides the unit's whole walk, so the earliest sub-step
        // it can show at is the first one.
        subStep: 1,
        unitId: unit.id,
        heldId: claim.id,
        via: NO_VIA,
        kind: "grammar",
        // The timeline read the claim as standing on its observed square.
        assumedPresent: true,
        // A unit that walks a different move can end anywhere the other move
        // did not, a death included. Nothing here is a survival argument.
        couldBeat: true,
        narrowed: claim.narrowed,
      })
    })
  })
}

/** Two planned actions, compared by everything `resolveTurn` reads off one. */
const sameAction = (a: UnitAction, b: UnitAction): boolean => {
  if (a.kind === "move" && b.kind === "move") {
    return a.path.length === b.path.length && a.path.every((cell, i) => cell === b.path[i])
  }
  if (a.kind === "rotate" && b.kind === "rotate") {
    return a.orientation.dx === b.orientation.dx && a.orientation.dy === b.orientation.dy
  }
  return a.kind === b.kind
}

/**
 * The two items. A meal or a potion a claim could already have taken is not
 * on the board when this timeline's eater arrives at it — and for a potion,
 * a claim's collection over an earlier turn moves its whole TEAM's tiers into
 * this turn's contests.
 */
const itemDivergences = (
  input: PartialSettleInput,
  settlement: Settlement,
  claims: ReadonlyArray<Claim>,
  tracks: ReadonlyArray<Track>,
  add: (entry: Divergence) => void,
): void => {
  const eaten = new Set(input.food.filter((cell) => !settlement.food.includes(cell)))
  const potions = input.potionsEnabled
    ? new Set(input.potions.filter((cell) => !settlement.potions.includes(cell)))
    : new Set<number>()

  // One set per claim, not one per (unit, claim) pair: `everPossible` is a
  // property of the claim and rebuilding it inside the sweep was quadratic in
  // the roster for no answer that changed.
  const reachOf = new Map<string, Set<number>>()
  claims.forEach((claim) => reachOf.set(claim.id, setOf(claim.everPossible)))

  tracks.forEach((track) => {
    const finalCell = settlement.finalCell[track.id]
    if (!eaten.has(finalCell) && !potions.has(finalCell)) return
    claims.forEach((claim) => {
      const reachable = reachOf.get(claim.id) as Set<number>
      if (eaten.has(finalCell) && reachable.has(finalCell)) {
        add({
          cell: finalCell,
          subStep: settlement.subStepCount,
          unitId: track.id,
          heldId: claim.id,
          via: NO_VIA,
          kind: "food",
          assumedPresent: false,
          couldBeat: false,
          narrowed: claim.narrowed,
        })
      }
      if (potions.has(finalCell) && reachable.has(finalCell)) {
        add({
          cell: finalCell,
          subStep: settlement.subStepCount,
          unitId: track.id,
          heldId: claim.id,
          via: NO_VIA,
          kind: "potion",
          assumedPresent: false,
          couldBeat: false,
          narrowed: claim.narrowed,
        })
      }
    })
  })

  // The invulnerability schedule is a TEAM object, so a claim's own turn moves
  // its team-mates' tiers without ever touching them. Two ways, and both are
  // rules rather than side effects:
  //
  //   · a potion. The pickup is inverted — the collector takes -1 and each of
  //     its living allies takes +1 — so a claim that could END on a potion
  //     moves every ally's tier into the next turn, and one it could have
  //     taken on an EARLIER turn of its span is already in force during this
  //     one, moving the contests themselves.
  //   · the ally-buff cancel. A unit that was vulnerable when it collided —
  //     killed, or severed and still standing — takes its team's borrowed
  //     invulnerability down with it. A claim can do that by walking into a
  //     wall, with nobody modelled anywhere near it.
  const byTeam = new Map<string, Track[]>()
  tracks.forEach((track) => {
    const teamID = input.teamOf[track.id]
    const roster = byTeam.get(teamID)
    if (roster === undefined) byTeam.set(teamID, [track])
    else roster.push(track)
  })
  const schedule = (claim: Claim, cell: number, subStep: number): void =>
    (byTeam.get(claim.teamID) ?? []).forEach((track) =>
      add({
        cell,
        subStep,
        unitId: track.id,
        heldId: claim.id,
        via: NO_VIA,
        kind: "potion",
        assumedPresent: false,
        couldBeat: false,
        narrowed: claim.narrowed,
      }),
    )

  claims.forEach((claim) => {
    if (input.potionsEnabled) {
      const front = claim.headPossible[claim.headPossible.length - 1]
      const ending = input.potions.find((cell) => front.includes(cell))
      if (ending !== undefined) schedule(claim, ending, settlement.subStepCount)
      const earlier = input.potions.find((cell) => claim.everPossible.includes(cell))
      if (earlier !== undefined && claim.tierMin !== claim.tierMax) schedule(claim, earlier, 0)
    }
    const borrowed = input.effects.some(
      (effect) =>
        effect.type === "invulnerability_buff" &&
        effect.playerID !== claim.id &&
        input.teamOf[effect.playerID] === claim.teamID,
    )
    if (!borrowed) return
    if (claim.tierMin >= 0) return
    if (!claim.deathPossible && !claim.severPossible) return
    schedule(claim, claim.headPossible[0][0] ?? 0, settlement.subStepCount)
  })
}

/**
 * The two verdicts a divergence changes without a contact of its own: whether
 * an exhaustion was fatal (a unit halted early spent less energy) and whether
 * a pawn reached the promotion threshold (a unit halted early ate something
 * else, or nothing).
 */
const derivedDivergences = (
  input: PartialSettleInput,
  settlement: Settlement,
  tracks: ReadonlyArray<Track>,
  byId: Map<string, ResolveUnit>,
  entries: Map<string, Divergence>,
  add: (entry: Divergence) => void,
): void => {
  const earliest = new Map<string, Divergence>()
  entries.forEach((entry) => {
    const known = earliest.get(entry.unitId)
    if (!known || entry.subStep < known.subStep) earliest.set(entry.unitId, entry)
  })

  settlement.exhaustions.forEach((event) => {
    const source = earliest.get(event.unitID)
    if (!source || source.subStep > event.subStep) return
    add({
      cell: event.cell,
      subStep: event.subStep,
      unitId: event.unitID,
      heldId: source.heldId,
      via: source.via,
      kind: "exhaustion",
      assumedPresent: source.assumedPresent,
      couldBeat: true,
      narrowed: source.narrowed,
    })
  })

  tracks.forEach((track) => {
    const unit = byId.get(track.id)
    if (!unit || unit.type !== "pawn") return
    const source = earliest.get(track.id)
    if (!source) return
    const weight = settlement.board[track.id]?.occupancy.length ?? 0
    const promoted = settlement.promoted.includes(track.id)
    if (!promoted && weight + 1 < input.pawnPromotionWeight) return
    add({
      cell: settlement.finalCell[track.id],
      subStep: settlement.subStepCount,
      unitId: track.id,
      heldId: source.heldId,
      via: source.via,
      kind: "promotion",
      assumedPresent: source.assumedPresent,
      couldBeat: false,
      narrowed: source.narrowed,
    })
  })
}

/**
 * Whether the game ended, on the board as it now stands — held units
 * included. `settleTurn` adjudicated a board they were absent from, and a
 * team whose only unit nobody modelled is not an eliminated team. The rule is
 * `adjudicate`'s and is asked again rather than restated; a held unit stands
 * at the weight it was observed with, which its claim's interval brackets.
 */
const outcomeOf = (
  input: PartialSettleInput,
  settlement: Settlement,
  claims: ReadonlyArray<Claim>,
  byId: Map<string, ResolveUnit>,
): Settlement["outcome"] => {
  const held = new Map<string, boolean>()
  claims.forEach((claim) => held.set(claim.id, claim.certainlyGone))
  const alive: string[] = []
  const pieces: { [unitID: string]: ReadonlyArray<number> } = {}
  input.units.forEach((unit) => {
    const gone = held.get(unit.id)
    if (gone !== undefined) {
      if (gone) return
      alive.push(unit.id)
      pieces[unit.id] = (byId.get(unit.id) as ResolveUnit).occupancy
      return
    }
    const settled = settlement.board[unit.id]
    if (!settled) return
    alive.push(unit.id)
    pieces[unit.id] = settled.occupancy
  })

  const board: BoardView = { alive, pieces }
  const adjudicated = adjudicate(
    board,
    input.previous,
    input.teamOf,
    input.turn,
    input.maxTurns,
  )
  return adjudicated.kind === "continues" ? null : adjudicated
}
