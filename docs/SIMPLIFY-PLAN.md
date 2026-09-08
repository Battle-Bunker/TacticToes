# Simplification plan — after the engine migration

The turn now settles inside `functions/src/gameprocessors/engine/`. E1–E7, the
partial mode and the energy rename all landed, and what is left above the
boundary is leftovers: state the processor keeps because it used to compute it,
a second copy of one rule that predates the shared module, and two test
harnesses that were written a fortnight apart.

This is a ranked list of what to delete. Every item states the special case it
removes, the abstraction it parameterises instead, the line delta, the gate that
catches a mistake, and whether it can be executed from this text alone
(MECHANICAL) or needs a judgement call at the keyboard (JUDGEMENT).

**No item changes behaviour, and no item re-records a golden.** Where a
simplification would change a fixture it is listed under "Not proposed" instead,
with the reason.

## The gates

| Gate | Command | What it catches |
| --- | --- | --- |
| Golden replays | `npm --prefix functions test -- settlementReplay pieceReplay` | Any change to a produced turn: boards, energy, deaths, clashes, moves, scores, potions, tiers, the effect schedule, and the spawner's draw order. Four fixtures, byte-for-byte. |
| Partial enumeration | `npm --prefix functions test -- settlePartial` | T1–T5 over ~1,600 random boards and every concrete world a held unit could produce. The oracle is `settleTurn` itself. |
| Vendor contract | `npm --prefix functions test -- engineVendor` | `engine/` importing outside itself, `require(`, `Math.random`, `Date.now`, and the standalone compile with no `node_modules`. |
| Frontend types | `cd frontend && npx tsc -b` | Every frontend item below. |
| Placement properties | `npm --prefix functions test -- checkSnakeStartLocations startGame` | Spawn parity, minimum distance, slice assignment, cluster fallback, preview/turn-0 agreement. Property-based, not a fixture. |

All 21 suites, 374 tests, pass on `claude/succession-doc-subagent-orchestration-n41iua`
as of this document. Note that **the golden replays never call `firstTurn`** —
they drive `applyMoves` from a hand-built turn 0 — so placement changes (items 3,
5 and 11) are gated by properties only, which is weaker. That difference is
priced into the ranking.

---

## 1. `expandTeams`: one copy, not two plus a drift guard

**MECHANICAL to write, JUDGEMENT to land** (the module-resolution check at the
end is the judgement).

| Files | Lines |
| --- | --- |
| `functions/src/utils/expandTeams.ts` | 1–37 |
| `frontend/src/utils/expandTeams.ts` | 1–30 |
| `functions/src/utils/expandTeams.parity.test.ts` | 1–88 |

The two `expandTeams` bodies are character-for-character identical from their
`UNIT_ORDER` constant to their closing brace. Both carry a "do not diverge"
comment; the 88-line parity test exists solely to fail when they do. This is a
second encoding of a rule — the one thing `engine/VENDOR.md` exists to prevent —
sitting outside `engine/` where the vendor spec does not look.

The stated reason for the copy is in `expandTeams.parity.test.ts:3-6`: *"it
cannot live in shared/ because Firebase deploy packages only the functions dir
and shared/ must stay type-only."* Half of that is right and half is not. There
is no runtime path mapping anywhere — `functions/jest.config.js` has no
`moduleNameMapper`, and `tsc` does not rewrite `paths` at emit — so an
`@shared/...` import of a module with runtime code would emit a bare
`require("@shared/...")` that resolves nowhere. That is the real constraint, and
it is about the **alias**, not the location. A *relative* import of the same file
emits a relative `require` that resolves fine, because `functions/tsconfig.json`
roots at the repo (`include: ["src", "../shared"]`) and therefore emits
`functions/lib/shared/...` alongside `functions/lib/functions/src/...` — which
`functions/tools/build-entry.mjs:40-41` already relies on, and which a build
confirms (`functions/lib/shared/types/Game.js` exists today).

**Do:**

1. New `shared/expandTeams.ts` — the body verbatim from
   `functions/src/utils/expandTeams.ts:1-37`.
