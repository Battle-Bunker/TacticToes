import { UnitType } from "@shared/types/Game"
import { ORTHOGONALS, Orientation, leavesTrail, traversesEdges } from "./moveGrammar"
import { BoardShape, GrammarUnit, actionOf, coverOf, legalTargets } from "./queries"
import { DEFAULT_FOOD_ENERGY, ResolveUnit } from "./resolveTurn"
import { SettleInput } from "./settleTurn"

/**
 * What a unit whose move nobody knows could be doing.
 *
 * A search does not have a staged move for every unit — that is the whole of
 * why it is a search — and `settleTurn` demands one. That is a SHAPE problem,
 * not a rules problem: the turn in which three units' moves are unknown obeys
 * the same rules, run against a set of boards instead of one. So the unknown
 * is described here, in the grammar's own terms, and `settlePartial` settles
 * the turn against it. Nothing in this file decides anything; it only says
 * where a unit could be and how strong it could be, and it says it by asking
 * `queries.ts` — the same `legalTargets`/`pathOf` the server stages with —
 * rather than by writing the grammar a second time. A caller that computes a
 * held unit's reach for itself HAS written the grammar a second time, which is
 * the one thing VENDOR.md exists to prevent. Read `claims`.
 *
 * Everything here OVER-approximates. The only error a caller cannot recover
 * from is one that hides a unit that was really there, so every set is a
 * superset of the truth and every interval contains it. A claim is a pure
 * function of (the held records, the board geometry, the terrain, the items,
 * the effect schedule, the turn span, the narrowing) — of nothing any
 * particular assignment does, which is what makes it hoistable and memoisable
 * by the caller (`settlePartial`'s third parameter).
 */

/** No sub-step ever reaches this cell. The `earliestSubStep` sentinel. */
export const NEVER = 0x7fffffff

/**
 * A unit in `units` whose staged move is NOT known. Its `stagedMove`/`path`
 * are ignored; its occupancy, energy, tier, orientation and type are the
 * OBSERVATION, taken at `observedTurn`.
 */
export interface HeldUnit {
  readonly id: string
  /**
   * The turn its record was observed. `input.turn - observedTurn` is how many
   * turns of unknown movement the claim has to cover; 1 is the common case
   * (a unit on this very board whose choice we are not modelling).
   */
  readonly observedTurn: number
  /**
   * Optional narrowing: the staged destinations this unit is assumed to be
   * choosing among on its FIRST unknown turn. Undefined = every legal one.
   * A narrowing is an ASSUMPTION, echoed on every ledger entry it licensed
   * (`Divergence.narrowed`), so a caller can never mistake it for a proof.
   */
  readonly options?: ReadonlyArray<number>
}

/** `settleTurn`'s input, with some of the roster's moves unknown. */
export interface PartialSettleInput extends SettleInput {
  readonly held: ReadonlyArray<HeldUnit>
}

/**
 * Where one held unit could be, and how strong it could be, at each sub-step
 * of the turn being settled.
 */
