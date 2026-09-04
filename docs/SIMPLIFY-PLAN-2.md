# Simplification plan 2 — after `docs/SIMPLIFY-PLAN.md` landed

All twelve items of the first plan are in. `expandTeams` has one body in
`shared/`, the two golden replays share `goldenReplay.ts`, the board geometry is
`BoardPlacement`'s, the dead-score pass is gone, and turn 0 and the lobby
preview run one `buildBoard`. `functions/src/gameprocessors/TeamSnekProcessor.ts`
is 637 lines instead of 1,500.

What is left is a different shape of leftover, and this is a ranked list of it.
The first plan looked at the server. This one looked outward, and found the
thing the owner asked to be told about: **one rule is still encoded outside
`engine/` — the frontend decides who won a game by re-sorting the board, and it
disagrees with `adjudicate` on the mutual-wipe branch.** That is item 1, and it
is not the biggest line delta on the list by a factor of forty.

Everything else is duplication: six copies of a test harness, three copies of a
per-unit-type map, two copies of every clash kind, and a debug renderer that
exists only so five tests can parse its output back.

Each item states the duplication or special case with file:line evidence, the
one abstraction that replaces it, the files touched, the gate, and whether it is
**Sonnet-mechanical** or needs **Opus**. The ranking is (special cases removed ×
lines deleted ÷ risk), except that item 1 is promoted above its line count
because "a second encoding of a rule" is a term the line count does not measure.

**No item changes a Firestore document shape, and no item re-records a golden.**
Where a change would do either it is under "Not worth it", with the reason.

## The gates

Baseline on `tt-audit-2` at `526ff4f`: **21 suites, 352 tests, all passing**
(`npm --prefix functions test`, 36s).

