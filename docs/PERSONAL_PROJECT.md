# Bluegrain Firebase pilot project

Infrastructure deployment and transfer to `bluegrain.llc@gmail.com` completed and verified on 2026-11-08. The user enabled Google sign-in and resumed pilot work. **The configured signed pilot APK and AAB are now built and verified. Physical-phone acceptance is the remaining pilot gate.**

Bluegrain is the project's only human Owner (`roles/owner`). The previous personal account's project Owner binding and Bluegrain's redundant Admin binding have been removed. Bluegrain accepted the Console Owner invitation; this satisfied Google's requirement for a ToS-accepting Owner on a standalone project. All service-account bindings are unchanged.

Billing is enabled and linked to Bluegrain's active account `0114A7-7187E7-B592F3`, replacing `019DEC-3BEFFB-3E3D45`. The old billing account remains open; historical charges remain with it. No resources were redeployed or migrated: the project ID, Firebase app registration, data, and service URL are preserved.

Verified after transfer using Bluegrain's credentials: project IAM, Firebase project access, billing linkage, Cloud Run readiness, HTTP health and authentication boundaries, and enabled Scheduler with a successful latest attempt. Infrastructure transfer verification completed at `2026-11-08T18:19:50Z`. Subsequent physical-phone checks verified Google-authenticated registration, an actual FCM request notification on the phone, and listener readiness. A real Bizee SMS was received on 2026-11-09 UTC, approved by the owner and retrieved through MCP and REST; result expiry was verified. Denial, lifecycle and two-phone acceptance remain pending.

The `bluegrain` named CLI configuration and scoped pilot environment select Bluegrain and this project. The active global `default` configuration still selects the work account and its original project. No passwords or access/ID tokens were written to the handoff files.

## Current deployment

| Setting | Current state |
| --- | --- |
| Project | `dk-sms-relay-20261108` — SMS Code Relay |
| Project number | `950978561139` |
| Owner | `bluegrain.llc@gmail.com` — Owner (`roles/owner`), accepted and verified |
| Billing | Bluegrain `0114A7-7187E7-B592F3` linked; billing enabled |
| Cloud Run | Ready in `us-central1`; revision `sms-code-relay-00007-ced` |
| Backend | `https://sms-code-relay-yettlpkbya-uc.a.run.app` |
| MCP endpoint | `https://sms-code-relay-yettlpkbya-uc.a.run.app/mcp` |
| Firestore | Native default database in `us-central1`; deny-all client rules published |
| Indexes | Five composite indexes READY |
| Retention | Six TTL policies ACTIVE: SMS data plus connections, codes and quota counters |
| Scheduler | `sms-relay-maintenance`, enabled every minute with Google OIDC authentication; successful HTTP 200 run verified |
| Google sign-in | Provider and OAuth configuration verified; physical-phone Google-authenticated registration passed |
| Android OAuth | Matching Android client and web client verified; release SHA-1/SHA-256 registered |
| Signed pilot APK/AAB | Version 0.3.0 (3), built with live project settings; signatures verified |
| Release checks | 21 backend tests, 7 unit tests and 7 UI tests passed; release lint: zero errors, 15 warnings; signed release installs/launches on isolated API 36 emulator |
| Physical phone | Samsung SM-G996B, Android 15/API 35; v0.4.2 installed with sign-in/registration retained. Focused SMS UI and Markdown header/message verified. Real SMS approval, MCP/REST retrieval and expiry passed on v0.3; v0.4.2 real-SMS automatic upload and automatic task closure passed after Android consent. Denial, lifecycle and two-phone acceptance remain pending |

