import { UnitType } from "@shared/types/Game"
import {
  ORTHOGONALS,
  Orientation,
  leavesTrail,
  readsFacingAndContents,
  traversesEdges,
} from "./moveGrammar"
import {
  BoardShape,
  GrammarUnit,
  actionOf,
  coverOf,
  legalActions,
  pawnTargetsOf,
} from "./queries"
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
   * unit or another CLAIM, or from the fall of its team's king. The middle
   * one is why claims are computed as a set rather than one at a time: two
   * claims whose grammars overlap can kill each other, and a tie kills both.
   */
  readonly deathPossible: boolean
  /**
   * `deathPossible` WITHOUT the regicide cascade — this unit's own peril,
   * from terrain, exhaustion, its own body, a modelled unit or another claim.
   */
  readonly selfDeathPossible: boolean
  /**
   * The king whose fall would take this unit off the board under regicide, or
   * null when there is no such king to name: the unit is itself a king, its
   * team plays no regicide, or no king of its team could fall. Null ALSO when
   * the team plays regicide with no king left on the roster — that team is
   * lost outright when the turn resolves, `deathPossible` says so on its own,
   * and there is no shot for a caller to price.
   *
   * Not-null is exactly the condition `deathPossible` adds to
   * `selfDeathPossible`, so a caller pricing a shot at a king reads this to
   * find out whose roster is riding on it — and a caller looking at a claim
   * that is only possibly-dead by cascade sees that in
   * `!selfDeathPossible && regicideKingId !== null`.
   *
   * A HELD king's peril is settled here, by its own claim. A MODELLED king's
   * is not — `claims.ts` settles nothing — so it is left conservative and
   * `settlePartial` discharges it against the king's `fate`.
   */
  readonly regicideKingId: string | null
  /** It could be severed, which is what makes `certainIfAlive` conditional. */
  readonly severPossible: boolean
  /** True when a caller's `options` narrowing was applied to this claim. */
  readonly narrowed: boolean
}

/**
 * A dilation state — where the head is, and which way a pawn is facing —
 * carried as ONE NUMBER: `cell * 4 + ori`, `ori` an index into `ORTHOGONALS`
 * (only a pawn's grammar reads it). The frontier is tens of thousands of
 * these per call and a pair of them per transition was an object each, which
 * is the module's largest remaining source of garbage; the cell is `key >> 2`
 * and the facing `key & 3`, and neither allocates.
 */
const keyOf = (cell: number, ori: number): number => cell * 4 + ori

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

/**
 * A board the grammar is asked about, WITH the one set the asking costs.
 *
 * `queries.ts::pawnTargetsOf` is a sweep of the board's food and every body on
 * it, and the dilation below asks the grammar once per reachable state per
 * kind per unknown turn — tens of thousands of times against two boards that
 * never change. Rebuilding the set inside each of those calls was 22% of this
 * module's profile, and against the permissive shape, whose `food` is every
 * cell, each rebuild is a set the size of the board.
 *
 * The two travel together because a set built from one board and handed down
 * beside another is a lie about where the bodies are: the only way to hold
 * one is to hold the board it came from.
 */
interface Ground {
  readonly shape: BoardShape
  readonly pawnTargets: ReadonlySet<number>
  /**
   * The grammar's answer for a state, remembered for the length of the call —
   * for the ONE KIND whose answer depends on this board and on the facing.
   *
   * A step out of `(cell, facing)` is a pure function of the kind, the state
   * and the board, and `legalActions` answers it with a full board sweep. The
   * dilation asks it once per state per kind per unknown turn, per HELD UNIT,
   * and the state sets of several held units over the same board overlap
   * almost completely by the second turn — so the answer is remembered rather
   * than recomputed. Keyed the way the dilation keys a state (`keyOf`), under
   * the kind. It belongs to the Ground because the answer does: a board and
   * the steps it admits travel together, exactly as its pawn targets do.
   */
  readonly facing: Map<UnitType, Map<number, ReadonlyArray<Step>>>
  /**
   * The same, for every kind whose answer depends on NEITHER the facing nor
   * the board's contents (`moveGrammar.ts::readsFacingAndContents`) — keyed by
   * the cell alone, and shared with the call's other board, because a rook's
   * moves off a square are a rook's moves off that square whichever way it is
   * turned and whichever of the two boards is asking.
   */
  readonly blind: Map<UnitType, Map<number, ReadonlyArray<Step>>>
}