2. `functions/src/utils/expandTeams.ts` becomes one line:
   `export { expandTeams } from "../../../shared/expandTeams"` — a **relative**
   specifier, not `@shared/`. All nine importers stay untouched.
3. `frontend/src/utils/expandTeams.ts` becomes one line:
   `export { expandTeams } from "@shared/expandTeams"` — the alias is fine here,
   because Vite (`frontend/vite.config.ts:16-18`) and `tsc` both resolve it at
   build time and nothing survives to a runtime `require`. Its one importer
   (`frontend/src/components/SnekConfiguration.tsx:7`) stays untouched.
4. Delete `functions/src/utils/expandTeams.parity.test.ts` entirely. It guards a
   duplication that no longer exists.

**Special case removed:** a rule with two implementations and a test whose only
job is to notice when they disagree.
**Parameterised instead:** nothing — there is one function, in one place, and the
two projects import it.

**Lines:** −155 / +39. **Net −116.**

**Gate:** the full `functions` suite. Nine files build their rosters through
`expandTeams`, *including both golden replays*
(`settlementReplay.spec.ts:122`, `pieceReplay.spec.ts:178`), so any change to its
output moves a pinned fixture. Then `cd frontend && npx tsc -b && npx vite build`.
Then the one check the test suite cannot make:

```sh
npm --prefix functions run build && ls functions/lib/shared/expandTeams.js
```

If that file is absent, stop — the deployed function would fail at load. (It will
be present; the same build already emits `lib/shared/types/Game.js`.)

**Bonus:** deleting the parity test also stops `functions/lib/frontend/src/` from
being emitted at all. It exists today only because that test imports across the
project boundary at `expandTeams.parity.test.ts:7`.

---

## 2. One golden-replay runner for both replays

**MECHANICAL.**

| Files | Lines |
| --- | --- |
| `functions/src/gameprocessors/settlementReplay.spec.ts` | 172–201, 203–228, 230–248, 283–289 |
| `functions/src/gameprocessors/pieceReplay.spec.ts` | 217–246, 248–276, 278–296, 306–312 |

A line-level diff of the two files finds 130 identical lines, of which ~80 per
file are the harness rather than the scenario: `mkGameState`, `mv`,
`seededRandom`, the `runReplay` loop, `canonical`, `serialise` and `check`. Two
copies of the same LCG with different seeds, two copies of the same
sorted-key canonicaliser, two copies of the same `UPDATE_GOLDEN` escape hatch.

The scenarios genuinely differ — one is a snake circuit, one is a chess script —
and should stay in their own files. What differs between the two harnesses is
exactly four things: the setup, the turn 0, the function from `(playerID, turn)`
to a staged cell, and the seed.

**Do:** new `functions/src/gameprocessors/goldenReplay.ts` (a test helper, not
production code, so it is outside `engine/` and the vendor spec does not apply):

```ts
export interface ReplayScript {
  setup: StartedGameSetup
  startingTurn: Turn
  /** The cells staged this turn, by unit. Absent ids stage nothing. */
  moves: (turn: number, alive: string[]) => Move[]
  turns: number
  seed: number
}
export const runReplay = (script: ReplayScript): Turn[] => { ... }
export const serialise = (stream: Turn[]): string => { ... }
export const check = (actual: string, path: string): void => { ... }
```

`runReplay` installs the seeded `Math.random` in a `try/finally` exactly as both
files do today, constructs a fresh `TeamSnekProcessor` per turn from the
accumulated turns, and returns the produced stream. Both spec files then keep
only their board, their script, their `mkSetup`/`startingTurn`, and their
assertions.

`settlementReplay` passes `moves: (turn, alive) => alive.map(id => mv(id, moveFor(id, turn)))`;
`pieceReplay` passes `moves: (turn, alive) => alive.filter(id => SCRIPT[turn-1][id] !== undefined).map(...)`.
That filter is the only behavioural difference between the two loops and it
falls out of the callback for free.

