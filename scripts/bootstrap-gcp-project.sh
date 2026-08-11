#!/bin/bash
set -euo pipefail

# =============================================================================
# Firebase/GCP Project Bootstrap
# =============================================================================
#
# Takes a freshly created Firebase project with billing enabled and provisions
# everything needed to deploy this app: APIs, the Firestore database, IAM, the
# Anonymous auth provider, and a registered Web app.
#
# INTENDED TO RUN IN GOOGLE CLOUD SHELL, authenticated as a project Owner.
# Cloud Shell already has gcloud authenticated as you, which is what lets this
# script call the Firebase and Identity Toolkit REST APIs without any extra
# credential setup. It deliberately does NOT require firebase-tools, which is
# not preinstalled there.
#
# Safe to re-run. Every step checks before it creates, and every IAM change is
# additive (add-iam-policy-binding, never set-iam-policy).
#
# Usage:
#   bash scripts/bootstrap-gcp-project.sh <PROJECT_ID> [REGION]
#
# REGION defaults to australia-southeast1 and must match BOTH the Firestore
# location and functions/src/config/region.ts.
# =============================================================================

if [ -z "${1:-}" ]; then
    echo "Usage: $0 <PROJECT_ID> [REGION]"
    echo ""
    echo "Example: $0 tactic-toes-au"
    echo "Example: $0 tactic-toes-au australia-southeast1"
    exit 1
fi

PROJECT_ID="$1"
REGION="${2:-australia-southeast1}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

section() {
    echo ""
    echo "=========================================="
    echo "$1"
    echo "=========================================="
}

api() {
    # api <METHOD> <URL> [JSON_BODY]
    local method="$1" url="$2" body="${3:-}"
    if [ -n "$body" ]; then
        curl -sS -X "$method" \
            -H "Authorization: Bearer $(gcloud auth print-access-token)" \
            -H "Content-Type: application/json" \
            -H "X-Goog-User-Project: ${PROJECT_ID}" \
            "$url" -d "$body"
    else
        curl -sS -X "$method" \
            -H "Authorization: Bearer $(gcloud auth print-access-token)" \
            -H "X-Goog-User-Project: ${PROJECT_ID}" \
            "$url"
    fi
}

json_get() {
    # json_get <dotted.path> -- reads JSON on stdin, prints value or nothing
    python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
for k in sys.argv[1].split("."):
    if isinstance(d,list):
        try: d=d[int(k)]
        except Exception: sys.exit(0)
    elif isinstance(d,dict): d=d.get(k)
    else: sys.exit(0)
    if d is None: sys.exit(0)
print(d if not isinstance(d,(dict,list)) else json.dumps(d))
' "$1"
}

section "Preflight"

if ! command -v gcloud >/dev/null 2>&1; then
    echo "ERROR: gcloud is required. Run this in Google Cloud Shell." >&2
    exit 1
fi

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)' 2>/dev/null || true)"
if [ -z "$PROJECT_NUMBER" ]; then
    echo "ERROR: Cannot read project '$PROJECT_ID'. Check the ID and your access." >&2
    exit 1
fi

# Fail fast on Spark. Cloud Functions gen2 cannot deploy without billing, and
# several API enables below will fail in confusing ways.
BILLING_ENABLED="$(gcloud billing projects describe "$PROJECT_ID" \
    --format='value(billingEnabled)' 2>/dev/null || echo "UNKNOWN")"
if [ "$BILLING_ENABLED" != "True" ]; then
    echo "ERROR: Billing is not enabled on '$PROJECT_ID' (got: $BILLING_ENABLED)." >&2
    echo "Upgrade to the Blaze plan before running this script:" >&2
    echo "  Firebase console -> Usage and billing -> Details & settings -> Modify plan" >&2
    exit 1
fi

echo "Project ID:     $PROJECT_ID"
echo "Project Number: $PROJECT_NUMBER"
echo "Region:         $REGION"
echo "Billing:        enabled"

