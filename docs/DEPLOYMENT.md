# Deployment and release

The production release path deploys a tested image digest. It never builds local source during deployment. Cloud Run keeps scale-to-zero, a 120-second request timeout and a per-revision maximum of ten instances (concurrent revisions can exceed ten total during rollout). Resource creation and traffic changes remain explicit operator actions against a named project.

## One-time infrastructure setup

Select a dedicated Firebase project and billing account. Create the Native Firestore database in the intended region, enable Google sign-in, register Android package `com.bluegrain.smsrelay`, and register the signing fingerprints with Firebase/OAuth. Record app ID, API key, sender ID and the OAuth web client ID. These client configuration values are not service-account secrets.

Run `npm ci`, then set `PROJECT_ID`, `REGION` and `SERVICE_URL` explicitly and run `scripts/provision.sh`. It provisions API access, service identities, Artifact Registry, the delivery queue, Firestore rules/indexes and the authenticated minute-by-minute Scheduler. It does not deploy application traffic or create the Firestore database. Supply an existing canonical HTTPS service URL; do not use a candidate-tag hostname as the Scheduler audience.

The server identity receives Firestore, Firebase Auth administration, FCM and task-enqueue access and can act as the Scheduler identity for task OIDC. Firestore direct-client rules remain deny-all. Keep all emulator environment variables absent in cloud revisions.

Initial staging bootstrap is separate from production rollout: create a fully configured baseline service in a disposable project, with no production data or clients. Record its canonical URL, configure Scheduler and pair a dedicated smoke caller there. The guarded rollout deliberately refuses a service without an existing named 100% traffic allocation. Never use bootstrap commands to replace an existing production service.

## Protected GitHub release configuration

Create a GitHub environment named `production`, restrict deployments to protected `main`, and configure required human reviewers. GitHub environment protection is a repository setting, not something a workflow file can enforce by itself. Do not enable the release workflow for production until these controls are verified.

Configure Workload Identity Federation to accept only this repository's `production` environment subject. No downloaded service-account JSON keys are used. The release service account needs Artifact Registry write, Cloud Run deployment, act-as on the server identity, Firestore index/rules deployment, Firebase Android app config read access and Cloud Logging read access. Use repository-specific/project-scoped bindings; no project Owner role is needed. Provisioning IAM is a separate operator duty.

Environment variables:

- `GCP_PROJECT_ID`, `GCP_REGION` (default `us-central1`), `GCP_SERVICE` (default `sms-code-relay`).
- `GCP_WORKLOAD_IDENTITY_PROVIDER`, `GCP_RELEASE_SERVICE_ACCOUNT`.
- `ANDROID_SIGNING_SHA256S`: JSON array of public uppercase colon-separated app signing fingerprints, including pilot/Play identities currently supported.
- `ANDROID_UPLOAD_SHA256`: public upload-key fingerprint used to verify the CI-signed APK/AAB. It may differ from Play's installed-app signer.
- `RELAY_KEY_ALIAS`, `RELAY_URL`, `FIREBASE_APP_ID`, `FIREBASE_API_KEY`, `FIREBASE_SENDER_ID`, `GOOGLE_WEB_CLIENT_ID`.

Environment secrets: `RELAY_KEYSTORE_BASE64`, `RELAY_STORE_PASSWORD`, `RELAY_KEY_PASSWORD`, and `RELAY_SMOKE_TOKEN`. The smoke token belongs to a dedicated paired caller. Smoke only lists tools and checks an absent request; it never creates a request or triggers SMS. Signing material is written to a private temporary file and removed on success or failure.

## Release procedure

1. Wait for the `CI and delivery` push run on `main` to succeed. Its tested container archive includes a SHA-256 checksum and an OCI commit label.
2. Dispatch `Protected production release` from `main`, supplying that CI run ID. The workflow rejects incomplete, failed, non-main, fork or unrelated workflow runs.
3. The workflow verifies the archive/commit label, builds release lint/R8/APK/AAB with complete configuration, verifies the Android configuration against the registered Firebase app and canonical Cloud Run URL, then verifies both signatures against the upload certificate and copies the tested container into Artifact Registry.
4. Deployment consumes the Artifact Registry digest, deploys additive indexes and waits for READY. It creates one fully configured revision with zero traffic and tag `candidate`.
5. The tagged URL must pass health, unauthenticated rejection, App Links certificate matching, authenticated REST and MCP tool-list checks before receiving traffic.
6. Traffic progresses through 5%, 25%, then 100%, each with at least 60 seconds of observation, repeat smoke checks and a candidate HTTP 5xx log check. No traffic-stage advances after failed checks.
7. Retain `release-evidence`: exact commit/digest/revision, previous traffic allocation, signed artifacts, checksums and signature results. Staging/load/physical acceptance remains separate from these deployment smoke checks.

