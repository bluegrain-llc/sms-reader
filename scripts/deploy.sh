#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?Set the explicitly chosen Firebase/Google Cloud project}"
: "${ANDROID_SIGNING_SHA256:?Set the public colon-separated SHA-256 APK signing certificate fingerprint}"
: "${REGION:=us-central1}"
: "${SERVICE:=sms-code-relay}"
: "${REPOSITORY:=sms-relay}"
: "${BACKEND:=typescript}"
case "$BACKEND" in
  typescript) dockerfile=server/Dockerfile; default_traffic=live ;;
  rust) dockerfile=server-rust/Dockerfile; default_traffic=stage ;;
  *) echo 'BACKEND must be typescript or rust' >&2; exit 1 ;;
esac
: "${TRAFFIC_MODE:=$default_traffic}"
revision_args=()
case "$TRAFFIC_MODE" in
  live) ;;
  stage) revision_args=(--no-traffic --tag "${BACKEND}-candidate") ;;
  *) echo 'TRAFFIC_MODE must be stage or live' >&2; exit 1 ;;
esac
export GOOGLE_CLOUD_QUOTA_PROJECT="${GOOGLE_CLOUD_QUOTA_PROJECT:-$PROJECT_ID}"
server_account="sms-relay-server@${PROJECT_ID}.iam.gserviceaccount.com"
scheduler_account="sms-relay-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
build_account="sms-relay-build@${PROJECT_ID}.iam.gserviceaccount.com"
gcloud services enable run.googleapis.com firestore.googleapis.com fcm.googleapis.com \
  identitytoolkit.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com cloudtasks.googleapis.com iam.googleapis.com iamcredentials.googleapis.com --project "$PROJECT_ID"
for name in sms-relay-server sms-relay-scheduler sms-relay-build; do
  if ! gcloud iam service-accounts describe "${name}@${PROJECT_ID}.iam.gserviceaccount.com" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$name" --project "$PROJECT_ID"
  fi
done
for role in roles/datastore.user roles/firebaseauth.admin roles/firebasecloudmessaging.admin roles/cloudtasks.enqueuer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$server_account" --role "$role" --condition=None --quiet >/dev/null
done
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member "serviceAccount:$build_account" --role roles/cloudbuild.builds.builder --condition=None --quiet >/dev/null
if ! gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create "$REPOSITORY" --repository-format docker --location "$REGION" --project "$PROJECT_ID"
fi
gcloud iam service-accounts add-iam-policy-binding "$scheduler_account" --project "$PROJECT_ID" \
  --member "serviceAccount:$server_account" --role roles/iam.serviceAccountUser --quiet >/dev/null
if ! gcloud tasks queues describe relay-delivery --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud tasks queues create relay-delivery --location "$REGION" --project "$PROJECT_ID" --max-concurrent-dispatches 5 --max-dispatches-per-second 5
fi
image="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:$(date -u +%Y%m%d%H%M%S)"
config_file="$(mktemp)"
trap 'rm -f "$config_file"' EXIT
cat > "$config_file" <<'YAML'
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', '${_DOCKERFILE}', '-t', '${_IMAGE}', '.']
images: ['${_IMAGE}']
options:
  logging: CLOUD_LOGGING_ONLY
YAML
gcloud builds submit . --config "$config_file" --substitutions "_IMAGE=$image,_DOCKERFILE=$dockerfile" --service-account "projects/$PROJECT_ID/serviceAccounts/$build_account" --project "$PROJECT_ID"
# Public ingress is required for device Firebase ID tokens and independent agent grants.
# Every application endpoint except healthz still authenticates requests itself.
# Build indexes before the new revision starts using the v2 queries.
npx firebase deploy --only firestore --project "$PROJECT_ID"
for attempt in {1..120}; do
  states="$(gcloud firestore indexes composite list --project "$PROJECT_ID" --format='value(state)')"
  if ! [[ "$states" =~ CREATING ]]; then break; fi
  if [ "$attempt" = 120 ]; then echo "Firestore indexes are still building; retry deployment later" >&2; exit 1; fi
  sleep 5
done
if [[ "$states" =~ NEEDS_REPAIR ]]; then echo "Firestore index needs repair" >&2; exit 1; fi
gcloud run deploy "$SERVICE" "${revision_args[@]}" --image "$image" --region "$REGION" --project "$PROJECT_ID" \
  --service-account "$server_account" --allow-unauthenticated --port 8080 --memory 512Mi \
  --timeout 120 --max-instances 10 --update-env-vars "GOOGLE_CLOUD_PROJECT=$PROJECT_ID,ANDROID_SIGNING_SHA256=$ANDROID_SIGNING_SHA256"
service_url="$(gcloud run services describe "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --format='value(status.url)')"
gcloud run services update "$SERVICE" "${revision_args[@]}" --region "$REGION" --project "$PROJECT_ID" \
  --update-env-vars "SERVICE_URL=$service_url,SCHEDULER_EMAIL=$scheduler_account,DELIVERY_QUEUE=projects/$PROJECT_ID/locations/$REGION/queues/relay-delivery"
job_args=(--location "$REGION" --project "$PROJECT_ID" --schedule '* * * * *' \
  --uri "$service_url/internal/maintenance" --http-method POST \
  --oidc-service-account-email "$scheduler_account" --oidc-token-audience "$service_url" --attempt-deadline 120s)
if gcloud scheduler jobs describe sms-relay-maintenance --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud scheduler jobs update http sms-relay-maintenance "${job_args[@]}"
else
  gcloud scheduler jobs create http sms-relay-maintenance "${job_args[@]}"
fi
if [ "$TRAFFIC_MODE" = live ]; then
  gcloud run services update-traffic "$SERVICE" --region "$REGION" --project "$PROJECT_ID" --to-latest --quiet
else
  echo 'Candidate staged with no traffic. Run staging acceptance before promoting its exact revision.'
fi
printf 'RELAY_URL=%s\n' "$service_url"
