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
APPENGINE_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

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
  # Deploying an onTaskDispatched function creates and configures its Cloud
  # Tasks queue from the options in source, and sets the enqueuer binding on it.
  # cloudfunctions.admin does not reach Cloud Tasks, so without this the deploy
  # fails with 403 cloudtasks.queues.get on a queue it is about to create.
  "roles/cloudtasks.admin"                  # task queue create/update/setIamPolicy
  # Functions builds push images to the gcf-artifacts repository. The bootstrap
  # script creates it, but the deployer still needs to write to it, and the CLI
  # sets a cleanup policy on it after deploying.
  "roles/artifactregistry.admin"            # gcf-artifacts push + cleanup policy
)

for role in "${DEPLOYER_ROLES[@]}"; do
  echo "  Granting $role to deployer..."
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
done

# actAs on the runtime SAs, scoped to those resources rather than project-wide.
#
# BOTH are needed, because this codebase mixes function generations and each
# generation runs as a different identity:
#   gen2 (onTaskDispatched)  -> the Compute Engine default SA
#   gen1 (everything else)   -> the App Engine default SA
# Granting only the compute one gets you through the gen2 deploy and then fails
# with "Missing permissions required for functions deploy ... iam.serviceAccounts
# .ActAs on service account PROJECT_ID@appspot.gserviceaccount.com".
RUNTIME_SAS=("$COMPUTE_SA" "$APPENGINE_SA")

for sa in "${RUNTIME_SAS[@]}"; do
  if ! gcloud iam service-accounts describe "$sa" --project="$PROJECT_ID" >/dev/null 2>&1; then
    echo "  Skipping actAs on $sa (does not exist yet)."
    echo "  If a gen1 deploy later fails on it, re-run this script."
    continue
  fi
  echo "  Granting deployer actAs on $sa..."
  gcloud iam service-accounts add-iam-policy-binding "$sa" \
    --member="serviceAccount:${SA_EMAIL}" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT_ID" \
    --quiet >/dev/null
done

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
echo "VITE_FIREBASE_PROJECT_ID = $PROJECT_ID"
echo "GCP_SA_KEY_B64      = (the single line below)"
echo ""
base64 -w0 /tmp/firebase-deployer-key.json 2>/dev/null || base64 /tmp/firebase-deployer-key.json | tr -d '\n'
echo ""
echo ""
echo "Then delete the local copy:  rm /tmp/firebase-deployer-key.json"
