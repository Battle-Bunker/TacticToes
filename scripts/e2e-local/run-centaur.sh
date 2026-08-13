#!/usr/bin/env bash
# Run one Chris-Centaur instance against the LOCAL emulator suite.
#
# Usage: CENTAUR_DIR=/path/to/Chris-Centaur run-centaur.sh <port> <centaurId> <apiKey>
#
#   CENTAUR_DIR       required — a Chris-Centaur checkout with node_modules
#                     installed. The checkout is not written to: the process
#                     runs src/index.ts under ts-node (transpile-only), so no
#                     dist/ build output is produced.
#   PROJECT_ID        demo project id (must start with "demo-", default
#                     demo-teamsnek — must match the emulator suite)
#   FUNCTIONS_REGION  required -- no default by design. Must match the region
#                     the emulated functions were loaded with (a dummy value
#                     works as long as both sides agree).
#   EMULATOR_FIRESTORE / EMULATOR_AUTH / EMULATOR_FUNCTIONS
#                     override emulator endpoints (defaults match firebase.json)
#
# The apiKey must be one seeded by seed.mjs (default ttc_local-key-<id>).
set -euo pipefail

PORT_ARG="${1:?usage: run-centaur.sh <port> <centaurId> <apiKey>}"
CENTAUR_ID="${2:?usage: run-centaur.sh <port> <centaurId> <apiKey>}"
API_KEY="${3:?usage: run-centaur.sh <port> <centaurId> <apiKey>}"
CENTAUR_DIR="${CENTAUR_DIR:?set CENTAUR_DIR to a Chris-Centaur checkout}"

PROJECT_ID="${PROJECT_ID:-demo-teamsnek}"
case "$PROJECT_ID" in
  demo-*) ;;
  *) echo "refusing to start: PROJECT_ID must start with 'demo-' (got '$PROJECT_ID')" >&2; exit 1 ;;
esac

cd "$CENTAUR_DIR"

export PORT="$PORT_ARG"
export TACTICTOES_CENTAUR_ID="$CENTAUR_ID"
export TACTICTOES_CENTAUR_API_KEY="$API_KEY"
export TACTICTOES_FIREBASE_PROJECT_ID="$PROJECT_ID"
export TACTICTOES_FIREBASE_API_KEY=fake-api-key
export TACTICTOES_FUNCTIONS_REGION="${FUNCTIONS_REGION:?set FUNCTIONS_REGION -- no default; must match the region the emulated functions run in}"
export TACTICTOES_EMULATOR_FIRESTORE="${EMULATOR_FIRESTORE:-127.0.0.1:8080}"
export TACTICTOES_EMULATOR_AUTH="${EMULATOR_AUTH:-http://127.0.0.1:9099}"
export TACTICTOES_EMULATOR_FUNCTIONS="${EMULATOR_FUNCTIONS:-127.0.0.1:5001}"

# No Postgres in the loop: the centaur's decision logger degrades gracefully
# (logs a dropped-entry warning per decision) when DATABASE_URL is absent.
unset DATABASE_URL

export TS_NODE_TRANSPILE_ONLY=true
exec node --max-old-space-size=512 -r ts-node/register src/index.ts
