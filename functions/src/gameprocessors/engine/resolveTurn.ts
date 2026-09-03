import { Clash, UnitDeath, UnitType } from "@shared/types/Game"
import { Orientation, leavesTrail, traversesEdges } from "./moveGrammar"
import { BoardShape, stagedAction } from "./queries"
import { EngineUnit, ExhaustionEvent, REASON, runTurnEngine } from "./turnEngine"

/**
 * The whole of turn resolution, as one pure function.
 *
 * `resolveTurn` is everything that happens between "the staged moves are
 * known" and "the wire is written": the movement grammar, the sub-step
 * collision engine, and the end-of-turn settlement — collision deaths, food
 * and growth, exhaustion deaths, sever truncation, regicide. It takes a board
 * and a roster and hands back the settled board plus the complete death
 * registry, mutating nothing it was given.
 *
 * It is the single encoding of the rules, used by the server that plays the
 * game and by any client that wants to predict a turn. See VENDOR.md: this
 * file and its two neighbours import nothing outside `engine/` and
 * `@shared/types/Game`, so they can be copied wholesale into another repo.
 *
 * Deliberately NOT here: the end-of-turn effect bookkeeping — the ally-buff
 * cancel and effect expiry — which reads the turn number and the effect
 * schedule, nor the orientation rewrite, which needs the roster the deaths
 * left behind, nor pawn promotion, which has to follow both. All of those
 * live one layer up, in `settleTurn`, the module's entry point; this file
 * reports the raw `rotations` and `traversed` the rewrite is computed from,
 * and the grown occupancy promotion reads its threshold against. Nor spawning
 * food, hazards or potions; scoring, winners and MMR; anything Firestore.
 */

export interface ResolveUnit {
  id: string
  /** Current kind. Only the movement grammar and max-energy lookup read it. */
  type: UnitType
  teamID: string
  /** Configured as a king at spawn. Kings never change kind, so this is stable. */
  isKing?: boolean
  /** Invulnerability tier. Frozen for the whole turn by the engine. */
  tier: number
  energy: number
  /** Board occupancy, index 0 = head. Never mutated. */
  occupancy: number[]
  /** Facing — pawn legality and the trail-unit default both read it. */
  orientation: Orientation
  /** The cell this unit staged, if any. Ignored when `path` is supplied. */
  stagedMove?: number
  /** A pre-planned path, one cell per sub-step. Supersedes `stagedMove`. */
  path?: number[]
}

export interface ResolveTurnInput {
  units: ResolveUnit[]
  boardWidth: number
  boardHeight: number
  walls: number[]
  hazards: number[]
  /** Energy lost per hazard cell entered. */
  hazardDamage: number
  food: number[]
  /** Per-kind max energy; kinds absent here use `defaultMaxEnergy`. */
  maxEnergy?: { [K in UnitType]?: number }
  /** Default max energy for kinds `maxEnergy` does not name. Defaults to 100. */
  defaultMaxEnergy?: number
  /**
   * Energy one food replenishes. Absent means `DEFAULT_FOOD_ENERGY`, which is
   * the default max energy, so at the shipped defaults one food is a full tank
   * and every meal grows the eater — the rule food has always played by. Set
   * it below a kind's max and that kind needs several meals to fill, and grows
   * on the one that fills it. See the food phase for what growth now costs.
   */
  foodEnergy?: number
  /**
   * Teams that play under regicide — those configured with at least one king,
   * whether or not a king is still standing. A team here loses every remaining
   * unit the moment its last king dies.
   */
  regicideTeamIDs?: string[]
  /**
   * Cells that hold a body for the purpose of STAGING LEGALITY ONLY — units
   * that are on the board as the turn opens but are not in `units`, so the
   * collision phase never sees them.
   *
   * There is exactly one caller, `settlePartial`, and exactly one reason. It
   * settles a turn over the roster whose moves are known, which means the
   * held units are absent from `units` — and the grammar reads the board:
   * a pawn's diagonal step is legal only onto food or a body standing there
   * when the turn opens (`queries.ts::pawnTargetsOf`). Re-read against a
   * roster with the held unit taken out, a capture staged onto its square is
   * not a legal action at all, the kind's default is substituted, and the
   * unit settles a different move from the one it was staged for. The staged
   * cells must therefore be interpreted against the board the turn OPENS on,
   * which is the board with every unit on it.
   *
   * It feeds `BoardShape.occupancy` and nothing else, so every occupancy read
   * in the grammar — this one and any that follows it — sees the same board,
   * while the timeline still models only the units it was given.
   */
  presence?: number[]
}

/** A unit still on the board when the turn closed. */
export interface ResolvedUnit {
  occupancy: number[]
  energy: number
}

