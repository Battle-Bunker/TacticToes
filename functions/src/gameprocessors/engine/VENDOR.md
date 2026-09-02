# The vendorable turn-resolution module

This directory is the **single encoding of the TacticToes rules**. The server
plays the game by calling it; a client (the Chris-Centaur bot) predicts a turn
by calling the same code, copied file-for-file. There is no second mirror of
the rules anywhere, and there must never be one again.

## Files that constitute the module

Copy exactly these, together, keeping their relative layout:

| File | What it is |
| --- | --- |
| `settleTurn.ts` | **The public entry point.** One pure function, `settleTurn`, covering everything from "the staged moves are known" to "the turn has closed" — `resolveTurn` plus the end-of-turn effect bookkeeping. |
| `resolveTurn.ts` | The board half of settlement, callable on its own: grammar, collisions, food, exhaustion, sever, regicide. |
| `turnEngine.ts` | The snapshot-adjudicated sub-step collision engine. |
| `moveGrammar.ts` | The movement grammar: staged cell → the path a unit of that kind walks, plus spawn orientation and the per-kind property flags. |
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

These need game-level state the module does not carry, and stay in
`TeamSnekProcessor`:

- SPAWNING food, hazards and potions (all of it random — collecting a potion
  is a rule and lives here; putting one on the board is a die roll and does
  not);
- the per-turn orientation rewrite (the module does report `rotations`, since
  choosing to rotate is a grammar outcome);
- pawn promotion;
- scoring, winners, MMR;
- anything Firestore, and the `Turn` wire assembly.

## Using it

```ts
import { settleTurn } from "./engine/settleTurn"

const settled = settleTurn({
  units: [
    { id, type, teamID, isKing, tier, health, occupancy, orientation, stagedMove },
    // ...one per unit alive at the start of the turn
  ],
  boardWidth, boardHeight, walls, hazards, hazardDamage, food,
  maxHealth,          // per-kind overrides; the rest default to 100
  regicideTeamIDs,    // teams configured with at least one king
  turn,               // the turn being resolved
  teamOf,             // unit id -> team id, for every configured unit
  effects,            // the invulnerability effect schedule as the turn opened
  potions,            // potion cells on the board as the turn opened
  potionsEnabled,     // off: potions are inert scenery
  potionWindowTurns,  // how long a pickup's debuff and ally buffs last (3)
})

settled.board          // survivors: final occupancy and health
settled.deaths         // every unit removed, with cell / subStep / cause
settled.eliminatedTeamIDs
settled.effects        // the schedule as the turn closed
settled.tiers          // per-unit tier the NEXT turn starts from
settled.potions        // potion cells left once every collector has taken one
```

**`tier` is an input AND an output.** A caller hands settlement the tiers a
turn is adjudicated at and reads back the tiers the next turn starts from.
Deriving the second set yourself — charging a pickup, giving a level back on
expiry — is writing a second encoding of the rules, which is the one thing
this directory exists to prevent. Read `tiers`.

`resolveTurn` remains exported for a caller that wants the board half alone;
it does not touch effects or tiers.

Pass `path` instead of `stagedMove` on a unit if you have already planned it.
Read outcomes off `board` and `deaths` — they are authoritative, and they are
what the server itself writes to the wire.
