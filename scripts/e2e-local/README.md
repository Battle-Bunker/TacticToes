# Local end-to-end scaffold (emulator suite + centaurs)

Runs the whole TacticToes stack **locally**: Firestore/Auth/Functions/Cloud
Tasks emulators, a seeded game, and (optionally) two Chris-Centaur instances
playing it, with turn-progression assertions on the game document and on each
centaur's web UI.

**Local only.** Everything runs under the `demo-teamsnek` project id, which
firebase-tools reserves for offline emulator use. Every script refuses to run
unless the project id starts with `demo-`, and the Node scripts pin
`FIRESTORE_EMULATOR_HOST` themselves. No deployed/dev Firebase project is
ever touched.

## Files

| file | purpose |
| --- | --- |
| `run-emulators.sh` | rebuild functions, then boot `firestore,auth,functions,tasks` emulators |
| `seed.mjs` | seed centaur identities + credentials, create a session, configure and start one game (parameterized; `--engine-only` mode for centaur-less runs) |
| `run-centaur.sh` | run one Chris-Centaur against the emulators via ts-node (no dist writes) |
| `watch.mjs` | assert turns keep resolving on the game document; nonzero exit on stall |
| `pw-smoke.mjs` | Playwright: open a centaur's `/play` page (presence!), assert its turn counter advances, check `/game/:id` renders |
| `run-all.sh` | orchestrate the full two-centaur flow with a cleanup trap |

## One-time setup

```bash
npm install                      # repo root: installs firebase-tools (devDependency)
cd functions && npm install      # functions deps (firebase-admin used by the .mjs scripts too)
```

The centaur flow additionally needs a Chris-Centaur checkout with its own
`node_modules` (`CENTAUR_DIR=...`), and `pw-smoke.mjs` needs the machine-global
Playwright install (`/opt/node22/lib/node_modules/playwright` with browsers in
`/opt/pw-browsers`; override via `PLAYWRIGHT_HOME` / `PLAYWRIGHT_BROWSERS_PATH`).

## Full two-centaur run

```bash
CENTAUR_DIR=/path/to/Chris-Centaur scripts/e2e-local/run-all.sh
```

Order (run-all does all of this, with a cleanup trap):

1. `run-emulators.sh` — rebuilds functions, boots the suite, waits for
   "All emulators ready".
2. `run-centaur.sh 6001 chris ttc_local-key-chris` and
   `run-centaur.sh 6002 dave ttc_local-key-dave` — must be up before seeding
   so they can pick up their invites.
3. `pw-smoke.mjs http://127.0.0.1:6001 3` (and :6002) — **before the game
   starts**, and the pages stay open for the whole run. An idle centaur
   suspends its Firebase connection after ~60s (`FIREBASE_SUSPEND_GRACE_MS`);
   an open `/play` page counts as operator activity and keeps it connected.
   The in-flight ActivityController work will make a running game hold the
   connection by itself, after which the pages are only needed as UI
   assertions, not as presence keep-alives.
4. `seed.mjs` — seeds and starts the game (two-step: settings update first,
   then `startRequested: true` as a separate update, because `onGameStarted`
   only fires on update events and invites must sync before the start).
5. `watch.mjs` + the two pw-smoke processes deliver the verdicts.

Useful knobs (env): `FIRST_TURN_TIME` (15), `MAX_TURN_TIME` (6), `MAX_TURNS`
(40), `WANT_TURNS` (5), `PW_ADVANCES` (3), `CENTAUR_A/B`, `CENTAUR_A_PORT/…`.
Keep `MAX_TURN_TIME >= ~3s` — the expiry-task chain needs headroom to
re-enqueue; 6s/15s are known-good test values.

## Engine-only run (no centaurs)

Validates emulator boot, seeding, and the Cloud-Tasks-driven turn-expiry
cadence without any centaur processes:

```bash
bash scripts/e2e-local/run-emulators.sh &            # window 1 (or background)
node scripts/e2e-local/seed.mjs --engine-only        # window 2, after "All emulators ready"
node scripts/e2e-local/watch.mjs --turns 3 --min-turns 3 --expect-alive 10
pkill -f "emulators[:]start"                         # teardown (self-safe pattern)
```

`--engine-only` stages one legal move per snake **for turn 0 only**; turns 1+
resolve purely via engine defaults (each snake marches straight until it hits
something). Why the nudge exists: snakes spawn stacked (`[p,p,p]`), so with no
staged move the engine derives a `{dx:0,dy:0}` "last direction" and the default
move is the snake's own square — every snake self-collides and the game ends at
the very first expiry. The nudge writes `privateMoves` only (never
`moveStatuses`), so resolution still happens on the expiry cadence rather than
the all-players-moved fast path. With the default 2×5 board the snakes
head-to-head collide mid-board around turn 4 — dying quickly is expected and
fine; ≥3 resolutions come first.