| Gate | Command | What it catches |
| --- | --- | --- |
| Golden replays | `npm --prefix functions test -- settlementReplay pieceReplay` | Any change to a produced turn. **Six** fixtures now, byte-for-byte: `settlementReplay{,.leanfood,.spawners,.window8}.golden.json` and `pieceReplay{,.spawner}.golden.json`. |
| Partial enumeration | `npm --prefix functions test -- settlePartial` | T1–T5 over ~1,200 random boards, oracle `settleTurn`. |
| Vendor contract | `npm --prefix functions test -- engineVendor` | `engine/` importing outside itself, `require(`, `Math.random`, `Date.now`, the exact file list, and a standalone compile with no `node_modules`. |
| Placement properties | `npm --prefix functions test -- checkSnakeStartLocations startGame` | Spawn parity, minimum distance, slice assignment, cluster fallback — and, since plan 1 item 5, the preview/turn-0 agreement on hazards, fertile tiles and food (`checkSnakeStartLocations.test.ts:388-390`). |
| Turn-0 food | `npm --prefix functions test -- foodPlacement` | The centre-food rule and the per-unit diagonal, exactly (plan 1 item 11's test). |
| Frontend types | `cd frontend && npx tsc -b && npx vite build` | Every frontend item. **There are no frontend tests**, which is priced into the ranking below and is why items 1 and 4 differ in kind. |

The golden replays still never call `firstTurn` — they drive `applyMoves` from a
hand-built turn 0 — so anything touching placement or turn 0 is gated by the
property tests and `foodPlacement` only. Items 6 and 8 say so where it bites.

---

## 1. The frontend decides who won. `adjudicate` already did.

**Opus.** Small, and the most important item on the list.

| File | Lines |
| --- | --- |
| `frontend/src/pages/GamePage/GameFinished.tsx` | 34, 52–55, 67, 69–72 |

`engine/adjudicate.ts` is the single encoding of "who has won, on which board,
and at what weight". Its own header (lines 5–10) says the rule had three
implementations that *"disagreed about the branch that is hardest to reach on
purpose — the mutual wipe, where nobody is left on the settled board and the
outcome comes off the PREVIOUS committed turn."* The server writes that verdict
to the wire as `Turn.winners`.

`GameFinished.tsx` reads `latestTurn.winners` at line 34 — and then uses it for
**nothing but the MMR column**. The winner and the draw are recomputed:

```ts
// GameFinished.tsx:52-55
teamScore: teamUnits.reduce(
  (total, gp) => total + (latestTurn.playerPieces[gp.id]?.length ?? 0), 0),
// :67-72
const sortedTeams = teamResults.sort((a, b) => b.teamScore - a.teamScore)
const draw = sortedTeams.length > 1 &&
  sortedTeams[0].teamScore === sortedTeams[1].teamScore
const winningTeam = !draw && sortedTeams.length > 0 ? sortedTeams[0] : null
```

That is `heaviestTeams` (`adjudicate.ts:165-172`) plus the tie test, written a
fourth time, against **the settled board only**. It is wrong on exactly the
branch `adjudicate.ts` was written to fix:

* `kind: "all-eliminated"`, `decidedOn: "previous"` — every remaining team dies
  on the same turn. `applySettlement` prunes the dead from `newSnakes`
  (`TeamSnekProcessor.ts:361-366`) so `Turn.playerPieces` is empty for every
  team; `winnerRows` takes its squares from `previousBoard()`
  (`TeamSnekProcessor.ts:503-504`) and writes a real winner to `winners`.
  The frontend sums the empty board, gets 0 for everyone, and prints
  **"It's a draw. Lame."** over a game the server awarded — and awarded MMR for,
  which the same table then displays. `adjudication.spec.ts` carries a corpus row
  for this branch, so it is reachable and pinned server-side.
* `kind: "turn-limit"` and `kind: "last-team"` happen to agree, because a dead
  team weighs 0 on the settled board too. Two of four branches right is what a
  re-derivation looks like.

**Do:** take the verdict from the wire.

```ts
const winningTeamIDs = new Set(winners.map((w) => w.teamID))
const draw = winningTeamIDs.size !== 1
const winningTeam = sortedTeams.find((t) => winningTeamIDs.has(t.teamID)) ?? null
```

Keep the board-derived `teamScore` as the **displayed** number — it is a score
column, not a verdict, and reading it off the board is what makes an old log
render correctly (the comment at 47–51 is right about that). Only the two lines
that *decide* change. `winners` is non-empty by the guard at line 35, so
`winningTeamIDs.size === 0` cannot occur and `size > 1` is the engine's own draw.

**Special case removed:** a fourth implementation of the winner rule, and the
"everybody weighs 0, so nobody won" branch it gets wrong.
**Parameterised instead:** nothing. `adjudicate` already ran; the answer is on
the wire and is read.

**Lines:** −6 / +4. **Net −2.**

**Gate:** `cd frontend && npx tsc -b`, and there it stops — there are no frontend
tests. So this one is verified by reading, which is why it is Opus: the
reviewer has to satisfy themselves that `winners` is empty exactly when the game
has not ended (`TeamSnekProcessor.ts:497-498`, `settleTurn.ts:330`) and that
`winnerRows` emits a row per PLAYER of a winning team, so several rows can carry
one `teamID` — hence the `Set`. Server-side, `adjudication.spec.ts` already pins
what `winners` contains in all five endings; nothing there changes.

**Related, and deliberately NOT changed:** `Scoreboard.tsx:45-46` sums living
weight per turn. That is a live, scrubbable score display, not an adjudication,
and its header (20–26) says so. It stays. Both files' comments do name a method
that no longer exists — `TeamSnekProcessor.getTeamScore`
(`Scoreboard.tsx:41`, `GameFinished.tsx:48`) — fix the reference while you are in
there.

---

## 2. One scenario runner for the six processor test harnesses

**Sonnet-mechanical.** The biggest deletion on the list.

| File | Scaffold lines |
| --- | --- |
| `functions/src/gameprocessors/turnEngine.spec.ts` | 25–101 (77) |
| `functions/src/gameprocessors/chessPieces.test.ts` | 19–111 (93) |
| `functions/src/gameprocessors/adjudication.spec.ts` | 39–116 (78) |
| `functions/src/gameprocessors/potions.test.ts` | 29–104 (76) |
| `functions/src/gameprocessors/TeamSnekProcessor.spec.ts` | 13–85 (73) |
| `functions/src/gameprocessors/headToHead.test.ts` | 15–87 (73) |
| `functions/src/gameprocessors/processTurn.test.ts` | 122–183 (62) |
| `functions/src/checkSnakeStartLocations.test.ts` | 20–107 (88) |
| `functions/src/gameprocessors/foodPlacement.test.ts` | 34–64 (31) |
| `functions/src/gameprocessors/settlementReplay.spec.ts` | 106–126 (21) |
| `functions/src/gameprocessors/pieceReplay.spec.ts` | 165–182 (18) |
| perimeter builders | `queries.spec.ts:28-39`, `resolveTurn.spec.ts:13-25`, `settlePartial.spec.ts:58-67`, `potions.test.ts:93-104` (47) |

Every one of these files builds the same four things by hand: a
`StartedGameSetup`, a `Turn`, a `GameState` and a `Move`. `headToHead.test.ts:43-66`
and `potions.test.ts:50-75` are **character-for-character identical** including
the comment *"Every unit carries an orientation; irrelevant here…"*;
`processTurn.test.ts:143-166` is the same body again; `TeamSnekProcessor.spec.ts:34-65`,
`chessPieces.test.ts:42-68` and `adjudication.spec.ts:66-90` are the same body
with the two-line `orientation` override instead of the one-line one. The four
`mkGameState` bodies differ only in whether they take one turn or an array, and
two of them pad the history with `Array(turnsPlayed - 1).fill(turn)` under
comments that say the same thing twice
(`TeamSnekProcessor.spec.ts:64-66`, `adjudication.spec.ts:92-97`).

The abstraction is **already written and already proven**:
`turnEngine.spec.ts:46-101` takes a `Scenario { players, pieces, moves, turn?,
setup?, turnsBefore? }` and returns the produced turn. `chessPieces.test.ts:93-111`
is the same function with positional arguments; `adjudication.spec.ts:120-137`
declares the same record under the name `Fixture`. Three copies of one runner,
on top of six copies of the pieces it is built from.

**Do:** new `functions/src/gameprocessors/playTurn.ts` — a test helper beside
`goldenReplay.ts`, so it is outside `engine/` and the vendor spec does not
apply, and named so Jest's default `testMatch` ignores it (as `goldenReplay.ts`
already is):