**Special case removed:** two harnesses that must stay in step for the two
fixtures to mean the same thing.
**Parameterised instead:** one runner over `(setup, turn 0, move source, count, seed)`.

**Lines:** −160 / +60. **Net −100.**

**Gate:** both golden replays, against **unchanged** `.golden.json` files. This is
the ideal gate for this item: the helper is only correct if all four fixtures
still match byte-for-byte. `UPDATE_GOLDEN=1` must not be run.

---

## 3. Board geometry is processor state, not a 47-line parameter thread

**MECHANICAL.**

| File | Lines |
| --- | --- |
| `functions/src/gameprocessors/TeamSnekProcessor.ts` | 442–443, 705–707, 795–797, 826–828, 875–891, 893–896, 916–925, 934–947, 971–980, 985–989, 1013–1015, 1056–1060, 1087–1090, 1122–1124, 1318–1320, 1390–1394 |

`grep -n "boardWidth: number,\|boardHeight,$"` on this file returns 47 lines.
Ten private methods take `(boardWidth, boardHeight)` as parameters, and every one
of them is called only with `this.gameSetup.boardWidth` and
`this.gameSetup.boardHeight` — values fixed for the life of the game. The
threading buys nothing and costs a two-line parameter pair per signature plus a
two-line argument pair per call site, several of which are otherwise one-liners
spread over seven lines (`985-1019` is the worst).

`getWallPositions` (875–891) is worse still: it rebuilds the whole perimeter from
scratch on **nine** separate calls (125, 138, 182, 362, 812, 926, 992, 1063,
1495), three of them inside loops over candidate hazards.

**Do:**

1. In the constructor (103–108), after `this.gameSetup` is assigned, add
   `private readonly walls: number[] = this.getWallPositions()` — or assign in the
   body, since `getWallPositions` reads `this.gameSetup`.
2. Drop the `(boardWidth, boardHeight)` parameters from `getWallPositions`,
   `getAdjacentIndices`, `getFreePositions`, `generateHazardPositions`,
   `ensureInitialSafeMoves`, `ensureConnectedBoard`, `generateFertileTiles`,
   `initializeFood`, `getSpawnCells` and `isValidSpawnPosition`; read
   `this.gameSetup.boardWidth/boardHeight` inside each.
3. Replace all nine `this.getWallPositions(...)` calls with `this.walls`, and
   `getWalls()` (123–126) with `return this.walls`.
4. Do **not** touch lines 221–222 (`pickSpawnOrientation`), 360–361 (the
   `SettleInput` literal) or 1271–1272 (`assignCellsToSlices`): those pass the
   dimensions across a module boundary, which is where they belong.

**Special case removed:** ten methods that each restate the board's dimensions as
if they might differ.
**Parameterised instead:** the processor already holds the setup; the geometry is
read from it, and the perimeter is computed once.

**Lines:** −45 / +6. **Net −39.**

**Gate:** `checkSnakeStartLocations.test.ts` (spawn parity, minimum distance,
slice assignment, cluster fallback, the preview/turn-0 agreement at 379–383),
`startGame.test.ts`, `spawn.spec.ts`, and both golden replays for `settleInput`'s
`walls` field at 362. This is a signature refactor with no arithmetic change, so
the weaker placement gate is acceptable here — unlike items 5 and 11.

---

## 4. One source for "died this turn", and the dead score pass deleted

**MECHANICAL.**

| File | Lines |
| --- | --- |
| `functions/src/gameprocessors/TeamSnekProcessor.ts` | 55–61, 78–79, 389–390, 509–517, 521–532, 589–603, 610–612, 643–666 |

`settleTurn` returns the death registry (`Settlement.deaths`), the survivors'
board and their energy. The processor takes all three and then keeps a fourth
account of the same fact:

* `SnakeGameState.deadPlayers` (57) is a `Set` filled at 389 from
  `Object.keys(resolution.deaths)` — the registry, re-typed.
* `removeDeadPlayers` (521–532) deletes from `playerInvulnerabilityLevel` (529)
  and filters `activeEffects` (530) — both of which lines 399–400 then **replace
  wholesale** with `resolution.tiers` and `resolution.effects` three statements
  earlier in the same method. That work is dead.
