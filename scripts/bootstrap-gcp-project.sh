#!/bin/bash
set -e

echo "=========================================="
echo "Firebase/GCP Project Bootstrap Script"
echo "=========================================="
echo ""
echo "This script configures a new GCP project with all required APIs and IAM"
echo "permissions for deploying this Firebase application (Functions, Firestore,"
echo "Hosting, Auth, Cloud Tasks)."
echo ""
echo "Prerequisites:"
echo "  - gcloud CLI installed and authenticated"
echo "  - Firebase CLI installed and authenticated"
echo "  - You have Owner or Editor role on the target GCP project"
echo "  - Billing is enabled on the project"
echo ""

if [ -z "$1" ]; then
    echo "Usage: $0 <PROJECT_ID>"
    echo ""
    echo "Example: $0 my-firebase-project-dev"
    exit 1
fi

PROJECT_ID="$1"

echo "Fetching project number for: $PROJECT_ID"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")

if [ -z "$PROJECT_NUMBER" ]; then
    echo "ERROR: Could not retrieve project number. Check that the project exists and you have access."
    exit 1
fi

echo "Project ID: $PROJECT_ID"
echo "Project Number: $PROJECT_NUMBER"
echo ""

echo "=========================================="
echo "Step 1: Enable Required APIs"
echo "=========================================="

APIS=(
    "firebase.googleapis.com"
    "firestore.googleapis.com"
    "identitytoolkit.googleapis.com"
    "cloudfunctions.googleapis.com"
    "run.googleapis.com"
    "eventarc.googleapis.com"
    "cloudbuild.googleapis.com"
    "artifactregistry.googleapis.com"
    "cloudtasks.googleapis.com"
    "pubsub.googleapis.com"
    "storage.googleapis.com"
    "logging.googleapis.com"
    "cloudresourcemanager.googleapis.com"
    "iam.googleapis.com"
    "secretmanager.googleapis.com"
)

echo "Enabling ${#APIS[@]} APIs..."
for api in "${APIS[@]}"; do
    echo "  - $api"
done

gcloud services enable "${APIS[@]}" --project="$PROJECT_ID"

echo ""
echo "APIs enabled successfully."
echo ""

echo "=========================================="
echo "Step 2: Wait for Service Agents (if needed)"
echo "=========================================="

CLOUD_BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
GCF_SA="service-${PROJECT_NUMBER}@gcf-admin-robot.iam.gserviceaccount.com"
SERVERLESS_SA="service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com"
APPENGINE_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

check_sa_exists() {
    gcloud iam service-accounts describe "$1" --project="$PROJECT_ID" --format='value(email)' >/dev/null 2>&1
}

REQUIRED_SAS=("$CLOUD_BUILD_SA" "$COMPUTE_SA")

all_exist=true
for sa in "${REQUIRED_SAS[@]}"; do
    if ! check_sa_exists "$sa"; then
        all_exist=false
        break
    fi
done

if $all_exist; then
    echo "All required service accounts already exist. Skipping wait."
