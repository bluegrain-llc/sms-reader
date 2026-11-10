# Firebase and Cloud Run deployment

Use a dedicated Firebase/Google Cloud project with billing enabled. Deployment creates billable resources; the checked-in scripts do not run automatically. The machine's default gcloud project is never selected implicitly.

## Project prerequisites

1. Create/select a Firebase project and a Firestore **Native mode** default database. Choose its region deliberately; keep Cloud Run nearby.
2. Enable Firebase Authentication's **Google** provider. Configure its support email and OAuth consent branding/test users for the pilot.
3. Register Android package `com.bluegrain.smsrelay`. Record the Firebase app ID, API key, project ID, project number (FCM sender ID), and the OAuth **web application** client ID. These are configuration values; do not put service-account private keys in the APK.
4. Keep the FCM HTTP v1 API enabled. The server uses its Cloud Run service identity and Application Default Credentials, without a downloaded key.
5. The deploying identity needs permission to enable APIs, create service accounts and repositories, grant project roles, deploy Cloud Run, submit Cloud Build jobs, deploy Firestore rules/indexes/TTL policies, and create Scheduler jobs. Cloud Build must be able to push to the chosen Artifact Registry repository. Ensure the Cloud Scheduler service agent retains its standard service-agent role so it can mint OIDC tokens.

```sh
npm ci
export PROJECT_ID=your-explicit-project
export REGION=us-central1
./scripts/deploy.sh
```

The deployment script enables required APIs, creates dedicated server, build, and scheduler identities, builds the Docker image, deploys public HTTPS ingress with application authentication, configures the minute-by-minute maintenance job, and deploys Firestore rules and indexes. The server identity receives `roles/datastore.user`, `roles/firebaseauth.admin`, and `roles/firebasecloudmessaging.admin`. The separate build identity receives `roles/cloudbuild.builds.builder`, and Cloud Build writes to Cloud Logging. The scheduler identity is authorized by the application's verified OIDC email/audience, rather than application bearer tokens.

Firestore's direct client rules deny every read/write. Admin SDK access is controlled by IAM. The code/results/purpose/FCM-token fields are excluded from indexing where appropriate. Firestore indexes must finish building before relying on history or maintenance queries. Confirm TTL is enabled for `results.purgeAt`, `requests.purgeAt`, and `audit.purgeAt`; the field overrides are part of the checked-in index configuration.

The script is rerunnable and updates the existing service and Scheduler job. It uses immutable timestamp image tags. It never creates a Firestore database or changes authentication providers automatically; complete those console prerequisites first. Changing data location after creation requires migration.

## Cloud Run settings

- `GOOGLE_CLOUD_PROJECT`: selected Firebase project.
- `SERVICE_URL`: exact Cloud Run HTTPS URL and Scheduler OIDC audience, no trailing slash.
- `SCHEDULER_EMAIL`: dedicated scheduler service-account email.
- `ALLOWED_ORIGINS`: optional comma-separated exact browser origins; empty denies browser-origin requests. Native Android and ordinary MCP clients need no entry. A browser integration additionally needs its own deliberate CORS design; no permissive CORS middleware is supplied.
- `PORT`: injected by Cloud Run (8080 in local container).

Do not enable request-body/header dumps, HTTP interceptors, APM body capture, or query-string credentials. Cloud Run access logs contain route/status metadata; the service logs only static event names. Use status/error counts and Scheduler failures for monitoring. Alarm on maintenance failure, oldest pending delivery age, quota errors, and growth of expired result documents. Firestore TTL is asynchronous and is a backstop, not an API expiry check.

For local service development, run with Application Default Credentials for a dedicated development project or explicit emulator variables. Emulator authentication bypasses real JWT signing by Firebase design; never set `FIREBASE_AUTH_EMULATOR_HOST` or `FIRESTORE_EMULATOR_HOST` on the deployed service.

## Android signing and configuration

Use JDK 17+ (JDK 21 is verified), SDK 36, and the included Gradle 8.13 wrapper with distribution checksum. Keep pilot values in environment variables or `~/.gradle/gradle.properties`, using [the example](../android/pilot.properties.example). `RELAY_URL` must be HTTPS; cleartext traffic is disabled.

