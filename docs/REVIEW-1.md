# Review 1 — correctness pass over `claude/succession-doc-subagent-orchestration-n41iua` (PR #24)

Scope: `git diff origin/develop...HEAD`. Correctness only; two simplification
plans have already run over this branch and style is not reviewed here.

Gates run on every commit: `npm --prefix functions test` (21 suites, 352 tests
at the baseline, 355 with the two tests this review added, 356 with the
outcome bracket's and 358 with the two the verdicts below added; the
byte-for-byte goldens are unchanged and were never re-recorded), and, for the
frontend files, `cd frontend && npm ci && npx tsc -b && npx vite build`.

---

## 1. Confirmed and fixed

Two, both in the new partial-settlement path, both demonstrated against
`settleTurn` as the oracle and both with a test that fails without the fix.

| # | Where | Defect |
|---|-------|--------|
| 1 | `functions/src/gameprocessors/engine/settleTurn.ts` (expiry phase) | The expiry phase purged every effect whose owner was not on the roster it was handed. `settlePartial` hands `settleTurn` only the units whose moves are KNOWN, so a held unit is off the roster and squarely on the board — its entire invulnerability schedule was deleted on any turn where anything expired at all, and every window it was carrying then stayed open for the rest of the game. The death filter at the top of the function already removes the effects of everything that died, so the pass was redundant for `settleTurn`'s own callers and wrong for `settlePartial`'s. |
| 2 | `functions/src/gameprocessors/engine/settlePartial.ts` (tier hand-back) | A held unit's tier was passed straight through as the one it carried into the turn. That is right about the pickup and wrong about the WINDOWS: an effect lapses on the clock, and on the ally-buff cancel a modelled team-mate triggers, and neither reads anything the held unit chose. `settleTurn` closed them and dropped the entries but could not credit the level back, because it keeps tiers only for units on its roster — so the debuff wore off the board and never wore off the unit. The level is now read off what settlement DROPPED, not off a second reading of the expiry rule. |

Tests added beside the module's existing ones, in
`functions/src/gameprocessors/settlePartial.spec.ts`, under
`describe("a held unit's invulnerability schedule survives the turn")`:

- *keeps it when the unit is held, exactly as the oracle keeps it* — and
- *keeps it in every world the held unit could have chosen* (enumerated), and
- *gives the level back when the held unit's own window closes*.

Both defects are introduced by this PR in the sense that matters: the offending
line in `settleTurn` predates it, but `settlePartial` is new and is the first
caller ever to hand `settleTurn` a partial roster.

---

## 2. Wire-shape changes vs `develop`, with their readers

Three, all in `shared/types/Game.ts`. Every other apparent field change in that
file is the `UnitCounts`/`UnitMaxEnergy` interfaces collapsing into
`PerUnitType<T>` — the same shape, written once.

### 2.1 `Turn.playerHealth` → `Turn.playerEnergy` (REQUIRED field, renamed)

`shared/types/Game.ts:150`. Readers:

| Reader | Site |
|---|---|
| server | `functions/src/gameprocessors/TeamSnekProcessor.ts:452` (`newPlayerEnergy: { ...playerEnergy }`) |
| server (write) | `TeamSnekProcessor.ts:212` (turn 0), `:523` (`createNewTurn`) |
| frontend | `frontend/src/board/turnToBoard.ts:216` |
| frontend fixtures | `frontend/src/dev/boardFixtures.ts:77` |
| e2e | `scripts/e2e-chess.mjs:266, 283, 298, 314, 342` |
| **production bot** | `Chris-Centaur` `src/firebase/translate.ts:308` and `src/firebase/tactictoes-types.ts:70` — **already migrated to `playerEnergy`**, so the bot repo is ahead of `develop` and needs this PR to land |
| interface doc | `docs/firebase-centaur-interface.md` never names the field at all, before or after |

**Deploy hazard, confirmed by test, NOT fixed** (the brief asks for renames to
be listed rather than patched, and the bot repo has clearly been migrated on
purpose, so a back-compat read would contradict a deliberate cutover):

A turn document committed by a `develop` server carries `playerHealth` and no
`playerEnergy`. `TeamSnekProcessor.ts:452` spreads `undefined`, so
`newPlayerEnergy` is `{}`, every unit enters the turn with `energy: undefined`,
the engine's `u.energy -= cost` is `NaN`, `NaN > 0` is false — and **every unit
on the board dies of exhaustion on the first turn after the deploy**. Measured:

