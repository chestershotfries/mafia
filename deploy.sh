#!/usr/bin/env bash
# Deploy the ego-mafia Cloud Function backend.
#
# Provisions a GCS bucket (if missing), grants the existing service account
# storage.objectAdmin on it, seeds it from games_input.csv via
# ego_mafia/bootstrap_gcs.py, and deploys a gen2 HTTP Cloud Function from
# backend/ wired to the GCS JSON store.
#
# Usage:
#   ./deploy.sh PROJECT_ID BUCKET_NAME EGO_FN_NAME [options]
#
# Options:
#   --redeploy-main         Also redeploy the original (Sheets-backed)
#                           Cloud Function so the new getMatchHistory action
#                           goes live. Requires --main-fn-name.
#   --main-fn-name NAME     Name of the original Cloud Function
#                           (required with --redeploy-main).
#   --region REGION         Cloud Functions region (default: us-central1).
#   --runtime RUNTIME       Python runtime (default: python312).
#   --service-account-email EMAIL
#                           Service account email to grant bucket access to
#                           and run the function as.
#                           Default: extracted from backend/service-account.json.
#   --service-account-key-file PATH
#                           Path to the SA key file for local bootstrap
#                           AND for passing to the function as
#                           SERVICE_ACCOUNT_KEY (default: backend/service-account.json).
#   --bucket-location LOC   Region for the bucket (default: US).
#   --json-object NAME      GCS object name for the ego-mafia data
#                           (default: ego-mafia.json).
#   --game-password PWD     GAME_PASSWORD env var for the new function.
#                           If unset, falls back to $GAME_PASSWORD or the
#                           main.py default.
#   --skip-bootstrap        Skip seeding the bucket from games_input.csv.
#   -h, --help              Show this help and exit.

set -euo pipefail

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
}

# --- Parse args ---

if [[ $# -lt 3 ]]; then
  usage
  exit 1
fi

PROJECT_ID="$1"; shift
BUCKET_NAME="$1"; shift
EGO_FN_NAME="$1"; shift

REDEPLOY_MAIN=0
MAIN_FN_NAME=""
REGION="us-central1"
RUNTIME="python312"
SERVICE_ACCOUNT_EMAIL=""
SERVICE_ACCOUNT_KEY_FILE="backend/service-account.json"
BUCKET_LOCATION="US"
JSON_OBJECT="ego-mafia.json"
GAME_PASSWORD_ARG="${GAME_PASSWORD:-}"
SKIP_BOOTSTRAP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --redeploy-main)
      REDEPLOY_MAIN=1; shift ;;
    --main-fn-name)
      MAIN_FN_NAME="$2"; shift 2 ;;
    --region)
      REGION="$2"; shift 2 ;;
    --runtime)
      RUNTIME="$2"; shift 2 ;;
    --service-account-email)
      SERVICE_ACCOUNT_EMAIL="$2"; shift 2 ;;
    --service-account-key-file)
      SERVICE_ACCOUNT_KEY_FILE="$2"; shift 2 ;;
    --bucket-location)
      BUCKET_LOCATION="$2"; shift 2 ;;
    --json-object)
      JSON_OBJECT="$2"; shift 2 ;;
    --game-password)
      GAME_PASSWORD_ARG="$2"; shift 2 ;;
    --skip-bootstrap)
      SKIP_BOOTSTRAP=1; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown option: $1" >&2
      usage; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$REPO_ROOT"

if [[ ! -f "$SERVICE_ACCOUNT_KEY_FILE" ]]; then
  echo "Service-account key file not found: $SERVICE_ACCOUNT_KEY_FILE" >&2
  exit 1
fi

if [[ -z "$SERVICE_ACCOUNT_EMAIL" ]]; then
  SERVICE_ACCOUNT_EMAIL="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1]))['client_email'])" "$SERVICE_ACCOUNT_KEY_FILE")"
fi

if [[ $REDEPLOY_MAIN -eq 1 && -z "$MAIN_FN_NAME" ]]; then
  echo "--redeploy-main requires --main-fn-name NAME" >&2
  exit 1
fi

echo "==> Project:        $PROJECT_ID"
echo "==> Bucket:         gs://$BUCKET_NAME (location: $BUCKET_LOCATION)"
echo "==> Function:       $EGO_FN_NAME (region: $REGION, runtime: $RUNTIME)"
echo "==> Service acct:   $SERVICE_ACCOUNT_EMAIL"
echo "==> JSON object:    $JSON_OBJECT"

# --- 1. Create bucket if missing ---

