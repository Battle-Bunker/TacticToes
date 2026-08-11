#!/usr/bin/env bash
set -euo pipefail

# Replit Deployments build entrypoint (see [deployment] in .replit).
#
# Runs when you publish the Repl to production. It does two things:
#   1. deploys the Firebase backend to the PRODUCTION project (team-snek)
#   2. builds the frontend that Replit then serves as a static site
#
# The Replit *development* environment never reaches production: it points at
# the dev Firebase project via [userenv.development] in .replit, and this script
# is only invoked by the deployment build.
#
# Required in Replit DEPLOYMENT secrets (not workspace secrets):
#   GCP_SA_KEY_B64        base64 of the team-snek deployer key
#   VITE_FIREBASE_*       the production web app config (7 vars)
#
# Optional overrides:
#   FIREBASE_PROD_PROJECT_ID   default team-snek
#   FIREBASE_PROD_REGION       default australia-southeast1
#   REPLIT_DEPLOY_TARGETS      default firestore:rules,firestore:indexes,functions

PROD_PROJECT_ID="${FIREBASE_PROD_PROJECT_ID:-team-snek}"
PROD_REGION="${FIREBASE_PROD_REGION:-australia-southeast1}"

# Firebase Hosting is deliberately NOT in the default target list. Replit serves
# the frontend from frontend/dist as a static deployment, so also publishing to
# Firebase Hosting would leave a second live copy at team-snek.web.app drifting
# out of sync. Add "hosting" here only if you intend Firebase to serve the app.
TARGETS="${REPLIT_DEPLOY_TARGETS:-firestore:rules,firestore:indexes,functions}"

# Set rather than defaulted. [userenv.development] pins these to us-central1 for
# the dev project, and inheriting that here would deploy production functions to
# the wrong region -- Firestore triggers fail outright against a Sydney database,
# and callables that did deploy would 404 for a Sydney client.
export FUNCTIONS_REGION="$PROD_REGION"
export VITE_FIREBASE_FUNCTIONS_REGION="$PROD_REGION"

echo "=========================================="
echo "Replit production deploy"
echo "  Firebase project: $PROD_PROJECT_ID"
echo "  Region:           $PROD_REGION"
echo "  Targets:          $TARGETS"
echo "=========================================="

if [ -z "${GCP_SA_KEY_B64:-}" ]; then
    echo "ERROR: GCP_SA_KEY_B64 is not set in this deployment's secrets." >&2
    echo "Without it the Firebase backend cannot be deployed. Add it under" >&2
    echo "the deployment's Secrets, or set REPLIT_DEPLOY_TARGETS= to skip the" >&2
    echo "Firebase step and publish the frontend only." >&2
    exit 1
fi

if [ -n "$TARGETS" ]; then
    FIREBASE_PROJECT_ID="$PROD_PROJECT_ID" bash "$(dirname "${BASH_SOURCE[0]}")/deploy.sh" "$TARGETS"
else
    echo "REPLIT_DEPLOY_TARGETS is empty - skipping the Firebase deploy."
fi

echo ""
echo "Building frontend for Replit static hosting..."

# Fail loudly rather than shipping a bundle wired to the wrong project. The
# frontend config throws on missing vars at import time, so a build that omits
# them produces a site that is blank on load.
: "${VITE_FIREBASE_PROJECT_ID:?production VITE_FIREBASE_* vars missing from deployment secrets}"

if [ "$VITE_FIREBASE_PROJECT_ID" != "$PROD_PROJECT_ID" ]; then
    echo "WARNING: VITE_FIREBASE_PROJECT_ID is '$VITE_FIREBASE_PROJECT_ID' but this" >&2
    echo "deploy targets '$PROD_PROJECT_ID'. The published frontend will talk to a" >&2
    echo "different project than the backend just deployed." >&2
fi

cd frontend
npm run build
cp dist/index.html dist/404.html

echo ""
echo "Deploy complete: backend on $PROD_PROJECT_ID, frontend built for Replit."
