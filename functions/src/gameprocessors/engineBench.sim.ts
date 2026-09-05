// What the engine costs a search, in milliseconds — NOT a test: it asserts
// nothing and prints. Named `.sim.ts` so jest's default matcher skips it,
// following `simulateMMR.sim.ts`.
//
// Two ways to run it, and they answer different questions:
//
//   cd functions && npx jest --testMatch "**/engineBench.sim.ts"
//     — the house way. ts-jest's instrumentation inflates every number by
//       about five times, so read the RATIO between two builds, never the
//       absolute.
//
//   cd functions && npx tsc && node lib/gameprocessors/engineBench.sim.js
//     — plain V8, which is what the bot actually runs. Add `--cpu-prof` and
//       the profile says where the time went:
//         node --cpu-prof --cpu-prof-dir=/tmp/prof \
//              lib/gameprocessors/engineBench.sim.js
//
// The workload is the one a search pays for: `computeClaims` once per held
// set, then `settlePartial` per candidate node with those claims hoisted —
// over the same crowded 9x9 corpus `settlePartial.spec.ts` proves itself on
// (engineBoards.ts).
//
// THE SPAN IS THE POINT. A claim over a unit observed THIS turn dilates for
// one turn against the real board; a claim over a unit last seen k turns ago
// runs k−1 turns of reach BFS against the PERMISSIVE shape, whose `food` is
// every cell. The bot asks for both — a stale enemy is held at its own
// staleness, and the potion window asks `computeClaims` once per horizon
// k = 1…W with every unit held — so the corpus below covers spans 1, 2 and 3,
// and a whole-roster hold as well as one and two units.

import { computeClaims } from "./engine/claims"
import { PartialSettleInput, settlePartial } from "./engine/settlePartial"
import { NO_SPAWN } from "./engine/spawn"
import { held, makeBoard } from "./engineBoards"

/** The boards, which of their units are held, and how stale those are. */
const cases = (): { name: string; input: PartialSettleInput }[] => {
  const out: { name: string; input: PartialSettleInput }[] = []
  for (const seed of [1, 2, 3, 5, 7, 11]) {
    const base = makeBoard(seed)
    const ids = base.units.map((u) => u.id)
    for (const span of [1, 2, 3]) {
      out.push({ name: `seed ${seed}, 1 held, span ${span}`, input: held(base, ids.slice(0, 1), span) })
      out.push({ name: `seed ${seed}, all held, span ${span}`, input: held(base, ids, span) })
    }
  }
  return out
}

const time = (runs: number, run: () => void): number => {
  for (let i = 0; i < Math.min(runs, 50); i++) run() // warm
  const started = process.hrtime.bigint()
  for (let i = 0; i < runs; i++) run()
  return Number(process.hrtime.bigint() - started) / 1e6
}

const RUNS = Number(process.env.ENGINE_BENCH_RUNS ?? 300)

const main = (): void => {
  const work = cases()
  const claimsFor = work.map(({ input }) => computeClaims(input))

  // Each call timed on its own board, then summed: one number per phase, over
  // the whole corpus, so a run is comparable to a run and not to a board.
  let claimsMs = 0
  let settleMs = 0
  work.forEach(({ input }, i) => {
    claimsMs += time(RUNS, () => computeClaims(input))
    settleMs += time(RUNS, () => settlePartial(input, NO_SPAWN, claimsFor[i]))
  })

  const calls = work.length * RUNS
  process.stdout.write(
    `engine bench: ${work.length} boards x ${RUNS} runs\n` +
      `  computeClaims           ${claimsMs.toFixed(1)} ms total, ` +
      `${((claimsMs / calls) * 1000).toFixed(1)} us/call\n` +
      `  settlePartial (hoisted) ${settleMs.toFixed(1)} ms total, ` +
      `${((settleMs / calls) * 1000).toFixed(1)} us/call\n` +
      `  TOTAL                   ${(claimsMs + settleMs).toFixed(1)} ms\n`,
  )
}

// Runs either as a jest suite or as a plain node script; `describe` is only
// defined under the former.
if (typeof describe === "function") {
  describe("what the engine costs a search", () => {
    it("prints the per-call time over the crowded corpus", main)
  })
} else {
  main()
}