export interface TurnResolution {
  /** Survivors only, by id: final occupancy (post-sever, post-growth) and energy. */
  board: { [unitID: string]: ResolvedUnit }
  /** Every unit removed this turn, by id. The authoritative registry. */
  deaths: { [unitID: string]: UnitDeath }
  /** Typed events, engine order followed by any regicide records. */
  clashes: Clash[]
  /**
   * Units that ran out of energy and halted. Already settled: an event whose
   * unit is absent from `deaths` recovered on food at its halt cell.
   */
  exhaustions: ExhaustionEvent[]
  /** Cells cut from each owner by a sever, for damage indicators. */
  severedCells: { [unitID: string]: number[] }
  /** Cells each unit actually entered, in order. */
  traversed: { [unitID: string]: number[] }
  /** Cell each unit ended on — the death cell for anything that died. */
  finalCell: { [unitID: string]: number }
  /** Food left on the board once every survivor standing on food has eaten. */
  food: number[]
  /**
   * Units whose tier was below zero and which either died or survived a sever.
   * Callers that model ally buffs key off this rather than recomputing it.
   */
  vulnerableCollided: string[]
  /** Teams whose last king fell this turn. */
  eliminatedTeamIDs: string[]
  /** Units whose staged action turned out to be a rotation, with the new facing. */
  rotations: { [unitID: string]: Orientation }
  /** How many sub-steps the collision phase ran. */
  subStepCount: number
}

/**
 * The energy one food replenishes when a setup names no amount — the same
 * number as the default max energy, so an unconfigured game plays the rule
 * food has always played: one meal, a full tank, one weight.
 */
export const DEFAULT_FOOD_ENERGY = 100

/**
 * The id the `presence` cells are handed to the grammar under. Nothing reads
 * an occupancy entry's id, and no unit can be called this, so a query can
 * never confuse the two.
 */
const PRESENCE = "@presence"