```
LEGACY {"energy":{},"alive":[],
        "deaths":{"t1":{"cell":20,"subStep":1,"cause":"exhaustion"},
                  "t2":{"cell":51,"subStep":1,"cause":"exhaustion"}}}
```

How to confirm: build a `Turn` with `mkTurn(...)`, rename its `playerEnergy`
key to `playerHealth`, and call `new TeamSnekProcessor(state).applyMoves(...)`.

The frontend has the same shape of exposure and it is permanent rather than
transient: `turnToBoard.ts:216` reads `turn.playerEnergy[playerID]` with no
guard, so **any archived game whose turns predate the rename throws** rather
than rendering — including finished logs the page is explicitly built to keep
scoring correctly (`GameFinished.tsx`, "an old log — written before teamScores
existed"). Confirm by loading a pre-rename game log in the board fixtures page.

Either drain in-flight games and accept that pre-rename logs stop rendering, or
add a one-line legacy fallback at both readers. That is a decision about the
product, not about the code, which is why it is reported rather than patched.

### 2.2 `GameSetup.maxHealthPerUnit` → `GameSetup.maxEnergyPerUnit` (optional, renamed)

`shared/types/Game.ts:60`. Readers: `TeamSnekProcessor.ts:335` (into the
engine), `:407` (`maxEnergyFor`, turn-0 energy), `frontend/src/board/turnToBoard.ts:217`,
`frontend/src/pages/GamePage/GameSetup.tsx:376, 545, 717, 1303`,
`scripts/e2e-chess.mjs:156`, and `Chris-Centaur` `src/firebase/translate.ts:330, 394`
(already migrated).

Lower stakes than 2.1 and still a live-game hazard: a setup written before the
rename keeps `maxHealthPerUnit`, which nothing now reads, so every unit's max
energy silently reverts to the default 100 mid-game. `firestore.rules` has no
`hasOnly` over setup keys, so the stale field is still accepted on write and
simply ignored.

### 2.3 `GameSetup.foodEnergy` (optional, NEW)

`shared/types/Game.ts:87`; validated in `firestore.rules` (1..1000, integer).
Readers: `TeamSnekProcessor.ts:336, 413`, `engine/resolveTurn.ts:159`,
`engine/claims.ts:543`, `frontend/src/pages/GamePage/GameSetup.tsx:363`,
`frontend/src/components/SnekConfiguration.tsx:128`,
`docs/firebase-centaur-interface.md:243`, `docs/chess-pieces.md`,
`engine/VENDOR.md`. Additive, defaults to 100, which is the rule food always
played — no compatibility exposure.

---

## 3. Findings taken to a verdict

Each was named here with a site and an experiment, and each has since been
run. The verdict is written under the finding, with the test that carries it.

1. **`PartialSettlement.outcome` is a guess, not a bracket.**
   `engine/settlePartial.ts:1393` (`outcomeOf`) stands every held unit on the
   board at its observed weight unless its claim is `certainlyGone`, and
   nothing in the ledger names the game's ending as a place a world could
   differ. So `outcome` can be `null` where every concrete world ends the game,
   and vice versa. Measured over the spec's own board generator: 47
   disagreements in 2,516 worlds with potions on, 76 with the promotion
   threshold at 2, 159 with `maxTurns` set to the turn being played, and 5,506
   in 15,532 worlds with two held units. Confirm: extend
   `settlePartial.spec.ts`'s `sweep` with
   `expect(partial.outcome).toEqual(truth.outcome)`. It is documented behaviour
   ("a held unit stands at the weight it was observed with"), so the question
   is whether a caller reading `outcome` in partial mode is entitled to a
   proof; if it is not, the ledger should carry the fact rather than the
   docstring.

   **CONFIRMED and fixed** (`7483724`). `outcome` is an `OutcomeBracket` over
   the completion worlds now, derived from the ledger and the claims, and the
   sweep asserts every world's ending is inside it (T6).

2. **The claim's tier ceiling counts TURNS, not simultaneous collectors.**
   `engine/claims.ts:558-573`: `potionTurns = min(span - 1, potionWindowTurns,
   potions.length)` and `tierMax = ceiling + (allies > 0 ? potionTurns : 0)`.
   Three team-mates each taking a potion on the same unknown turn is +3 to this
   unit, which the ceiling admits at +1. Not reachable at span 1, where
   `potionTurns` is 0, and not exercised anywhere: the span-2 sweep switches
   potions off on purpose (`settlePartial.spec.ts:511`). Confirm: an
   enumeration over two-move histories with potions on, several allies, and
   `tierMin/tierMax` asserted against the tier the resolver actually froze —
   note that `truth.tiers` is the POST-turn tier and is the wrong quantity to
   compare against, which is why my own sweep could not settle this.

   **CONFIRMED and fixed.** The quantity that settles it is the tier the
   resolver FREEZES for the turn being settled — the record's own `tier` as
   that turn opens, which is what `outranks` reads — and the unknown turn has
   to be played by `settleTurn` over the WHOLE roster, not the roster of one
   the span-2 sweep advances with. Done that way, three team-mates each taking
   a potion on the unknown turn freeze the held unit at `+3` against a claim
   of `[-1, +1]`: `settlePartial.spec.ts`, *a claim brackets the tier the
   resolver froze*, enumerating every two-move history of a potion round for
   one, two and three collectors, with and without a potion in the held unit's
   own reach. Two counts were wrong, not one: a pickup is not a turn's worth
   of tier (the collector takes −1 and every living ally takes +1, so one turn
   is worth as many levels as there are collectors), and the potions those
   collectors took are OFF the board by the time the ceiling reads
   `input.potions` — so `potionTurns` can be zero on the very board that moved
   the tier by three.

   The fix reads the width off the SCHEDULE the caller handed for this turn
   rather than off the turn count: every level still in force on the unit,
   buffs widening the ceiling and debuffs the floor, because a claim cannot
   tell an entry the record already counts from one taken since it was
   observed. That is exact for a caller whose schedule is its board's, which
   is what a pickup guarantees — an entry per unit it touches, lasting a
   window, and a level already given back is one already off the tier. The old
   turn count stays as a lower bound on the width, for a caller whose schedule
   is older than its board. Span 1 is untouched and still exact: no unknown
   turn has passed, so no potion can have moved anything.

   Residual, and out of this finding's scope: an effect that was in force when
   the record was observed and lapsed before this turn moves the tier DOWN,
   and a caller that hands a schedule pruned of it (as settlement itself
   prunes) shows the claim no evidence of it. `tierAtArrival`'s lapse loop
   covers exactly the caller that has not pruned.

3. **`resolveTurn` consumes the food a doomed unit eats.**
   `engine/resolveTurn.ts:270`: an exhausted unit at, say, −30 energy eats a
   meal worth 5, stays at or below zero, and dies — but the food has already
   left the board. Deliberate and pinned
   (`resolveTurn.spec.ts`, "lets an exhausted unit eat and die anyway when the
   meal cannot lift it"), and a rule change against `develop`, where a rescue
   was always a full tank. Flagged only so it is a decision rather than a
   side effect.

   **NOT A DEFECT — a rule decision, and one the PR did not introduce the
   shape of.** Three things settle it. (a) It is the documented rule and it is
   pinned to the cell: `resolveTurn.spec.ts`, *lets an exhausted unit eat and
   die anyway when the meal cannot lift it*, asserts `settled.food` is `[]`
   over the eater's corpse. (b) The order is not an accident of phasing that
   could be swapped: the food phase runs on the survivors of the collision
   phase and BEFORE exhaustion stops being provisional, because the meal is
   what decides whether the unit is doomed at all — a unit killed by a
   collision never reaches the phase and never eats, and putting the food back
   afterwards would make a meal conditional on its own outcome. (c) A doomed
   unit consuming the food it ends on is already `develop`'s behaviour by
   another route, on byte-identical phase ordering (`4. Food`, `5. Exhaustion`,
   `6. Regicide` in both): a unit whose king falls this turn eats first and is
   eliminated after. Measured on this branch —

   ```
   REGICIDE deaths={"k":{...,"cause":"contest"},"p":{"cell":58,"cause":"regicide"}}
            food=[] board=["e"]
   ```

   — the pawn ate the meal at 58 and left the board on the same turn. What is
   new is only that the EXHAUSTION instance is reachable at all, and it is
   reachable because `foodEnergy` can now be worth less than a tank (§2.3),
   where `develop`'s meal restored to max and always rescued. So the decision
   in front of the owner is the food rule already taken, not a new one.

4. **Spawn parity is not a property of the non-cluster spawn path.**
   `placement.ts:99` / `generateStartingPositions`. `getSpawnCells` enforces
   `(x + y) % 2 === 0` for the team-cluster path only; the edge/midpoint
   algorithm rounds (`getMidpoints`) and the last-resort fill walks the whole
   interior, so neither preserves parity. A sweep of 5..20 by 5..20 boards with
   2..12 units found 439 board/count combinations placing at least one unit on
   an odd square, in both cluster modes. The existing test
   (`checkSnakeStartLocations.test.ts`, "places players on even squares") only
   covers 11x11 with 8 units. **Pre-existing**: every method involved is
   byte-identical to `develop`'s (verified by comparing normalised method
   bodies), so this PR neither causes nor worsens it.

   **NOT A DEFECT — parity is a property of the CLUSTER path, and of nothing
   else.** Re-measured over the same sweep (5..20 by 5..20, 2..12 units, the
   non-cluster path, three combinations excluded as the crash of finding 5):
   2,557 of 2,816 board/count combinations place at least one unit on an odd
   square — far more than the original sweep found, and systematic rather than
   incidental. Any board with an even dimension breaks it at the CORNERS, which
   are the first four positions the edge algorithm emits: `startX = 1` and
   `endX = boardWidth - 2`, so on a 12x12 the corners are (1,1), (10,1), (1,10),
   (10,10) and two of the four are odd. A 5x5 with three units breaks it on the
   third position.

   That is not a rule being violated, because there is no rule: `(x + y) % 2`
   appears exactly once outside a test in the whole repo — in
   `isValidSpawnPosition`'s `requireParity` branch — and `requireParity` is
   passed `true` from exactly one caller, `getSpawnCells`, which is the team
   cluster path. Nothing in the engine, the wire or the frontend reads a
   spawn's parity (the renderer's other `% 2` is a hex-row stagger). So the
   even-square rule is a constraint the cluster spawner is written to satisfy,
   asserted where it is meant to hold (`expectSpawnConstraints`), and the
   edge/midpoint spawner has never claimed it in either repo.

   What overstates its reach is the NAME of the old test: *places players on
   even squares* is a fact about 11x11 with 8 units, not a property of the
   placer. Left as it is rather than renamed — this is a pre-existing test on
   a pre-existing path, and the finding to record is that a reader should not
   take it for a guarantee.