export interface Claim {
  readonly id: string
  readonly teamID: string
  /**
   * Kinds it could be. More than one only when a held pawn's weight interval
   * reaches `pawnPromotionWeight` — promotion is the only kind change in the
   * game, and a queen's grammar is not a pawn's.
   */
  readonly kinds: ReadonlyArray<UnitType>
  /** True when any kind it could be drags a trail behind its head. */
  readonly leavesTrail: boolean
  /** True when any kind it could be crosses edges, so could contest one. */
  readonly traversesEdges: boolean
  /**
   * Head cells it could occupy, per sub-step of the settled turn. Index 0 is
   * the board as the turn OPENS — identical to the observed head when the
   * span is 1, and a dilated set when the unit was observed earlier.
   * Cumulative: a unit stopped short of its ray stays where it was stopped, so
   * `headPossible[k] ⊇ headPossible[k - 1]`.
   */
  readonly headPossible: ReadonlyArray<ReadonlyArray<number>>
  /** Trail cells it could occupy, per sub-step. Empty for a unit with no trail. */
  readonly bodyPossible: ReadonlyArray<ReadonlyArray<number>>
  /**
   * Every cell any part of it could have held at any point over the whole
   * span — the set a corpse pile could be sitting on, and the set an item it
   * could already have taken lies in.
   */
  readonly everPossible: ReadonlyArray<number>
  /**
   * Cells it occupies in EVERY world in which it is still alive AND has not
   * been severed — the neck argument: a trail unit's `occupancy[0 .. len-2]`
   * is occupied whatever it chooses, because it must step and its body
   * follows. Read it with `deathPossible` and the ledger's `sever` entries in
   * hand: both are the conditions this set is conditional on.
   */
  readonly certainIfAlive: ReadonlyArray<number>
  /**
   * Earliest sub-step at which its head can reach a cell; `NEVER` elsewhere.
   * This is what gates an entanglement in time.
   */
  readonly earliestSubStep: Int32Array
  /**
   * Frozen strength interval — the only two coordinates a contest reads
   * (`outranks`). Weight moves by eating, by being severed and by promoting;
   * tier moves by a potion this unit or one of its team could already have
   * taken, and by an effect of `input.effects` lapsing.
   */
  readonly weightMin: number
  readonly weightMax: number
  readonly tierMin: number
  readonly tierMax: number
  /**
   * The scalar tier it carries into THIS turn's adjudication if nothing it
   * could reach moved it — `record.tier` with every effect of `input.effects`
   * that lapses before this turn given back.
   */
  readonly tierAtArrival: number
  /** The most energy it could be carrying, for a caller pricing an exchange. */
  readonly energyMax: number
  /** It is dead in every world (it was walled in, or it had no energy left). */
  readonly certainlyGone: boolean
  /**
   * It could be dead — from terrain, exhaustion, its own body, a modelled
   * unit or another CLAIM. The last is why claims are computed as a set
   * rather than one at a time: two claims whose grammars overlap can kill
   * each other, and a tie kills both.
   */
  readonly deathPossible: boolean
  /** It could be severed, which is what makes `certainIfAlive` conditional. */
  readonly severPossible: boolean
  /** True when a caller's `options` narrowing was applied to this claim. */
  readonly narrowed: boolean
}

/** A dilation state: where the head is, and which way a pawn is facing. */
interface State {
  readonly cell: number
  /** Index into `ORTHOGONALS`. Only a pawn's grammar reads it. */
  readonly ori: number
}

const keyOf = (s: State): number => s.cell * 4 + s.ori
const sorted = (cells: Iterable<number>): number[] =>
  Array.from(new Set(cells)).sort((a, b) => a - b)

/** The nearest legal orientation index for a facing the record carries. */
const oriIndex = (orientation: Orientation): number => {
  const i = ORTHOGONALS.findIndex(
    (o) => o.dx === Math.sign(orientation.dx) && o.dy === Math.sign(orientation.dy),
  )
  return i === -1 ? 0 : i
}

/** The board every query is asked against: terrain, bodies and food. */
const shapeOf = (input: SettleInput): BoardShape => ({
  boardWidth: input.boardWidth,
  boardHeight: input.boardHeight,
  walls: input.walls,
  hazards: input.hazards,
  occupancy: input.units.map((u) => ({ id: u.id, cells: u.occupancy })),
  food: input.food,
})

/**
 * The board a claim's SECOND and later unknown turns are asked against.
 *
 * A pawn's diagonal is legal only onto food or a body, and after one unknown
 * turn nobody knows where the bodies are. Every cell is therefore treated as
 * a pawn target from the second step on: an over-approximation, which is the
 * only direction a claim is allowed to be wrong in. Nothing else in the
 * grammar reads the board's contents.
 */
const permissiveShapeOf = (shape: BoardShape): BoardShape => {
  const cells = shape.boardWidth * shape.boardHeight
  const food: number[] = []
  for (let cell = 0; cell < cells; cell++) food.push(cell)
  return { ...shape, food }
}

