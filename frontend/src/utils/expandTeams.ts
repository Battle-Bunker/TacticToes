// The one implementation lives in shared/; the alias is safe here because Vite
// and tsc both resolve it at build time and nothing survives to a runtime require.
export { expandTeams } from "@shared/expandTeams"
