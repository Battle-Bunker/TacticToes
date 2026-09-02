#!/usr/bin/env bash
set -euo pipefail

# Deploy Firebase Functions before starting the Replit dev server, but only when
# function deployment inputs have changed since the last successful deploy.
#
# This intentionally ignores frontend/, Firestore rules/indexes, docs, and tests
# outside functions/. A frontend-only edit therefore starts immediately.

: "${VITE_FIREBASE_PROJECT_ID:?set VITE_FIREBASE_PROJECT_ID in Replit Secrets}"
: "${VITE_FIREBASE_FUNCTIONS_REGION:?set VITE_FIREBASE_FUNCTIONS_REGION in Replit Secrets}"

if [ -z "${GCP_SA_KEY_B64:-}" ]; then
  echo "Firebase Functions auto-deploy skipped: GCP_SA_KEY_B64 is not set."
  echo "Add the deploy service-account key to Replit Secrets to enable it."
  exit 0
fi

STATE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/tactic-toes-firebase-deploy"
SAFE_TARGET="$(printf '%s-%s' "$VITE_FIREBASE_PROJECT_ID" "$VITE_FIREBASE_FUNCTIONS_REGION" |
  tr -c 'A-Za-z0-9._-' '_')"
STATE_FILE="$STATE_DIR/functions-${SAFE_TARGET}.sha256"

# Keep this list limited to inputs that can change the deployed functions.
# firebase.json is included because its functions source, ignore, codebase, and
# predeploy configuration affect the deployment.
mapfile -d '' INPUTS < <(
  {
    find functions/src functions/tools -type f -print0
    find functions -maxdepth 1 -type f \
      \( -name 'package.json' -o -name 'package-lock.json' \
      -o -name 'tsconfig*.json' -o -name '.eslintrc.*' \) -print0
    printf '%s\0' firebase.json
  } | sort -z
)

if [ "${#INPUTS[@]}" -eq 0 ]; then
  echo "ERROR: no Firebase Functions deployment inputs were found." >&2
  exit 1
fi

CURRENT_HASH="$(
  {
    printf 'project=%s\nregion=%s\n' \
      "$VITE_FIREBASE_PROJECT_ID" "$VITE_FIREBASE_FUNCTIONS_REGION"
    for file in "${INPUTS[@]}"; do
      printf '%s\0' "$file"
      sha256sum "$file"
    done
  } | sha256sum | awk '{print $1}'
)"

PREVIOUS_HASH=""
if [ -f "$STATE_FILE" ]; then
  read -r PREVIOUS_HASH < "$STATE_FILE"
fi

if [ "$CURRENT_HASH" = "$PREVIOUS_HASH" ]; then
  echo "Firebase Functions unchanged; skipping deploy."
  exit 0
fi

echo "Firebase Functions inputs changed; deploying to $VITE_FIREBASE_PROJECT_ID..."
bash scripts/deploy.sh functions

mkdir -p "$STATE_DIR"
printf '%s\n' "$CURRENT_HASH" > "$STATE_FILE"
echo "Recorded successful Firebase Functions deployment: $CURRENT_HASH"