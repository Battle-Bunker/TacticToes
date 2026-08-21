# The vendorable turn-resolution module

This directory is the **single encoding of the TacticToes rules**. The server
plays the game by calling it; a client (the Chris-Centaur bot) predicts a turn
by calling the same code, copied file-for-file. There is no second mirror of
the rules anywhere, and there must never be one again.

## Files that constitute the module

Copy exactly these, together, keeping their relative layout:

| File | What it is |
| --- | --- |
| `resolveTurn.ts` | **The public entry point.** One pure function, `resolveTurn`, covering everything from "the staged moves are known" to "the board has settled". |
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

- spawning food, hazards and potions (all of it random);
- invulnerability potions, active effects, and the tier changes they cause —
  **tier is an input**, which already captures their effect at the moment
  adjudication reads it;
- the per-turn orientation rewrite (the module does report `rotations`, since
  choosing to rotate is a grammar outcome);
- pawn promotion;
- scoring, winners, MMR;
- anything Firestore, and the `Turn` wire assembly.

## Using it

```ts
import { resolveTurn } from "./engine/resolveTurn"

const settled = resolveTurn({
  units: [
    { id, type, teamID, isKing, tier, health, occupancy, orientation, stagedMove },
    // ...one per unit alive at the start of the turn
  ],
  boardWidth, boardHeight, walls, hazards, hazardDamage, food,
  maxHealth,          // per-kind overrides; the rest default to 100
  regicideTeamIDs,    // teams configured with at least one king
})

settled.board          // survivors: final occupancy and health
settled.deaths         // every unit removed, with cell / subStep / cause
settled.eliminatedTeamIDs
```

Pass `path` instead of `stagedMove` on a unit if you have already planned it.
Read outcomes off `board` and `deaths` — they are authoritative, and they are
what the server itself writes to the wire.
