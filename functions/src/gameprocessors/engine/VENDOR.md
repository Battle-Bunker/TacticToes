# The vendorable turn-resolution module

This directory is the **single encoding of the TacticToes rules**. The server
plays the game by calling it; a client (the Chris-Centaur bot) predicts a turn
by calling the same code, copied file-for-file. There is no second mirror of
the rules anywhere, and there must never be one again.

## Files that constitute the module

Copy exactly these, together, keeping their relative layout:

| File | What it is |
| --- | --- |
| `settleTurn.ts` | **The public entry point.** One pure function, `settleTurn`, covering everything from "the staged moves are known" to "the turn has closed" — `resolveTurn` plus the end-of-turn effect bookkeeping, the orientation rewrite, pawn promotion and the adjudication that says whether the game ended. |
| `resolveTurn.ts` | The board half of settlement, callable on its own: grammar, collisions, food, exhaustion, sever, regicide. |
| `turnEngine.ts` | The snapshot-adjudicated sub-step collision engine. |
| `adjudicate.ts` | Who has won, on which board, and at what weight — plus the turn limit a setup is played to. |
| `spawn.ts` | Where a food or a potion may land and how many arrive, behind an injected RNG. |
| `moveGrammar.ts` | The movement grammar: staged cell → the path a unit of that kind walks, plus spawn orientation and the per-kind property flags. |
| `queries.ts` | The grammar asked questions instead of applied: which cells may be staged, what a unit would walk, what it covers. |
| `VENDOR.md` | This file. |

Plus the one type module they depend on:

| File | Note |
| --- | --- |
| `shared/types/Game.ts` | Imported as `@shared/types/Game`. Wire types only — no runtime code, no dependencies of its own. Re-point the alias when vendoring. |

## The rule: dependency-light, and checked

**Every file in this directory may import only from this directory and from
`@shared/types/Game`.** No logger, no Firestore, no `firebase-admin`, no npm
runtime dependency, no reaching up into `../`. Nothing in here may read a
clock, a random number, or the network — `resolveTurn` is a pure function of
its input and mutates nothing it is given.

Item spawning is the game's only nondeterminism, and it is inside the module
anyway: the rules travel here and the DIE is an input. `settleTurn` takes a
`Spawner` as its second argument, `randomSpawner(rules, rng)` is the real one
over an injected `Rng`, and `NO_SPAWN` places nothing at all.

This is enforced, not merely requested: `../engineVendor.spec.ts` parses every
import in this directory and fails the build if one points anywhere else — and
also fails on `require(`, `Math.random`, `Date.now` or `fetch`. If you need
something from outside, pass it in as an input field instead.

To prove vendorability end-to-end, compile the module on its own — no
`node_modules`, no ambient types:

```sh
mkdir -p /tmp/vendorcheck/engine /tmp/vendorcheck/shared/types
cp functions/src/gameprocessors/engine/*.ts /tmp/vendorcheck/engine/
cp shared/types/Game.ts                     /tmp/vendorcheck/shared/types/
cat > /tmp/vendorcheck/tsconfig.json <<'JSON'
{ "compilerOptions": { "module": "commonjs", "target": "ES2020", "strict": true,
    "noImplicitReturns": true, "noUnusedLocals": true, "moduleResolution": "node",
    "noEmit": true, "types": [],
    "baseUrl": ".", "paths": { "@shared/*": ["shared/*"] } },
  "include": ["engine", "shared"] }
JSON
npx tsc --noEmit -p /tmp/vendorcheck/tsconfig.json   # must be silent
```

## What is deliberately NOT in the module

Two things, and they are not rules:

- **Placement and MMR.** Building the board before turn 1 — where each unit
  starts, where the hazards go, which tiles are fertile — is one pass over a
  board with nothing on it yet, driven by the setup's geometry rather than by
  any rule of play; nothing in it happens again while the game runs. And what
  a league does with a finished game — the winner ROWS, per-player scores,
  placements, MMR — is a ranking policy, not a rule: WHICH teams won is
  `adjudicate`'s and lives here, what that is worth to a player does not.
- **Firestore, and the `Turn` wire assembly.** Documents, timestamps and
  transactions. The module takes plain numbers and hands plain numbers back.

Everything else a turn does is in here, including the two that used to be
argued out of it: spawning (the rules travel, the die is injected) and
adjudication (who won, and on which board).

## Using it