if gcloud storage buckets describe "gs://$BUCKET_NAME" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> Bucket gs://$BUCKET_NAME already exists, skipping create."
else
  echo "==> Creating bucket gs://$BUCKET_NAME ..."
  gcloud storage buckets create "gs://$BUCKET_NAME" \
    --project="$PROJECT_ID" \
    --location="$BUCKET_LOCATION" \
    --uniform-bucket-level-access
fi

# --- 2. Grant service account roles/storage.objectAdmin on the bucket ---

echo "==> Granting roles/storage.objectAdmin to $SERVICE_ACCOUNT_EMAIL on gs://$BUCKET_NAME ..."
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" \
  --project="$PROJECT_ID" \
  --member="serviceAccount:$SERVICE_ACCOUNT_EMAIL" \
  --role="roles/storage.objectAdmin" >/dev/null

# --- 3. Seed bucket from games_input.csv ---

if [[ $SKIP_BOOTSTRAP -eq 1 ]]; then
  echo "==> Skipping bootstrap (--skip-bootstrap)."
else
  echo "==> Seeding gs://$BUCKET_NAME/$JSON_OBJECT from ego_mafia/games_input.csv ..."
  (
    cd ego_mafia
    JSON_BUCKET="$BUCKET_NAME" \
    JSON_OBJECT="$JSON_OBJECT" \
    SERVICE_ACCOUNT_KEY_FILE="$REPO_ROOT/$SERVICE_ACCOUNT_KEY_FILE" \
      python3 bootstrap_gcs.py
  )
fi

# --- 4. Deploy ego-mafia gen2 Cloud Function ---

ENV_FILE="$(mktemp -t ego-mafia-env-XXXXXX.yaml)"
trap 'rm -f "$ENV_FILE"' EXIT

# Build env-vars yaml. SERVICE_ACCOUNT_KEY holds the SA key file's contents as
# a single-line JSON string env var; main.py runs json.loads on it. We first
# compact the JSON (no real newlines in the value), then JSON-escape that
# compact string to form a YAML 1.2 double-quoted scalar — yaml parses it back
# to the compact JSON, and main.py parses that.
SAK_JSON_STRING="$(python3 -c "import json,sys; print(json.dumps(json.dumps(json.load(open(sys.argv[1])), separators=(',',':'))))" "$SERVICE_ACCOUNT_KEY_FILE")"
{
  echo "STORAGE: gcs_json"
  printf 'JSON_BUCKET: %s\n' "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$BUCKET_NAME")"
  printf 'JSON_OBJECT: %s\n' "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$JSON_OBJECT")"
  if [[ -n "$GAME_PASSWORD_ARG" ]]; then
    printf 'GAME_PASSWORD: %s\n' "$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$GAME_PASSWORD_ARG")"
  fi
  printf 'SERVICE_ACCOUNT_KEY: %s\n' "$SAK_JSON_STRING"
} > "$ENV_FILE"

echo "==> Deploying Cloud Function $EGO_FN_NAME from backend/ ..."
gcloud functions deploy "$EGO_FN_NAME" \
  --project="$PROJECT_ID" \
  --region="$REGION" \
  --gen2 \
  --runtime="$RUNTIME" \
  --source=./backend \
  --entry-point=main \
  --trigger-http \
  --allow-unauthenticated \
  --service-account="$SERVICE_ACCOUNT_EMAIL" \
  --env-vars-file="$ENV_FILE"

EGO_URL="$(gcloud functions describe "$EGO_FN_NAME" \
  --project="$PROJECT_ID" --region="$REGION" --gen2 \
  --format='value(serviceConfig.uri)')"
echo "==> Ego-mafia function deployed: $EGO_URL"
echo "    Set window.SCRIPT_URL in ego-mafia/*.html to this URL."

# --- 5. Optionally redeploy main function ---

if [[ $REDEPLOY_MAIN -eq 1 ]]; then
  echo "==> Redeploying main Cloud Function $MAIN_FN_NAME from backend/ ..."
  gcloud functions deploy "$MAIN_FN_NAME" \
    --project="$PROJECT_ID" \
    --region="$REGION" \
    --gen2 \
    --runtime="$RUNTIME" \
    --source=./backend \
    --entry-point=main \
    --trigger-http \
    --allow-unauthenticated
  MAIN_URL="$(gcloud functions describe "$MAIN_FN_NAME" \
    --project="$PROJECT_ID" --region="$REGION" --gen2 \
    --format='value(serviceConfig.uri)')"
  echo "==> Main function redeployed: $MAIN_URL"
fi

echo "==> Done."