```ts
export interface Scenario {
  players: GamePlayer[]
  pieces: { [playerID: string]: number[] }
  moves: Move[]
  turn?: Partial<Turn>
  setup?: Partial<StartedGameSetup>
  turnsBefore?: number
}
export const mkTeams: (...ids: string[]) => Team[]
export const gp: (id, teamID, letter, unitType?) => GamePlayer
export const mv: (playerID: string, move: number, atMillis?: number) => Move
export const mkSetup: (over: Partial<StartedGameSetup>) => StartedGameSetup
export const mkTurn: (pieces, over?: Partial<Turn>) => Turn
export const mkGameState: (setup, turns: Turn | Turn[], turnsPlayed?) => GameState
export const perimeter: (w: number, h: number) => number[]
export const at: (w: number) => (x: number, y: number) => number
export const play: (scenario: Scenario) => Turn      // verbatim from turnEngine.spec.ts:55-101
```

`play` is lifted verbatim; `mkSetup` takes the board size as an override
(`boardWidth`/`boardHeight` default 7, which is what four of the six files use)
and `gamePlayers` either explicitly or via `expandTeams`. Each spec file then
keeps only its `W`, its `at(W)`, and its scenarios.

`settlementReplay.spec.ts` and `pieceReplay.spec.ts` keep their own `mkSetup`
overrides but take the base from here; `checkSnakeStartLocations.test.ts` and
`foodPlacement.test.ts` replace `createGameState`/`createTeamGameState`/`mkState`
with `mkGameState(mkSetup({...}), [])`.

**Special case removed:** six declarations of one `Turn`, four of one
`GameState`, three of one scenario runner, and five hand-rolled board
perimeters — nine files that must agree about what a turn document looks like
for their assertions to mean the same thing.
**Parameterised instead:** one `Scenario`, one `play`.

**Lines:** −430 / +170. **Net −260.**

**Gate:** the whole `functions` suite, unchanged — 21 suites, 352 tests, and
**both golden replays byte-identical against unrecorded fixtures**. That is the
right gate: the helper is only correct if every existing assertion still holds,
and `UPDATE_GOLDEN=1` must not be run. Do it file by file, running the suite
after each, so a break names its own file.

---

## 3. `visualizeBoard`, and the five tests that parse its output back

**Sonnet-mechanical.**

| File | Lines |
| --- | --- |
| `functions/src/gameprocessors/TeamSnekProcessor.ts` | 605–636 |
| `functions/src/checkSnakeStartLocations.test.ts` | 109–194 |

`visualizeBoard` (31 lines of production code in the class that resolves turns)
has **no production caller**. Its only five callers are tests, and each of them
renders the board to an ASCII string and then parses the string back with
`split("\n")`, `split(" ")` and `match(/[1-8]/)` to assert a fact that
`Turn.playerPieces` states directly:

* `:113-116` — board is `height` lines of `width` tokens. That is
  `gameSetup.boardWidth/boardHeight`, which the test itself supplied.
* `:123-124` — count `/[1-4]/g` matches to check four players are placed. This
  works only by accident: a snake is three cells at ONE index, and the renderer
  overwrites `board[y][x]`, so three body cells count once. `Object.keys(turn.playerPieces).length`
  is the assertion.
* `:131-141` — spawn parity, by scanning tokens for digits and testing `(x+y)%2`.
  Directly: `indexToXY(pieces[id][0])`.
* `:147-163` — "near the edges", the same scan.
* `:177-193` — both of the above again, over four board sizes.