section "Step 1: Enable Required APIs"

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
    "iamcredentials.googleapis.com"
    "secretmanager.googleapis.com"
    # Enabling compute is what materialises the Compute Engine default service
    # account, which is the gen2 functions runtime identity and (since 2024) the
    # Cloud Build identity. Without it the IAM grants below have no target.
    "compute.googleapis.com"
)

echo "Enabling ${#APIS[@]} APIs (this can take a couple of minutes)..."
gcloud services enable "${APIS[@]}" --project="$PROJECT_ID"
echo "APIs enabled."

section "Step 2: Create Firestore Database"

# Order matters. Two separate failure modes if this runs late:
#   1. Deploying functions with Firestore triggers fails outright, because the
#      CLI resolves the trigger region by reading the database.
#   2. Far worse: `firebase deploy --only firestore:rules` SILENTLY CREATES the
#      database itself if it is missing, defaulting to the nam5 US multi-region,
#      with no prompt in either interactive or non-interactive mode. Location is
#      permanent, so that mistake costs you the project.
# firebase.json also pins "location" as a second line of defence.

if gcloud firestore databases describe --database='(default)' \
       --project="$PROJECT_ID" >/dev/null 2>&1; then
    EXISTING_LOC="$(gcloud firestore databases describe --database='(default)' \
        --project="$PROJECT_ID" --format='value(locationId)')"
    echo "Database (default) already exists in: $EXISTING_LOC"
    if [ "$EXISTING_LOC" != "$REGION" ]; then
        echo "" >&2
        echo "ERROR: existing database is in '$EXISTING_LOC', not '$REGION'." >&2
        echo "Firestore location is PERMANENT and cannot be changed. To proceed" >&2
        echo "you need a new project, or you must re-run this script with" >&2
        echo "REGION=$EXISTING_LOC and set VITE_FIREBASE_FUNCTIONS_REGION to match." >&2
        exit 1
    fi
else
    echo "Creating Firestore (default) database, Native mode, in $REGION..."
    # Edition is stated explicitly rather than inherited. Like location, it is
    # permanent -- there is no --edition flag on `databases update`, and the
    # only way across is an export/import into a new database.
    #
    # Standard is the correct choice here and Enterprise is disqualified outright:
    # Enterprise does not support Cloud Functions 1st gen, and all three Firestore
    # triggers in this repo are 1st gen. Enterprise also creates no indexes at all
    # by default, so the automatic single-field indexes this app relies on would
    # become billed collection scans rather than errors.
    gcloud firestore databases create \
        --database='(default)' \
        --location="$REGION" \
        --type=firestore-native \
        --edition=standard \
        --project="$PROJECT_ID"
    echo "Database created."
fi

section "Step 3: Resolve Service Accounts"

CLOUD_BUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
GCF_SA="service-${PROJECT_NUMBER}@gcf-admin-robot.iam.gserviceaccount.com"
SERVERLESS_SA="service-${PROJECT_NUMBER}@serverless-robot-prod.iam.gserviceaccount.com"
APPENGINE_SA="${PROJECT_ID}@appspot.gserviceaccount.com"

sa_exists() {
    gcloud iam service-accounts describe "$1" --project="$PROJECT_ID" \
        --format='value(email)' >/dev/null 2>&1
}

echo "Waiting for the Compute Engine default service account..."
for attempt in $(seq 1 12); do
    if sa_exists "$COMPUTE_SA"; then
        echo "  Ready: $COMPUTE_SA"
        break
    fi
    echo "  Attempt $attempt/12..."
    sleep 5
done

if ! sa_exists "$COMPUTE_SA"; then
    echo "ERROR: $COMPUTE_SA never appeared. Confirm compute.googleapis.com" >&2
    echo "enabled successfully, then re-run." >&2
    exit 1
fi

# The appspot SA is the RUNTIME identity for gen1 functions, and this codebase
# has nine of them. It is only documented as being created when an App Engine
# app is provisioned, and since late 2024 neither Firestore nor the default
# Storage bucket provisions one. Grants against a missing principal are rejected
# outright, so every use of it below is guarded.
#
# In practice the Cloud Functions v1 control plane appears to create it on first
# deploy -- Google's own error text for a missing appspot SA suggests toggling
# the Cloud Functions API as the remedy. So this is a warning, not a hard stop.
if sa_exists "$APPENGINE_SA"; then
    HAVE_APPENGINE_SA=true
    echo "  Present: $APPENGINE_SA"
