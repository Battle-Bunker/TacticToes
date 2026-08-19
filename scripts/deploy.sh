#!/usr/bin/env bash
set -euo pipefail

# Non-interactive Firebase deploy, intended for the Replit shell.
#
# Required environment (Replit Secrets):
#   VITE_FIREBASE_PROJECT_ID  target project, e.g. team-snek. Shared with the
#                        frontend build so the two cannot disagree.
#   GCP_SA_KEY_B64       base64 of the deployer service account JSON key
#                        (created by scripts/create-deployer-sa.sh)
#   VITE_FIREBASE_FUNCTIONS_REGION
#                        no default by design; must match the target project's
#                        Firestore region. Read straight from the environment
#                        by both halves of the deploy: the frontend build
#                        (Vite) and the functions build, which stamps it into
#                        the generated entrypoint for the CLI's function
#                        discovery and the deployed runtime (see
#                        functions/tools/build-entry.mjs). No config files are
#                        involved anywhere.
#
# Usage:
#   bash scripts/deploy.sh                      # everything
#   bash scripts/deploy.sh functions            # just functions
#   bash scripts/deploy.sh firestore:rules      # just rules

TARGETS="${1:-firestore:rules,firestore:indexes,hosting,functions}"

: "${VITE_FIREBASE_PROJECT_ID:?set VITE_FIREBASE_PROJECT_ID (Replit Secrets)}"
: "${GCP_SA_KEY_B64:?set GCP_SA_KEY_B64 (Replit Secrets)}"
: "${VITE_FIREBASE_FUNCTIONS_REGION:?set VITE_FIREBASE_FUNCTIONS_REGION -- there is no default; it must match the Firestore region of the target project}"
# Exported, not just set: the functions build runs as the CLI's predeploy hook
# and reads it from the environment, which is the only channel that carries a
# deployment secret into function discovery and the deployed runtime.
export VITE_FIREBASE_FUNCTIONS_REGION

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

# Guard: the (default) Firestore database must already exist. firebase.json
# deliberately pins no "location" (region hardcodes are banned), which revives
# a known footgun: `firebase deploy --only firestore:rules` against a project
# with no database SILENTLY CREATES one, defaulting to the nam5 US
# multi-region, with no prompt even in interactive mode -- and Firestore
# location is permanent. So verify the database exists before deploying
# anything, and leave database creation to scripts/bootstrap-gcp-project.sh.
DB_LIST="$("$FIREBASE_BIN" firestore:databases:list \
  --project "$VITE_FIREBASE_PROJECT_ID" --non-interactive 2>&1)" || {
  echo "ERROR: could not list Firestore databases for $VITE_FIREBASE_PROJECT_ID:" >&2
  echo "$DB_LIST" >&2
  exit 1
}
if ! echo "$DB_LIST" | grep -qF "(default)"; then
  echo "ERROR: project $VITE_FIREBASE_PROJECT_ID has no (default) Firestore database." >&2
  echo "Deploying now would let the Firebase CLI silently create one in the" >&2
  echo "wrong region (nam5), and Firestore location is PERMANENT." >&2
  echo "Create the database first with scripts/bootstrap-gcp-project.sh, in the" >&2
  echo "region that VITE_FIREBASE_FUNCTIONS_REGION names." >&2
  exit 1
fi

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