[Live health check](https://sms-code-relay-yettlpkbya-uc.a.run.app/health) · [Firebase console](https://console.firebase.google.com/project/dk-sms-relay-20261108/overview) · [Cloud Run console](https://console.cloud.google.com/run/detail/us-central1/sms-code-relay/metrics?project=dk-sms-relay-20261108).

The deployment uses separate `sms-relay-server`, `sms-relay-build`, and `sms-relay-scheduler` service accounts. The server has Firestore, Firebase Auth administration, and FCM permissions; the build identity uses the Cloud Build builder role. No service-account private keys were downloaded. Temporary personal-user token-creation permission used to verify the scheduler identity was removed after testing.

Verified live: `/health` returns 200; management, MCP, and maintenance endpoints reject unauthenticated requests with 401; maintenance with the scheduler identity returns 200; Cloud Scheduler also recorded successful delivery. The first maintenance attempts occurred while indexes were building and failed; subsequent attempts succeeded once all indexes were READY. A later phone test passed actual Google-authenticated registration, FCM notification delivery, and SMS listener startup. MCP bearer authentication, tool listing, and request creation/status retrieval passed against the deployed service. Both MCP and REST returned no code at `ready`, before any consent.

The public health route is `/health`. `/healthz` collided with Google Frontend's reserved routing during deployment; the compatibility alias remains for local callers. See the [Google issue report](https://issuetracker.google.com/issues/554732235).

The repository's `.firebaserc` selects this project. Ignored `artifacts/pilot-setup/infrastructure.json` contains the deployment verification snapshot. Scoped account/project settings and SDK configuration are in the same ignored directory; access/ID tokens were held only in process memory, and SDK configuration was not committed.

```sh
source artifacts/pilot-setup/account.env
```

For future redeployment, use authenticated Bluegrain-account Firebase CLI credentials and the scoped account/project environment. Firebase CLI login is separate from gcloud login; sign into it as Bluegrain when needed. The deployment script sets `GOOGLE_CLOUD_QUOTA_PROJECT`, provisions the build identity, and preserves existing runtime environment settings. Cloud Billing API is enabled on this project so billing commands can explicitly use `--billing-project=dk-sms-relay-20261108` rather than the shared CLI quota project.

## Pilot artifacts and signing

Install [the signed pilot APK](../artifacts/sms-code-relay-pilot.apk). The [signed release AAB](../artifacts/sms-code-relay-release.aab) is prepared for a later Play workflow; it is not the directly installable file. Both artifacts are listed in [SHA256SUMS](../artifacts/SHA256SUMS). The earlier debug APK remains unconfigured.

The RSA 3072-bit pilot signing key is outside the repository at `/home/dmitry.kropachev/.local/share/sms-code-relay/pilot-release/sms-relay-pilot.jks`. The same directory contains `signing.json`, which holds the alias and randomly generated passwords. The directory is mode 0700 and both files are mode 0600. Back up both privately; updates to this APK must use the same key. The public certificate is available as `artifacts/pilot-signing-certificate.pem`.

- Certificate SHA-1: `BBD96DCF31D97F66215887DD6CB1AA17C8881041`
- Certificate SHA-256: `AC32575608BDCCF302625CB45B842BD46497ADBA9BF36E486141076ABEE8F0E2`

Firebase's Android app has both fingerprints, and its refreshed SDK configuration includes the matching Android OAuth client. Build settings are in ignored `artifacts/pilot-setup/android.properties`; the local `build-pilot.py` helper reads these and the external signing record, then invokes `scripts/build-pilot.sh` without putting passwords in command arguments. The helper currently uses this machine's JDK/SDK paths. Rebuild with:

```sh
python3 artifacts/pilot-setup/build-pilot.py
```

The local build/signature/manifest/runtime verification record is `artifacts/pilot-setup/release-verification.json`. The release is not debuggable, allows no cleartext HTTP or backups, and requests no broad SMS/Contacts permissions. Its Firebase and relay configuration was checked in the generated APK. No service-account private key is included.

## Next: physical SMS and two-phone acceptance

1. Transfer the pilot APK to an Android 8+ phone with Google Play services and install it. Open **SMS Code Relay**, press **Continue with Google**, allow notifications; registration is automatic.
2. Have the app or bot request a connection, open its link on the phone, and approve in **Admin → Access**. Its own credential becomes usable automatically. Sign in with the same Google account on additional phones to receive request notifications there too. Start a request, tap its notification, and wait until the caller sees `ready` before a separate workflow sends an eligible SMS.
3. Complete the [physical-phone feasibility and acceptance checks](PILOT.md), including consent denial and approval, expiry, and lifecycle cases. Google-authenticated registration, FCM notification delivery, and listener startup passed on the physical phone. Real SMS approval/retrieval and result expiry passed on v0.3. The v0.4 focused screen adds manual entry, Markdown explanations and explicit Send; denial/lifecycle/two-phone outcomes still need acceptance.

The pilot caller token is stored only in ignored `artifacts/pilot-setup/agent-token.txt` with mode 0600. It was created through the phone UI using ADB and was never printed. The local `phone-test.mjs` driver uses the official MCP client and REST for metadata-only checks; it never logs SMS codes. Physical test records are in `physical-phone-verification.json` and `phone-test-denial.json` under the same ignored setup directory. ADB's native backend intermittently lost the connected phone; restarting the local server with `ADB_LIBUSB=1` restored access for UI automation. The request notification was opened by ADB automation; Android's SMS consent decision is left to the owner.

The current service was checked on a staged revision before moving traffic. All five indexes are READY. Real Scheduler calls returned HTTP 200 on the new revision. See the latest section of [verification](VERIFICATION.md) for the executed v0.3 checks and remaining physical acceptance.

The v0.3 update replaces external manager credentials with direct owner-approved pairing. The bot keeps its own private credential, opens a comparison-code link on the phone, and polls until the owner approves. Legacy manager APIs are removed; existing ordinary pilot caller credentials and phone registrations remain compatible.

The v0.4 backend is `sms-code-relay-00010-vof`. Requests accept a short `title` and Markdown `purpose` body; the phone opens a separate SMS request screen with the server-bound bot name, title, parsed message, code input, Send and Cancel. Android approval only fills the field. Manual Send is an owner-only phone operation, and caller credentials cannot submit results.

The current Android v0.4.2 update automatically submits a single code after Android approval and closes on server confirmation. This was verified on the Samsung with real Bizee SMS, matching MCP/REST retrieval and absence of an app task/activity afterward. Multiple candidates require one selection; manual typing retains Send.