else
    HAVE_APPENGINE_SA=false
    echo "  Absent:  $APPENGINE_SA"
    echo ""
    echo "  This project has no App Engine app, so the gen1 functions runtime"
    echo "  service account does not exist yet. It will most likely be created"
    echo "  by the first functions deploy. If that deploy instead fails with"
    echo "  \"Default service account '...@appspot.gserviceaccount.com' doesn't"
    echo "  exist\", re-run this script with CREATE_APP_ENGINE_APP=1 to provision"
    echo "  an App Engine app, which is the only documented way to create it."
    echo ""

    if [ "${CREATE_APP_ENGINE_APP:-0}" = "1" ]; then
        echo "  CREATE_APP_ENGINE_APP=1 set -- creating App Engine app in $REGION."
        echo "  NOTE: the App Engine region is PERMANENT and there is one app per"
        echo "  project. This is low-risk here because Firestore has already pinned"
        echo "  the project's location to $REGION, and an app with no deployed"
        echo "  version costs nothing."
        gcloud app create --region="$REGION" --project="$PROJECT_ID" --quiet
        for attempt in $(seq 1 12); do
            sa_exists "$APPENGINE_SA" && break
            echo "    Waiting for $APPENGINE_SA ($attempt/12)..."
            sleep 5
        done
        if sa_exists "$APPENGINE_SA"; then
            HAVE_APPENGINE_SA=true
            echo "  Created: $APPENGINE_SA"
        else
            echo "  WARNING: App Engine app created but the service account has not" >&2
            echo "  appeared yet. Re-run this script shortly to apply its grants." >&2
        fi
    fi
fi

grant_project_role() {
    # grant_project_role <SA_EMAIL> <ROLE>
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:$1" \
        --role="$2" \
        --condition=None \
        --quiet >/dev/null
}

section "Step 4: IAM for Build Identities"

echo "Compute SA (gen2 runtime + Cloud Build identity since mid-2024): $COMPUTE_SA"
COMPUTE_ROLES=(
    "roles/cloudbuild.builds.builder"
    "roles/artifactregistry.writer"
    "roles/logging.logWriter"
    "roles/storage.objectAdmin"
    "roles/datastore.user"
    "roles/cloudtasks.enqueuer"
    "roles/pubsub.publisher"
    "roles/run.invoker"
)
for role in "${COMPUTE_ROLES[@]}"; do
    echo "  $role"
    grant_project_role "$COMPUTE_SA" "$role"
done

if sa_exists "$CLOUD_BUILD_SA"; then
    echo "Legacy Cloud Build SA: $CLOUD_BUILD_SA"
    for role in "roles/artifactregistry.writer" "roles/storage.objectAdmin" "roles/logging.logWriter"; do
        echo "  $role"
        grant_project_role "$CLOUD_BUILD_SA" "$role" || true
    done
else
    echo "Legacy Cloud Build SA absent - skipping (expected on new projects)."
fi

section "Step 5: IAM for Service Agents"

for sa_role in "$GCF_SA:roles/artifactregistry.reader" \
               "$SERVERLESS_SA:roles/artifactregistry.reader" \
               "$SERVERLESS_SA:roles/run.invoker"; do
    sa="${sa_role%%:*}"; role="${sa_role#*:}"
    echo "  $sa -> $role"
    grant_project_role "$sa" "$role" 2>/dev/null \
        || echo "    (agent not created yet - re-run after first deploy)"
done

section "Step 6: Service Account Impersonation"

# Gen2 functions scheduling Cloud Tasks need actAs on their own runtime identity.
echo "Compute SA acting as itself..."
gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" \
    --member="serviceAccount:$COMPUTE_SA" \
    --role="roles/iam.serviceAccountUser" \
    --project="$PROJECT_ID" --quiet >/dev/null