/** One legal continuation from a state: where it ends, what it walks, how it faces. */
interface Step {
  readonly to: number
  readonly path: ReadonlyArray<number>
  readonly ori: number
}

const stepsFrom = (
  type: UnitType,
  state: State,
  shape: BoardShape,
  options: ReadonlyArray<number> | undefined,
): Step[] => {
  const unit: GrammarUnit = {
    type,
    occupancy: [state.cell],
    orientation: ORTHOGONALS[state.ori],
  }
  const targets = options
    ? legalTargets(unit, shape).filter((t) => options.includes(t))
    : legalTargets(unit, shape)
  const steps: Step[] = []
  targets.forEach((target) => {
    const action = actionOf(unit, target, shape)
    if (!action) return
    if (action.kind === "move") {
      steps.push({ to: action.path[action.path.length - 1], path: action.path, ori: state.ori })
      return
    }
    if (action.kind === "rotate") {
      steps.push({ to: state.cell, path: [], ori: oriIndex(action.orientation) })
      return
    }
    steps.push({ to: state.cell, path: [], ori: state.ori })
  })
  return steps
}

/** Everything one claim's reach is built out of, before the danger pass. */
interface Reach {
  readonly held: HeldUnit
  readonly record: ResolveUnit
  readonly span: number
  readonly kinds: UnitType[]
  /** Head sets at the end of each unknown turn BEFORE the settled one. */
  readonly turnHeads: number[][]
  readonly headPossible: number[][]
  readonly everHead: Set<number>
  /** First-turn destinations that kill on terrain alone, and how many there were. */
  readonly fatalFirst: number
  readonly totalFirst: number
  /** The longest ray any kind it could be may walk in one turn. */
  readonly longestPath: number
}

/**
 * How many sub-steps the settled turn can run to. The live units' staged
 * paths set it, and so does the longest ray a claim could be walking — a
 * claim's slider can still be crossing the board after every modelled unit
 * has stopped, and a contest at that sub-step is as real as any other.
 */
const subStepsOf = (input: PartialSettleInput, held: Set<string>, shape: BoardShape): number => {
  // The longest ray the interior admits: a slider crossing it corner to corner
  // walks one cell per sub-step. A held slider is priced at that rather than
  // at the ray it happens to have from where it was observed, because over a
  // span longer than a turn it is somewhere else by the time it walks one.
  const longestRay = Math.max(shape.boardWidth, shape.boardHeight) - 3
  let steps = 1
  input.units.forEach((u) => {
    if (held.has(u.id)) {
      // A pawn is the only kind that can become another one, so it is the only
      // kind whose reach is not settled by the kind it is now.
      const slides =
        u.type === "rook" || u.type === "bishop" || u.type === "queen" || u.type === "pawn"
      steps = Math.max(steps, slides ? longestRay : 1)
      return
    }
    steps = Math.max(steps, u.path?.length ?? 0)
    const unit: GrammarUnit = { type: u.type, occupancy: u.occupancy, orientation: u.orientation }
    if (u.stagedMove !== undefined) {
      const action = actionOf(unit, u.stagedMove, shape)
      if (action?.kind === "move") steps = Math.max(steps, action.path.length)
    }
  })
  return steps
}

/**
 * Every held unit's claim, computed together.
 *
 * Together, because the last half of `deathPossible` is a question about
 * PAIRS: two claims whose grammars overlap can kill each other, and a claim
 * that only another claim could have killed is exactly the world a ceiling
 * computed one unit at a time leaves out.
 */
