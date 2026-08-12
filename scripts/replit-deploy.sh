#!/usr/bin/env bash
set -euo pipefail

# Replit Deployments build entrypoint (see [deployment] in .replit).
#
# Runs when you publish the Repl to production. It does two things:
#   1. deploys the Firebase backend to the project the frontend is built for
#   2. builds the frontend that Replit then serves as a static site
#
# The Replit *development* environment never reaches production: its workspace
# Secrets name the dev project, it holds no production deploy key, and this
# script runs only in the deployment build. Nothing in git names either project,
# so the two cannot be confused by a stale committed value.
#
# Required in Replit DEPLOYMENT secrets (not workspace secrets):
#   GCP_SA_KEY_B64        base64 of the production deployer key
#   VITE_FIREBASE_*       the production web app config, exactly as printed by
#                         scripts/bootstrap-gcp-project.sh
#
# Optional:
#   REPLIT_DEPLOY_TARGETS  default firestore:rules,firestore:indexes,functions

# Firebase Hosting is deliberately NOT in the default target list. Replit serves
# the frontend from frontend/dist as a static deployment, so also publishing to
# Firebase Hosting would leave a second live copy at <project>.web.app drifting
# out of sync. Add "hosting" here only if you intend Firebase to serve the app.
TARGETS="${REPLIT_DEPLOY_TARGETS:-firestore:rules,firestore:indexes,functions}"

# One variable drives both the backend deploy target and the frontend build, so
# the published site cannot end up talking to a different project than the one
# just deployed. The frontend config throws on a missing value at import time,
# so an unset var here would otherwise ship a site that is blank on load.
: "${VITE_FIREBASE_PROJECT_ID:?production VITE_FIREBASE_ vars missing from the deployment secrets}"

echo "=========================================="
echo "Replit production deploy"
echo "  Firebase project: $VITE_FIREBASE_PROJECT_ID"
echo "  Region:           ${VITE_FIREBASE_FUNCTIONS_REGION:-australia-southeast1 (default)}"
echo "  Targets:          ${TARGETS:-<none>}"
echo "=========================================="

if [ -z "${GCP_SA_KEY_B64:-}" ]; then
    echo "ERROR: GCP_SA_KEY_B64 is not set in this deployment's secrets." >&2
    echo "Without it the Firebase backend cannot be deployed. Add it under" >&2
    echo "the deployment's Secrets, or set REPLIT_DEPLOY_TARGETS= to skip the" >&2
    echo "Firebase step and publish the frontend only." >&2
    exit 1
fi

if [ -n "$TARGETS" ]; then
    bash "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "$TARGETS"
else
    echo "REPLIT_DEPLOY_TARGETS is empty - skipping the Firebase deploy."
fi

echo ""
echo "Building frontend for Replit static hosting..."

cd frontend
npm run build
cp dist/index.html dist/404.html

echo ""
echo "Deploy complete: backend and frontend both on $VITE_FIREBASE_PROJECT_ID."
