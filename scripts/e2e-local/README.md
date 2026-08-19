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
| `seed.mjs` | seed centaur identities + credentials, create a session, configure and start one game (parameterized) |
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
   starts**. Under the centaur's ActivityController idle rule a
   merely-open tab counts as NOTHING: only verifiable human actions
   (dashboard page GETs, user-intent WS messages, mutating API calls)
   reset the 60s idle grace (`IDLE_GRACE_MS`), after which Firebase is
   suspended. pw-smoke therefore reloads `/play` every ~40s while waiting
   for a game card — each reload is a real page GET, i.e. a human action.
   Once the game is progressing, the robustly-progressing-game rule holds
   the instance awake by itself (up to `GAME_HUMAN_ATTENTION_CAP_MS` =
   10 min past the last human action) and the reloads stop; after game
   end, with no further human actions, the centaur suspends within one
   evaluation sweep (~5s).
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
node scripts/e2e-local/seed.mjs                      # window 2, after "All emulators ready"
node scripts/e2e-local/watch.mjs --turns 3 --min-turns 3 --expect-alive 10
pkill -f "emulators[:]start"                         # teardown (self-safe pattern)
```

No pre-staged moves are needed: every turn resolves purely via engine
defaults on the expiry cadence. Snakes spawn stacked (`[p,p,p]`) with no
movement history, so on turn 0 the engine's default move is its legal
adjacent-cell fallback (first open non-wall, non-occupied neighbor); from
turn 1 each snake has a real direction and marches straight until it hits
something. (An earlier engine bug derived a `{dx:0,dy:0}` "last direction"
for stacked snakes, making the default move the snake's own square — every
snake self-collided at the first expiry, and this mode needed a turn-0
pre-staging workaround. Fixed in `TeamSnekProcessor`; the regression tests
live in `TeamSnekProcessor.spec.ts`.) Straight-marching snakes reach walls
quickly — with the default 2×5 setup on the 13×13 board, expect wall deaths
from around turn 2 and a finished game near turn 10; dying quickly is
expected and fine, ≥3 resolutions come first.

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
`claude/codebase-refactor-opportunities-qin5z9`, after the stacked-spawn
default-move fix, with **no** turn-0 pre-staging; the two-centaur
`run-all.sh` flow is a straight productionization of the proven prototype
and gets its live run once the Chris-Centaur keepalive work lands):

```
$ bash scripts/e2e-local/run-emulators.sh 480 &     # → "All emulators ready" ~20s
$ node scripts/e2e-local/seed.mjs --first-turn-time 8 --max-turn-time 4
centaurs seeded: chris (key ttc_local-key-chris), dave (key ttc_local-key-dave)
SEEDED session=e2e-1786582267809 game=zEIPsx5rrjNfdNaWNzzb (start not yet requested)
STARTED session=e2e-1786582267809 game=zEIPsx5rrjNfdNaWNzzb alive=10
$ node scripts/e2e-local/watch.mjs --session e2e-1786582267809 --game zEIPsx5rrjNfdNaWNzzb \
    --turns 3 --min-turns 3 --expect-alive 10
