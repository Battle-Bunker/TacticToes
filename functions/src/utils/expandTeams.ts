// The one implementation lives in shared/, imported relatively (not via the
// @shared alias) so the emitted require resolves at runtime in the deployed
// function: tsc roots at the repo and emits lib/shared/ beside lib/functions/.
export { expandTeams } from "../../../shared/expandTeams"
