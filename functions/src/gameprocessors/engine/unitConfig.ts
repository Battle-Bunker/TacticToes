import { UnitConfig, UnitMaxEnergy, UnitType, UnitTypeConfig } from "@shared/types/Game"

/**
 * The per-unit-type configuration group, and the ONE place a game document of
 * any age is read for it.
 *
 * Three numbers are configured per kind — what a meal is worth to it, how much
 * energy it can hold, and the weight it spawns at — and they are read here and
 * nowhere else: the engine's food phase, its max-energy clamp and the board
 * placement that creates a unit all index this by kind rather than branching
 * on it, and the lobby edits the very same shape.
 *
 * Older documents carry the two settings this group replaced — a per-type
 * `maxEnergyPerUnit` map and a single global `foodEnergy`. They are mapped
 * here, ON READ, into the one shape; nothing writes them any more.
 *
 * The wire types carry no runtime code, so the defaults and the indexing live
 * HERE, in the engine, where the rules that read them are — and travel with it
 * when it is vendored. A caller outside the engine (board placement, the
 * lobby) reads the same function; there is no second table of defaults.
 */

/** Every unit kind there is, in lobby order. */
export const UNIT_TYPES: UnitType[] = [
  "snake",
  "pawn",
  "knight",
  "bishop",
  "rook",
  "queen",
  "king",
]

/** Energy a kind holds when its group names no maximum. */
export const DEFAULT_MAX_ENERGY = 100

/**
 * Energy one food replenishes when a group names no amount — the same number
 * as the default maximum, so an unconfigured game plays the rule food has
 * always played: one meal, a full tank, one weight.
 */
export const DEFAULT_FOOD_ENERGY = 100

/**
 * The weight a kind spawns at when its group names none: a snake spawns as a
 * stacked triple, every chess piece as the single square it stands on. This is
 * the shipped board, written down as the table it always was.
 */
export const DEFAULT_STARTING_WEIGHT: { [K in UnitType]: number } = {
  snake: 3,
  pawn: 1,
  knight: 1,
  bishop: 1,
  rook: 1,
  queen: 1,
  king: 1,
}

/** One kind's configuration with every default filled in. */
export interface ResolvedUnitTypeConfig {
  /** Energy one food replenishes for this kind. */
  foodEnergy: number
  /** Energy this kind can hold; a meal is clamped to it, and filling it grows. */
  maxEnergy: number
  /** Weight (occupancy length) this kind is created with at game start. */
  startingWeight: number
}

/**
 * The configuration of ONE kind, defaults applied. Every rule that reads any
 * of the three asks this, indexed by the kind it already has in hand.
 */
export const unitTypeConfig = (
  config: UnitConfig | undefined,
  type: UnitType,
): ResolvedUnitTypeConfig => {
  const group = config?.[type]
  return {
    foodEnergy: group?.foodEnergy ?? DEFAULT_FOOD_ENERGY,
    maxEnergy: group?.maxEnergy ?? DEFAULT_MAX_ENERGY,
    startingWeight: group?.startingWeight ?? DEFAULT_STARTING_WEIGHT[type],
  }
}

/** The same group for every kind — what a setting that used to be global means. */
export const everyUnitType = (group: UnitTypeConfig): UnitConfig => {
  const out: UnitConfig = {}
  UNIT_TYPES.forEach((type) => {
    out[type] = { ...group }
  })
  return out
}

/** The fields of a game document this module reads — new shape and old. */
export interface UnitConfigSource {
  unitConfig?: UnitConfig
  /** @deprecated Read-only legacy: folded into `unitConfig` here, never written. */
  maxEnergyPerUnit?: UnitMaxEnergy
  /** @deprecated Read-only legacy: folded into `unitConfig` here, never written. */
  foodEnergy?: number
}

/**
 * The one reader. A setup written before the group existed carries
 * `maxEnergyPerUnit` and a global `foodEnergy`; a setup written after carries
 * `unitConfig`. Both come out of here as one `UnitConfig`, the group's own
 * fields winning field by field where a document somehow holds both.
 *
 * Only fields the document actually states are returned, so an absent setting
 * is still absent afterwards and takes the default at the point of use.
 */
export const unitConfigOf = (setup: UnitConfigSource | undefined): UnitConfig => {
  const out: UnitConfig = {}
  UNIT_TYPES.forEach((type) => {
    const group = setup?.unitConfig?.[type]
    const foodEnergy = group?.foodEnergy ?? setup?.foodEnergy
    const maxEnergy = group?.maxEnergy ?? setup?.maxEnergyPerUnit?.[type]
    const startingWeight = group?.startingWeight
    const resolved: UnitTypeConfig = {}
    if (foodEnergy !== undefined) resolved.foodEnergy = foodEnergy
    if (maxEnergy !== undefined) resolved.maxEnergy = maxEnergy
    if (startingWeight !== undefined) resolved.startingWeight = startingWeight
    if (Object.keys(resolved).length > 0) out[type] = resolved
  })
  return out
}