else
    echo "Waiting for GCP to create service agents..."
    for attempt in {1..6}; do
        missing=()
        for sa in "${REQUIRED_SAS[@]}"; do
            if ! check_sa_exists "$sa"; then
                missing+=("$sa")
            fi
        done
        if [ ${#missing[@]} -eq 0 ]; then
            echo "All service accounts are ready."
            break
        fi
        echo "  Attempt $attempt/6: Waiting for ${#missing[@]} service account(s)..."
        sleep 5
    done
fi

echo ""
echo "=========================================="
echo "Step 3: Grant IAM Permissions to Cloud Build Service Account"
echo "=========================================="

echo "Cloud Build SA: $CLOUD_BUILD_SA"

CLOUD_BUILD_ROLES=(
    "roles/artifactregistry.writer"
    "roles/storage.objectAdmin"
    "roles/logging.logWriter"
)

for role in "${CLOUD_BUILD_ROLES[@]}"; do
    echo "  Granting $role..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$CLOUD_BUILD_SA" \
        --role="$role" \
        --condition=None \
        --quiet
done

echo ""
echo "=========================================="
echo "Step 4: Grant IAM Permissions to Compute Service Account"
echo "=========================================="

echo "Compute SA: $COMPUTE_SA"

COMPUTE_ROLES=(
    "roles/artifactregistry.writer"
    "roles/cloudbuild.builds.builder"
    "roles/logging.logWriter"
    "roles/storage.objectAdmin"
    "roles/datastore.user"
    "roles/cloudtasks.enqueuer"
    "roles/pubsub.publisher"
    "roles/run.invoker"
)

for role in "${COMPUTE_ROLES[@]}"; do
    echo "  Granting $role..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$COMPUTE_SA" \
        --role="$role" \
        --condition=None \
        --quiet
done

echo ""
echo "=========================================="
echo "Step 5: Grant IAM Permissions to Cloud Functions Service Agent"
echo "=========================================="

echo "Cloud Functions SA: $GCF_SA"

GCF_ROLES=(
    "roles/artifactregistry.reader"
)

for role in "${GCF_ROLES[@]}"; do
    echo "  Granting $role..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$GCF_SA" \
        --role="$role" \
        --condition=None \
        --quiet 2>/dev/null || echo "    (May not exist yet - will be created on first deploy)"
done

echo ""
echo "=========================================="
echo "Step 6: Grant IAM Permissions to Serverless Robot (Gen2 Functions)"
echo "=========================================="

echo "Serverless Robot SA: $SERVERLESS_SA"

SERVERLESS_ROLES=(
    "roles/artifactregistry.reader"
    "roles/run.invoker"
)

for role in "${SERVERLESS_ROLES[@]}"; do
    echo "  Granting $role..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$SERVERLESS_SA" \
        --role="$role" \
        --condition=None \
        --quiet 2>/dev/null || echo "    (May not exist yet - will be created on first deploy)"
done

echo ""
echo "=========================================="
echo "Step 7: Grant IAM Permissions to App Engine Default Service Account"
echo "=========================================="

echo "App Engine SA: $APPENGINE_SA"

APPENGINE_ROLES=(
    "roles/datastore.user"
    "roles/cloudtasks.enqueuer"
    "roles/storage.objectAdmin"
)

for role in "${APPENGINE_ROLES[@]}"; do
    echo "  Granting $role..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$APPENGINE_SA" \
        --role="$role" \
        --condition=None \
        --quiet 2>/dev/null || echo "    (May not exist yet - will be created on first deploy)"
done

echo ""
echo "=========================================="
echo "Step 8: Grant Compute SA Permission to Act As App Engine SA"
echo "=========================================="

echo "This allows Cloud Functions to schedule Cloud Tasks"
gcloud iam service-accounts add-iam-policy-binding "$APPENGINE_SA" \
    --member="serviceAccount:$COMPUTE_SA" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT_ID" \
    --quiet 2>/dev/null || echo "    (May not exist yet - will be created on first deploy)"

echo ""
echo "=========================================="
echo "Step 9: Grant Public Access to Callable Functions"
echo "=========================================="

echo "Granting allUsers invoker access to wakeBot function..."
gcloud functions add-iam-policy-binding wakeBot \
    --region=us-central1 \
    --member=allUsers \
    --role=roles/cloudfunctions.invoker \
    --project="$PROJECT_ID" \
    --quiet 2>/dev/null || echo "    (Function may not exist yet - run after first deploy)"

echo ""
echo "=========================================="
echo "Step 10: Create Cloud Tasks Queue"
echo "=========================================="

QUEUE_NAME="turn-expiration-queue"
QUEUE_LOCATION="us-central1"

echo "Creating Cloud Tasks queue: $QUEUE_NAME in $QUEUE_LOCATION"

gcloud tasks queues create "$QUEUE_NAME" \
    --location="$QUEUE_LOCATION" \
    --project="$PROJECT_ID" \
    2>/dev/null || echo "Queue already exists or will be created on first use."

echo ""
echo "=========================================="
echo "Bootstrap Complete!"
echo "=========================================="
echo ""
echo "Next steps:"
echo "  1. Run 'firebase use $PROJECT_ID' to select this project"
echo "  2. Run 'firebase deploy' to deploy all resources"
echo ""
echo "If you still encounter permission errors during deploy, check the"
echo "Cloud Build logs in the GCP Console for specific missing permissions."
echo ""
echo "Common additional permissions that may be needed:"
echo "  - roles/eventarc.eventReceiver (for Eventarc triggers)"
echo "  - roles/secretmanager.secretAccessor (if using Secret Manager)"
echo "  - roles/firebase.admin (for full Firebase access)"
echo ""
