// The per-unit-type configuration group — food energy, max energy, starting
// weight — with its defaults and its one reader. The implementation lives in
// the engine, where the rules that read it are (see
// functions/src/gameprocessors/engine/VENDOR.md); the alias is safe here
// because Vite and tsc both resolve it at build time.
export {
  DEFAULT_FOOD_ENERGY,
  DEFAULT_MAX_ENERGY,
  DEFAULT_STARTING_WEIGHT,
  UNIT_TYPES,
  everyUnitType,
  unitConfigOf,
  unitTypeConfig,
} from "@engine/unitConfig"
export type { ResolvedUnitTypeConfig, UnitConfigSource } from "@engine/unitConfig"