# exchangeCentaurApiKey mints Firebase custom tokens via iam.serviceAccounts.signBlob.
echo "Compute SA token creator (for custom token minting)..."
gcloud iam service-accounts add-iam-policy-binding "$COMPUTE_SA" \
    --member="serviceAccount:$COMPUTE_SA" \
    --role="roles/iam.serviceAccountTokenCreator" \
    --project="$PROJECT_ID" --quiet >/dev/null

if [ "$HAVE_APPENGINE_SA" = true ]; then
    echo "App Engine SA present - applying gen1 runtime grants..."
    for role in "roles/datastore.user" "roles/cloudtasks.enqueuer" "roles/storage.objectAdmin"; do
        echo "  $role"
        grant_project_role "$APPENGINE_SA" "$role"
    done
    for binding in "$APPENGINE_SA:roles/iam.serviceAccountUser" \
                   "$APPENGINE_SA:roles/iam.serviceAccountTokenCreator" \
                   "$COMPUTE_SA:roles/iam.serviceAccountUser"; do
        member="${binding%%:*}"; role="${binding#*:}"
        gcloud iam service-accounts add-iam-policy-binding "$APPENGINE_SA" \
            --member="serviceAccount:$member" --role="$role" \
            --project="$PROJECT_ID" --quiet >/dev/null
    done
else
    echo "App Engine SA absent - skipping gen1 runtime grants."
fi

section "Step 7: Enable Anonymous Sign-In"

# The app calls signInAnonymously() on load, so this is not optional.
AUTH_CFG="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config" || true)"
if echo "$AUTH_CFG" | grep -q '"error"'; then
    echo "Auth not initialised yet; initialising..."
    api POST "https://identitytoolkit.googleapis.com/v2/projects/${PROJECT_ID}/identityPlatform:initializeAuth" '{}' >/dev/null || true
    sleep 5
fi

api PATCH \
  "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config?updateMask=signIn.anonymous.enabled" \
  '{"signIn":{"anonymous":{"enabled":true}}}' >/dev/null

ANON_STATE="$(api GET "https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT_ID}/config" | json_get signIn.anonymous.enabled)"
echo "Anonymous sign-in enabled: ${ANON_STATE:-unknown}"

echo ""
echo "NOTE: Google sign-in is NOT enabled by this script."
echo "It needs an OAuth 2.0 client ID and secret, and creating those (plus the"
echo "consent screen) has no supported gcloud command. Toggle it once in the"
echo "Firebase console -- Authentication -> Sign-in method -> Google -- which"
echo "auto-creates the OAuth client for you. Then add your Replit and custom"
echo "domains under Authentication -> Settings -> Authorized domains."

section "Step 8: Register Web App"

WEB_APPS="$(api GET "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps")"
APP_ID="$(echo "$WEB_APPS" | json_get apps.0.appId)"

if [ -z "$APP_ID" ]; then
    echo "Creating Web app..."
    api POST "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps" \
        '{"displayName":"TacticToes Web"}' >/dev/null
    for attempt in $(seq 1 12); do
        sleep 5
        APP_ID="$(api GET "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps" | json_get apps.0.appId)"
        [ -n "$APP_ID" ] && break
        echo "  Waiting for app registration ($attempt/12)..."
    done
else
    echo "Web app already registered."
fi

if [ -z "$APP_ID" ]; then
    echo "WARNING: Web app registration did not complete. Re-run this script, or" >&2
    echo "add a Web app manually under Project settings -> General -> Your apps." >&2