A debug renderer kept alive in production so five tests can read a game state
they already hold is the definition of a test that pins structure.

**Do:** delete `visualizeBoard` and rewrite the five assertions against
`initializedGame.playerPieces` and the `getPositionMap` helper the same file
already has at `:94-107`.

**Special case removed:** a second, lossy projection of the board, and five
tests written against it instead of against the board.
**Parameterised instead:** nothing — the tests read the data structure.

**Lines:** −95 / +30. **Net −65.**

**Gate:** `checkSnakeStartLocations.test.ts` itself — the five tests keep their
names and their meanings, and the other twelve tests in the file (spawn parity,
minimum distance, slice assignment, cluster fallback, preview agreement) are
untouched and already assert against `playerPieces`. Then the whole suite, since
`visualizeBoard` is `public`.

---

## 4. One declaration per setup field in the lobby, not three

**Opus** — hook ordering around an early return is the judgement call.

| File | Lines |
| --- | --- |
| `frontend/src/pages/GamePage/GameSetup.tsx` | 334–388, 519–550, 664–853 |

Fifteen setup fields, each stated three times:

1. a `useState` initialiser with its default — `:344` `gameSetup?.hazardDamage ?? 100`;
2. a setter in the "update local state when gameSetup changes" effect — `:534`
   `setHazardDamage(gameSetup.hazardDamage ?? 100)`, the **same default written
   again**, nine times over (`?? 100` twice, `?? 30` twice, `?? 10` twice,
   `?? 0.5`, `?? 0.15`, `?? 1`);
3. a `setLocal:` line in the `setupNumberField`/`setupToggleField` call — `:765`.

The factories at `:664-702` are already the right idea; the state they mirror is
what has not been factored. A default changed in one place and not the other is
a lobby that shows a number the server does not play by, and nothing catches it.

**Do:** one table and one hook, above the early return at `:584`:

```ts
const SETUP_DEFAULTS = {
  hazardPercentage: 0, hazardDamage: 100,
  teamClustersEnabled: false,
  fertileGroundEnabled: false, fertileGroundDensity: 30, fertileGroundClustering: 10,
  foodSpawnRate: 0.5, foodEnergy: 100,
  invulnerabilityPotionEnabled: false, invulnerabilityPotionSpawnRate: 0.15,
  pawnPromotionWeight: 10,
  maxEnergyPerUnit: {} as UnitMaxEnergy,
  tournamentMode: false, remainingRounds: 1, interludeDuration: 30,
} as const

// value mirrored from the doc, and the setter the field handlers call.
const useSetupField = <K extends keyof typeof SETUP_DEFAULTS>(
  setup: GameSetup | null, key: K,
): [(typeof SETUP_DEFAULTS)[K], (v: (typeof SETUP_DEFAULTS)[K]) => void] => { ... }
```

one `useSetupField(gameSetup, "hazardDamage")` per field, and the sync effect at
`:519-550` loses every line except the two that are genuinely special: the
board-size preset match (`:521-532`) and `maxTurns`, whose `null` is an opt-out
rather than a default (`:334-339`, `:524-529`, `:724-751`). Leave both
hand-written.

**Special case removed:** fifteen fields × three statements, and nine defaults
written twice each, with nothing to notice when a pair diverges.
**Parameterised instead:** one defaults table, one hook.

**Lines:** −87 / +42. **Net −45.**

**Gate:** `cd frontend && npx tsc -b && npx vite build`, plus opening the lobby
and changing each control once. Opus because `useSetupField` must be called
unconditionally and before `if (!gameSetup) return null` (`:584`) — the hook
therefore takes `GameSetup | null` and the handlers below the return keep
reading the values it produced. Getting that order wrong is a runtime hook
error, not a type error, and there is no test to catch it.

---

## 5. One clash-kind table instead of two switches and a hand-written set

**Sonnet-mechanical.**

| File | Lines |
| --- | --- |
| `frontend/src/board/turnToBoard.ts` | 43–59 |
| `frontend/src/board/clashes.ts` | 141–164, 167–192 |

`ClashKind` has nine members (`shared/types/Game.ts:213-222`). The frontend
lists them three more times: `KNOWN_KINDS` as a hand-written `Set` of the nine
strings (`turnToBoard.ts:44-54`), and two `switch` statements with a `default`
(`clashHeadline` 141–164, `deathHeadline` 167–192). Because both switches have a
`default`, **TypeScript cannot tell anyone a kind is missing**: add `"drowned"`
to the wire and the board silently renders it as `"unknown"` with the note *"a
cause this board does not know"* — which is the honest fallback for a kind from
a newer server, and the wrong answer for one this build knows about.