5. **A crowded small board throws rather than placing.**
   `placement.ts:99`, `const { x, y } = positions[index]`. A 5x5 board with 20
   units raises `Cannot destructure property 'x' of 'positions[index]' as it is
   undefined`; `firestore.rules` allows `boardWidth >= 5` with up to 26 units
   per team, so the lobby can reach it. **Pre-existing** (`develop`
   TeamSnekProcessor.ts:865 is the same line). Confirm: `firstTurn()` on a 5x5
   setup with 20 game players.

   **CONFIRMED and fixed** — and it is nearer the lobby than the finding said.
   A 5x5 board holds nine units (its interior, one to a cell): `n = 9` places
   nine, and `n = 10` is already the crash. Measured over the 5..20 by 5..20
   sweep with 2..12 units, three combinations throw — `5x5` at 10, 11 and 12
   units — so a full game of six two-unit teams on the smallest legal board is
   enough to reach it, no crafted write required.

   Placing is not the alternative: there is no tenth cell, and every spawn path
   already stops when it runs out rather than inventing one. What was wrong was
   the FAILURE — `initializeSnakes` read a position off the end of the list and
   raised `Cannot destructure property 'x' of 'positions[index]'` from inside
   the placer, which names neither the board nor the count. It now states the
   capacity it could not meet:

   ```
   Board too small to start: 5x5 has 9 spawn cells for 10 units.
   ```

   Pinned by `checkSnakeStartLocations.test.ts`, *fills a 5x5 to its capacity,
   and says which board is too small past it*, which also pins the capacity
   itself at nine. The lobby-side half — `firestore.rules` has no cross-field
   constraint tying the unit count to `boardWidth * boardHeight` — is left as a
   rules decision; the server now refuses intelligibly either way.