## Gotchas

- **Proxy sentinel (do not remove).** This container routes HTTPS through an
  agent proxy, and firebase-tools' internal HTTP client (apiv2) ignores
  `no_proxy`, so emulator-internal calls hang through the proxy.
  `run-emulators.sh` sets `HTTP_PROXY`/`HTTPS_PROXY`/lowercase variants to the
  literal string `undefined`, which apiv2 fails to parse as a proxy URL and
  therefore ignores — the verified workaround. Plain `unset` is not reliable
  when a parent shell re-exports the variables.
- **Rebuild before every boot.** The functions emulator serves compiled
  `functions/lib`; `run-emulators.sh` runs `tsc` first and refuses to boot if
  `functions/lib/functions/src/index.js` is missing. A stale lib means stale
  triggers.
- **Emulator state is in-memory.** Every boot starts empty — run `seed.mjs`
  again after each boot. Reseeding on a *running* suite is fine too: centaur
  and credential docs are idempotent upserts, and each seed creates a fresh
  `e2e-<epoch-ms>` session (validated below — two seeds on one boot).
- **Turn expiry works locally.** The Cloud Tasks emulator dispatches
  immediately, but `processTurnExpirationTask` sleeps until the turn's real
  `endTime` (early-dispatch guard), so the cadence matches the configured
  turn times.
- **`watch.mjs` game discovery.** `collectionGroup('games')` also returns
  centaur invite docs (`centaurs/{id}/games/{gameID}`); the filter must be
  `path.startsWith('sessions/…')` — no leading slash in Firestore paths.
  (The prototype had this bug; fixed here.)
- **Teardown.** Use the self-safe pattern `pkill -f "emulators[:]start"` —
  the bracket keeps the pkill from matching its own command line. `run-all.sh`
  does this in its EXIT trap, plus the same for the ts-node centaurs.
- **Functions lint vs `lib/`.** `functions/.eslintrc.js` ignores `lib/**` so
  the compiled output this scaffold produces never pollutes `npm run lint`.

## Validated

Engine-only path, validated live on 2026-08-13 (branch
`claude/codebase-refactor-opportunities-qin5z9`; the two-centaur `run-all.sh`
flow is a straight productionization of the proven prototype and gets its live
run once the Chris-Centaur keepalive work lands):

```
$ bash scripts/e2e-local/run-emulators.sh 480 &     # → "All emulators ready" ~20s
$ node scripts/e2e-local/seed.mjs --engine-only
centaurs seeded: chris (key ttc_local-key-chris), dave (key ttc_local-key-dave)
SEEDED session=e2e-1786580258718 game=ITHEOqfARpDo8yl9SgQ7 (start not yet requested)
STARTED session=e2e-1786580258718 game=ITHEOqfARpDo8yl9SgQ7 alive=10
NUDGED 10/10 snakes for turn 0 (engine defaults take over from turn 1)
$ node scripts/e2e-local/watch.mjs --session e2e-1786580258718 --game ITHEOqfARpDo8yl9SgQ7 \
    --turns 3 --min-turns 3 --expect-alive 10
watching sessions/e2e-1786580258718/games/ITHEOqfARpDo8yl9SgQ7 (want 3 resolved turns, min 3 on finish)
turn 0: alive=10 movesApplied=0  winners=0 docBytes=2135
turn 1: alive=10 movesApplied=10 winners=0 docBytes=3328
turn 2: alive=10 movesApplied=10 winners=0 docBytes=4521
turn 3: alive=10 movesApplied=10 winners=0 docBytes=5710
PROGRESSED 3 resolved turns — SUCCESS            # exit 0
```

Expiry cadence from the emulator log (early-dispatch guard sleeping to each
turn's real endTime): `waiting 12507ms` (turn 0, firstTurnTime 15s), then
`5853ms / 5950ms / 5957ms` (maxTurnTime 6s). Left to run, the game finished at
turn 4 (all 10 snakes head-to-head mid-board, winners=10 draw) and `watch.mjs
--turns 30` exited 0 via `GAME FINISHED after 4 resolved turns — SUCCESS (>= 3)`.

A second `seed.mjs --engine-only --first-turn-time 8 --max-turn-time 4` on the
same boot (no reseed/reboot) produced session `e2e-1786580384721`, discovered
by `watch.mjs --prefix e2e-1786580384721` through the fixed collectionGroup
filter (invite docs present and correctly excluded), and passed identically.
Teardown via `pkill -f "emulators[:]start"` left no processes running.