**Do:** two `Record`s keyed by `BoardClashKind`, and derive the set:

```ts
// clashes.ts
export const CLASH_HEADLINE: Record<BoardClashKind, string> = { contest: "…", …, unknown: "Unrecorded event" }
export const DEATH_HEADLINE: Record<BoardClashKind, string> = { … }
export const clashHeadline = (kind: BoardClashKind) => CLASH_HEADLINE[kind]
export const deathHeadline = (cause: BoardClashKind) => DEATH_HEADLINE[cause]

// turnToBoard.ts
const KNOWN_KINDS: ReadonlySet<string> =
  new Set(Object.keys(CLASH_HEADLINE).filter((k) => k !== "unknown"))
```

A `Record<BoardClashKind, string>` is exhaustive by construction, so a kind
added to `shared/types/Game.ts` breaks the frontend build in two places and the
`KNOWN_KINDS` set follows for free.

**Special case removed:** three hand-maintained copies of one enum, none of
which the compiler checks.
**Parameterised instead:** two exhaustive tables and one derived set.

**Lines:** −62 / +26. **Net −36.**

**Gate:** `cd frontend && npx tsc -b`. Strong here, unusually: the whole point
is that the type checker starts enforcing what the switches did not. Verify by
adding a tenth member to `ClashKind` locally and confirming the build fails.

---

## 6. Facts fixed at game start, computed once — and turn 0's score read off the board

**Sonnet-mechanical**, with one prerequisite (below).

| File | Lines |
| --- | --- |
| `functions/src/gameprocessors/TeamSnekProcessor.ts` | 38–40, 172–176, 268–279, 304–306, 405–409, 411–424, 330–331, 452, 473–474 |

Plan 1 item 10 built `teamOf` once in the constructor because scanning
`gamePlayers` per unit per turn was O(n²). Four more scans of the same fixed
roster survive:

* `regicideTeamIDs()` (268–279) filters `gamePlayers` for `unitType === "king"`
  on **every turn**, and `settleInput` (304–306) filters `gamePlayers` for
  `unitType === "king"` again, three lines later, into a different shape. Two
  scans of one predicate per turn. Kings never change kind — the comment at
  269–270 says so — so both belong beside `teamOf` at 107.
* `hasPieceUnits()` (405–409) scans on every call; called at 221 and 571.
* `spawnOrientation` (411–424) is a 14-line private method that forwards to
  `pickSpawnOrientation` with `{ next: () => Math.random() }`, from **one call
  site** (188). Inline it.
* `SnakeGameState.boardWidth` / `boardHeight` (38–40) are copied from
  `this.gameSetup` at 452/473–474 and read at exactly two places (330–331) —
  where `this.gameSetup` is in scope anyway. The field pair is a third name for
  a number the class already holds.

And one restatement of a rule inside the file that owns it:

* `initializeTurn` writes `initialScores[player.id] = isPieceType(player.unitType) ? 1 : 3`
  (172–176), which is the spawn-weight rule — *"snakes spawn as a stacked
  triple; chess pieces as a single square"* — already stated twice in
  `placement.ts` (`:61` and `:102-104`). It is `playerPieces[player.id].length`,
  which is exactly what `createNewTurn` writes for every later turn (`:540`).

**Do:**
1. Constructor: `private readonly kings: Set<string>`,
   `private readonly regicideTeams: string[]`, `private readonly pieceGame: boolean`,
   built from `gameSetup.gamePlayers` beside `teamOf` (107).
2. Delete `regicideTeamIDs()`, `hasPieceUnits()` and `spawnOrientation()`; read
   the fields, and call `pickSpawnOrientation(...)` directly at 188.
3. Delete `boardWidth`/`boardHeight` from `SnakeGameState`; read
   `this.gameSetup` at 330–331.
4. `initialScores[player.id] = playerPieces[player.id].length`.

**Special case removed:** five restatements of facts the setup fixes at game
start, and a third copy of the spawn-weight rule.
**Parameterised instead:** the constructor already reads the setup once; these
join what is already there.

**Lines:** −47 / +12. **Net −35.**

**Gate:** the whole suite. `chessPieces.test.ts` (regicide, kings, promotion),
`adjudication.spec.ts`, `settlePartial.spec.ts` and both goldens cover 1–3.
**Step 4 has no gate today** — nothing asserts turn 0's `scores`
(`grep -rn "scores" functions/src` finds no `firstTurn().scores` assertion), and
the goldens never call `firstTurn`. So do what plan 1 item 11 did: **add the
assertion first**, one line in `foodPlacement.test.ts` or
`checkSnakeStartLocations.test.ts` — `expect(turn0.scores).toEqual(...)` for a
mixed snake/piece roster — as a standalone change, then make the edit. An item
with no gate is not on this list.