const groundOf = (
  shape: BoardShape,
  blind: Map<UnitType, Map<number, ReadonlyArray<Step>>>,
): Ground => ({
  shape,
  pawnTargets: pawnTargetsOf(shape),
  facing: new Map(),
  blind,
})

/** One legal continuation from a state: where it ends, what it walks, how it faces. */
interface Step {
  readonly to: number
  readonly path: ReadonlyArray<number>
  /**
   * The facing it ends in, or -1 when the step leaves the facing alone — which
   * every step but a pawn's turn does. Held as "unchanged" rather than as the
   * facing it came from so that an answer can be remembered for a kind that
   * never reads a facing at all.
   */
  readonly ori: number
  /** The cell staged to reach it — what a caller's `options` narrowing names. */
  readonly target: number
}

/** `Step.ori` for a step that leaves the unit facing the way it already was. */
const ORI_UNCHANGED = -1

/**
 * The flag arrays a dilation runs on, allocated once for the whole call.
 *
 * Every set the dilation keeps is a set of board cells or of dilation states,
 * both of which are small dense integers, so each is a flag per index rather
 * than a hash — and each is cleared and reused by the next held unit instead
 * of allocated again. `seen` is the reach under construction, `front` the head
 * front of one horizon, `mark` the frontier's membership.
 */
interface Scratch {
  readonly seen: Uint8Array
  readonly front: Uint8Array
  readonly mark: Uint8Array
}

/** A step that walks nowhere — a hold, or a pawn's turn — shares one path. */
const EMPTY_PATH: ReadonlyArray<number> = []

/** Every step the grammar admits out of this state, narrowing not yet applied. */
const allStepsFrom = (type: UnitType, cell: number, ori: number, ground: Ground): Step[] => {
  const unit: GrammarUnit = { type, occupancy: [cell], orientation: ORTHOGONALS[ori] }
  const steps: Step[] = []
  const legal = legalActions(unit, ground.shape, ground.pawnTargets)
  for (let i = 0; i < legal.length; i++) {
    const { target, action } = legal[i]
    if (action.kind === "move") {
      const path = action.path
      steps.push({ to: path[path.length - 1], path, ori: ORI_UNCHANGED, target })
    } else if (action.kind === "rotate") {
      steps.push({ to: cell, path: EMPTY_PATH, ori: oriIndex(action.orientation), target })
    } else {
      steps.push({ to: cell, path: EMPTY_PATH, ori: ORI_UNCHANGED, target })
    }
  }
  return steps
}

