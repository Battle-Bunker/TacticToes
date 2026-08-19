# Overview

Team Snek is a single-game platform: a simultaneous-turn team snake game
played exclusively by **centaurs** (Firebase-connected snake controllers)
over a direct Firestore interface. Humans sign in with Google to configure
games, own centaurs, and spectate/replay — they never play. The stack is a
React/TypeScript frontend (Vite + MUI) on Firebase Hosting and a Firebase
Functions backend on Firestore.

# Architecture

## Frontend (`frontend/`)
- React 18 + TypeScript + Vite, Material-UI v6, React Router
- Context providers: `UserContext` (Google auth, `{ userID, name }`),
  `GameStateContext` (session/setup/game subscriptions, lobby centaur list),
  `LadderContext` (rankings)
- All game state arrives via Firestore `onSnapshot` listeners; spectators
  watch live games and replay finished ones with the turn scrubber

## Backend (`functions/`)
- Firebase Functions (Node), Firestore triggers + Cloud Tasks
- `onSessionCreated` writes the default setup; `onGameStarted` /
  `processScheduledGameStart` funnel into one idempotent `startGame`
  transaction; `onMoveCreated` resolves turns early;
  `processTurnExpirationTask` resolves them at the deadline
- Game engine: `SnekProcessor` (board mechanics) extended by
  `TeamSnekProcessor` (team scoring/win conditions)
- Centaur auth callables: `createCentaurApiKey`, `exchangeCentaurApiKey`,
  `getCentaurApiKeyStatus`; preview generation via `generatePreviewBoard`

## Data model (Firestore)
- `users/{uid}` — `{ name }`
- `centaurs/{id}` — `{ id, name, owner, public, createdAt }`;
  `centaurs/{id}/games/{gameId}` — server-written game invites
- `centaurCredentials/{id}` — API-key hashes (no rules; server-only)
- `sessions/{id}` — `{ latestGameID, owner, timeCreated }`; owner can
  abdicate (owner → null, irrevocable)
- `sessions/{s}/setups/{g}` — lobby config: `teams` (≤10, one per centaur;
  team id == centaur id), `snakesPerTeam` (1–26), board size, timing,
  hazards/food/fertile/potions/preview, tournament fields,
  `startRequested`/`started`
- `sessions/{s}/games/{g}` — immutable `turns` array plus the setup snapshot
  with server-expanded `gamePlayers` (`{ id, teamID, letter }`)
- `.../games/{g}/meta/centaurMap` — `{ players: { [snakeID]: centaurId } }`,
  the rules' per-snake authorization map
- `.../games/{g}/moveStatuses/{n}` — commit signals (`movedPlayerIDs`)
- `.../games/{g}/privateMoves/{id}` — staged moves (own-snake read/create)
- `rankings/{centaurId}` — `{ currentMMR, gamesPlayed, wins, losses,
  gameHistory, lastUpdated }`

## Game lifecycle
1. A session is created (creator becomes owner); the server writes a default
   setup.
2. The owner adds teams by adding centaurs (team name/id snapshot the
   centaur; colour from the palette, editable), tunes config, and presses
   Start (`startRequested: true`). Tournament mode instead schedules the
   start and chains rounds.
3. `startGame` expands teams × `snakesPerTeam` into snakes (ids `centaurId`,
   `centaurId#2`, …; letters A, B, C…), creates turn 0, `moveStatuses/0`,
   `meta/centaurMap`, and centaur game invites, then arms the expiration
   task.
4. Turn loop: centaurs stage moves (`privateMoves`, last write before
   `endTime` wins) and optionally commit (`movedPlayerIDs`, binding); turns
   resolve early when all alive snakes committed, otherwise at the deadline.
   Unstaged snakes continue in their previous direction.
5. Game end: team winners are scored, MMR (Elo by team score placement)
   updates `rankings/{centaurId}`, and the next game's setup is created with
   teams preserved.

## Centaur interface
The full wire protocol — API-key exchange, custom-token sign-in
(`centaur:<id>` uid, `{ centaur: true, centaurId }` claims), invite
discovery, staging/commit semantics, and the coordinate convention — is
documented in `docs/firebase-centaur-interface.md`. Chris-Centaur is the
reference client.

# Development

```bash
firebase emulators:start          # Firestore/Functions/Auth/Hosting emulators
cd frontend && npm install && npm run dev
cd functions && npm install && npm run build   # emulator does NOT auto-rebuild TS
cd functions && npm test
```

Deployment, per-project GCP bootstrap (`scripts/bootstrap-gcp-project.sh`),
callable IAM grants (`scripts/grant-callable-invokers.sh`), and the
`turn-expirations` Cloud Tasks queue are covered in `README.md`.

Firebase project aliases (`.firebaserc`): `production` = team-snek (australia-southeast1),
`staging` = tactic-toes-cyphid-dev.

# Conventions
- Source code is deployment agnostic: no hardcoded region defaults anywhere.
  `VITE_FIREBASE_FUNCTIONS_REGION` is required config, supplied as a plain
  environment variable (Replit Secrets / deploy shell) with no config file
  anywhere; the functions build stamps it into the generated entrypoint for
  the processes firebase-tools spawns (`functions/tools/build-entry.mjs`). It
  must match the target project's Firestore region; missing values throw.
- Never assign `undefined` to a field bound for Firestore — omit the key
  (conditional spread) or use `null`.
- Turns are append-only and immutable, deadline included; clients ignore any
  game snapshot that doesn't advance `turns.length`.
- Firebase deploys do not repair IAM: new callables need the `allUsers`
  invoker grant added to both scripts.