6. **The cluster minimum distance is vacuous.** `placement.ts:598`,
   `minDistance = 2`, checked against candidates that `getSpawnCells` has
   already filtered to even parity — and two distinct even-parity cells are
   always at least 2 apart in Manhattan distance. So the constraint only
   enforces distinctness. **Pre-existing** and byte-identical to `develop`;
   noted because the comment claims a spacing guarantee it does not provide.

   **NOT A DEFECT.** The vacuity is real and it is provable rather than
   merely measured: on two cells with `(x + y)` even, `dx + dy` is even, so
   `|dx| + |dy|` is even; distinct makes it non-zero; an even non-zero number
   is at least 2. Checked exhaustively as well — every pair of even-parity
   interior cells on the square boards 5..21, 70,046 pairs, minimum Manhattan
   distance 2.

   But the comments do not claim otherwise, which is the half of the finding
   that does not survive reading them. `getSpawnCells` says the parity is
   there "so any two spawns sit an even Manhattan distance apart" — which is
   exactly what parity gives and all it gives — and the call site says "the
   minimum distance ALSO keeps spawns distinct, since a cell is zero away
   from itself", which names distinctness as the work it does. Nothing in
   `placement.ts` promises spacing beyond that. The constraint is a
   `minDistance` parameter written to be raised, and raising it is the only
   change that would make it do anything; that is a game-design knob, not a
   defect. Left alone.