const stepsFrom = (
  type: UnitType,
  cell: number,
  ori: number,
  ground: Ground,
  options: ReadonlyArray<number> | undefined,
): ReadonlyArray<Step> => {
  // What the answer depends on is what it is remembered by: the pawn's is keyed
  // by the facing and held per board, every other kind's by the cell alone.
  const reads = readsFacingAndContents(type)
  const memo = reads ? ground.facing : ground.blind
  let byState = memo.get(type)
  if (byState === undefined) {
    byState = new Map()
    memo.set(type, byState)
  }
  const key = reads ? keyOf(cell, ori) : cell
  let steps = byState.get(key)
  if (steps === undefined) {
    steps = allStepsFrom(type, cell, ori, ground)
    byState.set(key, steps)
  }
  // The narrowing is a caller's, not the board's, so it is applied to the
  // remembered answer rather than baked into it.
  return options === undefined ? steps : steps.filter((step) => options.includes(step.target))
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
  /** Earliest sub-step each cell is reachable at — the horizons, inverted. */
  readonly earliestSubStep: Int32Array
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
const subStepsOf = (input: PartialSettleInput, held: Set<string>, ground: Ground): number => {
  // The longest ray the interior admits: a slider crossing it corner to corner
  // walks one cell per sub-step. A held slider is priced at that rather than
  // at the ray it happens to have from where it was observed, because over a
  // span longer than a turn it is somewhere else by the time it walks one.
  const longestRay = Math.max(ground.shape.boardWidth, ground.shape.boardHeight) - 3
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
      const action = actionOf(unit, u.stagedMove, ground.shape, ground.pawnTargets)
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
  // Both boards, and both pawn-target sets, built ONCE for the whole call:
  // everything below asks the grammar about one of these two and nothing else.
  const blind: Map<UnitType, Map<number, ReadonlyArray<Step>>> = new Map()
  const real = groundOf(shapeOf(input), blind)
  const permissive = groundOf(permissiveShapeOf(real.shape), blind)
  const subSteps = subStepsOf(input, heldIds, real)
  const wallSet = new Set(input.walls)
  const byId = new Map(input.units.map((u) => [u.id, u]))
  const cells = input.boardWidth * input.boardHeight
  const scratch: Scratch = {
    seen: new Uint8Array(cells),
    front: new Uint8Array(cells),
    mark: new Uint8Array(cells * 4),
  }

  const reaches: Reach[] = []
  input.held.forEach((held) => {
    const record = byId.get(held.id)
    if (!record) return
    reaches.push(reachOf(held, record, input, real, permissive, subSteps, wallSet, scratch))
  })

  // The danger pass. A claim can be killed by terrain it chose, by a modelled
  // unit that could reach it, or by another claim — and the third is only
  // answerable here, with every claim of the turn in hand.
  const liveCover = new Set<number>()
  input.units.forEach((u) => {
    if (heldIds.has(u.id)) return
    coverOf(
      { type: u.type, occupancy: u.occupancy, orientation: u.orientation },
      real.shape,
      real.pawnTargets,
    ).forEach((cell) => liveCover.add(cell))
    u.occupancy.forEach((cell) => liveCover.add(cell))
  })

  const claims = reaches.map((reach) => {
    const others = new Set<number>()
    reaches.forEach((other) => {
      if (other === reach) return
      other.everHead.forEach((cell) => others.add(cell))
    })
    return claimOf(reach, input, liveCover, others, subSteps)
  })
  return foldRegicide(input, claims, byId)
}

/**
 * The regicide cascade, folded onto the claims that could actually suffer it.
 *
 * Regicide is a team verdict off one unit's death, so a unit that plays under
 * it can be taken off the board by a king it never met — BUT ONLY BY A KING
 * THAT COULD FALL. Charging every unit of every king-bearing team with a
 * possible death, unconditionally, is sound and useless: it says the same
 * thing about the plan that takes a shot at the king and the plan that walks
 * away from it, and a caller folding material out of `deathPossible` cannot
 * tell those two apart at all. The condition is the king's own peril, and it
 * is cheap: `selfDeathPossible` is exactly `deathPossible` with this cascade
 * taken out, so asking it of the king is not circular.
 *
 * A HELD king answers here, from its own claim. A MODELLED king does not —
 * nothing in this file settles a turn — so it is treated as able to fall and
 * `settlePartial` discharges it against the king's settled `fate`.
 */
const foldRegicide = (
  input: PartialSettleInput,
  claims: ReadonlyArray<Claim>,
  byId: Map<string, ResolveUnit>,
): ReadonlyArray<Claim> => {
  const regicide = new Set(input.regicideTeamIDs ?? [])
  if (regicide.size === 0) return claims
  const claimById = new Map(claims.map((claim) => [claim.id, claim]))
  return claims.map((claim) => {
    const record = byId.get(claim.id)
    if (!record || record.isKing || !regicide.has(claim.teamID)) return claim
    const kings = input.units.filter((u) => u.isKing && u.teamID === claim.teamID)
    // A team configured for regicide with no king left on the roster loses
    // every remaining unit the moment this turn resolves. There is no king to
    // name and no shot to price: the loss is unconditional.
    if (kings.length === 0) return { ...claim, deathPossible: true }
    const king = kings.find((u) => claimById.get(u.id)?.selfDeathPossible ?? true)
    if (king === undefined) return claim
    return { ...claim, deathPossible: true, regicideKingId: king.id }
  })
}

/** One held unit's reach, dilated turn by turn from its observation. */
const reachOf = (
  held: HeldUnit,
  record: ResolveUnit,
  input: PartialSettleInput,
  real: Ground,
  permissive: Ground,
  subSteps: number,
  wallSet: Set<number>,
  scratch: Scratch,
): Reach => {
  const span = Math.max(1, input.turn - held.observedTurn)
  const kinds: UnitType[] = [record.type]
  const weightCeiling = record.occupancy.length + span
  if (record.type === "pawn" && weightCeiling >= input.pawnPromotionWeight) kinds.push("queen")

  const startCell = record.occupancy[0]
  const startOri = oriIndex(record.orientation)
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
  for (const type of kinds) {
    const trail = leavesTrail(type)
    for (const step of stepsFrom(type, startCell, startOri, real, held.options)) {
      totalFirst++
      if (step.path.length > longestPath) longestPath = step.path.length
      if (wallSet.has(step.to) || (trail && selfFatal.has(step.to))) fatalFirst++
    }
  }

  // Every set below is a set of BOARD CELLS or of dilation states, so it is a
  // flag per index rather than a hash. Read out in ascending cell order, a
  // flag array yields the sorted, de-duplicated array these sets are wanted as
  // — the `sorted` call that used to build each of them was a Set, an
  // Array.from and a comparison sort per horizon per held unit. The arrays
  // belong to the CALL, not to this unit: each is cleared as it is drained.
  const cellCount = real.shape.boardWidth * real.shape.boardHeight
  const { seen, front, mark } = scratch
  seen.fill(0)

  // Dilation. Each kind it could be runs its own track and the reach is the
  // union: promotion is a rule, and a queen's grammar is not a pawn's.
  let states: number[] = [keyOf(startCell, startOri)]
  const turnHeads: number[][] = [[startCell]]
  seen[startCell] = 1

  for (let turn = 1; turn < span; turn++) {
    const next: number[] = []
    const board = turn === 1 ? real : permissive
    const options = turn === 1 ? held.options : undefined
    for (let s = 0; s < states.length; s++) {
      const key = states[s]
      const cell = key >> 2
      const ori = key & 3
      for (let t = 0; t < kinds.length; t++) {
        const steps = stepsFrom(kinds[t], cell, ori, board, options)
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]
          const to = keyOf(step.to, step.ori === ORI_UNCHANGED ? ori : step.ori)
          if (mark[to] === 0) {
            mark[to] = 1
            next.push(to)
          }
          const path = step.path
          for (let j = 0; j < path.length; j++) seen[path[j]] = 1
        }
      }
    }
    for (let i = 0; i < next.length; i++) mark[next[i]] = 0
    if (next.length > 0) states = next
    const heads = headsOf(states, front)
    turnHeads.push(heads)
    for (let i = 0; i < heads.length; i++) seen[heads[i]] = 1
  }

  // The settled turn, sub-step by sub-step. A unit stopped short of its ray
  // stays where it was stopped, so the sets are cumulative — which is also
  // exactly what "it may simply have held" means. Cumulative is the whole of
  // what they say, so what is recorded is the EARLIEST sub-step each cell is
  // reachable at, and the horizons are read off that: `headPossible[k]` is the
  // cells whose earliest is at most k, which is also `earliestSubStep` itself
  // and is no longer derived a second time by the claim.
  const board = span === 1 ? real : permissive
  const options = span === 1 ? held.options : undefined
  const heads = headsOf(states, front)
  const earliestSubStep = new Int32Array(cellCount).fill(NEVER)
  for (let i = 0; i < heads.length; i++) earliestSubStep[heads[i]] = 0
  for (let s = 0; s < states.length; s++) {
    const key = states[s]
    const cell = key >> 2
    const ori = key & 3
    for (let t = 0; t < kinds.length; t++) {
      const steps = stepsFrom(kinds[t], cell, ori, board, options)
      for (let i = 0; i < steps.length; i++) {
        const path = steps[i].path
        const walked = path.length < subSteps ? path.length : subSteps
        for (let j = 0; j < walked; j++) {
          if (earliestSubStep[path[j]] > j + 1) earliestSubStep[path[j]] = j + 1
        }
      }
    }
  }
  const headPossible: number[][] = [heads]
  for (let k = 1; k <= subSteps; k++) {
    const front: number[] = []
    for (let cell = 0; cell < cellCount; cell++) if (earliestSubStep[cell] <= k) front.push(cell)
    headPossible.push(front)
  }
  for (let cell = 0; cell < cellCount; cell++) if (earliestSubStep[cell] !== NEVER) seen[cell] = 1

  const everHead = new Set<number>()
  for (let cell = 0; cell < cellCount; cell++) if (seen[cell]) everHead.add(cell)

  return {
    held,
    record,
    span,
    kinds,
    turnHeads,
    headPossible,
    earliestSubStep,
    everHead,
    fatalFirst,
    totalFirst,
    longestPath,
  }
}

