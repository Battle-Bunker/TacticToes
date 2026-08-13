#!/usr/bin/env bash
# Full local e2e: emulator suite + two Chris-Centaur instances + Playwright
# presence pages + a seeded game, with turn-progression assertions.
# Everything is local (demo- project); nothing deployed is touched.
#
# Usage: CENTAUR_DIR=/path/to/Chris-Centaur scripts/e2e-local/run-all.sh
#
#   CENTAUR_DIR      required — Chris-Centaur checkout (node_modules installed)
#   LOG_DIR          where to write logs (default: mktemp under /tmp)
#   FIRST_TURN_TIME  default 15   MAX_TURN_TIME default 6 (keep >= ~3)
#   MAX_TURNS        default 40   WANT_TURNS    default 5 (watch assertion)
#   PW_ADVANCES      default 3    turn advances each centaur page must see
#   CENTAUR_A/B      default chris/dave; CENTAUR_A_PORT/B_PORT 6001/6002
#
# Order matters:
#   emulators -> centaurs -> centaur /play pages open -> seed/start -> assert.
# The pages MUST be open before the game starts: an idle centaur suspends its
# Firebase connection after ~60s and would never receive the invite/start.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CENTAUR_DIR="${CENTAUR_DIR:?set CENTAUR_DIR to a Chris-Centaur checkout}"
LOG_DIR="${LOG_DIR:-$(mktemp -d /tmp/tt-e2e.XXXXXX)}"
mkdir -p "$LOG_DIR"

CENTAUR_A="${CENTAUR_A:-chris}";  CENTAUR_A_PORT="${CENTAUR_A_PORT:-6001}"
CENTAUR_B="${CENTAUR_B:-dave}";   CENTAUR_B_PORT="${CENTAUR_B_PORT:-6002}"
CENTAUR_A_KEY="${CENTAUR_A_KEY:-ttc_local-key-$CENTAUR_A}"
CENTAUR_B_KEY="${CENTAUR_B_KEY:-ttc_local-key-$CENTAUR_B}"
WANT_TURNS="${WANT_TURNS:-5}"
PW_ADVANCES="${PW_ADVANCES:-3}"

PIDS=()
cleanup() {
  set +e
  echo "[run-all] cleaning up..."
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  # Self-safe pattern: the bracket keeps this pkill from matching (and killing)
  # its own command line or this script.
  pkill -f "emulators[:]start" 2>/dev/null
  pkill -f "ts-node[/]register src/index.ts" 2>/dev/null
  sleep 3
  pkill -9 -f "emulators[:]start" 2>/dev/null
  echo "[run-all] logs in $LOG_DIR"
}
trap cleanup EXIT INT TERM

wait_for() { # wait_for <name> <url> <tries>
  local name="$1" url="$2" tries="${3:-90}"
  for _ in $(seq "$tries"); do
    if curl --noproxy '*' -sf -o /dev/null "$url"; then echo "[run-all] $name is up"; return 0; fi
    sleep 1
  done
  echo "[run-all] FAIL: $name never came up at $url" >&2
  return 1
}

echo "[run-all] logs: $LOG_DIR"

# 1. emulator suite (rebuilds functions first; see run-emulators.sh)
bash "$HERE/run-emulators.sh" >"$LOG_DIR/emulators.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 120); do
  grep -q "All emulators ready" "$LOG_DIR/emulators.log" && break
  sleep 1
done
grep -q "All emulators ready" "$LOG_DIR/emulators.log" || {
  echo "[run-all] FAIL: emulators never became ready — tail of log:" >&2
  tail -20 "$LOG_DIR/emulators.log" >&2
  exit 1
}
echo "[run-all] emulator suite ready"

# 2. centaurs (ts-node against the checkout; no dist writes)
CENTAUR_DIR="$CENTAUR_DIR" bash "$HERE/run-centaur.sh" "$CENTAUR_A_PORT" "$CENTAUR_A" "$CENTAUR_A_KEY" \
  >"$LOG_DIR/centaur-$CENTAUR_A.log" 2>&1 &
PIDS+=($!)
CENTAUR_DIR="$CENTAUR_DIR" bash "$HERE/run-centaur.sh" "$CENTAUR_B_PORT" "$CENTAUR_B" "$CENTAUR_B_KEY" \
  >"$LOG_DIR/centaur-$CENTAUR_B.log" 2>&1 &
PIDS+=($!)
wait_for "centaur $CENTAUR_A" "http://127.0.0.1:$CENTAUR_A_PORT/play" || exit 1
wait_for "centaur $CENTAUR_B" "http://127.0.0.1:$CENTAUR_B_PORT/play" || exit 1

# 3. presence pages BEFORE the game starts (they double as UI assertions)
node "$HERE/pw-smoke.mjs" "http://127.0.0.1:$CENTAUR_A_PORT" "$PW_ADVANCES" >"$LOG_DIR/pw-$CENTAUR_A.log" 2>&1 &
PW_A=$!
node "$HERE/pw-smoke.mjs" "http://127.0.0.1:$CENTAUR_B_PORT" "$PW_ADVANCES" >"$LOG_DIR/pw-$CENTAUR_B.log" 2>&1 &
PW_B=$!
PIDS+=("$PW_A" "$PW_B")
sleep 3 # let both pages land on /play

# 4. seed + start the game
E2E_CENTAURS="$CENTAUR_A::$CENTAUR_A_KEY,$CENTAUR_B::$CENTAUR_B_KEY" \
  node "$HERE/seed.mjs" | tee "$LOG_DIR/seed.log"
SESSION=$(sed -n 's/.*STARTED session=\([^ ]*\) .*/\1/p' "$LOG_DIR/seed.log" | tail -1)
GAME=$(sed -n 's/.*STARTED session=[^ ]* game=\([^ ]*\).*/\1/p' "$LOG_DIR/seed.log" | tail -1)
[ -n "$SESSION" ] && [ -n "$GAME" ] || { echo "[run-all] FAIL: seed did not report a started game" >&2; exit 1; }

# 5. assert turn progression on the game document
node "$HERE/watch.mjs" --session "$SESSION" --game "$GAME" --turns "$WANT_TURNS" --min-turns 3 \
  | tee "$LOG_DIR/watch.log"
WATCH_RC=${PIPESTATUS[0]}

# 6. collect the Playwright verdicts
wait "$PW_A"; PW_A_RC=$?
wait "$PW_B"; PW_B_RC=$?
cat "$LOG_DIR/pw-$CENTAUR_A.log" "$LOG_DIR/pw-$CENTAUR_B.log"

echo "[run-all] watch=$WATCH_RC pw-$CENTAUR_A=$PW_A_RC pw-$CENTAUR_B=$PW_B_RC"
if [ "$WATCH_RC" -eq 0 ] && [ "$PW_A_RC" -eq 0 ] && [ "$PW_B_RC" -eq 0 ]; then
  echo "[run-all] E2E PASS"
  exit 0
fi
echo "[run-all] E2E FAIL"
exit 1