7. **My `settleTurn` fix must be vendored.** `Chris-Centaur` carries a copy of
   the engine at `src/engine-vendor/`. Fix #1 above is inside the vendored
   directory, so the bot's copy needs re-vendoring or it keeps the defect.

   **TRUE, and already discharged for `settleTurn`; now outstanding for
   `claims.ts` alone.** Diffed file by file against `src/engine-vendor/engine/`
   as it stands: every one of the nine files differs from this branch by
   exactly the nine-line `VENDORED from Battle-Bunker/TacticToes` header and
   nothing else — `settleTurn.ts` included, so the bot has re-vendored since
   this review was written and carries the expiry fix. The one exception is
   `claims.ts`, which differs by the header AND by the tier-width change of
   finding 2 above. So the re-vendor this branch requires is `npm run
   sync-engine` in the bot repo after merge, and `claims.ts` is the file it
   moves. Nothing else in the module changed: no import was added, no file was
   added or removed, and `engineVendor.spec.ts` — real imports parsed, no
   `require`/`Math.random`/`Date.now`, the directory compiled standing alone —
   passes.

---

## 4. Read and found clean

Verified by reading against `develop` and, where a behaviour was in doubt, by
running it.

**Engine (`functions/src/gameprocessors/engine/`)**

- `adjudicate.ts` (new) — the four branches, the mutual-wipe fallback onto the
  previous committed board, tied-team ordering and `weighTeams` over every
  CONFIGURED team all reproduce `develop`'s `calculateWinners` /
  `calculatePreviousTurnTeamOutcome` decision for decision, including the
  iteration order tied teams are reported in. Pinned independently by the new
  `adjudication.spec.ts` corpus, which plays every ending as a real game
  through `applyMoves` and then asks `adjudicate` the same question off the
  wire data.
- `resolveTurn.ts` — the food rule reads exactly as specified: a meal is
  `foodEnergy` ADDED and clamped to the kind's max; growth only on the meal
  that reaches the max (so a unit already at max grows on every meal, which is
  the shipped default); an exhausted unit's rescue conditional on the meal
  carrying it above zero. Eight tests cover the branches individually. Regicide,
  the sever/exhaustion ordering and the `presence` escape hatch all check out.
- `settleTurn.ts` — phase order (ally cancel → pickup → expiry → orientation →
  promotion → spawn → adjudication) matches its docstring and the processor it
  replaced; promotion mutates only the engine's own occupancy copies, so the
  free-cell set the spawners see is the one the rules promise.
- `turnEngine.ts` — the `strictMaximum` rewrite (`participants.find(u =>
  participants.every(o => o === u || outranks(u, o)))`) is equivalent to the
  old two-maxima form, because both call sites hand it a deduplicated
  participant list (`[...standing]` from a Set-backed filter, plus a
  `participants.includes` guard when folding in the durable pile). Identity
  comparison is therefore safe. `energy`/`health` is a pure rename.
- `moveGrammar.ts` — the scalar rewrite of `planUnitAction`/`rayPath` is
  arithmetic-identical; `pickSpawnOrientation` moves the tie-break behind an
  injected `Rng` without changing the candidate set.
- `queries.ts`, `spawn.ts`, `claims.ts` — read in full. `spawn.ts`'s draw order
  (fractional coin, then one draw per placed item, none when there is nowhere
  to place) is pinned by the new `spawn.spec.ts`.
- Vendoring contract — `engineVendor.spec.ts` still parses real imports, still
  forbids `require`/`Math.random`/`Date.now`, and still compiles the directory
  standing alone with no `node_modules`. Passes.

**Partial settlement**

