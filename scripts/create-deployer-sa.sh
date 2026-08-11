#!/usr/bin/env bash
set -euo pipefail

# Creates the service account that Replit (and any other non-interactive shell)
# uses to deploy. Run this ONCE per project, from a machine with an authenticated
# gcloud as a project Owner -- not from Replit.
#
# Usage: bash scripts/create-deployer-sa.sh <PROJECT_ID>

if [ -z "${1:-}" ]; then
  echo "Usage: $0 <PROJECT_ID>" >&2
  exit 1
fi

PROJECT_ID="$1"
SA_NAME="firebase-deployer"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

echo "Project: $PROJECT_ID ($PROJECT_NUMBER)"

gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Firebase CI deployer" \
  --project="$PROJECT_ID" \
  --quiet 2>/dev/null || echo "  Service account already exists."

# Project-level roles. firebase.admin alone is NOT sufficient for functions, and
# it does not cover Firestore indexes -- both gaps are documented behaviour.
DEPLOYER_ROLES=(
  "roles/firebase.admin"                    # hosting, rules, project read
  "roles/datastore.indexAdmin"              # firestore:indexes
  "roles/cloudfunctions.admin"              # functions deploy (gen1 + gen2)
  "roles/serviceusage.serviceUsageConsumer" # enabling APIs during deploy
)

for role in "${DEPLOYER_ROLES[@]}"; do
  echo "  Granting $role to deployer..."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# actAs on the runtime SA, scoped to that resource rather than project-wide.
echo "  Granting deployer actAs on the runtime service account..."
gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountUser" \
  --project="$PROJECT_ID" \
  --quiet >/dev/null

# Since mid-2024 Cloud Build runs as the compute default SA, and (for orgs
# created on/after 2024-05-03) that account is created with no roles at all.
# Without this the first functions deploy fails at the build step.
echo "  Granting build permissions to the compute default service account..."
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${COMPUTE_SA}" \
  --role="roles/cloudbuild.builds.builder" \
  --condition=None \
  --quiet >/dev/null

echo ""
echo "Creating key. If this fails with 'key creation is disabled', your org"
echo "enforces constraints/iam.disableServiceAccountKeyCreation and needs a"
echo "project-level exemption."
gcloud iam service-accounts keys create /tmp/firebase-deployer-key.json \
  --iam-account="$SA_EMAIL" \
  --project="$PROJECT_ID"

echo ""
echo "=========================================="
echo "Add these to Replit Secrets:"
echo "=========================================="
echo "FIREBASE_PROJECT_ID = $PROJECT_ID"
echo "GCP_SA_KEY_B64      = (the single line below)"
echo ""
base64 -w0 /tmp/firebase-deployer-key.json 2>/dev/null || base64 /tmp/firebase-deployer-key.json | tr -d '\n'
echo ""
echo ""
echo "Then delete the local copy:  rm /tmp/firebase-deployer-key.json"