The release workflow serializes production deploys and does not cancel an in-progress deployment for a later one. Staging may use the same scripts with a separate explicit project and identities. For an operator-run deployment set `PROJECT_ID`, `IMAGE_URI` (`LOCATION-docker.pkg.dev/PROJECT/REPO/IMAGE@sha256:...`), full `COMMIT_SHA`, `RELAY_SMOKE_TOKEN`, and certificate configuration before invoking `scripts/deploy.sh`. The operator must first establish the same successful-CI provenance; the protected workflow automates that check.

`DEPLOYMENT_MANIFEST_PATH` defaults to `artifacts/deployment.json`. Its JSON fields include `projectId`, `region`, `service`, `serviceUrl`, `revision`, `image`, `commit`, `schedulerEmail`, `deliveryQueue`, `candidateUrl`, `previousTraffic`, `previousImages` and `status`. No token or signing secret is written. `PROMOTION_HOLD_SECONDS` may extend, but cannot shorten, the 60-second observation period.

## Failure and rollback

Before promotion, errors leave the named previous revisions serving traffic. After promotion begins, a failed smoke/log check or handled interruption restores the exact previous percentage split, never `LATEST`. The manifest reports `rolled-back` or `rollback-required`. SIGKILL, runner loss and failed rollback RPCs still require operator recovery; inspect actual Cloud Run traffic before retrying.

Use `previousTraffic` in the retained manifest to restore the recorded allocation with `gcloud run services update-traffic SERVICE --project PROJECT --region REGION --to-revisions REVISION=PERCENT,...`. Confirm service health, authenticated caller access, Scheduler and delivery after recovery. Do not rerun promotion until the failure is understood. A successful smoke check is not a completed live rollback drill; record that drill separately in staging.

Deploy indexes/additive backend changes before phones. Preserve existing request fields, caller credentials and signing identities. Do not deploy an older backend after introducing records it cannot safely interpret. Destructive schema changes require a separate reviewed migration and a compatible rollback target; container rollback cannot undo a schema migration.

## Android and privacy

Use JDK 17+ (JDK 21 in CI), SDK 36 and the pinned Gradle wrapper. `scripts/build-pilot.sh` validates the exact Gradle-property-preferred public settings, rejects known placeholders and checks Firebase project-number consistency and creates a private pilot signing key only when the chosen path does not already exist. Back up signing keys outside the repository. For Play builds, use a separate upload key and register the certificates of the APKs Play actually signs.

The backend accepts `ANDROID_SIGNING_SHA256S` as a JSON array and continues to accept legacy `ANDROID_SIGNING_SHA256`. Asset Links contains the deduplicated union; malformed fingerprints fail closed. Do not drop an active certificate until its installed clients have migrated.

Do not enable request/header/body capture. Use [production monitoring, alert provisioning and incident runbooks](OPERATIONS.md) for maintenance, delivery age, provider failures and overdue result deletion. API expiry is independent of asynchronous TTL cleanup. Signed release and cloud smoke evidence do not replace physical-phone consent, denial, lifecycle or multi-phone acceptance in [PILOT.md](PILOT.md).

## Rust migration candidates

`BACKEND=typescript` remains the deployment default. Supply an already tested Rust image digest through `IMAGE_URI` and set `BACKEND=rust`; the deployment defaults `TRAFFIC_MODE` to `stage`, leaving the verified tagged candidate at zero production traffic. The protected release workflow continues to publish the TypeScript image. `BACKEND` describes the supplied image; it does not build or select a different artifact.

Set `TRAFFIC_MODE=live` only after the isolated staging and production-candidate acceptance steps in [RUST_MIGRATION.md](RUST_MIGRATION.md). Live mode uses the same guarded 5%, 25%, 100% promotion and rollback as TypeScript. Keep the TypeScript source and prior Cloud Run revision for seven days of observation before making Rust the default.