---

## 7. One per-unit-type map, not four

**Sonnet-mechanical.**

| File | Lines |
| --- | --- |
| `shared/types/Game.ts` | 46–66 |
| `frontend/src/board/renderer.ts` | 18–27 |
| `frontend/src/board/turnToBoard.ts` | 199 |
| `functions/src/gameprocessors/engine/resolveTurn.ts` | 61 (optional) |

`UnitCounts` (47–55) and `UnitMaxEnergy` (58–66) are two nine-line interfaces
that list the same seven keys with the same `?: number` type. They are
`{ [K in UnitType]?: number }` — which `resolveTurn.ts:61` already writes out as
a mapped type for the same map. And `renderer.ts:18-27` re-declares `UnitType`
under the name `UnitIconKey`, member for member, forcing the cast at
`turnToBoard.ts:199` (`unitType as UnitIconKey`).

**Do:**

```ts
// shared/types/Game.ts
export type PerUnitType<T> = { [K in UnitType]?: T }
export type UnitCounts = PerUnitType<number>     // absent → snakesPerTeam snakes
export type UnitMaxEnergy = PerUnitType<number>  // absent → 100
```

and `export type UnitIconKey = UnitType` in `renderer.ts` (it already depends on
`@shared/types/Game` transitively through `../utils/unitTypes`), dropping the
cast. Optionally point `ResolveTurnInput.maxEnergy` at `UnitMaxEnergy`; it is
structurally identical, `engine/` may import `@shared/types/Game`, and the
vendor compile covers it — but it is an engine edit, so it is listed under
"engine-internal" below rather than assumed here.

**Special case removed:** four hand-written enumerations of the seven unit
kinds, in three projects.
**Parameterised instead:** one mapped type over `UnitType`.

**Lines:** −26 / +5. **Net −21.**

**Gate:** the whole `functions` suite (the types are load-bearing in
`settleInput`, `expandTeams` and `startGame`) plus `cd frontend && npx tsc -b`.
Purely structural, so a type error is the only possible failure mode and it is
a compile-time one.

---

## 8. `placement.ts`: one shuffle, one occupancy set, no dead parameters

**Sonnet-mechanical.**

| File | Lines |
| --- | --- |
| `functions/src/gameprocessors/placement.ts` | 110–114, 340–347, 365–371, 433–438, 742–751 |

Three leftovers from the extraction:

* `generateHazardPositions` shuffles its candidates with an inline Fisher–Yates
  at 340–347 — while `shuffleArray` (742–751) sits in the same class doing the
  identical algorithm with the identical `Math.random` consumption per step. The
  only difference is in place versus copy, which nothing depends on:
  `candidatePositions` is a fresh array from `getFreePositions`.
* `ensureInitialSafeMoves` (365–371) and `ensureConnectedBoard` (433–438) each
  open with the same six lines: `new Set(hazards)`, `new Set(this.walls)`, and a
  fold of `playerPieces` into an `occupied` set. One `private occupancyOf(playerPieces)`.
* `generateFertileTiles(walls, hazards, _playerPieces)` (110–114) takes a
  `walls` argument that is always `this.walls` (its only call site, 81) and a
  `_playerPieces` it does not use. Both go.

**Special case removed:** a second shuffle, a second "what is occupied" fold,
and two parameters that carry no information.
**Parameterised instead:** the class already holds the setup and the perimeter;
these read them.

**Lines:** −24 / +5. **Net −19.**

**Gate:** `checkSnakeStartLocations.test.ts`, `startGame.test.ts`,
`foodPlacement.test.ts`. Weaker than the goldens, because the goldens do not
call `firstTurn` — so the shuffle change is the one to be careful with. It is
safe on inspection (same loop bounds, same `Math.floor(Math.random() * (i+1))`,
same swap), and `checkSnakeStartLocations.test.ts`'s
`withStubbedRandom` preview/turn-0 test at 375–391 compares two full builds
under a pinned RNG, which would catch a changed draw order.

---

## 9. Small items, same discipline

