import { Clash, UnitDeath, UnitType } from "@shared/types/Game"
import {
  Orientation,
  defaultAction,
  leavesTrail,
  planUnitAction,
  traversesEdges,
} from "./moveGrammar"
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
 * schedule and so lives one layer up, in `settleTurn`, the module's entry
 * point. Nor spawning food, hazards or potions; the orientation rewrite; pawn
 * promotion; scoring, winners and MMR; anything Firestore.
 */

export interface ResolveUnit {
  id: string
  /** Current kind. Only the movement grammar and max-health lookup read it. */
  type: UnitType
  teamID: string
  /** Configured as a king at spawn. Kings never change kind, so this is stable. */
  isKing?: boolean
  /** Invulnerability tier. Frozen for the whole turn by the engine. */
  tier: number
  health: number
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
  /** Health lost per hazard cell entered. */
  hazardDamage: number
  food: number[]
  /** Per-kind max health; kinds absent here use `defaultMaxHealth`. */
  maxHealth?: { [K in UnitType]?: number }
  /** Default max health for kinds `maxHealth` does not name. Defaults to 100. */
  defaultMaxHealth?: number
  /**
   * Teams that play under regicide — those configured with at least one king,
   * whether or not a king is still standing. A team here loses every remaining
   * unit the moment its last king dies.
   */
  regicideTeamIDs?: string[]
}

/** A unit still on the board when the turn closed. */
export interface ResolvedUnit {
  occupancy: number[]
  health: number
}

export interface TurnResolution {
  /** Survivors only, by id: final occupancy (post-sever, post-growth) and health. */
  board: { [unitID: string]: ResolvedUnit }
  /** Every unit removed this turn, by id. The authoritative registry. */
  deaths: { [unitID: string]: UnitDeath }
  /** Typed events, engine order followed by any regicide records. */
  clashes: Clash[]
  /**
   * Units that ran out of health and halted. Already settled: an event whose
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

export const resolveTurn = (input: ResolveTurnInput): TurnResolution => {
  const { units, boardWidth, boardHeight } = input
  const defaultMaxHealth = input.defaultMaxHealth ?? 100
  const maxHealthFor = (type: UnitType): number =>
    input.maxHealth?.[type] ?? defaultMaxHealth

  // 1. Movement grammar: every staged cell becomes the path the unit walks,
  // one cell per sub-step. An illegal or missing destination falls back to the
  // kind's default — trail units continue straight, pieces hold.
  const pawnTargets = new Set<number>(input.food)
  units.forEach((u) => u.occupancy.forEach((cell) => pawnTargets.add(cell)))

  const rotations: { [unitID: string]: Orientation } = {}
  const paths: { [unitID: string]: number[] } = {}
  units.forEach((u) => {
    if (u.path) {
      paths[u.id] = u.path
      return
    }
    const origin = u.occupancy[0]
    const planned =
      u.stagedMove === undefined
        ? null
        : planUnitAction(
            u.type,
            origin,
            u.stagedMove,
            boardWidth,
            boardHeight,
            u.orientation,
            pawnTargets,
          )
    const action =
      planned ?? defaultAction(u.type, origin, boardWidth, boardHeight, u.orientation)

    if (action.kind === "move") {
      paths[u.id] = action.path
      return
    }
    if (action.kind === "rotate") rotations[u.id] = action.orientation
    paths[u.id] = []
  })

  // 2. The collision phase: every sub-step, every collision, sever truncation
  // and all in-turn health accounting.
  const engineUnits: EngineUnit[] = units.map((u) => ({
    id: u.id,
    leavesTrail: leavesTrail(u.type),
    traversesEdges: traversesEdges(u.type),
    occupancy: u.occupancy,
    tier: u.tier,
    health: u.health,
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
      health: engine.health.get(u.id) as number,
    }
  })

  // 4. Food: every surviving unit standing on food eats it, restoring health
  // to its kind's max and adding one weight/length — exhausted units included,
  // and this is the only way one ever comes back. Movement cost is not settled
  // here; the engine charged it as it was spent.
  const food = [...input.food]
  Object.entries(board).forEach(([id, unit]) => {
    const index = food.indexOf(unit.occupancy[0])
    if (index === -1) return
    food.splice(index, 1)
    unit.occupancy.push(unit.occupancy[unit.occupancy.length - 1])
    unit.health = maxHealthFor(typeOf.get(id) as UnitType)
  })

  // 5. Exhaustion stops being provisional. A unit the food phase brought back
  // above zero lives on, halted and short of where it was going, and its halt
  // record keeps the empty victimIDs that says so. A unit a heavier arrival
  // already killed is untouched: that was a collision death, and it must not
  // appear in the registry twice.
  engine.exhaustions.forEach((event) => {
    if (dead.has(event.unitID)) return
    const unit = board[event.unitID]
    if (!unit || unit.health > 0) return

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