export const computeClaims = (input: PartialSettleInput): ReadonlyArray<Claim> => {
  const heldIds = new Set(input.held.map((h) => h.id))
  const shape = shapeOf(input)
  const permissive = permissiveShapeOf(shape)
  const subSteps = subStepsOf(input, heldIds, shape)
  const cells = input.boardWidth * input.boardHeight
  const wallSet = new Set(input.walls)
  const byId = new Map(input.units.map((u) => [u.id, u]))

  const reaches: Reach[] = []
  input.held.forEach((held) => {
    const record = byId.get(held.id)
    if (!record) return
    reaches.push(reachOf(held, record, input, shape, permissive, subSteps, wallSet))
  })

  // The danger pass. A claim can be killed by terrain it chose, by a modelled
  // unit that could reach it, or by another claim — and the third is only
  // answerable here, with every claim of the turn in hand.
  const liveCover = new Set<number>()
  input.units.forEach((u) => {
    if (heldIds.has(u.id)) return
    coverOf({ type: u.type, occupancy: u.occupancy, orientation: u.orientation }, shape)
      .forEach((cell) => liveCover.add(cell))
    u.occupancy.forEach((cell) => liveCover.add(cell))
  })

  return reaches.map((reach) => {
    const others = new Set<number>()
    reaches.forEach((other) => {
      if (other === reach) return
      other.everHead.forEach((cell) => others.add(cell))
    })
    return claimOf(reach, input, cells, liveCover, others, subSteps)
  })
}

/** One held unit's reach, dilated turn by turn from its observation. */
const reachOf = (
  held: HeldUnit,
  record: ResolveUnit,
  input: PartialSettleInput,
  shape: BoardShape,
  permissive: BoardShape,
  subSteps: number,
  wallSet: Set<number>,
): Reach => {
  const span = Math.max(1, input.turn - held.observedTurn)
  const kinds: UnitType[] = [record.type]
  const weightCeiling = record.occupancy.length + span
  if (record.type === "pawn" && weightCeiling >= input.pawnPromotionWeight) kinds.push("queen")

  const start: State = { cell: record.occupancy[0], ori: oriIndex(record.orientation) }
  // The cells a trail unit's own step would land it inside itself. The TAIL is
  // not one of them: it departs deterministically as the head arrives, so
  // stepping onto it is a legal, survivable move — unless the unit grew this
  // turn and its last cell is doubled, in which case the doubled copy is still
  // standing there when the head arrives. `occupancy[0 .. len-2]` says both at
  // once, and it is the same set the neck argument is built from.
  const selfFatal = new Set(record.occupancy.slice(0, record.occupancy.length - 1))

  // How many of the first turn's choices kill on terrain alone: a trail unit
  // may legally stage the perimeter, and it may legally stage its own neck.
  let fatalFirst = 0
  let totalFirst = 0
  let longestPath = 1
  kinds.forEach((type) => {
    stepsFrom(type, start, shape, held.options).forEach((step) => {
      totalFirst++
      longestPath = Math.max(longestPath, step.path.length)
      if (wallSet.has(step.to) || (leavesTrail(type) && selfFatal.has(step.to))) fatalFirst++
    })
  })

  // Dilation. Each kind it could be runs its own track and the reach is the
  // union: promotion is a rule, and a queen's grammar is not a pawn's.
  let states = new Map<number, State>([[keyOf(start), start]])
  const turnHeads: number[][] = [[start.cell]]
  const everHead = new Set<number>([start.cell])

  for (let turn = 1; turn < span; turn++) {
    const next = new Map<number, State>()
    const board = turn === 1 ? shape : permissive
    const options = turn === 1 ? held.options : undefined
    states.forEach((state) => {
      kinds.forEach((type) => {
        stepsFrom(type, state, board, options).forEach((step) => {
          const to: State = { cell: step.to, ori: step.ori }
          next.set(keyOf(to), to)
          step.path.forEach((cell) => everHead.add(cell))
        })
      })
    })
    states = next.size > 0 ? next : states
    const heads = sorted(Array.from(states.values()).map((s) => s.cell))
    turnHeads.push(heads)
    heads.forEach((cell) => everHead.add(cell))
  }

  // The settled turn, sub-step by sub-step. A unit stopped short of its ray
  // stays where it was stopped, so the sets are cumulative — which is also
  // exactly what "it may simply have held" means.
  const board = span === 1 ? shape : permissive
  const options = span === 1 ? held.options : undefined
  const headPossible: number[][] = [sorted(Array.from(states.values()).map((s) => s.cell))]
  const perStep: Set<number>[] = []
  for (let k = 0; k < subSteps; k++) perStep.push(new Set<number>())
  states.forEach((state) => {
    kinds.forEach((type) => {
      stepsFrom(type, state, board, options).forEach((step) => {
        step.path.forEach((cell, i) => {
          if (i < subSteps) perStep[i].add(cell)
        })
      })
    })
  })
  for (let k = 1; k <= subSteps; k++) {
    const union = new Set(headPossible[k - 1])
    perStep[k - 1].forEach((cell) => union.add(cell))
    headPossible.push(sorted(union))
  }
  headPossible[headPossible.length - 1].forEach((cell) => everHead.add(cell))
  headPossible.forEach((set) => set.forEach((cell) => everHead.add(cell)))

  return {
    held,
    record,
    span,
    kinds,
    turnHeads,
    headPossible,
    everHead,
    fatalFirst,
    totalFirst,
    longestPath,
  }
}

