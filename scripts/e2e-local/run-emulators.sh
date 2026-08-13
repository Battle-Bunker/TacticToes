#!/usr/bin/env bash
# Boot the Firebase emulator suite for local end-to-end runs.
#
# LOCAL ONLY: this runs against the emulator suite under a demo- project id.
# It never talks to a deployed Firebase project (demo- ids are reserved by
# firebase-tools for offline use and cannot resolve to a real project).
#
# Usage: run-emulators.sh [timeout-seconds]
#   PROJECT_ID  override the demo project id (must start with "demo-",
#               default demo-teamsnek)
#   FUNCTIONS_REGION (or VITE_FIREBASE_FUNCTIONS_REGION)
#               required -- no default by design (functions/src/config/region.ts
#               throws without it). Any value works for the emulators (e.g.
#               local-region-1), but every client hitting the emulated
#               callables must use the same value.
#
# Ports (from firebase.json): firestore 8080, functions 5001, auth 9099,
# tasks 9499, emulator UI 4000, hub 4400.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT_ID="${PROJECT_ID:-demo-teamsnek}"
case "$PROJECT_ID" in
  demo-*) ;;
  *) echo "refusing to start: PROJECT_ID must start with 'demo-' (got '$PROJECT_ID')" >&2; exit 1 ;;
esac
TIMEOUT_SECS="${1:-${EMULATOR_TIMEOUT_SECS:-1800}}"

# Region is required, no default: functions/src/config/region.ts throws at
# load without it, which would kill the functions emulator at discovery time.
# A dummy value is fine locally as long as clients use the same one.
export VITE_FIREBASE_FUNCTIONS_REGION="${VITE_FIREBASE_FUNCTIONS_REGION:-${FUNCTIONS_REGION:-}}"
: "${VITE_FIREBASE_FUNCTIONS_REGION:?set FUNCTIONS_REGION (or VITE_FIREBASE_FUNCTIONS_REGION) -- no default; any value works for the emulators, e.g. local-region-1}"

cd "$ROOT"

if [ ! -x node_modules/.bin/firebase ]; then
  echo "firebase-tools not installed — run 'npm install' at the repo root once" >&2
  exit 1
fi

# The functions emulator serves the COMPILED output (functions/lib). Rebuild
# immediately before every boot so lib/ matches src/ — a stale or missing
# build makes the suite come up with old (or zero) trigger definitions.
echo "[run-emulators] building functions (tsc)..."
(cd functions && ./node_modules/.bin/tsc)
if [ ! -f functions/lib/functions/src/index.js ]; then
  echo "functions build did not produce functions/lib/functions/src/index.js" >&2
  exit 1
fi

# Proxy sentinel — do not remove. This container routes HTTPS through an
# agent proxy, and firebase-tools' internal HTTP client (apiv2) ignores
# no_proxy, so emulator-internal calls (hub <-> functions <-> firestore)
# get swallowed by the proxy and the suite hangs. Setting the variables to
# the literal string "undefined" makes the proxy URL unparseable, which
# apiv2 treats as "no proxy". Plain `unset` is NOT enough when the parent
# shell re-exports them; the sentinel wins in all cases.
export HTTP_PROXY=undefined HTTPS_PROXY=undefined http_proxy=undefined https_proxy=undefined

echo "[run-emulators] starting emulator suite (project $PROJECT_ID, timeout ${TIMEOUT_SECS}s)"
exec timeout "$TIMEOUT_SECS" ./node_modules/.bin/firebase emulators:start \
  --only firestore,auth,functions,tasks --project "$PROJECT_ID"