* `SnakeGameState.newScores` (61) is filled by a nine-line loop at 590–598 and
  handed to the turn at 611 — and then line 665 overwrites `newTurn.scores`
  entirely with `playerScores` from the second pass at 659–662. The whole first
  pass, and the field, are dead.
* `validAlivePlayers` (601–603) filters `newAlivePlayers` for units with a
  non-empty occupancy. It can never remove anything: `turnEngine.ts:571-578`
  truncates a severed body to `Math.min(...severCuts)` where every cut index is
  `occupancy.indexOf(cell, 1) >= 1`, so a survivor always keeps at least its
  head; and every id in `newAlivePlayers` has a `resolution.board` entry by
  construction.
* Lines 653 and 661 each write `deadPlayers.has(id) ? 0 : (newSnakes[id]?.length || 0)`.
  After the dead are pruned from `newSnakes`, `newSnakes[id]?.length ?? 0` gives
  the identical answer for a unit that died this turn *and* for one that died
  three turns ago — the ternary is a special case for the first that the second
  already handles.
* `SnakeGameState.subStepCount` (79) is written at 381 and 517 and never read.

**Do:**

1. Delete `deadPlayers` (57), `newScores` (60–61), `subStepCount` (78–79) from
   `SnakeGameState`, and their initialisers at 509, 511, 517.
2. Replace 389–390 and the whole of `removeDeadPlayers` (521–532) with four lines
   in `applySettlement`:
   ```ts
   const dead = new Set(Object.keys(resolution.deaths))
   gameState.newAlivePlayers = gameState.newAlivePlayers.filter((id) => !dead.has(id))
   dead.forEach((id) => { delete gameState.newSnakes[id]; delete gameState.newPlayerEnergy[id] })
   ```
   Keep it where `removeDeadPlayers` was called (390), i.e. before the
   `resolution.board` fold at 391–394 and before the tier/effect replacement at
   399–401.
3. Delete 590–598. Move the `playerScores` pass (659–662) above the `newTurn`
   literal and write `scores: playerScores` at 611; delete the reassignment at 665.
4. Fold `teamScores` (643–656) out of `playerScores` rather than recomputing the
   same expression: `playerScores` is already per-player, so the team loop
   becomes a sum over `gamePlayers` of `playerScores[player.id]`.
5. Replace 601–603 with `alivePlayers: gameState.newAlivePlayers` at 612.
6. Both `deadPlayers.has(...)` ternaries become `gameState.newSnakes[id]?.length ?? 0`.

**Special case removed:** four parallel notions of "removed this turn" — a `Set`,
two deletions that are immediately overwritten, a defensive filter that can never
fire, and a score pass whose result is discarded.
**Parameterised instead:** `Settlement.deaths` and the settled board are the
single source; the processor prunes once and reads.

**Lines:** −28 / +6. **Net −22.**

**Gate:** both golden replays — they pin `scores`, `teamScores`, `alivePlayers`,
`playerInvulnerabilityLevel` and `activeEffects` on every turn of a game that
kills a unit on turn 2 (`settlementReplay.spec.ts:397-407`) — plus
`TeamSnekProcessor.spec.ts:357` *"writes team scores and individual scores"* and
`adjudication.spec.ts`.

---

## 5. One board-building pass for the preview and for turn 0

**JUDGEMENT.**

| File | Lines |
| --- | --- |
| `functions/src/gameprocessors/TeamSnekProcessor.ts` | 128–152, 154–194 |

`generatePreviewBoard` (128–152) and `initializeTurn` (154–194) run the same
five-step board build in the same order: starting positions → walls → hazards →
fertile tiles → food. `initializeTurn` additionally lets a preset override each
of the last four. Two sequences that must agree, because the preview's whole
purpose is to show the board the game will actually be built on — and nothing
checks that they still do beyond `checkSnakeStartLocations.test.ts:379-383`,
which compares the unit positions only.

**Do:** one private method,