```sh
export RELAY_KEYSTORE=/private/path/sms-relay-pilot.jks
export RELAY_STORE_PASSWORD='set-privately'
export RELAY_KEY_PASSWORD='set-privately'
export RELAY_KEY_ALIAS=pilot
# Set the Firebase and URL variables shown in pilot.properties.example too.
./scripts/build-pilot.sh
```

The build script creates the key only when the target path does not exist, runs unit tests and release lint, then copies the signed APK/AAB and checksums into ignored `artifacts/`. It never overwrites an existing key. Back up the key privately: Android upgrades must use the same signing identity.

Before sign-in testing, register the certificate's SHA-1 and SHA-256 in the Firebase Android app settings. The Google OAuth Android client must match package name and signing certificate; `GOOGLE_WEB_CLIENT_ID` must be the web client in the same project. For Play App Signing, register the Play signing certificate as well. No `google-services.json` is needed: the app initializes Firebase explicitly from BuildConfig values.

## Deployed verification

Check `/health`, Scheduler's authenticated invocation, Firestore index readiness, expiry cleanup, FCM reception with the app stopped/backgrounded, and Google sign-in from the signed APK. Run:

```sh
RELAY_URL=https://SERVICE RELAY_TOKEN='provided-privately' node examples/mcp-smoke.mjs
```

This opens and cancels a real request and may send a generic phone notification if maintenance dispatches it before cancellation; it triggers no SMS. Then run the physical checklist in [PILOT.md](PILOT.md). Keep the rollout private until every required case is recorded. Review current Play target API, privacy, data safety, and account-deletion requirements before publication.


## v0.2 rollout and compatibility

Deploy the `ownerId + createdAt DESC` history index and wait for READY before sending phone traffic to v0.2. The per-phone state map is excluded from indexing. Check that no legacy request is active during the pilot upgrade; existing sign-in, registrations and caller credentials remain usable. Existing caller credentials now notify all the owner's available phones for new requests.

Stage the new Cloud Run image with no traffic, verify health and authenticated MCP version/tool listing, then explicitly move traffic to that verified revision. A service pinned to a revision needs an explicit traffic update during future deployments. New manager grants and multi-phone queued requests require v0.2-compatible server code; do not roll back to the v0.1 data model after creating them. Keep prior signing credentials for an Android in-place upgrade.


## Direct pairing (v0.3)

Before running the deployment script, export the public `ANDROID_SIGNING_SHA256` value (also propagated to the runtime) to the APK signing certificate's uppercase colon-separated SHA-256 fingerprint. The backend serves this public certificate in `/.well-known/assetlinks.json`. `SERVICE_URL` must be the canonical HTTPS service URL. The release manifest derives its verified App Link host from `RELAY_URL`; custom-scheme and manual-code fallbacks remain available.

Deploy Firestore retention/index overrides for `connections` (seven days), `connectionCodes` (ten-minute approval window), and `connectionRates` (ten-minute quota window). All use `purgeAt`, scheduled cleanup, and TTL backstops. No additional composite indexes are required beyond the five existing SMS indexes. Verify the public asset-links response against the APK signer before upgrading phones.

Manager creation/provisioning APIs are retired and their child credentials are rejected. Direct pairing creates owner-bound caller grants without a parent credential. Existing ordinary pilot grants remain compatible. Configure an ingress proxy hop only for a trusted proxy deployment; production Cloud Run uses one hop, while direct local servers use zero. Verify source/global creation quotas and owner decision quotas before exposing pairing outside the private pilot.

## Rust migration candidates

`BACKEND=typescript` remains the default. `BACKEND=rust` selects `server-rust/Dockerfile` and defaults `TRAFFIC_MODE` to `stage`: a tagged candidate revision receives no production traffic. Set `TRAFFIC_MODE=live` only after the isolated staging and production-candidate acceptance steps in [RUST_MIGRATION.md](RUST_MIGRATION.md). Promote a verified exact revision rather than an unverified latest revision. Keep the TypeScript source and prior Cloud Run revision for seven days of observation before making Rust the default.
