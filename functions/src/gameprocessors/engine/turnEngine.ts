import { Clash, ClashKind } from "@shared/types/Game"

/**
 * The unified turn engine. Every game — snake-only, pure chess, or mixed —
 * resolves its turn here.
 *
 * The engine is property-driven: it never asks what KIND a unit is. A unit is
 * described by `leavesTrail` (occupancy trails the head, and the trail cells
 * are body-walls that can be severed), `traversesEdges` (false for jumps),
 * and a `path` of one cell per sub-step. "Snakes move only in sub-step 1" is
 * not a rule here — it is what a path of length 1 means.
 *
 * ## Frozen state
 *
 * All collision adjudication reads the TIER and WEIGHT each unit held at the
 * START of the turn. Board occupancy changes within the turn only through
 * movement (a trail sweep including the tail pop, a piece stack teleporting)
 * and halting — never through removal. Dead units, exhausted units and severed
 * segments all stay on the board as collision objects until the collision
 * phase (every sub-step) has finished. Energy is the only thing that advances.
 *
 * ## Exhaustion is provisional death
 *
 * Running out of energy mid-turn (movement cost or a hazard dose) stops
 * MOVEMENT and nothing else. The unit halts on the cell it reached and stays a
 * fully live collision incumbent for the rest of the phase: it still beats
 * lighter arrivals on frozen tier and weight, and a heavier arrival can still
 * kill it — which is an ordinary collision death, not an exhaustion one.
 * Whether exhaustion itself kills is decided at END OF TURN by the caller,
 * after the food phase: food is the only refill, and it is eaten at a unit's
 * final cell, so an exhausted unit that halted on food may come back — it
 * lives if the meal's energy carries it above zero, and a meal is worth
 * `foodEnergy`, not a full tank. The engine therefore reports exhaustions
 * rather than acting on them.
 *
 * ## Sub-step loop: snapshot → resolve → apply
 *
 * Each sub-step:
 *   a. every mover advances;
 *   b. every collision event is detected against the post-advance snapshot;
 *   c. every event is adjudicated against that snapshot and the frozen
 *      tier/weight ALONE — no adjudication reads anything a sibling
 *      adjudication wrote, so the outcome is identical under any unit
 *      ordering;
 *   d. the whole batch is applied at once (deaths, fallbacks, capture-stops,
 *      sever registrations, durable-cell registrations);
 *   e. the energy phase runs, strictly after the collisions.
 *
 * Adjudication proceeds in fixed tiers within one sub-step — edge exchanges
 * decide who actually completed a crossing, then walls, then self-collisions,
 * then arrivals, then living bodies. Each tier is a pure function of the
 * snapshot plus the tiers before it, which is what makes the whole sub-step
 * order-independent rather than iteration-order dependent.
 *
 * ## Edge exchanges
 *
 * Two units whose HEADS exchange through the same edge in one sub-step contest
 * that edge. This is uniform across every unit: the only exemption is a jump,
 * which traverses no edge at all. Trails make no difference — the contest is
 * head-to-head and is decided before either head reaches the far side.
 *
 * ## The wrestling rule
 *
 * From the moment a unit dies, its entire remaining occupancy
 * becomes a set of DURABLE cells. Any unit arriving at a durable cell on a
 * later sub-step joins that cell's cumulative contest against every prior
 * participant there, judged on frozen tier and weight. It lives only if it is
 * the unique strict maximum of the whole pile — and then it capture-stops.
 * Otherwise it dies there and joins the pile. A unit that crossed the cell
 * before its first death is untouched by any of it.
 */

export type UnitStatus = "active" | "stopped" | "exhausted" | "dead"

/** One set of display strings. Rendering keys on `kind` and the id lists. */
export const REASON = {
  tier: "Outranked: lower invulnerability tier",
  weight: "Outweighed",
  tie: "Deadlock: no unique survivor",
  bodyBlock: "Ran into a body",
  sever: "Body severed by a higher tier",
  wall: "Hit the wall",
  self: "Ran into its own body",
  hazard: "Drained by a hazard",
  exhaustion: "Ran out of energy",
  regicide: "Team eliminated: king fell",
} as const