/** The head front of a state set, as the ascending cell array everything wants. */
const headsOf = (states: ReadonlyArray<number>, front: Uint8Array): number[] => {
  for (let i = 0; i < states.length; i++) front[states[i] >> 2] = 1
  const heads: number[] = []
  for (let cell = 0; cell < front.length; cell++) {
    if (front[cell]) {
      heads.push(cell)
      front[cell] = 0
    }
  }
  return heads
}

/** The claim itself: the reach, plus the intervals and the two survival flags. */
const claimOf = (
  reach: Reach,
  input: PartialSettleInput,
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
  // The width, when the record is older than a turn. Counting the TURNS of
  // the span admits one potion per turn, and a potion is not a turn: three
  // team-mates collecting on the same unknown turn is +3 to this unit, and
  // the potions they took are off the board by the time this reads
  // `input.potions`, so the turn count can be zero on the very board that
  // moved the tier by three. What did move it is on the SCHEDULE the caller
  // handed for this turn — every pickup pushes one entry per unit it touches,
  // lasting a window — so the width is read off that: every level still in
  // force on this unit, buffs widening the ceiling and debuffs the floor,
  // because a claim cannot tell an entry the record already counts from one
  // taken since it was observed. The turn count stays as a lower bound on the
  // width for a caller whose schedule is older than its board.
  const carried =
    span > 1
      ? input.effects.filter((e) => e.playerID === record.id && e.expiryTurn >= input.turn)
      : []
  const gained = carried.reduce((n, e) => n + Math.max(0, e.level), 0)
  const lost = carried.reduce((n, e) => n + Math.max(0, -e.level), 0)
  const tierMin = floor - Math.max(lost, Math.min(potionTurns, potionsInReach))
  const tierMax = ceiling + Math.max(gained, allies > 0 ? potionTurns : 0)

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
  // This unit's OWN peril. Regicide is folded on afterwards, by `foldRegicide`,
  // because the answer is a question about ANOTHER claim — the team's king —
  // and a claim cannot read a claim that is still being built.
  const selfDeathPossible = certainlyGone || reach.fatalFirst > 0 || reachable || couldExhaust

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
    earliestSubStep: reach.earliestSubStep,
    weightMin: severPossible || promotionPossible ? 1 : length,
    weightMax,
    tierMin,
    tierMax,
    tierAtArrival,
    energyMax,
    certainlyGone,
    deathPossible: selfDeathPossible,
    selfDeathPossible,
    regicideKingId: null,
    severPossible,
    narrowed: reach.held.options !== undefined,
  }
}