else
    CFG="$(api GET "https://firebase.googleapis.com/v1beta1/projects/${PROJECT_ID}/webApps/${APP_ID}/config")"
    echo ""
    echo "=========================================="
    echo "Replit Secrets - frontend"
    echo "=========================================="
    echo "VITE_FIREBASE_API_KEY=$(echo "$CFG" | json_get apiKey)"
    echo "VITE_FIREBASE_AUTH_DOMAIN=$(echo "$CFG" | json_get authDomain)"
    echo "VITE_FIREBASE_PROJECT_ID=$(echo "$CFG" | json_get projectId)"
    echo "VITE_FIREBASE_STORAGE_BUCKET=$(echo "$CFG" | json_get storageBucket)"
    echo "VITE_FIREBASE_MESSAGING_SENDER_ID=$(echo "$CFG" | json_get messagingSenderId)"
    echo "VITE_FIREBASE_APP_ID=$(echo "$CFG" | json_get appId)"
    echo "VITE_FIREBASE_MEASUREMENT_ID=$(echo "$CFG" | json_get measurementId)"
    echo "VITE_FIREBASE_FUNCTIONS_REGION=$REGION"
fi

section "Step 9: Post-Deploy IAM (functions must exist)"

# Callables are reachable only if allUsers holds the invoker role. GCP IAM and
# Firebase Auth are separate layers: this grants network reachability, and the
# function still validates the Firebase Auth token in code. Without it the
# browser gets a Google Frontend 403 that presents as a CORS error.
#
# If this fails with "User allUsers is not in permitted organization", your org
# enforces Domain Restricted Sharing:
#   gcloud org-policies delete iam.allowedPolicyMemberDomains --organization=ORG_ID
# Propagation can take 15 minutes.
#
# IMPORTANT: keep in sync with the onCall/onRequest exports in functions/src.
CALLABLE_FUNCTIONS=(
    "createCentaurApiKey"
    "exchangeCentaurApiKey"
    "getCentaurApiKeyStatus"
    "generatePreviewBoard"
)

DEPLOYED_ANY=false
for fn in "${CALLABLE_FUNCTIONS[@]}"; do
    if gcloud functions add-iam-policy-binding "$fn" \
        --region="$REGION" \
        --member=allUsers \
        --role=roles/cloudfunctions.invoker \
        --project="$PROJECT_ID" \
        --quiet >/dev/null 2>&1; then
        echo "  allUsers invoker -> $fn"
        DEPLOYED_ANY=true
    else
        echo "  skipped $fn (not deployed yet)"
    fi
done

# Gen2 functions run as Cloud Run services. Cloud Tasks must be able to invoke
# them, and under an Organization the project-level run.invoker grant is not
# always sufficient.
GEN2_SERVICES=("processturnexpirationtask" "processscheduledgamestart")
for service in "${GEN2_SERVICES[@]}"; do
    if gcloud run services add-iam-policy-binding "$service" \
        --region="$REGION" \
        --member="serviceAccount:$COMPUTE_SA" \
        --role="roles/run.invoker" \
        --project="$PROJECT_ID" \
        --quiet >/dev/null 2>&1; then
        echo "  compute run.invoker -> $service"
    else
        echo "  skipped $service (not deployed yet)"
    fi
done

# NOTE: Cloud Tasks queues are NOT pre-created here. Firebase creates a queue
# per task function on deploy, named after the exported function verbatim
# (processTurnExpirationTask, processScheduledGameStart) in the function's
# region, configured from the onTaskDispatched options in source. A manually
# created queue with a different name is simply unused; one with a MATCHING name
# is worse, because deploy overwrites its config and purges it if disabled.

section "Bootstrap Complete"

cat <<EOF

Provisioned:
  - APIs, Firestore ($REGION, Native mode), IAM, Anonymous sign-in, Web app

Gen1 runtime service account: $([ "$HAVE_APPENGINE_SA" = true ] && echo "present" || echo "ABSENT - see Step 3 note")

Still manual:
  1. Enable Google sign-in in the Firebase console (see Step 7 note).
  2. Add authorized domains for Replit and any custom domain.
  3. Copy the VITE_FIREBASE_* values above into Replit Secrets.

Next:
  4. Create the deploy service account:
       bash "$SCRIPT_DIR/create-deployer-sa.sh" $PROJECT_ID
  5. Deploy from Replit:
       npm run deploy
  6. Re-run THIS script to finish Step 9 -- the callable and Cloud Run IAM
     grants need the functions to exist first.

EOF