| # | Item | Files:lines | Removes | Δ | Gate | Kind |
| --- | --- | --- | --- | --- | --- | --- |
| 9a | Three dead exports | `frontend/src/board/clashes.ts:95-104` (`inspectableCellKeys` — `isInspectable` is what callers use); `frontend/src/dev/boardFixtures.ts:620-621` (`BOARD_WIDTH`, `BOARD_HEIGHT`); `shared/types/Game.ts:149-151` (`UserProfile`, no importer) | Code with no caller anywhere in the repo. `UserProfile` documents a real document shape written at `frontend/src/context/UserContext.tsx:29-33` and read at `GameSetup.tsx:412` — so either annotate those two sites with it or delete it, but do not leave it floating | −16/+2 | frontend `tsc -b`, functions suite | Sonnet |
| 9b | One invite writer in `centaurGameMeta` | `functions/src/utils/centaurGameMeta.ts:79-93, 95-105, 124-142` | Three copies of "write/delete `centaurs/{id}/games/{gameID}`, catch, `logger.error` with the same three context keys". One `inviteRef(centaurId, gameID)` and one `bestEffort(label, context, fn)` | −18/+8 | `centaurGameMeta.test.ts` | Sonnet |
| 9c | `buildCentaurPlayerMap` is `teamOf` | `functions/src/utils/centaurGameMeta.ts:21-29` vs `TeamSnekProcessor.ts:107` | The same `{ [unitID]: teamID }` map built twice, under two names, from the same field | −6/+1 | `centaurGameMeta.test.ts`, `startGame.test.ts` | Sonnet |
| 9d | Subscription boilerplate in the game context | `frontend/src/context/GameStateContext.tsx:79-188` | Five `useFirestoreSubscription` calls repeating `onError: setError`, `onQueryTimeoutChange: setQueryTimedOut` and a `timeoutMessage`/`errorMessage` pair that is the label with fixed text around it. One local `subscribe(label, buildTarget, deps, onSnapshot, extra?)` deriving both messages from `label` | −18/+8 | frontend `tsc -b` + open a game | Sonnet |
| 9e | Two stale comment references | `frontend/src/pages/GamePage/Scoreboard.tsx:41`, `GameFinished.tsx:48` | Both cite `TeamSnekProcessor.getTeamScore`, a method that no longer exists. Point them at `engine/adjudicate.ts::weighTeams` | 0 | none | Sonnet |

---

## Engine-internal candidates (listed separately, as asked)

`engine/`'s public surface and file set do not change in this plan. These are
strictly inside the module, and each keeps every test and the vendor compile
green. They are listed rather than ranked, because two of the three need a
ruling from the owner on what counts as "the public surface".

**E-a. "Max energy for a kind", written three times.** `resolveTurn.ts:156-158`
builds a `maxEnergyFor` closure; `settleTurn.ts:278` writes
`input.maxEnergy?.queen ?? input.defaultMaxEnergy ?? 100` by hand;
`claims.ts:541-542` writes `input.maxEnergy?.[k] ?? defaultMax` with its own
`?? 100`. Three statements of one lookup, and the `?? 100` default in all three.
The same is true of `foodEnergy`: `resolveTurn.ts:159` and `claims.ts:544`.
The fix is one helper in `resolveTurn.ts` imported by the other two — **but any
new `export` in an engine file widens the module's surface**, even one nobody
outside vendors. Needs the owner's ruling before it is done.
**Δ −8/+4.** Gate: `settlePartial`, `resolveTurn.spec`, `chessPieces` (the
per-type max-energy block at 1230–1368), both goldens, `engineVendor`.

**E-b. `ResolveTurnInput.maxEnergy` as `UnitMaxEnergy`.** `resolveTurn.ts:61`
writes `{ [K in UnitType]?: number }` inline; item 7 gives that type a name in
`@shared/types/Game`, which `engine/` is already allowed to import. Structurally
identical, so nothing about the surface changes in fact — only in spelling.
**Δ −1/+1.** Gate: `engineVendor` (the standalone compile copies
`shared/types/Game.ts`, so the alias travels).

**E-c. Nothing else.** `settlePartial.ts` (1,391 lines) was read for repeated
phases and has none: `settlePartial:312-313` calls `settleTurn` and every
function below it — `entangle`, `absences`, `regicideSpread`, `scheduleSpread`,
`itemDivergences`, `grammarDivergences`, `derivedDivergences` — reads the
settlement rather than recomputing it. `turnEngine.ts`, `adjudicate.ts`,
`spawn.ts`, `queries.ts` and `moveGrammar.ts` carry no duplicated block worth a
line. `legalActions` (`queries.ts:161-182`) already collapsed
`legalTargets`/`coverOf`/`rotationTargets` into one sweep. Closed.

---

## Not worth it, and why

