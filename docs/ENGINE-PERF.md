# What the engine costs a search, and where the cost went

The bot (`Battle-Bunker/Chris-Centaur`) vendors
`functions/src/gameprocessors/engine/` byte-for-byte and calls `computeClaims`
and `settlePartial` once per search node, so a millisecond here is search depth
there. This file is the record of two rounds of making them cheaper — WHAT was
measured, HOW, what each change bought, and what was tried and thrown away.

Nothing here changed a rule. Every commit was gated on
`npm --prefix functions test -- settlePartial engineVendor` — the T-properties
enumerated over ~240,000 concrete worlds, plus the vendor contract — and on the
full suite (358 tests, the replay goldens byte-identical); and the whole round
was gated end-to-end on the bot, whose 25-run deterministic summary is
byte-identical before and after.

## How it is measured

`functions/src/gameprocessors/engineBench.sim.ts` is the workload: the same
crowded 9x9 corpus `settlePartial.spec.ts` proves itself on
(`engineBoards.ts`), 36 boards — six seeds x {one held, whole roster held} x
spans 1, 2 and 3 — `computeClaims` once per board and `settlePartial` per node
with those claims hoisted, which is the shape a search pays for.

**The machine is shared and noisy, so an absolute number from it means
nothing.** Two builds are loaded into ONE process, their rounds interleaved,
and the statistic is the MEDIAN OF THE PER-ROUND RATIO — a paired ratio cancels
load drift, which a median of two separate distributions does not. The whole
experiment is then run a second time with the two builds swapped and the two
medians combined geometrically, which cancels the residual advantage the
first-loaded copy holds. Identical builds compared this way land within ±3%,
and that is the noise floor every claim below is read against.

`node --cpu-prof` on the same bench says where the time is; profiles are read
for SHAPE (which function, what share) and never for absolute milliseconds.

## Round 2: the profile before

Top ten by self time at round 1's head (`29a98cd`):

| share | function |
| ---: | --- |
| 23.2% | `moveGrammar.planUnitAction` |
| 9.7% | the settled-turn pass's `states.forEach` closure, `claims.ts` |
| 8.6% | garbage collector |
| 6.5% | `claims.sorted` |
| 6.2% | that pass's inner `step.path.forEach` closure |
| 4.2% | `claims.reachOf` |
| 3.6% | `moveGrammar.rayPath` |
| 3.3% | the dilation loop's `states.forEach` closure |
| 2.2% | `settlePartial` |
| 2.1% | `claims.claimOf` |

Read as one sentence: the reach dilation asks the grammar for a full board
sweep tens of thousands of times per settled turn, through four levels of
`forEach` closure, allocating an object per state and a hash set per horizon.

## What each change bought

Per-commit, against the commit before it, by the method above.

| # | change | computeClaims | weighted total |
| --- | --- | ---: | ---: |
| 1 | The grammar's answer for a dilation state is remembered per board — `legalActions` is a board sweep, and several held units' state sets over one board overlap almost completely by the second unknown turn | -11.1% | -10.0% |
| 2 | The frontier is numbers, not objects (`cell * 4 + ori`); every head front and sub-step horizon is a flag array read out in cell order instead of a `Set` sorted into an array; the horizons are one earliest-arrival `Int32Array`, which IS `Claim.earliestSubStep` and is no longer derived twice | -27.9% | -23.3% |
| 3 | The board sweep asks the grammar with its arithmetic done: `planFromCoords` is the rule with both squares' coordinates in hand, `planUnitAction` is that plus the four divisions, and the sweep pays none of them | -6.7%, -7.9% | -4.6%, -6.3% |
| 4 | The frontier is an array with a flag array for membership rather than a `Set`; the three flag arrays are allocated once per call and cleared as drained, not three per held unit | -12.9% | -10.2% |
| 5 | The answer is remembered under WHAT THE GRAMMAR READS: only a pawn's grammar reads its facing or the board's contents (`readsFacingAndContents`), so six kinds in seven are keyed by the cell alone and shared between the call's two boards. Distinct sweeps over the corpus: 2409 -> 1904 | -16.9% | -12.8% |
| 6 | The memo is a dense array indexed by the key, not a second hash | -3.0%, -8.7%, -6.8% | -1.1%, -6.6%, -5.0% |

Cumulative, round 1's head against this branch's head, two runs:

```
computeClaims   -52.1%   -56.5%     (549 us/call -> 251 us/call)
settlePartial     0.0%    -1.2%     ( 93 us/call ->  90 us/call)
weighted total  -44.4%   -48.5%
```

`settlePartial` is untouched by design: every change above is in the claim
half, which is where the profile was.

## Tried and rejected

Both were implemented, measured and reverted. They are recorded because the
next person will think of them too.

- **Folding each remembered answer's walked cells once.** A queen walks 168
  path cells to touch 48, because every target along a ray carries the whole
  prefix — so fold the union, with each cell's earliest sub-step, beside the
  steps. It costs three typed arrays and two board scans PER MISS, and only
  1324 of 3228 asks are hits, so the fold is paid for more often than it is
  spent: **+40%**, comfortably the worst thing measured in either round.
- **A visitor for the board sweep**, to stop `legalActions` allocating a
  `{target, action}` pair per legal target for a caller that turns each into a
  dilation step and drops the pair. Real garbage, no measurable gain: -1.7%,
  -2.9%, +1.8% over three runs — inside the noise floor, and it widens
  `queries.ts`'s surface. Not kept.

## The profile after, and why it stops here

| share | function |
| ---: | --- |
| 17.5% | `claims.reachOf` |
| 15.2% | `moveGrammar.planFromCoords` |
| 11.1% | garbage collector |
| 5.0% | `moveGrammar.rayPath` |
| 3.7% | `settlePartial` |
| 3.5% | `claims.stepsFrom` |
| 2.3% | `claims.computeClaims` |
| 2.1% | `settlePartial.arrivalsOf` |
| 2.0% | `claims.sorted` |
| 1.7% | `resolveTurn` |

What is left above 3% is the work itself: `reachOf`'s dilation loops,
`planFromCoords` and `rayPath` — the grammar answering — and the garbage those
answers are made of. The one remaining way to cut the grammar's share is to
stop sweeping the board and have each kind ENUMERATE its targets instead, and
that is a second encoding of the movement rules, which is the one thing
`engine/VENDOR.md` exists to prevent. So this is where it stops.

## Verified against the bot

A scratch copy of `Chris-Centaur` outside both repos, `npm run sync-engine`
against this branch, `npx tsc -p .`, and
`node dist/tests/local-game.js sum all 60 5 --nodes --json` on each arm —
25 runs over five board classes, 1,495,182 search nodes, the deterministic
node-budgeted mode so the two arms are comparable at all.

- **`scripts/ab-compare.js` is all-zero**: every metric, every seed, every
  board class, delta 0. The 25 JSON summaries are byte-identical but for the
  arm's label, and the node counts match exactly. The bot plays the same games.
- **Time per node: 0.225 ms -> 0.183 ms, -18.7%** (CPU time over identical node
  counts; wall clock on the shared machine moved -8.0% and is the less
  trustworthy of the two).

## Round 1, for the record

One change: the pawn-target set (`queries.pawnTargetsOf`) is a board sweep that
every query rebuilt per call, and the dilation asks the grammar once per
reachable state per unknown turn. Built once per board and handed down: the
engine bench 37% faster and the bot 19.5% less time per node, byte-identical.
It is what left `planUnitAction` at the top of the profile round 2 opened on.
