import { Clash, ClashKind } from "@shared/types/Game"
import { BoardView, adjudicate } from "./adjudicate"
import { Claim, PartialSettleInput, computeClaims } from "./claims"
import { leavesTrail, traversesEdges } from "./moveGrammar"
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
 * ## Contingency propagates
 *
 * A unit a claim could have halted did not go on to kill what it killed here,
 * and a unit a claim could have killed was not standing where this timeline
 * has it standing. So contingency spreads: a modelled unit whose own outcome
 * is contingent becomes, for the rest of the turn, a second source of
 * unknown presence — able to be standing on any cell of its own traversal —
 * and a second source of unknown absence, at every clash it took part in
 * afterwards. The ledger is closed under that spread before it is returned,
 * which is why `heldId` names *the unit whose unknown disposition creates the
 * difference* rather than always a held one.
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
  | "contest" // a unit ended a sub-step where a claim could be standing
  | "edge" // a claim could cross the same edge the other way
  | "bodyBlock" // a claim's trail could hold this cell
  | "sever" // a claim could sever this unit, or be severed by it
  | "durable" // a claim could have DIED here, leaving a pile
  | "food" // a claim could have eaten the food this unit ate
  | "potion" // a claim could have taken the potion this unit took
  | "exhaustion" // energy spent here depends on whether a claim halted it
  | "promotion" // the weight the threshold is read against could differ

export interface Divergence {
  readonly cell: number
  readonly subStep: number
  /**
   * The unit whose outcome could differ from this timeline. A MODELLED unit
   * for every entry: what is known about a held unit is its `Claim`.
   */
  readonly unitId: string
  /**
   * The unit whose unknown disposition creates the difference — a held unit,
   * or a modelled unit whose own outcome is already contingent.
   */
  readonly heldId: string
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

/** Anything whose presence at a cell is unknown: a claim, or a contingent unit. */
interface Ghost {
  readonly id: string
  readonly narrowed: boolean
  readonly leavesTrail: boolean
  readonly traversesEdges: boolean
  readonly tierMin: number
  readonly tierMax: number
  readonly weightMax: number
  readonly deathPossible: boolean
  /** Cells it holds in every world where it is alive and unsevered. */
  readonly certain: ReadonlySet<number>
  /** Sub-step from which this ghost's disposition is unknown. */
  readonly from: number
  head(subStep: number): ReadonlySet<number>
  body(subStep: number): ReadonlySet<number>
  /** Everything it could have held at a STRICTLY earlier sub-step. */
  before(subStep: number): ReadonlySet<number>
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
  readonly lastSubStep: number
  readonly alive: boolean
}

const setOf = (cells: Iterable<number>): Set<number> => new Set(cells)
const EMPTY: ReadonlySet<number> = new Set<number>()

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
  const settlement = settleTurn(
    { ...input, units: live, regicideTeamIDs },
    shield(spawn, Array.from(hidden)),
  )

  const subSteps = Math.max(
    settlement.subStepCount,
    ...claimList.map((claim) => claim.headPossible.length - 1),
  )
  const tracks = live.map((unit) => trackOf(unit, settlement, subSteps))
  const trackById = new Map(tracks.map((t) => [t.id, t]))

  const entries = new Map<string, Divergence>()
  const add = (entry: Divergence): void => {
    const key = `${entry.subStep}|${entry.cell}|${entry.kind}|${entry.heldId}|${entry.unitId}`
    if (!entries.has(key)) entries.set(key, entry)
  }

  claimList.forEach((claim) => entangle(ghostOfClaim(claim), tracks, subSteps, add))
  itemDivergences(input, settlement, claimList, tracks, add)

  // Contingency closure. A unit whose own outcome is unknown is, from that
  // sub-step on, exactly the same kind of unknown presence a claim is — and
  // exactly the same kind of unknown ABSENCE at every clash it took part in
  // afterwards. Both directions, to a fixpoint.
  const contingent = new Map<string, { subStep: number; narrowed: boolean }>()
  const seed = (): boolean => {
    let grew = false
    entries.forEach((entry) => {
      const track = trackById.get(entry.unitId)
      if (!track) return
      const known = contingent.get(entry.unitId)
      if (known && known.subStep <= entry.subStep) return
      contingent.set(entry.unitId, { subStep: entry.subStep, narrowed: entry.narrowed })
      grew = true
    })
    return grew
  }

  const expanded = new Set<string>()
  for (let pass = 0; pass < tracks.length + 1; pass++) {
    if (!seed()) break
    let opened = false
    contingent.forEach((state, id) => {
      const stamp = `${id}@${state.subStep}`
      if (expanded.has(stamp)) return
      expanded.add(stamp)
      opened = true
      const track = trackById.get(id) as Track
      entangle(ghostOfTrack(track, state.subStep, state.narrowed), tracks, subSteps, add)
      absences(track, state, settlement.clashes, trackById, add)
    })
    if (!opened) break
  }
  regicideSpread(input, settlement, claimList, contingent, trackById, add)
  scheduleSpread(input, settlement, contingent, trackById, add)
  seed()