export const resolveTurn = (input: ResolveTurnInput): TurnResolution => {
  const { units, boardWidth, boardHeight } = input
  const defaultMaxEnergy = input.defaultMaxEnergy ?? 100
  const maxEnergyFor = (type: UnitType): number =>
    input.maxEnergy?.[type] ?? defaultMaxEnergy
  const foodEnergy = input.foodEnergy ?? DEFAULT_FOOD_ENERGY

  // 1. Movement grammar: every staged cell becomes the path the unit walks,
  // one cell per sub-step. An illegal or missing destination falls back to the
  // kind's default — trail units continue straight, pieces hold. The step is
  // `stagedAction`, which is also what a caller asks when it wants to know
  // what a click will do (queries.ts): one staging rule, not two.
  const standing = units.map((u) => ({ id: u.id, cells: u.occupancy }))
  const shape: BoardShape = {
    boardWidth,
    boardHeight,
    walls: input.walls,
    hazards: input.hazards,
    // Bodies the grammar must see but the collision phase must not: see
    // `presence`. Empty in every ordinary settlement, so the shape is the
    // roster's own occupancy and nothing else.
    occupancy:
      input.presence && input.presence.length > 0
        ? [...standing, { id: PRESENCE, cells: input.presence }]
        : standing,
    food: input.food,
  }

  const rotations: { [unitID: string]: Orientation } = {}
  const paths: { [unitID: string]: number[] } = {}
  units.forEach((u) => {
    if (u.path) {
      paths[u.id] = u.path
      return
    }
    const action = stagedAction(u, u.stagedMove, shape)

    if (action.kind === "move") {
      paths[u.id] = action.path
      return
    }
    if (action.kind === "rotate") rotations[u.id] = action.orientation
    paths[u.id] = []
  })

  // 2. The collision phase: every sub-step, every collision, sever truncation
  // and all in-turn energy accounting.
  const engineUnits: EngineUnit[] = units.map((u) => ({
    id: u.id,
    leavesTrail: leavesTrail(u.type),
    traversesEdges: traversesEdges(u.type),
    occupancy: u.occupancy,
    tier: u.tier,
    energy: u.energy,
    path: paths[u.id] ?? [],
  }))
  const subStepCount = Math.max(1, ...engineUnits.map((u) => u.path.length))
  const engine = runTurnEngine(engineUnits, input.hazards, input.walls, input.hazardDamage)

  const clashes = [...engine.clashes]
  const deaths: { [unitID: string]: UnitDeath } = {}
  const dead = new Set<string>()
  const vulnerableCollided = new Set(engine.vulnerableCollided)

  // 3. The collision dead leave the board. Exhausted units do NOT: they are
  // only provisionally dead and still have the food phase ahead of them.
  engine.deaths.forEach((death) => {
    dead.add(death.unitID)
    deaths[death.unitID] = {
      cell: death.cell,
      subStep: death.subStep,
      cause: death.cause,
    }
  })

  const board: { [unitID: string]: ResolvedUnit } = {}
  const typeOf = new Map(units.map((u) => [u.id, u.type]))
  const tierOf = new Map(units.map((u) => [u.id, u.tier]))
  units.forEach((u) => {
    if (dead.has(u.id)) return
    board[u.id] = {
      occupancy: engine.occupancy.get(u.id) as number[],
      energy: engine.energy.get(u.id) as number,
    }
  })

  // 4. Food: every surviving unit standing on food eats it — exhausted units
  // included, and this is the only way one ever comes back. Movement cost is
  // not settled here; the engine charged it as it was spent.
  //
  // A meal is `foodEnergy`, added and CLAMPED to the kind's max, and it grows
  // the eater by one weight/length only when it brings the unit TO that max.
  // Growth is therefore what a full tank costs: a unit that eats while nearly
  // empty gets fuel and nothing else, and only the meal that tops it off is
  // worth a length. A unit already AT max grows on every meal, because the
  // clamp leaves it at max and max is what the rule asks for — the shipped
  // default of a food worth a whole tank is exactly the old rule, where every
  // meal filled and every meal grew.
  //
  // Note what this does to an exhausted unit: at zero or below, a meal lifts
  // it by `foodEnergy` and, unless that reaches max, it survives on partial
  // energy and does NOT grow. Under the old rule its rescue was always a full
  // tank and always a length.
  //
  // Eating is per FOOD, applied in board order: a cell can only be reached by
  // one unit and the spawner never stacks two items on one cell, so exactly
  // one meal per unit per turn is reachable today (food is eaten at the cell a
  // unit ENDS on — a slider passing over food leaves it). A setup that presets
  // the same cell twice is the one way to see the loop run twice, and then
  // each food is a separate meal settled in turn: add, clamp, grow if full.
  const food = [...input.food]
  Object.entries(board).forEach(([id, unit]) => {
    const max = maxEnergyFor(typeOf.get(id) as UnitType)
    for (;;) {
      const index = food.indexOf(unit.occupancy[0])
      if (index === -1) return
      food.splice(index, 1)
      unit.energy = Math.min(max, unit.energy + foodEnergy)
      if (unit.energy < max) continue
      unit.occupancy.push(unit.occupancy[unit.occupancy.length - 1])
    }
  })

  // 5. Exhaustion stops being provisional. A unit the food phase brought back
  // above zero lives on, halted and short of where it was going, and its halt
  // record keeps the empty victimIDs that says so. A unit a heavier arrival
  // already killed is untouched: that was a collision death, and it must not
  // appear in the registry twice.
  engine.exhaustions.forEach((event) => {
    if (dead.has(event.unitID)) return
    const unit = board[event.unitID]
    if (!unit || unit.energy > 0) return

    dead.add(event.unitID)
    delete board[event.unitID]
    deaths[event.unitID] = {
      cell: event.cell,
      subStep: event.subStep,
      cause: event.cause,
    }
    event.record.victimIDs = [event.unitID]
    if ((tierOf.get(event.unitID) as number) < 0) vulnerableCollided.add(event.unitID)
  })

  // 6. Regicide: a team configured with kings loses everything with its last
  // king. Kings never change kind, so `isKing` is stable for the whole game.
  const eliminatedTeamIDs: string[] = []
  new Set(input.regicideTeamIDs ?? []).forEach((teamID) => {
    const kingStands = units.some((u) => u.teamID === teamID && u.isKing && !dead.has(u.id))
    if (kingStands) return

    units.forEach((u) => {
      if (u.teamID !== teamID || dead.has(u.id)) return
      const cell = (board[u.id] as ResolvedUnit).occupancy[0]
      dead.add(u.id)
      delete board[u.id]
      deaths[u.id] = { cell, subStep: subStepCount, cause: "regicide" }
      clashes.push({
        index: cell,
        subStep: subStepCount,
        kind: "regicide",
        playerIDs: [u.id],
        victimIDs: [u.id],
        reason: REASON.regicide,
      })
    })
    eliminatedTeamIDs.push(teamID)
  })

  return {
    board,
    deaths,
    clashes,
    exhaustions: engine.exhaustions,
    severedCells: fromMap(engine.severedCells),
    traversed: fromMap(engine.traversed),
    finalCell: fromMap(engine.finalCell),
    food,
    vulnerableCollided: Array.from(vulnerableCollided),
    eliminatedTeamIDs,
    rotations,
    subStepCount,
  }
}

const fromMap = <T>(map: Map<string, T>): { [key: string]: T } => {
  const out: { [key: string]: T } = {}
  map.forEach((value, key) => {
    out[key] = value
  })
  return out
}