- The soundness properties hold under four board variants the shipped sweep
  does not cover — potions forced on, promotion threshold at 2, `maxTurns` set
  to the turn being played, and two held units with both — over 23,080
  enumerated worlds. Zero T1 (divergence containment), T1b (survival), T2
  (fate proofs), claim-head, claim-weight and claim-energy failures. Only
  `outcome` disagreed (finding 3.1).

**Processor and placement**

- `TeamSnekProcessor.ts` — the 1,500-line shrink is an extraction. Every
  placement method (`generateStartingPositions`, `getMidpoints`,
  `fillInnerPositions`, `isValidSpawnPosition`,
  `generateTeamClusterStartingPositions`, `orderSliceCandidates`,
  `ensureInitialSafeMoves`, `ensureConnectedBoard`, `generateFertileTiles`) is
  byte-identical to `develop`'s modulo the removed dead parameters, verified by
  comparing normalised bodies. `initializeFood`'s rewrite over `freeCells` is
  equivalent: `freeCells` returns board order, so the Set's first element is
  `develop`'s `fallbackPositions[0]`.
- The board-build ORDER (positions → hazards → fertile → food) and the preset
  override conditions are unchanged, and the preview and turn 0 now run the
  same `buildBoard` — asserted by the extended `checkSnakeStartLocations`
  test, which now compares hazards, fertile tiles and food and not only unit
  positions.
- Turn-0 scores changed from `isPieceType ? 1 : 3` to
  `playerPieces[id].length` — the same numbers, and correct for preset
  positions too.
- Turn-0 food is now pinned by the new `foodPlacement.test.ts`: centre cell,
  the board-order fallback when the centre is taken, the fixed diagonal order,
  and the wall/hazard/unit/duplicate exclusions.
- `processTurn.ts` — the removed `if (!currentTurn)` guard was unreachable
  (`turnNumber === turns.length - 1` and `turns.length > 0` are both checked
  above it, and `currentTurn.winners` is dereferenced before it). Dropping
  `await` on the now-synchronous `applyMoves` changes no ordering: every
  transaction read still precedes every write.
- `centaurGameMeta.ts` — the `bestEffort` refactor preserves fire-and-forget
  semantics and the log context keys; `Promise.all` over the same set.
- `expandTeams` — one implementation in `shared/`, re-exported by both sides.
  The functions build emits `lib/shared/expandTeams.js` beside
  `lib/functions/`, and the emitted `require("../../../shared/expandTeams")`
  resolves at runtime (checked with `node -e`). No `require("@shared/...")`
  survives anywhere in `lib/`.

**Frontend**

- `GameFinished.tsx` — the verdict now comes off `Turn.winners` instead of
  being re-derived from the settled board, which is the fix for the mutual
  wipe: every team weighs 0 there, so the old code called a draw over a game
  the server had awarded and paid MMR for. The `winners.length === 0` guard
  above makes the `size !== 1` draw test well-defined.
- `clashes.ts` — `KNOWN_KINDS` derived from `CLASH_HEADLINE`'s keys minus
  `"unknown"` is exactly the old hand-written set; the two exhaustive
  `Record<BoardClashKind, string>` tables make a new wire kind a build error
  rather than a silent `"unknown"`.
- `renderer.ts`, `BoardIcons.tsx`, `turnToBoard.ts`, `Scoreboard.tsx`,
  `ClashDialog.tsx`, `Rules.tsx`, `unitGlyphs.tsx`, `SnekConfiguration.tsx`,
  `GameSetup.tsx`, `GameStateContext.tsx`, `UserContext.tsx` — rename plus the
  bolt mark plus the `useSubscription` label hoist (five hook calls, same
  order, same options). `unitTypes.ts`'s `isPieceType` agrees with the
  engine's.

**Tests and fixtures**

- No test was lost anywhere: `turnEngine.spec` 40→40, `chessPieces.test`
  68→69, `potions.test` 6→6, `processTurn.test` 17→17, `headToHead.test` 7→7,
  `TeamSnekProcessor.spec` 14→14, `resolveTurn.spec` 8→16,
  `settlementReplay.spec` 4→7, plus five new files.
- Both existing goldens changed on exactly the `playerHealth` → `playerEnergy`
  key and nothing else; `goldenReplay.ts` still compares serialised streams
  byte for byte with sorted keys and preserved array order.
- `firestore.rules` — the validator rename is mechanical and `foodEnergy` gets
  the same 1..1000 band as max energy.
