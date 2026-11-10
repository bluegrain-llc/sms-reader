#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PROJECT_ID:?Set the explicitly chosen Firebase/Google Cloud project}"
: "${REGION:=us-central1}"
: "${SERVICE:=sms-code-relay}"
: "${REPOSITORY:=sms-relay}"
export GOOGLE_CLOUD_QUOTA_PROJECT="${GOOGLE_CLOUD_QUOTA_PROJECT:-$PROJECT_ID}"
server_account="sms-relay-server@${PROJECT_ID}.iam.gserviceaccount.com"
scheduler_account="sms-relay-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"
build_account="sms-relay-build@${PROJECT_ID}.iam.gserviceaccount.com"
: "${SERVICE_URL:?Set the canonical HTTPS service URL}"
[[ "$SERVICE_URL" == https://* ]] || { echo "SERVICE_URL must be HTTPS" >&2; exit 1; }
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
npx firebase deploy --only firestore --project "$PROJECT_ID"
# Scheduler needs the canonical URL; do not guess a first-deployment hostname.
: "${SERVICE_URL:?Set the canonical HTTPS service URL}"
[[ "$SERVICE_URL" == https://* ]] || { echo "SERVICE_URL must be HTTPS" >&2; exit 1; }
job_args=(--location "$REGION" --project "$PROJECT_ID" --schedule '* * * * *' \
  --uri "$SERVICE_URL/internal/maintenance" --http-method POST \
  --oidc-service-account-email "$scheduler_account" --oidc-token-audience "$SERVICE_URL" --attempt-deadline 120s)
if gcloud scheduler jobs describe sms-relay-maintenance --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud scheduler jobs update http sms-relay-maintenance "${job_args[@]}"
else
  gcloud scheduler jobs create http sms-relay-maintenance "${job_args[@]}"
fi
printf 'Provisioned project %s in %s; no application traffic changed.\n' "$PROJECT_ID" "$REGION"