```ts
private buildBoard(presets: {
  positions?: { [playerID: string]: number }
  hazards?: number[]
  fertileTiles?: number[]
  food?: number[]
} = {}): {
  playerPieces: { [playerID: string]: number[] }
  hazards: number[]
  fertileTiles: number[]
  food: number[]
  teamClusterFallback: boolean
}
```

with the preset-or-generate ternaries from 184–194 applied to whichever presets
it is handed. `generatePreviewBoard` calls `this.buildBoard()`; `initializeTurn`
calls `this.buildBoard(usePreview ? {...this.gameSetup presets} : {})`.

**Why JUDGEMENT, not mechanical.** Three things must be got right and none is
visible from the signature:

* `initializeTurn` assigns `this.fertileTiles` (188) as a side effect;
  `generatePreviewBoard` must not. Keep the assignment at the `initializeTurn`
  call site, not inside `buildBoard`.
* The preset-positions branch (162–175) has a length guard and a fallback to
  `initializeSnakes()`, and it decides `teamClusterFallback` differently in each
  arm (`false` for presets, the generator's answer otherwise).
* Each preset is honoured only when non-empty (`presetHazards && length > 0`),
  which is not the same as "present".

**Special case removed:** two copies of the build order, which can drift silently
because only the unit positions are compared.
**Parameterised instead:** one build, taking the presets that override it.

**Lines:** −18 / +6. **Net −12.**

**Gate:** `checkSnakeStartLocations.test.ts` (its preview test at 379–383 is the
only thing comparing the two paths today) and `startGame.test.ts`. Weak. Consider
extending 379–383 to compare `hazards` and `fertileTiles` as well *before* doing
this — that extension is itself a safe standalone change, since it adds an
assertion to a property test rather than touching a fixture.

---

## 6–12: smaller items, same discipline

| # | Item | Files:lines | Removes | Δ | Gate | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| 6 | One "is a piece" predicate and one current-type resolver in the frontend | `board/turnToBoard.ts:104-111,228`; `board/renderer.ts:447-448`; `utils/unitGlyphs.tsx:22`; `pages/GamePage/GameFinished.tsx:58` | Four hand-written `unitType !== "snake"` tests and two copies of the `turn.unitTypes ?? setup.unitType ?? "snake"` fallback | −8/+3 | frontend `tsc -b` | MECHANICAL |
| 7 | One exhaustion-kind set | `board/turnToBoard.ts:65-68` vs `board/clashes.ts:202-205` | The same two-element `ReadonlySet<ClashKind>` defined twice in one directory; export `EXHAUSTION_KINDS` from `clashes.ts` and import it | −5/+1 | frontend `tsc -b` | MECHANICAL |
| 8 | `SnakeGameState.newHazards` | `TeamSnekProcessor.ts:48,363,502,614` | A copied array that is never mutated — hazards pass through from `currentTurn.hazards` unchanged | −4/+0 | goldens | MECHANICAL |
| 9 | Unreachable guard, redundant `await` | `processTurn.ts:332-335,339` | `if (!currentTurn)` after `currentTurn.winners` is dereferenced at 314; `await` on the synchronous `applyMoves` | −5/+1 | `processTurn.test.ts` | MECHANICAL |
| 10 | Three `gamePlayers.find` scans where the `teamOf` map is already built | `TeamSnekProcessor.ts:352,417,549`; `562-564` | An O(n²) roster scan per unit per turn, beside the `teamOf()` map constructed at 339; and `liveBoard`, which rebuilds the `BoardView` that `settled.board` already is | −12/+3 | goldens, `adjudication.spec.ts` | JUDGEMENT |
| 11 | `initializeFood`'s hand-rolled occupancy set → `freeCells` | `TeamSnekProcessor.ts:795-873` (vs `engine/spawn.ts:143-157`) | A fourth hand-built "what is occupied" set, in a method that already calls `getFreePositions` for its own fallback branch at 826 | −20/+8 | **none today** | JUDGEMENT |
| 12 | Placement extracted from the processor | `TeamSnekProcessor.ts:685-1487` | 800 lines of one-time board building — Perlin noise, hazard connectivity, radial slices, spawn geometry — living as private methods of the class that resolves turns, reachable only through `this` | 0 net, −800 from the processor | items 3 and 5 first | JUDGEMENT |

**On item 11.** `engine/VENDOR.md` is explicit that placement is *not* a rule and
stays with the caller, so `initializeFood` is in the right file. But its occupancy
set (801–813) is `freeCells`'s rule written a second time, and `freeCells` is
right there and already imported (923–931). The obstacle is that nothing tests
food placement: `checkSnakeStartLocations.test.ts` checks positions and parity,
never the centre-food or per-unit-diagonal rule. **Write that test first.** As it
stands this item has no gate, and an item with no gate is not on this list.

**On item 12.** A pure move, so the line delta is zero and the ranking is low —
but it is the item that changes how the file reads. Do items 3 and 5 first: they
remove the parameter threading and the duplicate build order, which is most of
what makes the move awkward today.

---

## Not proposed, and why

**`settlePartial.ts` does not duplicate `settleTurn.ts`'s phases.** The brief
asked whether the two phase lists could become one parameterised list. They
already are one: `settlePartial.ts:312-315` calls `settleTurn` and adds no phase
of its own. Everything below that line is the divergence ledger — `entangle`,
`absences`, the contingency closure, `regicideSpread`, `itemDivergences` — which
reads the settlement rather than recomputing it (`trackOf`, 510–560, is explicit
about this: *"read off the settlement rather than recomputed"*). The only rule
`settlePartial` states in its own terms is the regicide discharge (455–479), and
that is genuinely new information — a modelled king's fate — not a restatement.
There is nothing to factor here. Closed.

**`createNewGame.ts` does no board building.** The brief expected to compare it
with `engine/spawn.ts`. It builds a *lobby setup* — copies the previous setup,
clears `started`, deletes `gamePlayers`, decrements the tournament round — and
never touches a cell. The board building it was standing in for is
`TeamSnekProcessor.initializeTurn` / `initializeFood` / `generateHazardPositions`,
covered by items 3, 5 and 11. The one thing `createNewGame` could lose is its
duplicated setup literal (28–49), where the `previousSetup` and default arms
share seven keys — worth about four lines and not worth a numbered item.

**Wire fields that are written and never read.** `Turn.scores` (written
`TeamSnekProcessor.ts:665`), `Turn.teamScores` (666) and `Winner.score` (553)
have no reader anywhere: not in `functions/`, not in `frontend/`, and not in the
bot — where `Chris-Centaur/src/firebase/tactictoes-types.ts:143-147` says so
outright, having deliberately left `teamScores` untyped because the scoreboard
derives each team's score from the board it is rendering
(`Scoreboard.tsx:39-46`, `GameFinished.tsx:46-54`). Deleting them is the right
call eventually and it is **not proposed here**, because every golden fixture
carries all three on every turn and removing them means re-recording four
`.golden.json` files. That is a deliberate, separately-argued change, not a
cleanup to fold into a refactor.

**The frontend re-derives no rules.** `turnToBoard.ts` reads `turn.deaths`,
`turn.severedCells` and `turn.clashes` and draws doubt where a record is
incomplete rather than inferring (21–39, 301–319); `clashes.ts` branches on
`kind`, `victimIDs` and `survivorID` and never on occupancy or on the `reason`
string; `renderer.ts` reads `Turn.orientation` verbatim (426–434) and computes
only screen angles from it. Contests, severs, promotion and orientation are all
read, not recomputed. The only duplication is the piece predicate (item 6).

---

## Suggested order

Items 1 and 2 are independent of everything else and delete the most; do them
first and in either order. Item 4 is independent of 3 and 5. Items 3 → 5 → 12
form a chain and should run in that order. Items 6–9 are ten-minute changes that
can ride along with anything.

Running total if items 1–9 land: **−325 lines / +85**, net **−240**, with no
fixture re-recorded and no behaviour changed.