  derivedDivergences(input, settlement, tracks, entries, add)

  const ledger = Array.from(entries.values()).sort(byLedgerOrder)
  const named = new Set(ledger.map((entry) => entry.unitId))

  const fates: Record<string, Fate> = {}
  tracks.forEach((track) => {
    fates[track.id] = named.has(track.id)
      ? "contingent"
      : settlement.deaths[track.id]
        ? "dead"
        : "alive"
  })
  claimList.forEach((claim) => {
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
  claimList.forEach((claim) => {
    tiers[claim.id] = claim.tierAtArrival
  })

  return {
    ...settlement,
    tiers,
    outcome: outcomeOf(input, settlement, claimList, byId),
    ledger,
    fates,
    claims: claimList,
  }
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
  for (let k = 0; k <= subSteps; k++) {
    if (!trail) {
      body.push(new Set<number>())
      continue
    }
    // Occupancy after k steps is the last k heads followed by the record's
    // kept prefix; the settled occupancy covers what growth and severing did.
    const cells = new Set<number>()
    for (let j = Math.max(1, k - unit.occupancy.length + 1); j <= k; j++) cells.add(head[j])
    unit.occupancy
      .slice(0, Math.max(0, unit.occupancy.length - k))
      .forEach((cell) => cells.add(cell))
    settled?.occupancy.forEach((cell) => cells.add(cell))
    cells.delete(head[k])
    body.push(cells)
  }

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
    lastSubStep: death ? Math.min(death.subStep, subSteps) : subSteps,
    alive: !death,
  }
}

const ghostOfClaim = (claim: Claim): Ghost => {
  const heads = claim.headPossible.map(setOf)
  const bodies = claim.bodyPossible.map(setOf)
  const prefix: Set<number>[] = []
  const running = new Set<number>()
  for (let k = 0; k < heads.length; k++) {
    prefix.push(new Set(running))
    heads[k].forEach((cell) => running.add(cell))
    bodies[k]?.forEach((cell) => running.add(cell))
  }
  const at = (sets: Set<number>[], k: number): ReadonlySet<number> =>
    sets.length === 0 ? EMPTY : sets[Math.min(k, sets.length - 1)]
  return {
    id: claim.id,
    narrowed: claim.narrowed,
    leavesTrail: claim.leavesTrail,
    traversesEdges: claim.traversesEdges,
    tierMin: claim.tierMin,
    tierMax: claim.tierMax,
    weightMax: claim.weightMax,
    deathPossible: claim.deathPossible,
    certain: setOf(claim.certainIfAlive),
    from: 0,
    head: (k) => at(heads, Math.max(0, k)),
    body: (k) => at(bodies, Math.max(0, k)),
    before: (k) => (k <= 0 ? EMPTY : at(prefix, k)),
  }
}

/**
 * A modelled unit whose own outcome is contingent, read as an unknown
 * presence: from the sub-step its outcome became unknown, it could be halted
 * on any cell of its own traversal rather than the one this timeline has it
 * on. Its strength is not an interval — it is a unit, and its tier and weight
 * are frozen and known.
 */
const ghostOfTrack = (track: Track, from: number, narrowed: boolean): Ghost => {
  const possible = (k: number): ReadonlySet<number> => {
    const cells = new Set<number>()
    for (let j = Math.max(0, from - 1); j < Math.min(k, track.head.length); j++) {
      cells.add(track.head[j])
    }
    cells.delete(track.head[Math.min(k, track.head.length - 1)])
    return cells
  }
  return {
    id: track.id,
    narrowed,
    leavesTrail: track.leavesTrail,
    traversesEdges: track.traversesEdges,
    tierMin: track.tier,
    tierMax: track.tier,
    weightMax: track.weight,
    deathPossible: true,
    certain: EMPTY,
    from,
    head: possible,
    body: () => EMPTY,
    before: possible,
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
  add: (entry: Divergence) => void,
): void => {
  tracks.forEach((track) => {
    if (track.id === ghost.id) return
    const base = {
      unitId: track.id,
      heldId: ghost.id,
      narrowed: ghost.narrowed,
    }
    for (let k = Math.max(1, ghost.from); k <= Math.min(subSteps, track.lastSubStep); k++) {
      const cell = track.head[k]
      const heads = ghost.head(k)
      let contacted = false

      if (heads.has(cell)) {
        contacted = true
        add({
          ...base,
          cell,
          subStep: k,
          kind: "contest",
          assumedPresent: ghost.certain.has(cell),
          couldBeat: couldLose(track, ghost),
        })
      }

      // The body rule: equal-or-lower tier dies on the segment, strictly
      // higher tier severs it and capture-stops. Both halves can be live at
      // once when the claim's tier interval straddles this unit's.
      if (ghost.leavesTrail && ghost.body(k).has(cell)) {
        contacted = true
        const assumedPresent = ghost.certain.has(cell)
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
        ghost.head(k - 1).has(cell) &&
        heads.has(track.head[k - 1])
      ) {
        add({
          ...base,
          cell,
          subStep: k,
          kind: "edge",
          assumedPresent: ghost.certain.has(cell),
          couldBeat: couldLose(track, ghost),
        })
      }

      // A death never removes anything from the board, so a claim that could
      // have died earlier is a pile this arrival joins.
      if (!contacted && ghost.deathPossible && track.moved[k] && ghost.before(k).has(cell)) {
        add({
          ...base,
          cell,
          subStep: k,
          kind: "durable",
          assumedPresent: false,
          couldBeat: couldLose(track, ghost),
        })
      }

      // The other half of the body rule: this unit's own trail is what the
      // claim could be arriving on, and a cut is a weight loss rather than a
      // death.
      if (track.leavesTrail) {
        track.body[k].forEach((segment) => {
          if (!heads.has(segment)) return
          add({
            ...base,
            cell: segment,
            subStep: k,
            kind: "sever",
            assumedPresent: ghost.certain.has(segment),
            couldBeat: false,
          })
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
  state: { subStep: number; narrowed: boolean },
  clashes: ReadonlyArray<Clash>,
  trackById: Map<string, Track>,
  add: (entry: Divergence) => void,
): void => {
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
        heldId: track.id,
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
 * Regicide is a team-wide verdict off one unit's death, so a contingent king
 * makes its whole team contingent — the one place a divergence travels
 * without a cell to travel through.
 */
const regicideSpread = (
  input: PartialSettleInput,
  settlement: Settlement,
  claims: ReadonlyArray<Claim>,
  contingent: Map<string, { subStep: number; narrowed: boolean }>,
  trackById: Map<string, Track>,
  add: (entry: Divergence) => void,
): void => {
  const regicide = new Set(input.regicideTeamIDs ?? [])
  if (regicide.size === 0) return
  const claimById = new Map(claims.map((claim) => [claim.id, claim]))
  input.units.forEach((king) => {
    if (!king.isKing || !regicide.has(king.teamID)) return
    const claim = claimById.get(king.id)
    const state = contingent.get(king.id)
    // A held king's survival is unknown by construction; a modelled king's is
    // unknown once anything has made it contingent.
    if (!claim && !state) return
    if (claim && !claim.deathPossible) return
    input.units.forEach((unit) => {
      if (unit.teamID !== king.teamID || unit.id === king.id) return
      const track = trackById.get(unit.id)
      if (!track) return
      add({
        cell: settlement.deaths[unit.id]?.cell ?? track.head[track.lastSubStep],
        subStep: settlement.subStepCount,
        unitId: unit.id,
        heldId: king.id,
        kind: "contest",
        assumedPresent: true,
        couldBeat: true,
        narrowed: claim?.narrowed ?? state?.narrowed ?? false,
      })
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
  contingent: Map<string, { subStep: number; narrowed: boolean }>,
  trackById: Map<string, Track>,
  add: (entry: Divergence) => void,
): void => {
  const potions = new Set(input.potionsEnabled ? input.potions : [])
  contingent.forEach((state, id) => {
    const track = trackById.get(id)
    if (!track) return
    const teamID = input.teamOf[id]
    const where = settlement.deaths[id]?.cell ?? track.head[track.lastSubStep]
    const spread = (unitId: string, cell: number): void =>
      add({
        cell,
        subStep: settlement.subStepCount,
        unitId,
        heldId: id,
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

  tracks.forEach((track) => {
    const finalCell = settlement.finalCell[track.id]
    claims.forEach((claim) => {
      const reachable = new Set(claim.everPossible)
      if (eaten.has(finalCell) && reachable.has(finalCell)) {
        add({
          cell: finalCell,
          subStep: settlement.subStepCount,
          unitId: track.id,
          heldId: claim.id,
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
  const alliesOf = (teamID: string): Track[] =>
    tracks.filter((track) => input.teamOf[track.id] === teamID)
  const schedule = (claim: Claim, cell: number, subStep: number): void =>
    alliesOf(claim.teamID).forEach((track) =>
      add({
        cell,
        subStep,
        unitId: track.id,
        heldId: claim.id,
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
      kind: "exhaustion",
      assumedPresent: source.assumedPresent,
      couldBeat: true,
      narrowed: source.narrowed,
    })
  })

  tracks.forEach((track) => {
    const unit = input.units.find((u) => u.id === track.id)
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
  const gone = new Set(claims.filter((claim) => claim.certainlyGone).map((claim) => claim.id))
  const held = new Map(claims.map((claim) => [claim.id, claim]))
  const alive: string[] = []
  const pieces: { [unitID: string]: ReadonlyArray<number> } = {}
  input.units.forEach((unit) => {
    if (held.has(unit.id)) {
      if (gone.has(unit.id)) return
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