export interface EngineUnit {
  id: string
  /** Occupancy trails the head; trail cells are body-walls. */
  leavesTrail: boolean
  /** A jump traverses no edge, so it never contests one. */
  traversesEdges: boolean
  /** Board occupancy at the start of the turn; index 0 is the head. */
  occupancy: number[]
  /** Invulnerability tier, frozen for the whole turn. */
  tier: number
  energy: number
  /** One cell per sub-step, in order. Empty means the unit holds. */
  path: number[]
}

export interface UnitDeathRecord {
  unitID: string
  cell: number
  subStep: number
  cause: ClashKind
}

/**
 * A unit that ran out of energy mid-turn. Exhaustion is PROVISIONAL death: it
 * halts movement and nothing else. Whether it kills is settled at end of turn,
 * after the food phase, by the caller — so this is a report, not a death.
 */
export interface ExhaustionEvent {
  unitID: string
  /** The cell it halted on. */
  cell: number
  subStep: number
  /** "hazard" when a hazard dose finished it, "exhaustion" for movement cost. */
  cause: ClashKind
  /**
   * The halt record already on the wire, carrying an EMPTY victimIDs. If the
   * exhaustion proves fatal the caller adds the unit to it; if food at the
   * halt cell revives the unit, it stays empty and the record simply explains
   * why the unit stopped short.
   */
  record: Clash
}

export interface TurnEngineResult {
  /** Typed events, deterministically ordered. */
  clashes: Clash[]
  /** Units killed outright during the collision phase. Exhaustion is separate. */
  deaths: UnitDeathRecord[]
  /** Units that ran out of energy and halted; fatality is the caller's call. */
  exhaustions: ExhaustionEvent[]
  /** Cells actually cut from each SURVIVING trail unit. */
  severedCells: Map<string, number[]>
  /** Units whose frozen tier was below zero and which died or were severed. */
  vulnerableCollided: Set<string>
  /** Final occupancy per unit: survivors post-truncation, the dead as they lie. */
  occupancy: Map<string, number[]>
  /** Cells each unit actually entered, in order. */
  traversed: Map<string, number[]>
  /** Cell each unit ended on — the death square for anything that died. */
  finalCell: Map<string, number>
  energy: Map<string, number>
}

interface RuntimeUnit extends EngineUnit {
  status: UnitStatus
  /** Weight frozen at the start of the turn. */
  weight: number
  traversed: number[]
  /** Head cell held at the start of the current sub-step, for fallbacks. */
  subStepOrigin: number | null
  /** Segment indices at which this unit's trail was cut, this turn. */
  severCuts: number[]
  death: UnitDeathRecord | null
}

/** One decision produced by adjudication and applied in the batch. */
type Outcome =
  | { op: "fallback"; unit: RuntimeUnit }
  | { op: "kill"; unit: RuntimeUnit; cell: number; cause: ClashKind }
  | { op: "stop"; unit: RuntimeUnit }
  | { op: "durable"; cell: number; unitIDs: string[] }
  | { op: "sever"; owner: RuntimeUnit; cutIndex: number }

const byID = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** Tier first, then frozen weight. At most one unique strict maximum survives. */
const strictMaximum = (participants: RuntimeUnit[]): RuntimeUnit | null => {
  const maxTier = Math.max(...participants.map((u) => u.tier))
  const top = participants.filter((u) => u.tier === maxTier)
  const maxWeight = Math.max(...top.map((u) => u.weight))
  const heaviest = top.filter((u) => u.weight === maxWeight)
  return heaviest.length === 1 ? heaviest[0] : null
}

/** Why the contest ended the way it did — display text only. */
const contestReason = (participants: RuntimeUnit[], survivor: RuntimeUnit | null): string => {
  if (!survivor) return REASON.tie
  const maxTier = Math.max(...participants.map((u) => u.tier))
  return participants.filter((u) => u.tier === maxTier).length > 1 ? REASON.weight : REASON.tier
}