```ts
import { settleTurn } from "./engine/settleTurn"

const settled = settleTurn({
  units: [
    { id, type, teamID, isKing, tier, energy, occupancy, orientation, stagedMove },
    // ...one per unit alive at the start of the turn
  ],
  boardWidth, boardHeight, walls, hazards, hazardDamage, food,
  maxEnergy,          // per-kind overrides; the rest default to 100
  foodEnergy,         // energy one food replenishes (100)
  regicideTeamIDs,    // teams configured with at least one king
  turn,               // the turn being resolved
  teamOf,             // unit id -> team id, for every configured unit
  effects,            // the invulnerability effect schedule as the turn opened
  potions,            // potion cells on the board as the turn opened
  potionsEnabled,     // off: potions are inert scenery
  potionWindowTurns,  // how long a pickup's debuff and ally buffs last (3)
  pawnPromotionWeight, // the weight at which a pawn becomes a queen (10)
  maxTurns,           // resolveMaxTurns(setup.maxTurns): 100 unless told otherwise
  previous,           // the last committed turn's board, for the mutual-wipe branch
}, randomSpawner({ foodSpawnRate, potionsEnabled, potionSpawnRate, fertileTiles },
                 { next: () => Math.random() }))   // or NO_SPAWN

settled.board          // survivors: final occupancy and energy
settled.deaths         // every unit removed, with cell / subStep / cause
settled.eliminatedTeamIDs
settled.effects        // the schedule as the turn closed
settled.tiers          // per-unit tier the NEXT turn starts from
settled.food           // food left once every eater has eaten, plus what spawned
settled.potions        // potion cells left once every collector has taken one, plus spawns
settled.spawned        // { food, potions }: just the cells this turn added
settled.orientation    // facing per surviving unit, rewritten for the turn
settled.unitTypes      // kind per surviving unit, promotion applied
settled.promoted       // units that became queens this turn
settled.outcome        // null while the game continues; the adjudication when it ends
```

**`tier` is an input AND an output.** A caller hands settlement the tiers a
turn is adjudicated at and reads back the tiers the next turn starts from.
Deriving the second set yourself — charging a pickup, giving a level back on
expiry — is writing a second encoding of the rules, which is the one thing
this directory exists to prevent. Read `tiers`.

**`type` is an input AND an output, exactly like `tier`.** Promotion is the
only kind change in the game, and settlement is where it happens: the kinds a
caller sends in are the kinds the turn was played at, and `unitTypes` is the
kinds the next turn opens with. A caller that promotes for itself has written
the threshold, the weight-1 collapse and the queen energy clamp a second time.

Promotion runs last of the unit phases, after the food phase (so a pawn that
ate its way to the threshold promotes on that turn) and after the orientation
rewrite (so it was still a pawn when its facing was decided), and before
spawning — which changes nothing either way, because a piece's occupancy is N
copies of one square and the collapse frees no cell.

**Eating adds `foodEnergy`, and only a FULL TANK grows.** A meal is
`foodEnergy` (default 100) added to the eater and clamped to its kind's max,
and it adds one weight/length only when it brings the unit TO that max. So
growth is not what eating costs — it is what filling up costs. Three
consequences a caller predicting a turn has to carry:

- A unit already at max grows on every meal (the clamp leaves it at max, and
  max is what the rule asks for). At the shipped defaults — food 100, tank 100
  — every meal fills and every meal grows, which is the rule food always
  played, so a default game is unchanged.
- An exhausted unit's rescue is no longer automatic. It halts at or below
  zero, eats `foodEnergy`, and lives only if that carries it above zero; if it
  does not reach max it lives WITHOUT growing. Read `deaths`, never "it was on
  food, so it survived".
- Promotion follows weight, so it now follows full tanks. A pawn eating its way
  to `pawnPromotionWeight` needs each of those meals to fill it.

Food is eaten at the cell a unit ENDS on, and the spawner never stacks two
items on one cell, so one meal per unit per turn is all that is reachable; the
phase applies the rule per food in board order regardless, so a preset board
that doubles up a cell settles each meal in turn.

**Take `orientation` whole.** It is rebuilt each turn from the units still
standing, with rotations folded in and the dead dropped. Carrying the previous
turn's map forward and patching the units that moved is the per-kind facing
rule written a second time — sliders sign their ray, knights keep their exact
L-offset, and pawns turn only through their rotation action.

**Asking the grammar questions.** `queries.ts` is the surface for anything
that has to CHOOSE a move rather than resolve one — a client's search, an
interface offering a player their legal squares, a model of what an opponent
might do:

```ts
legalTargets(unit, board)      // every cell this kind may be staged to
pathOf(unit, target, board)    // the cells it would walk, or null if illegal
coverOf(unit, board)           // what it could contest, rays cut at the first body
actionOf(unit, target, board)  // the planned action, or null
stagedAction(unit, staged, board) // ...with the default substituted, as the server does
rotationTargets(unit, board)   // a pawn's turns: the cell to stage, and the facing
```

`stagedAction` is not a reimplementation of the staging step — it IS the
staging step, and `resolveTurn` calls it. `planUnitAction`, `defaultAction`
and `legalOrientations` are re-exported from here so the whole movement
surface has one import site. Note what the answers include, because these are
the three a re-derivation gets wrong: a trail unit may legally stage a WALL
(fatal, and still a move the server accepts), a hazard blocks nothing, and a
pawn's diagonal is legal only onto food or a body.

**`outcome` is the end of the game, not the score of it.** It names the kind
of ending, the winning team ids, the weight behind each team and WHICH board
decided — the settled one, or the previous committed turn's when every
remaining team died at once. `adjudicate` is exported separately for a caller
that has two boards and no turn to settle (a harness recomputing placements),
and `sharePar` turns an outcome into a par-1 score per team.

`resolveTurn` remains exported for a caller that wants the board half alone;
it does not touch effects, tiers or facing.

Pass `path` instead of `stagedMove` on a unit if you have already planned it.
Read outcomes off `board` and `deaths` — they are authoritative, and they are
what the server itself writes to the wire.