**`Turn.scores`, `Turn.teamScores` and `Winner.score` still have no reader —
and still should not be deleted here.** Re-checked: `Turn.scores` and
`Turn.teamScores` are read only by tests (`TeamSnekProcessor.spec.ts:384-385`,
`turnEngine.spec.ts:121-122`, `chessPieces.test.ts:792`, `pieceReplay.spec.ts:321`);
the frontend derives both from the board it is rendering
(`Scoreboard.tsx:45-46`, `GameFinished.tsx:52-55`). `Winner.score`
(`TeamSnekProcessor.ts:512`) has no reader at all. But `Winner.teamScore` **is**
load-bearing — `processTurn.ts:146` sorts MMR placements by it — so this is not
a clean sweep of a struct, and the other three are on the wire. Deleting them
changes a Firestore document shape a production bot may read, and re-records
**six** golden fixtures. That is a deliberate, separately-argued change with an
owner decision in it, not a cleanup.

**Two subscriptions that do not fit `useFirestoreSubscription`.**
`SessionPage.tsx:23-82` runs a transaction and only then subscribes, with a
`cancelled` flag for the effect torn down mid-flight; `usePlayerInfo.ts:38-56`
fans out one document listener per id **on purpose** — its comment (9–16)
explains that a batched `where('__name__','in',…)` would be a `list` under
`firestore.rules:286-287` and would lock signed-out `/ladder` visitors out.
Forcing either into the hook would add a mode to the hook to serve one caller.
Leave both.

**`frontend/src/board/renderer.ts` (2,897 lines).** Scanned for repeated draw
code. It is already table-driven where it can be: `UNIT_ICONS` is a
`Record<UnitIconKey, IconLayer[]>` (591), `STAT_MARK` is a
`Record<MarkName, DrawnMark>` (931) explicitly so *"a mark can never be measured
from one path and painted from another"*, and the death/sever/recovery/uncertainty
marks share `markGeometry` (1933). What is left is per-mark geometry, which is
not duplication. Nothing rule-shaped: it reads `Turn.orientation` verbatim
(427–445) and computes only screen angles from it.

**`frontend/src/dev/boardFixtures.ts` (621 lines) and its page.** Not junk. It
has its own dev entry (`dev-fixtures.html`, `fixturesMain.tsx:10-18`), the
production build never names it, and it exists so the board's marks can be
reviewed without a project or a game. Keep.

**The frontend's lobby defaults versus the engine's.** `GameSetup.tsx` writes
`?? 0.5`, `?? 0.15`, `?? 10`, `?? 100` and `DEFAULT_MAX_TURNS = 100` (`:68`) as
bare literals for values the engine already names —
`spawn.ts:61,63`, `moveGrammar.ts:21`, `resolveTurn.ts:145`, `adjudicate.ts:55`.
A lobby default that disagrees with the engine's is a lobby that lies about the
game it is configuring. Item 4 removes the **doubled** statement inside
`GameSetup.tsx`; closing the frontend↔engine gap as well would need either an
engine export the frontend imports (widening the module's surface, and pulling
`engine/` into the Vite build) or a third `shared/` runtime module that restates
them and can drift the same way. Neither is obviously right. Flagged for the
owner, not proposed.

**`shared/types/Game.ts` does not duplicate the engine's types.** Checked
member by member: `ResolveUnit`, `BoardView`, `GrammarUnit`, `SpawnState` and
`EngineUnit` are engine-shaped views over a roster, not wire records — the wire
has no `tier`, no `path`, no `leavesTrail`. The one real overlap is
`Orientation`: declared in `moveGrammar.ts:14-17`, inline in
`shared/types/Game.ts:192`, and again in `renderer.ts:13-16`. Three declarations
of `{dx, dy}`. Naming it once in `@shared/types/Game` and importing it in both
places is correct, and is worth about four lines — below the bar for a numbered
item, and it touches an engine file, so it belongs with E-b if that ruling
comes back yes.

**`firestore.rules` states no rule of play.** `isValidPrivateMove`
(`firestore.rules:141-148`) checks types and ownership and stops; nothing there
knows what a legal move is. Correct as it stands.

**`createNewGame.ts`'s duplicated setup literal** (`:28-49`, seven shared keys
between the `previousSetup` and default arms) is still about four lines and
still not worth a numbered item.

---

## Suggested order

Item 1 first: it is two lines, it is a correctness fix, and it is the one thing
on this list the owner asked to be told about. Item 2 next and on its own — it
touches eleven test files and wants the suite green after each — and it makes
items 3 and 6 easier, because both edit files item 2 has already thinned.
Items 5, 7 and 9a are ten-minute changes that ride along with anything. Item 4
is independent of everything and is the only one with no automated gate at all,
so schedule it when someone can click through the lobby.

Running total if items 1–8 and 9a–9d land: **−795 lines / +302**, net **−493**,
with no fixture re-recorded, no document shape changed, and one wrong answer on
the mutual-wipe branch fixed.