/** The claim itself: the reach, plus the intervals and the two survival flags. */
const claimOf = (
  reach: Reach,
  input: PartialSettleInput,
  cells: number,
  liveCover: Set<number>,
  otherClaims: Set<number>,
  subSteps: number,
): Claim => {
  const { record, span, kinds, headPossible, everHead } = reach
  const trail = kinds.some((k) => leavesTrail(k))
  const length = record.occupancy.length

  // Weight. Eating is the only way up (one meal per turn at most, and only as
  // many as there are meals in reach); a sever and a promotion are the two
  // ways down, and both can take it to one. A meal only grows the eater when
  // it FILLS it, so the meals it could take are a ceiling on the lengths it
  // could gain rather than a count of them — which is the direction a claim
  // is allowed to be wrong in.
  const foodInReach = input.food.filter((cell) => everHead.has(cell)).length
  const meals = Math.min(span, foodInReach)
  const weightMax = length + meals
  const promotionPossible = record.type === "pawn" && weightMax >= input.pawnPromotionWeight

  // The body, turn by turn: segment j at turn n was the head of turn n - j, so
  // the set is the last len-1 head fronts plus the record's kept suffix.
  const bodyAt = (elapsed: number): number[] => {
    if (!trail) return []
    if (elapsed <= 0) return sorted(record.occupancy.slice(1))
    const out = new Set<number>()
    for (let i = 1; i < elapsed && i < reach.turnHeads.length; i++) {
      reach.turnHeads[i].forEach((cell) => out.add(cell))
    }
    record.occupancy.slice(0, Math.max(0, weightMax - elapsed)).forEach((cell) => out.add(cell))
    return sorted(out)
  }
  const bodyOpen = bodyAt(span - 1)
  const bodyMoved = bodyAt(span)
  const bodyAfter = sorted([...bodyOpen, ...bodyMoved])
  const bodyPossible: number[][] = [bodyOpen]
  for (let k = 1; k <= subSteps; k++) bodyPossible.push(bodyAfter)

  const everPossible = sorted([...everHead, ...bodyOpen, ...bodyMoved, ...record.occupancy])

  // Could anything have reached it? Modelled units answer with their cover;
  // the other claims answer with theirs, which is why claims are a set.
  const reachable =
    everPossible.some((cell) => liveCover.has(cell)) ||
    everPossible.some((cell) => otherClaims.has(cell))
  const severPossible = trail && reachable

  // Certainty, and the two things it is conditional on. A trail unit must
  // step and its body follows, so everything but the tail it sheds is still
  // there — in every world where it neither died nor was cut. A piece may
  // always hold, and may always leave, so nothing about it is certain at all.
  const certainIfAlive = trail ? sorted(record.occupancy.slice(0, Math.max(0, length - span))) : []

  // Energy. A meal is `foodEnergy` ADDED and clamped to the kind's max, not a
  // free refill to it, so the ceiling is what it was observed with plus every
  // meal it could take, held down by the biggest maximum any kind it could be
  // is allowed. Energy never rises any other way, and a record carrying more
  // than that maximum already (a kind whose max was lowered under it) still
  // has what it has — hence the floor at `record.energy`.
  const defaultMax = input.defaultMaxEnergy ?? 100
  const kindMax = Math.max(...kinds.map((k) => input.maxEnergy?.[k] ?? defaultMax))
  const foodEnergy = input.foodEnergy ?? DEFAULT_FOOD_ENERGY
  const energyMax = Math.max(record.energy, Math.min(kindMax, record.energy + meals * foodEnergy))

  // Tier. Only two things move it: an effect of the schedule lapsing before
  // this turn, which is arithmetic the caller cannot be asked to redo, and a
  // potion this unit or one of its team could already have taken. A potion
  // taken on the move resolved at turn U first governs a contest at U+1, so
  // nothing taken during the settled turn is in force for it.
  let tierAtArrival = record.tier
  input.effects.forEach((effect) => {
    if (effect.playerID !== record.id) return
    if (effect.expiryTurn >= input.turn) return
    if (effect.expiryTurn < reach.held.observedTurn) return
    tierAtArrival -= effect.level
  })
  const potionTurns = input.potionsEnabled
    ? Math.min(span - 1, input.potionWindowTurns, input.potions.length)
    : 0
  const potionsInReach = input.potions.filter((cell) => everHead.has(cell)).length
  const allies = input.units.filter(
    (u) => u.id !== record.id && u.teamID === record.teamID,
  ).length
  // The interval covers BOTH readings of the record's own tier — the one the
  // lapse above derives and the one the caller handed in. They differ only
  // when the span is longer than a turn, and then only because the caller may
  // already have lapsed the schedule itself; a claim that picked one of the
  // two would be sound only for callers that agreed with it.
  const floor = Math.min(record.tier, tierAtArrival)
  const ceiling = Math.max(record.tier, tierAtArrival)
  const tierMin = floor - Math.min(potionTurns, potionsInReach)
  const tierMax = ceiling + (allies > 0 ? potionTurns : 0)

  // Death. `certainlyGone` is a PROOF and is claimed only where one exists:
  // every choice it had walks into terrain that kills, or it had no energy
  // left to spend and nothing to eat. `deathPossible` is the opposite
  // conservatism — anything unproven is possible.
  const walledIn = reach.totalFirst > 0 && reach.fatalFirst === reach.totalFirst
  const starved = record.energy <= 0 || (trail && record.energy <= span && foodInReach === 0)
  const certainlyGone = walledIn || starved
  // The energy it could spend: a cell entered costs one, and a hazard cell
  // entered costs a whole dose — and a unit standing still on a hazard pays
  // one anyway. Nothing here proves an exhaustion fatal; it only refuses to
  // prove it impossible.
  const hazardInReach = input.hazards.some((cell) => everPossible.includes(cell))
  const perCell = 1 + (hazardInReach ? input.hazardDamage : 0)
  const couldExhaust = record.energy <= span * reach.longestPath * perCell
  // Regicide is a team verdict off one unit's death, so a unit that plays
  // under it can be taken off the board by a king it never met.
  const underRegicide = (input.regicideTeamIDs ?? []).includes(record.teamID)
  const deathPossible =
    certainlyGone || reach.fatalFirst > 0 || reachable || couldExhaust || underRegicide

  const earliestSubStep = new Int32Array(cells).fill(NEVER)
  headPossible.forEach((set, k) => {
    set.forEach((cell) => {
      if (cell >= 0 && cell < cells && earliestSubStep[cell] === NEVER) earliestSubStep[cell] = k
    })
  })

  return {
    id: record.id,
    teamID: record.teamID,
    kinds,
    leavesTrail: trail,
    traversesEdges: kinds.some((k) => traversesEdges(k)),
    headPossible,
    bodyPossible,
    everPossible,
    certainIfAlive,
    earliestSubStep,
    weightMin: severPossible || promotionPossible ? 1 : length,
    weightMax,
    tierMin,
    tierMax,
    tierAtArrival,
    energyMax,
    certainlyGone,
    deathPossible,
    severPossible,
    narrowed: reach.held.options !== undefined,
  }
}