export const runTurnEngine = (
  input: EngineUnit[],
  hazards: number[],
  walls: number[],
  hazardDamage: number,
): TurnEngineResult => {
  const hazardSet = new Set(hazards)
  const wallSet = new Set(walls)
  const clashes: Clash[] = []
  const deaths: UnitDeathRecord[] = []
  const exhaustions: ExhaustionEvent[] = []
  const vulnerableCollided = new Set<string>()

  // Cells that hold collision objects: corpses, and every unit that took part
  // in a fatal contest there. Cumulative for the whole turn. Exhausted units
  // are NOT here — they are still alive, and contest as themselves.
  const durable = new Map<number, Set<string>>()

  const units: RuntimeUnit[] = input
    .map((u) => ({
      ...u,
      occupancy: [...u.occupancy],
      path: [...u.path],
      status: "active" as UnitStatus,
      weight: u.occupancy.length,
      traversed: [] as number[],
      subStepOrigin: null,
      severCuts: [] as number[],
      death: null,
    }))
    .sort(byID)

  const byId = new Map(units.map((u) => [u.id, u]))
  // Exhausted counts as living: it has halted, but it is on the board, it
  // contests, and it may yet be fed back to energy at end of turn.
  const isLiving = (u: RuntimeUnit): boolean => u.status !== "dead"

  const record = (
    kind: ClashKind,
    cell: number,
    playerIDs: string[],
    victimIDs: string[],
    reason: string,
    subStep: number,
    survivorID?: string,
  ): Clash => {
    const clash: Clash = {
      index: cell,
      subStep,
      kind,
      playerIDs: [...playerIDs].sort(),
      victimIDs: [...victimIDs].sort(),
      ...(survivorID ? { survivorID } : {}),
      reason,
    }
    clashes.push(clash)
    return clash
  }

  const addDurable = (cell: number, unitIDs: string[]): void => {
    const pile = durable.get(cell) ?? new Set<string>()
    unitIDs.forEach((id) => pile.add(id))
    durable.set(cell, pile)
  }

  // A death never removes anything from the board: the unit halts where it is
  // and its whole remaining occupancy becomes durable collision objects.
  const kill = (unit: RuntimeUnit, cell: number, cause: ClashKind, subStep: number): void => {
    if (!isLiving(unit)) return
    unit.status = "dead"
    unit.death = { unitID: unit.id, cell, subStep, cause }
    deaths.push(unit.death)
    if (unit.tier < 0) vulnerableCollided.add(unit.id)
    addDurable(cell, [unit.id])
    unit.occupancy.forEach((c) => addDurable(c, [unit.id]))
  }

  const advance = (unit: RuntimeUnit, subStep: number): void => {
    const to = unit.path[subStep - 1]
    unit.subStepOrigin = unit.occupancy[0]
    if (unit.leavesTrail) {
      unit.occupancy.pop()
      unit.occupancy.unshift(to)
    } else {
      unit.occupancy.fill(to)
    }
    unit.traversed.push(to)
  }

  // An edge-contest loser is squashed against its own neck: its head never
  // crossed, so it goes back to the cell it held at the start of the sub-step,
  // and it never gets credited with entering anywhere.
  //
  // The TAIL POP IS NOT UNDONE. Tails depart deterministically — a trail unit
  // shedding its last cell is not conditional on whether a contest happened
  // somewhere ahead of its head. So a swap-losing trail unit's final occupancy
  // is its start-of-turn body MINUS the popped tail cell, which for a length-1
  // unit is nothing at all: it left its cell completely and was squashed
  // against empty space. It still dies at its start-of-sub-step head cell, and
  // that cell is a collision object for the rest of the turn either way.
  const fallback = (unit: RuntimeUnit): void => {
    if (unit.subStepOrigin === null) return
    if (unit.leavesTrail) {
      unit.occupancy.shift()
    } else {
      unit.occupancy.fill(unit.subStepOrigin)
    }
    unit.traversed.pop()
  }

  // Whether a mover contests the edge it just crossed. Uniform for every unit:
  // the only exemption is a jump, which traverses no edge at all. Trails make
  // no difference — the contest is head-to-head, decided before either head
  // can reach the far side.
  const contestsEdge = (unit: RuntimeUnit): boolean =>
    unit.traversesEdges && unit.subStepOrigin !== null

  const maxSubSteps = Math.max(1, ...units.map((u) => u.path.length))

  for (let subStep = 1; subStep <= maxSubSteps; subStep++) {
    // a. Advance every mover with a cell for this sub-step.
    const movers = units.filter((u) => u.status === "active" && u.path.length >= subStep)
    if (movers.length === 0 && subStep > 1) break
    movers.forEach((m) => advance(m, subStep))

    // b + c. Detect and adjudicate everything against the post-advance
    // snapshot, producing a batch of decisions and no board changes.
    const batch: Outcome[] = []
    /** Units this sub-step's adjudication has already condemned. */
    const condemned = new Set<string>()
    /** Units that never completed their crossing and are not at their destination. */
    const blocked = new Set<string>()

    const condemn = (unit: RuntimeUnit, cell: number, cause: ClashKind): void => {
      condemned.add(unit.id)
      batch.push({ op: "kill", unit, cell, cause })
    }

    // c1. In-flight edge exchanges: two units traversing the same edge in
    // opposite directions. Settled before anything else, because they decide
    // who actually arrived anywhere.
    const edgeMovers = movers.filter(contestsEdge)
    for (let i = 0; i < edgeMovers.length; i++) {
      for (let j = i + 1; j < edgeMovers.length; j++) {
        const a = edgeMovers[i]
        const b = edgeMovers[j]
        if (blocked.has(a.id) || blocked.has(b.id)) continue
        if (a.subStepOrigin !== b.occupancy[0] || b.subStepOrigin !== a.occupancy[0]) continue

        const pair = [a, b]
        const winner = strictMaximum(pair)
        const reason = contestReason(pair, winner)
        const ids = [a.id, b.id]
        if (!winner) {
          // Tie: neither crosses. Each is squashed at its own head cell, and
          // each cell gets its own record.
          pair.forEach((u) => {
            blocked.add(u.id)
            batch.push({ op: "fallback", unit: u })
            condemn(u, u.subStepOrigin as number, "edge")
            record("edge", u.subStepOrigin as number, ids, [u.id], reason, subStep)
          })
        } else {
          const loser = winner === a ? b : a
          const cell = loser.subStepOrigin as number
          blocked.add(loser.id)
          batch.push({ op: "fallback", unit: loser })
          condemn(loser, cell, "edge")
          // The winner completes into the loser's head cell and capture-stops.
          // It is the SURVIVOR of that cell, not a fresh arrival at it: the
          // pile it just made there must not be re-adjudicated against it this
          // sub-step. Registering both means later arrivals contest the winner
          // plus the pile, in one cumulative contest, exactly as usual.
          batch.push({ op: "stop", unit: winner })
          batch.push({ op: "durable", cell, unitIDs: ids })
          record("edge", cell, ids, [loser.id], reason, subStep, winner.id)
        }
      }
    }

    const arrived = movers.filter((m) => !blocked.has(m.id) && !condemned.has(m.id))

    // c2. Walls. Piece destinations are grammar-validated, so in practice only
    // trail units reach here — but the engine checks every mover.
    arrived.forEach((m) => {
      if (condemned.has(m.id)) return
      if (!wallSet.has(m.occupancy[0])) return
      condemn(m, m.occupancy[0], "wall")
      record("wall", m.occupancy[0], [m.id], [m.id], REASON.wall, subStep)
    })

    // c3. Self-collision — only a trail unit can run into itself.
    arrived.forEach((m) => {
      if (condemned.has(m.id) || !m.leavesTrail) return
      if (m.occupancy.indexOf(m.occupancy[0], 1) === -1) return
      condemn(m, m.occupancy[0], "self")
      record("self", m.occupancy[0], [m.id], [m.id], REASON.self, subStep)
    })

    // c4. Arrivals: every cell somebody reached is contested by all the
    // head-class units standing there plus everything the cell's pile holds.
    // The participant sets are drawn from the state as the earlier tiers left
    // it, never from what a sibling cell's contest just decided.
    const standingBeforeArrivals = new Set(
      units.filter((u) => isLiving(u) && !condemned.has(u.id) && !blocked.has(u.id)).map((u) => u.id),
    )
    const arrivalCells = Array.from(
      new Set(arrived.filter((m) => !condemned.has(m.id)).map((m) => m.occupancy[0])),
    ).sort((x, y) => x - y)

    arrivalCells.forEach((cell) => {
      const pile = durable.get(cell)
      const standing = units.filter(
        (u) => standingBeforeArrivals.has(u.id) && u.occupancy[0] === cell,
      )
      const participants = [...standing]
      pile?.forEach((id) => {
        const u = byId.get(id)
        if (u && !participants.includes(u)) participants.push(u)
      })
      participants.sort(byID)
      if (participants.length < 2) return

      const survivor = strictMaximum(participants)
      const reason = contestReason(participants, survivor)
      const victims = participants.filter(
        (u) => u !== survivor && standingBeforeArrivals.has(u.id),
      )
      victims.forEach((u) => condemn(u, cell, "contest"))

      record(
        "contest",
        cell,
        participants.map((u) => u.id),
        victims.map((u) => u.id),
        reason,
        subStep,
        survivor && standingBeforeArrivals.has(survivor.id) ? survivor.id : undefined,
      )

      // The cell now holds collision objects for the rest of the turn, and a
      // survivor that arrived here capture-stops.
      batch.push({ op: "durable", cell, unitIDs: participants.map((u) => u.id) })
      if (survivor && standingBeforeArrivals.has(survivor.id)) {
        batch.push({ op: "stop", unit: survivor })
      }
    })

    // c5. Living body/trail cells. Equal-or-lower tier dies on the segment;
    // strictly higher tier severs it and capture-stops. Every owner at the
    // cell is judged together, and "living owner" means living as this tier
    // FOUND the board — so two snakes that run into each other's necks both
    // die, whichever order the roster happens to list them in.
    const ownersAlive = new Set(
      units.filter((u) => isLiving(u) && !condemned.has(u.id)).map((u) => u.id),
    )
    arrived.forEach((m) => {
      if (!ownersAlive.has(m.id)) return
      const cell = m.occupancy[0]
      const owners = units.filter(
        (owner) =>
          owner.id !== m.id &&
          owner.leavesTrail &&
          ownersAlive.has(owner.id) &&
          owner.occupancy.indexOf(cell, 1) !== -1,
      )
      if (owners.length === 0) return

      const maxOwnerTier = Math.max(...owners.map((o) => o.tier))
      if (m.tier <= maxOwnerTier) {
        condemn(m, cell, "bodyBlock")
        record(
          "bodyBlock",
          cell,
          [m.id, ...owners.map((o) => o.id)],
          [m.id],
          REASON.bodyBlock,
          subStep,
          owners.length === 1 ? owners[0].id : undefined,
        )
        batch.push({ op: "durable", cell, unitIDs: [m.id, ...owners.map((o) => o.id)] })
        return
      }

      // Severs are non-fatal: the owner is not a victim, the cut is recorded
      // now and only applied once the collision phase is over.
      owners.forEach((owner) => {
        batch.push({ op: "sever", owner, cutIndex: owner.occupancy.indexOf(cell, 1) })
        if (owner.tier < 0) vulnerableCollided.add(owner.id)
        record("sever", cell, [m.id, owner.id], [], REASON.sever, subStep, m.id)
      })
      batch.push({ op: "stop", unit: m })
    })

    // d. Apply the whole batch at once.
    batch.forEach((outcome) => {
      switch (outcome.op) {
        case "fallback":
          fallback(outcome.unit)
          break
        case "durable":
          addDurable(outcome.cell, outcome.unitIDs)
          break
        case "sever":
          outcome.owner.severCuts.push(outcome.cutIndex)
          break
        default:
          break
      }
    })
    batch.forEach((outcome) => {
      if (outcome.op === "kill") kill(outcome.unit, outcome.cell, outcome.cause, subStep)
    })
    batch.forEach((outcome) => {
      if (outcome.op === "stop" && outcome.unit.status === "active") outcome.unit.status = "stopped"
    })

    // e. Energy, strictly after the collisions. Movement costs one energy per
    // cell entered; each hazard cell entered costs a full dose. A unit that
    // never moves at all pays a single dose for standing on a hazard.
    units.forEach((u) => {
      if (!isLiving(u)) return
      const entered = movers.includes(u) && !blocked.has(u.id)
      const stationary = subStep === 1 && u.path.length === 0
      if (!entered && !stationary) return

      const cell = u.occupancy[0]
      const onHazard = hazardSet.has(cell)
      const cost = (entered ? 1 : 0) + (onHazard ? hazardDamage : 0)
      if (cost === 0) return

      u.energy -= cost
      if (u.energy > 0) return

      // Exhausted: MOVEMENT stops here and nothing else does. It stays on the
      // board as a full collision incumbent — a dying animal that still beats
      // a lighter arrival, and that a heavier arrival can still kill outright
      // (an ordinary collision death, not this one). Whether the exhaustion
      // itself is fatal is settled at end of turn, once food has been eaten,
      // so the record goes out now with an EMPTY victimIDs and the caller
      // fills it in only if the unit is still at zero when the turn closes.
      u.status = "exhausted"
      const cause: ClashKind = onHazard ? "hazard" : "exhaustion"
      const halt = record(
        cause,
        cell,
        [u.id],
        [],
        onHazard ? REASON.hazard : REASON.exhaustion,
        subStep,
      )
      exhaustions.push({ unitID: u.id, cell, subStep, cause, record: halt })
    })

    units.forEach((u) => {
      u.subStepOrigin = null
    })
  }

  // The collision phase is over: only now do severs truncate anything. Several
  // cuts on one owner collapse to the lowest index — the deepest bite wins.
  const severedCells = new Map<string, number[]>()
  units.forEach((u) => {
    if (u.severCuts.length === 0 || !isLiving(u)) return
    const cut = Math.min(...u.severCuts)
    const removed = u.occupancy.slice(cut)
    u.occupancy.length = cut
    severedCells.set(u.id, Array.from(new Set(removed)))
  })

  // `survivorID` is decided from the snapshot, but two units can condemn each
  // other in the SAME sub-step (two snakes running into each other's necks).
  // Nobody is left standing then, so the field is withdrawn rather than
  // pointing at a unit that did not outlive the record.
  const deathSubStep = new Map(deaths.map((d) => [d.unitID, d.subStep]))
  clashes.forEach((clash) => {
    if (!clash.survivorID) return
    const died = deathSubStep.get(clash.survivorID)
    if (died !== undefined && died <= clash.subStep) delete clash.survivorID
  })

  clashes.sort(
    (a, b) =>
      a.subStep - b.subStep ||
      a.index - b.index ||
      (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
      (a.playerIDs.join() < b.playerIDs.join() ? -1 : 1),
  )
  deaths.sort((a, b) => a.subStep - b.subStep || (a.unitID < b.unitID ? -1 : 1))

  const occupancy = new Map<string, number[]>()
  const traversed = new Map<string, number[]>()
  const finalCell = new Map<string, number>()
  const energy = new Map<string, number>()
  units.forEach((u) => {
    occupancy.set(u.id, u.occupancy)
    traversed.set(u.id, u.traversed)
    // A swap-losing length-1 trail unit ends up owning no cells at all: its
    // only cell was the tail it shed. It still died somewhere, and that is the
    // cell the wire must name.
    finalCell.set(u.id, u.occupancy.length > 0 ? u.occupancy[0] : (u.death as UnitDeathRecord).cell)
    energy.set(u.id, u.energy)
  })

  return {
    clashes,
    deaths,
    exhaustions,
    severedCells,
    vulnerableCollided,
    occupancy,
    traversed,
    finalCell,
    energy,
  }
}
