#!/usr/bin/env bash
set -euo pipefail

# Firebase callable endpoints need to be reachable by Google's frontend before
# Firebase Auth can authorize the request inside the function. This grants
# network-level reachability; the functions still enforce owner/auth checks.
PROJECT_ID="${1:-tactic-toes-cyphid-dev}"
REGION="${2:-us-central1}"

CALLABLE_FUNCTIONS=(
  "wakeBot"
  "createBotApiKey"
  "exchangeBotApiKey"
  "getBotApiKeyStatus"
)

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud CLI is required. Install it, then run: gcloud auth login" >&2
  exit 1
fi

gcloud config set project "$PROJECT_ID" --quiet

for function_name in "${CALLABLE_FUNCTIONS[@]}"; do
  echo "Granting allUsers invoker access to ${function_name}..."
  gcloud functions add-iam-policy-binding "$function_name" \
    --region="$REGION" \
    --member="allUsers" \
    --role="roles/cloudfunctions.invoker" \
    --project="$PROJECT_ID" \
    --quiet
done

echo "Callable invoker grants applied to ${PROJECT_ID}."