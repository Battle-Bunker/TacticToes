#!/usr/bin/env bash
set -euo pipefail

# Non-interactive Firebase deploy, intended for the Replit shell.
#
# Required environment (Replit Secrets):
#   VITE_FIREBASE_PROJECT_ID  target project, e.g. team-snek. Shared with the
#                        frontend build so the two cannot disagree.
#   GCP_SA_KEY_B64       base64 of the deployer service account JSON key
#                        (created by scripts/create-deployer-sa.sh)
#
# Optional:
#   VITE_FIREBASE_FUNCTIONS_REGION
#                        defaults to australia-southeast1, must match Firestore
#
# Usage:
#   bash scripts/deploy.sh                      # everything
#   bash scripts/deploy.sh functions            # just functions
#   bash scripts/deploy.sh firestore:rules      # just rules

TARGETS="${1:-firestore:rules,firestore:indexes,hosting,functions}"

: "${VITE_FIREBASE_PROJECT_ID:?set VITE_FIREBASE_PROJECT_ID (Replit Secrets)}"
: "${GCP_SA_KEY_B64:?set GCP_SA_KEY_B64 (Replit Secrets)}"

export VITE_FIREBASE_FUNCTIONS_REGION="${VITE_FIREBASE_FUNCTIONS_REGION:-australia-southeast1}"

# The CLI resolves credentials in this order: --token, FIREBASE_TOKEN, a cached
# interactive login in the configstore, and only THEN application default
# credentials. A stale `firebase login` therefore silently outranks the service
# account, so clear it before every deploy.
rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/configstore/firebase-tools.json"
unset FIREBASE_TOKEN || true

# Replit Secrets hold strings, but GOOGLE_APPLICATION_CREDENTIALS must be a
# path. Materialise the key outside the workspace so it cannot be committed or
# seen by Repl collaborators.
KEY_PATH="$(mktemp /tmp/firebase-sa-XXXXXX.json)"
chmod 600 "$KEY_PATH"
trap 'rm -f "$KEY_PATH"' EXIT
echo "$GCP_SA_KEY_B64" | base64 -d > "$KEY_PATH"
export GOOGLE_APPLICATION_CREDENTIALS="$KEY_PATH"

# `npx firebase` has been broken since firebase-tools v12, and `npm i -g` is
# unreliable on Replit's read-only Nix store. Prefer the local devDependency;
# fall back to the Nix-provided binary on PATH, which is what the deployment
# build has, since it does not npm install at the repo root.
if [ -x "./node_modules/.bin/firebase" ]; then
  FIREBASE_BIN="./node_modules/.bin/firebase"
elif command -v firebase >/dev/null 2>&1; then
  FIREBASE_BIN="$(command -v firebase)"
else
  echo "firebase-tools not found. Install it with:" >&2
  echo "  npm install --save-dev firebase-tools" >&2
  echo "or add it to [nix] packages in .replit." >&2
  exit 1
fi
echo "Using firebase CLI: $FIREBASE_BIN"

export CI=true

echo "Deploying [$TARGETS] to $VITE_FIREBASE_PROJECT_ID (region $VITE_FIREBASE_FUNCTIONS_REGION)"

# --project is passed explicitly. Neither FIREBASE_PROJECT nor GCLOUD_PROJECT
# selects the deploy target despite the names, and relying on .firebaserc alone
# leaves the choice to whatever the configstore last recorded for this
# directory.
"$FIREBASE_BIN" deploy \
  --only "$TARGETS" \
  --project "$VITE_FIREBASE_PROJECT_ID" \
  --non-interactive

echo "Deploy complete."