watching sessions/e2e-1786582267809/games/zEIPsx5rrjNfdNaWNzzb (want 3 resolved turns, min 3 on finish)
turn 0: alive=10 movesApplied=0 winners=0 docBytes=3321
turn 1: alive=10 movesApplied=10 winners=0 docBytes=3321
turn 2: alive=5 movesApplied=10 winners=0 docBytes=5232
turn 3: alive=5 movesApplied=5 winners=0 docBytes=6098
PROGRESSED 3 resolved turns — SUCCESS            # exit 0
```

`turn 1: alive=10` is the fix's proof: all 10 spawn-stacked snakes survived
the turn-0 expiry on engine defaults alone (pre-fix this read `alive=0` and
the game ended at the first resolution). The emulator log shows zero
`Collided with own body` deaths — every death was `collided with a wall`
from straight-marching. Expiry cadence held (early-dispatch guard sleeping
to each turn's real endTime: `waiting 5586ms` for the 8s first turn net of
dispatch lag, then `~3950ms` steadily for the 4s turns). Left to run, the
game finished naturally: `GAME FINISHED after 10 resolved turns — SUCCESS
(>= 3)` (alive 10 → 5 → 3 → 0, winners=5).

A second `seed.mjs --first-turn-time 6 --max-turn-time 4 --start-delay-ms
1000` on the same boot (no reseed/reboot) produced session
`e2e-1786582335819`, discovered by `watch.mjs --prefix e2e-1786582335819`
through the fixed collectionGroup filter (invite docs present and correctly
excluded), and passed identically (alive=10 at turn 1, 3 resolutions).
Teardown via `pkill -f "emulators[:]start"` left no processes running.

### Two-centaur run (post-refactor), validated live 2026-08-13

Full 2-team × 5-snakes run with BOTH teams driven by real Chris-Centaur
processes (TacticToes `ce93581` + this run's scaffold fixes; Chris-Centaur
`f2a4360`, post-ActivityController refactor), steps run individually rather
than via `run-all.sh` for control. Emulator suite booted (~25s to "All
emulators ready"), then `seed.mjs --credentials-only` (new flag), then
`run-centaur.sh 6001 chris …` and `6002 dave …`. Both centaurs booted before
the credentials landed, failed their first sign-in (`functions/
permission-denied`), and connected cleanly via `POST /api/firebase-retry`
("Signed in as centaur:chris"/":dave"). pw-smoke pages opened next (each
`/play` GET = a verifiable human action), then
`seed.mjs --first-turn-time 15 --max-turn-time 6 --max-turns 60`.

Results:

- `watch.mjs --turns 10 --min-turns 10`: **PASS** — turns 1–6 all
  `alive=10 movesApplied=10`, first death turn 7, `PROGRESSED 10 resolved
  turns — SUCCESS`. (Engine-default marching kills half the snakes by turn
  2 — 10/10 alive through turn 6 is itself proof the centaurs were
  steering.) Left running, the game went the full `maxTurns`:
  60 resolved turns, team dave won (teamScore 28, all 5 dave snakes in
  the winners list; 5 snakes alive at the final turn).
- Centaur-staged moves: **PASS** — 207 `privateMoves` docs by turn 13,
  staged on every turn (12–18 writes/turn), all 10 distinct snake ids
  staging; ~150 staging log lines per centaur.
- Both dashboards: **PASS** — pw-smoke on :6001 and :6002 each saw 3 turn
  advances on the `/play` card and `/game/:id` rendered `#pageTitle`
  ("Game <id>").
- Idle rule, mid-game: **PASS** — zero `[tt-firebase] Suspended` lines
  during the game. Last human action 04:14:49 (pw `/game/:id` GET); the
  60s grace expired ~04:15:49 and the progressing game alone held both
  instances connected for the remaining ~4.7 min — the new
  progressing-game rule doing real work (old presence rule would have
  needed an open-tab crutch; new rule ignores untouched tabs entirely).
- Idle rule, post-game: **PASS** — game finished 04:20:33 (turn 60); both
  logs show `endGame` → "Manager is now fully idle" → `[tt-firebase]
  Suspended` immediately after (observed suspended ≤11s after
  `timeFinished`), i.e. game-end pokes the controller and the already-
  expired grace suspends on the spot rather than waiting out the 10-min
  cap.
- SIGTERM: **orderly but SLOW** — both processes ran the full shutdown
  sequence and exited ("Server closed"), but took ~2.5–3 min because
  `DecisionLogger.shutdown()` drains its queue (328/309 entries) against
  an unreachable Postgres with 3 retries + backoff per row (no
  DATABASE_URL ⇒ pg defaults to 127.0.0.1:5432, ECONNREFUSED). Centaur-
  side issue, reported upstream: the flush should short-circuit or be
  deadline-capped when the DB is unreachable/not configured.

Teardown: `pkill -f "emulators[:]start"` — all emulator, centaur and
Playwright processes gone; ports 8080/9099/5001/4400/6001/6002 all closed.

Scaffold changes from this run: `pw-smoke.mjs` reload-keepalive while
waiting for the game card (new idle rule), `seed.mjs --credentials-only`
(seed credentials before centaur boot so sign-in can succeed first try or
via one retry), stale presence-rule comments in `run-all.sh` and this
README rewritten.
