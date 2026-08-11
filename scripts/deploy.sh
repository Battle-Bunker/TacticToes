#!/usr/bin/env bash
set -euo pipefail

# Non-interactive Firebase deploy, intended for the Replit shell.
#
# Required environment (Replit Secrets):
#   FIREBASE_PROJECT_ID  target project, e.g. tactic-toes-au
#   GCP_SA_KEY_B64       base64 of the deployer service account JSON key
#                        (created by scripts/create-deployer-sa.sh)
#
# Optional:
#   FUNCTIONS_REGION     defaults to australia-southeast1, must match Firestore
#
# Usage:
#   bash scripts/deploy.sh                      # everything
#   bash scripts/deploy.sh functions            # just functions
#   bash scripts/deploy.sh firestore:rules      # just rules

TARGETS="${1:-firestore:rules,firestore:indexes,hosting,functions}"

: "${FIREBASE_PROJECT_ID:?set FIREBASE_PROJECT_ID (Replit Secrets)}"
: "${GCP_SA_KEY_B64:?set GCP_SA_KEY_B64 (Replit Secrets)}"

export FUNCTIONS_REGION="${FUNCTIONS_REGION:-australia-southeast1}"

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
# unreliable on Replit's read-only Nix store. Invoke the local binary directly.
FIREBASE_BIN="./node_modules/.bin/firebase"
if [ ! -x "$FIREBASE_BIN" ]; then
  echo "firebase-tools not installed. Run: npm install --save-dev firebase-tools" >&2
  exit 1
fi

export CI=true

echo "Deploying [$TARGETS] to $FIREBASE_PROJECT_ID (region $FUNCTIONS_REGION)"

# --project is passed explicitly: FIREBASE_PROJECT and GCLOUD_PROJECT do NOT
# select the deploy target, and relying on .firebaserc alone leaves the choice
# to whatever the configstore last recorded for this directory.
"$FIREBASE_BIN" deploy \
  --only "$TARGETS" \
  --project "$FIREBASE_PROJECT_ID" \
  --non-interactive

echo "Deploy complete."
