# Verification record

## Repeatable cloud acceptance tooling

The [staging acceptance runner and fault-drill procedure](CLOUD_ACCEPTANCE.md)
separate real-service checks from emulator and physical-phone evidence. Runner
guard/signature/evidence tests execute without cloud credentials; unperformed
cloud scenarios remain pending. This tooling does not establish a live staging
pass or close the physical acceptance gate.

## Interactive request inbox (2026-11-09)

Executed locally: server type checking; 11 server unit tests; 36 Firestore/Auth/REST/MCP integration tests; 13 Android unit tests, debug lint, APK and instrumentation builds; 18 UI tests on the Android 36 emulator at both 1080×2400 and CI’s 320×640 viewport; production-dependency audit with zero vulnerabilities; Docker build and HTTP startup/authentication smoke; deployment script syntax check.

Wizard coverage includes conditional-path validation, immutable grouping, capability negotiation and old-client isolation, Next/Previous and final review, draft isolation/resume, branch-answer removal, REST/MCP round trips, concurrent final submissions, cancellation and expiry.

The new coverage includes form validation and immutable definitions, separate permission approval, concurrent forms and SMS, caller isolation, competing phone submissions and upload deduplication, manual SMS-helper entry and independent timeouts, cancellation/expiry, per-device tap/open deduplication including delayed reports, durable event replay across two server instances, callback failures/duplicates, expired event filtering, dead-worker lease recovery, cancellation recovery and account deletion. Existing SMS integration and UI checks remain included.

Not established by these local checks: live Cloud Tasks/OIDC/IAM delivery, public TLS callback delivery, production Firestore index readiness, or physical-phone notification/SMS acceptance. The deployment script provisions the queue and waits for indexes; the [v2 rollout and phone checklist](REQUEST_INBOX.md) remains the cloud/physical acceptance gate.

Executed on 2026-11-07 America/Santo_Domingo (2026-11-08 UTC) in the initially empty workspace. No production Firebase project or signing configuration was supplied. No physical phone was attached.

| Check | Result |
| --- | --- |
| `npm run build` | Passed, strict TypeScript compilation |
| `npm run test:emulator` | 11 passed, none skipped: 3 pure tests and 8 Firestore/Auth Emulator integration tests |
| MCP SDK client with bearer authentication | Passed initialization, tool listing, create/get/cancel, readiness, and approved-code retrieval through HTTP |
| Request security and lifecycle | Passed exclusivity/concurrency, idempotency/conflicts, owner/device/token isolation, pre-consent upload rejection, duplicate uploads, cancellation/upload races, token revocation/expiry, token/device quotas, timeout/expiry, outbox retry, cleanup, and deletion |
| `npm audit --omit=dev` | 0 production vulnerabilities; the Firebase CLI development dependency tree still reports moderate advisories in a full tooling audit |
| Docker build and `scripts/container-smoke.sh` | Passed container startup, HTTP health and missing-auth rejection; image runs as nonroot |
| `testDebugUnitTest` | 4 passed: numeric/alphanumeric extraction, multiple candidates, unsupported formats, request-bound consent gate |
| `lintDebug` | Passed: 0 errors, 15 dependency-version advisory warnings |
| `assembleDebug assembleDebugAndroidTest` | Passed; debug APK signature verified with apksigner |
| `connectedDebugAndroidTest` | 2 passed on an isolated Android 16/API 36 x86_64 Google APIs emulator: identity/purpose/candidate selection, and Cancel available while upload controls are busy |
| Release R8 compilation | Passed with synthetic configuration and `preReleaseBuild` deliberately excluded; this is a compiler/shrinker check, not a signed release or deployment |
| ShellCheck and example JavaScript syntax | Passed |
| Production logging paths and merged manifest inspection | Static event labels only; no payload logging or broad SMS/Contacts/accessibility permissions |

The backend integration tests use real Firestore transactions against the emulator, synthetic times and codes, and a fake FCM sender. Authentication tests exchange an emulator custom token for a Firebase ID token; production specifically requires Google sign-in. These tests do not prove Google OAuth certificate configuration, real FCM delivery, Cloud IAM, Firestore index deployment, or carrier SMS/Play-services consent behavior.

Local artifacts are ignored by Git:

- [Unconfigured debug APK](../artifacts/sms-code-relay-debug-unconfigured.apk), signed with the local Android debug certificate. It opens a setup screen and cannot register a phone until rebuilt with Firebase settings. It is not the signed pilot release.
- [Approval screen preview](../artifacts/approval-preview.png), rendered by instrumentation with synthetic fixture data.
- [Artifact checksums](../artifacts/SHA256SUMS).

Build reports remain under `android/app/build/reports/`; instrumentation results under `android/app/build/outputs/androidTest-results/`. The isolated SDK and test AVD were installed outside the repository under `/tmp`; local SDK configuration is ignored. The test emulator is shut down after verification.

## Remaining acceptance work

1. Run the [physical phone feasibility gate and acceptance matrix](PILOT.md), including real Google sign-in, FCM, SMS, consent denial/approval, Contacts exclusion, sender filter, pre-readiness SMS, lock/background/rotation/process death, offline delivery and upload, and disabled notifications. These cases are specified but are not reported as passed.
2. Finalize the operator identity, contact and public privacy/deletion URLs before broader distribution or Play submission.

The app deliberately prevents a new listener during the previous five-minute listening window after cancellation, failure or completion, because the public API has no cancellation method. This conservative pilot limitation is documented and visible when a new request is opened too early. FCM dispatch normally starts at the next minute-by-minute maintenance run so agent request creation never waits for provider retries. Both behaviors should be included in the physical pilot review.

## Provisioning update — 2026-11-08

A dedicated Firebase project was subsequently created under the owner's personal Google account, and the Android app was registered. See [personal project setup](PERSONAL_PROJECT.md). No billing account is linked; the only visible personal billing account is closed. Cloud Run, Firestore database, Google sign-in configuration, and a usable signed pilot remain outstanding. The local test results above still describe the implementation verification; no cloud deployment or physical SMS success is claimed.

## Infrastructure deployment verification — 2026-11-08

Personal billing was activated and linked with the user's authorization. Cloud Run is deployed at `https://sms-code-relay-yettlpkbya-uc.a.run.app` in `us-central1`, revision `sms-code-relay-00004-ctc`. The Firestore Native database, deny-all direct-client rules, four READY composite indexes, three ACTIVE TTL policies, dedicated server/build/scheduler identities, Artifact Registry and Cloud Build, and the enabled minute-by-minute OIDC Scheduler job are provisioned.

Live checks: `/health` HTTP 200; unauthenticated owner/MCP/maintenance calls HTTP 401; scheduler-identity maintenance HTTP 200; real Scheduler delivery HTTP 200. The public health path was corrected after Google Frontend intercepted `/healthz`. The corrected implementation passed strict compilation and all 11 backend emulator tests again; ShellCheck and the complete deployment script passed. Temporary user impersonation permission was removed after verification.

Per the user's explicit request, further work is paused after infrastructure. Google sign-in console activation, release signing/configured APK/AAB, and physical-phone SMS acceptance remain pending. No Android/APK work was performed in this deployment phase. See [current project state](PERSONAL_PROJECT.md) and ignored `artifacts/pilot-setup/infrastructure.json`.

## Configured signed pilot verification — 2026-11-08

The user subsequently transferred ownership and billing to Bluegrain, enabled Google sign-in, and resumed APK work. A private RSA 3072-bit pilot key was generated outside the repository. Both certificate fingerprints were registered in Firebase; refreshed SDK configuration includes the matching Android OAuth client and the project's web OAuth client.

`scripts/build-pilot.sh` completed `testDebugUnitTest lintRelease assembleRelease bundleRelease` with live configuration and normal release validation enabled. Four unit tests passed. Release lint reported zero errors and 15 dependency-version advisory warnings. The minified/shrunk release APK and signed AAB are version 0.1.0 (1), package `com.bluegrain.smsrelay`, minimum API 26, target API 36.

APK signatures were verified with `apksigner`; AAB integrity was verified with `jarsigner`. Both artifacts' signer certificates match the registered release certificate. Manifest checks confirmed no debuggable flag, cleartext HTTP, backups, or broad SMS/Contacts permissions. Required Firebase, OAuth, and relay settings were verified in the generated APK without logging their values. Artifact checksums passed.

The actual signed release APK installed and launched on the isolated Android 16/API 36 Google APIs emulator, displayed **Continue with Google**, and remained running with no app crash recorded. This was a startup smoke check; no Google account was signed in and no SMS consent or real FCM delivery was tested. The read-only emulator was shut down afterward. The earlier instrumentation results above remain historical; they were not rerun as release instrumentation.

- [Signed configured pilot APK](../artifacts/sms-code-relay-pilot.apk), SHA-256 `aa56d7ea179583dcc1906b9bec5ae7f1239f2861e812711dca36eaa98e9bb544`.
- [Signed release AAB](../artifacts/sms-code-relay-release.aab), SHA-256 `1b89163d789d83c9012b9fe1203ed6327cfbdf2c2adbb0b5c3bccf1ff98c801f`.

Private local records are in `artifacts/pilot-setup/release-verification.json` and `signing-metadata.json`; build and signature reports are in that directory too. See [signing backup and installation](PERSONAL_PROJECT.md). Physical-phone acceptance remains open.

The signed APK was subsequently installed successfully over USB on the owner's Samsung SM-G996B running Android 15/API 35. USB disconnected before the app could be opened through ADB; the owner was asked to open it, sign in, grant notifications, and register. Google sign-in, FCM, and SMS consent are not yet verified. Physical installation metadata is in `artifacts/pilot-setup/physical-phone-verification.json`.

## Physical pilot progress — 2026-11-08

The owner completed Google sign-in and notification-enabled registration on the Samsung phone; the deployed backend verified its Google-authenticated registration. Switching the local ADB server to the LIBUSB backend restored UI automation. A caller token named **Pilot verification** was created through the app and saved directly to a mode-0600 local file without being printed.

Using that token, the official MCP SDK client authenticated to the deployed `/mcp` endpoint, listed exactly the three public tools, created a real request, and polled its status. The corresponding generic request notification was observed on the phone via notification-key metadata and opened through ADB automation. The request reached `ready`, establishing SMS User Consent listener startup on the physical phone. Both MCP and REST returned no code before consent.

The first five-minute listening window expired without a consent event (`expired`, reason `request_timeout`). MCP and REST returned no code, and no result document was stored. Whether an eligible SMS actually arrived during the window is awaiting the owner's report; this timeout does not establish a consent denial. Denial, approval, actual code retrieval, and result-expiry checks are not yet passed. A fresh request must precede the next externally triggered SMS. The public app requests no broad SMS/Contacts permission; ADB is used only as an external pilot test tool. No SMS body or code is included in these records.

## Relay/Admin and multiple-device update — 2026-11-08

Version **0.2.0 (2)** is built, signed, deployed, and installed as an upgrade on the Samsung phone. One app now has Relay and Admin areas. Google sign-in plus notification permission automatically registers a new phone. Admin manages one-time manager connections, their distinct caller credentials, all registered phones, and account-wide history. The backend broadcasts each active request to all available registered phones, tracks each phone's listener and consent independently, and stores only the first approved upload. Other phones see a handled outcome without the code. Further callers queue; activation waits if all phones are in earlier Android listening windows.

Current checks:

| Check | Result |
| --- | --- |
| Strict TypeScript compilation | Passed |
| Firestore/Auth Emulator suite | **19 passed**, zero skipped; concurrency, all-phone delivery/retry, individual consent gating, racing approvals, queue promotion/current phone snapshots, manager/child separation and revocation, expiry, quotas, metadata privacy and deletion |
| Android unit tests | **4 passed** |
| Compose instrumentation | **4 passed** on API 36, at normal screen size and 360×640dp with 1.3 font scale; Relay/Admin navigation, two-phone administration fixture, candidate selection, local Stop during upload, handled-on-another-phone outcome |
| Release build and lint | APK/AAB passed normal configured release validation and R8; zero lint errors, 15 dependency advisory warnings |
| Signatures and manifest | APK/AAB signatures verified, same registered pilot certificate; version 0.2.0 (2), no debug/backup/cleartext/broad SMS/Contacts permissions |
| Signed release startup | Installed/launched on API 36 emulator; Continue with Google visible |
| Cloud deployment | Build `2a68f7a0-7ac9-4971-a315-c3b598b95eee` succeeded; all five indexes READY; staged health/authenticated MCP checks passed before 100% traffic moved to `sms-code-relay-00005-kem` |
| Live endpoint checks | Official MCP client initialized version 0.2.0 and listed all three tools; health 200; missing-auth management/maintenance 401; no code request created by this smoke check |
| Scheduled maintenance | New revision recorded real Google Cloud Scheduler HTTP 200 calls |
| Physical signed upgrade | Samsung SM-G996B/API 35 upgraded in place; Relay, Admin and Ready for requests visible; no new sign-in required |
| Production dependency audit | Zero vulnerabilities |

APK SHA-256: `90b478f4e550319897407dbe2fd6def8c92c0f24b6b5f7584249f4413f6aaf01`.
AAB SHA-256: `8b06e3aa5aa032f8699aacd65f37c8b3daf44f436924929e0bb0bd16aeab7bff`.

Predeployment query found no active legacy requests. The service URL, project ownership, billing, signing key and existing phone registration were preserved. ADB recovery using LIBUSB restored the attached phone without requiring another reconnect. Metadata-only local records are `deployment-v2.json`, `live-v2-verification.json`, `release-verification.json`, and `phone-v2-upgrade.json` under ignored `artifacts/pilot-setup/`. Synthetic previews are [Admin](../artifacts/admin-preview.png) and [approval](../artifacts/approval-preview.png), with smaller-screen variants beside them.

These checks do not establish real SMS consent denial/approval or two physical phones racing to approve. Those remain explicit [physical acceptance cases](PILOT.md). Manager provisioning is exposed as REST with an example; an external manager integrates it into its own credential vault/settings. Automatic MCP OAuth remains outside this pilot.


## Direct app/bot pairing update — 2026-11-08

Version **0.3.0 (3)** replaces the external manager setup. The app's Admin area now reviews a bot's connection link/comparison code and requires explicit Approve/Decline. The bot privately keeps a random pending credential; only owner approval creates its owner-bound grant. No credential is displayed/copied on the phone. Retired manager APIs return 404 and their credentials are rejected. Existing ordinary pilot caller credentials and multi-phone SMS behavior remain compatible.

Executed checks:

| Check | Result |
| --- | --- |
| Strict TypeScript build | Passed |
| Backend Emulator suite | **21 passed**, zero skipped; pending credential denied, direct approval/denial/expiry, conflicting owner claims, isolated callers, revocation/result blocking, source/global/owner quotas and header spoofing, deletion, existing SMS multi-phone/concurrency/expiry checks |
| Connection helper | Actual helper paired through the emulator HTTP API, saved pending/approved states through its vault callback, and returned the authorized credential without exposing it in the user link |
| Android unit tests | **7 passed**, including supported/hostile/malformed/duplicate connection links |
| Android UI instrumentation | **7 passed** at normal size and 360×640dp with 1.3 text scaling; explicit decision, expiry, request-bound decision callback, retry without losing a comparison code, connected-device administration, and existing SMS consent UI |
| Signed release | Configured unit/lint/R8/APK/AAB build passed; zero lint errors; signatures/checksums and version/security/App Link manifest verified |
| Cloud rollout | Build `e606fdc1-148b-461b-9de4-bfe62c2cf7a3` succeeded; staged health, registered App Link certificate, and authenticated MCP checks passed before 100% traffic moved to `sms-code-relay-00007-ced` |
| Live boundaries | Health 200, App Link JSON 200, retired manager API 404; old v0.2 tagged route removed and confirmed 404; authenticated MCP reports 0.3.0 and all three tools |
| Retention/maintenance | Five composite indexes READY, all six TTL policies ACTIVE, real Scheduler HTTP 200 calls on the new revision |
| Deployment script | Bash syntax and ShellCheck passed; script now propagates the public signing fingerprint and explicitly moves traffic after a revision-pinned deployment |

Synthetic [connection approval preview](../artifacts/connection-preview.png) and [Admin preview](../artifacts/admin-preview.png), plus smaller-screen variants, contain test data only.

Current APK SHA-256: `dcc1b66886508991f69da395422f4e8f3d12c5533b767d80e03cd1088e0650e8`.
Current AAB SHA-256: `01f913629462a7edd9066b2c93bf8671a00683b8b088b8c3b6ba0325f6d3e94d`.

After USB reconnection on 2026-11-09 UTC, the signed v0.3 APK installed successfully on the Samsung SM-G996B (Android 15/API 35), retaining Google sign-in and phone registration. Relay, Admin and Ready for requests were visible. Android verified the production App Link domain. A controlled temporary bot connection passed the live physical-phone flow: its credential received 401 before approval; the HTTPS link opened Admin with the matching comparison code; UI automation explicitly approved that test connection; its own credential authenticated to MCP 0.3.0; revoking it through Admin changed polling to revoked and MCP authentication to 401. Temporary test connections were revoked, and the test credential file was removed. Metadata-only records are `phone-v3-upgrade.json` and `phone-v3-pairing.json` under ignored `artifacts/pilot-setup/`. No SMS requests or persisted phone UI dumps were created. Real Android SMS consent denial/approval and two-phone carrier acceptance remain separate pending gates.

The final signed v0.3 APK also installed and launched on the isolated API 36 emulator with Continue with Google visible. Android independently verified the actual Cloud Run App Link domain against the APK signer; domain verification reports verified. An actual implicit VIEW+BROWSABLE launch opened MainActivity. This separately confirms release startup and the signing-domain association on that emulator.

## Injected SMS consent probe — 2026-11-09 UTC

**Passed, one opt-in instrumentation test.** An isolated API 36 Google APIs emulator with Play services 25.26.35 successfully started the public SMS User Consent listener. Only after readiness, the host injected a synthetic SMS through the emulator console. Play services delivered its permission-protected broadcast and displayed its real consent dialog. The probe verified no approved message/code was available before consent, approved the synthetic dialog, then successfully extracted the expected code using the production `ConsentGate`/`CodeExtractor`.

This probe runs in a test activity without an owner account, FCM or backend upload. It verifies simulated reception and the real Play services consent boundary, not the complete deployed relay or Samsung carrier reception. Production APK/backend behavior was unchanged; Bizee login was not needed. The reproducible runner is [test-sms-injection.py](../scripts/test-sms-injection.py), with metadata-only output in [sms-injection-verification.json](../artifacts/sms-injection-verification.json). Physical SMS denial/approval and two-phone acceptance remain pending.

## Real SMS approval — 2026-11-09 UTC

On signed v0.3, the Samsung started its listener and MCP/REST both returned ready without a code. Only afterward, an external Bizee SMS-login workflow requested a real message to the account’s existing phone. The owner’s system consent was not automated. The relay completed, returned the same approved code through MCP and REST, and later reported result_expired without a code on either API. No SMS body or code was printed or persisted by the test helper, and the Bizee login was not completed. Metadata-only evidence is in ignored physical-sms-approval.json and phone-test-manual.json. Denial, lifecycle and two-phone acceptance remain pending.

## Focused SMS request UI — 2026-11-09 UTC

Version **0.4.0 (4)** opens each request in its own screen: **Bot name — short title**, the bot’s parsed Markdown explanation, an SMS code field, **Send**, and **Cancel request**. Relay/Admin/device navigation is absent. Android approval fills the field; multiple candidates only select a value. There is no automatic submission. Manual entry is available, including after declining Android message access. Send uses an explicit owner-authenticated manual source when appropriate; agent credentials cannot submit results.

The title is limited to 80 characters, Markdown purpose to 4,000 characters, and JSON to 32 KiB. CommonMark renders native text with inert HTML and no remote image/link requests. Title participates in request idempotency while untitled callers retain their earlier fingerprint format.

Verification: strict TypeScript build passed; **23 backend tests** passed with zero skipped; **8 Android unit tests** passed; **9 Compose UI tests** passed at normal size and 360×640dp with 1.3 font scaling. Tests cover focused navigation, Markdown rendering, manual validation, selection/autofill without sending, expiry, cancellation during upload, ready-phone/source authorization and caller isolation. Configured signed release APK/AAB, R8 and release lint passed; artifact signatures/checksums were verified. Normal and small-screen synthetic previews are sms-request-preview.png and sms-request-preview-small.png under artifacts.

The backend deployed to **sms-code-relay-00010-vof** after staged health, App Link and authenticated MCP checks; live MCP reports 0.4.0 with title/Markdown input schema. The signed update installed on the Samsung, retained registration and showed the expected bot/title, rendered Markdown heading, code input and Send without Relay/Admin navigation. A fresh Bizee SMS test then completed through the focused screen: the owner approved Android-assisted filling and submitted with Send; MCP and REST returned the same code. The request metadata records android_consent. Neither approval nor Send was automated. Metadata-only evidence is in ignored phone-test-focused.json and phone-v4-focused-ui.json.

Current APK SHA-256: `26ec63e7582c818e5d7d2b0d0326ed9703aee306fbfd4a96ad038cdfca7a520a`.
Current AAB SHA-256: `0693c68b586593b99b8e5baa70c7c3c0c2048c491d147d73e5b626eec53fc510`.

## Close after successful Send — 2026-11-09 UTC

Android v0.4.1 (5) closes its task as soon as this phone's successful submission is confirmed by the server. It applies the confirmed POST response immediately, avoiding a second network fetch before closing. Failure, expiry and “Handled on another phone” keep their outcome UI. A filled field alone does not close the app. The backend remains v0.4.0.

Google's [SMS User Consent overview](https://developers.google.com/identity/sms-retriever/user-consent/overview) also explicitly supports automatically extracting and sending a code after the owner grants access to a single SMS. A second Send tap is not an API requirement. That was checked in response to the owner's question; changing submission timing is separate from this close-after-success fix.

The v0.4.1 configured release APK/AAB build, eight Android unit tests, release lint and signature/checksum checks passed. All **10 Compose UI tests** passed, including no close on mere filling/failure/another phone's result, close exactly once on this phone's server-confirmed success, and no intermediate Close button for success. The signed update installed on the Samsung using a local APK push and Package Manager after streamed installation lost its USB connection. No further live SMS was requested solely to retest closing; physical closure after the next submission remains unobserved.

v0.4.1 APK SHA-256: `aea9d064a9e67da5930184dfa9dadeeb2340eac83e3a95eb661a32d5ef2d5bbf`.
v0.4.1 AAB SHA-256: `b28c86edffe2e80d1c17d0e21ec8c0aad65a58bf91bbb4bfcce4818085abeae1`.

## Automatic submission and close — 2026-11-09 UTC

Android **v0.4.2 (6)** automatically uploads a single extracted code immediately after Android SMS consent. If extraction finds multiple candidates, choosing a candidate sends it without a second Send tap. Manual entry retains Send. Automatic upload waits for an in-flight action to finish and then rechecks the request ID, current draft and approved candidate; cancelled, stale or edited values cannot be submitted by the delayed automatic action.

The configured signed APK/AAB, release lint and eight unit tests passed, along with all ten Compose UI tests. The signed update installed on the Samsung. A fresh Bizee SMS was requested only after the caller observed ready without a code. Following the owner's Android consent, the request completed and MCP/REST returned the same code. The test harness clicked neither consent nor Send. ADB metadata then confirmed no live/resumed app activity and no app task in Recents, verifying automatic closure. No phone UI, SMS body or code was saved or printed. Metadata-only evidence is in ignored phone-test-auto.json and phone-v042-auto.json. Backend version remains 0.4.0; no infrastructure changes were needed.

v0.4.2 APK SHA-256: `ab4526b29552a723252d81d2e35b8dd9e1cefbeacc6d64be5a25f74408d41dfc`.

v0.4.2 AAB SHA-256: `fd48d23921de4843819c21c3012e209df12bc2c55d73b7a2f6e3d460b70f5377`.


## Separate Inbox, Settings and request responses — 2026-11-09

Implemented explicit destinations and request origins in the existing single activity/session. Inbox shows full-width pending rows; Settings holds Access, Devices and History. Notification targets survive authentication/registration and busy operations, show only response loading/retry states, and retain their origin across recreation. Refresh discovers SMS requests without opening a listener or redirecting Settings. Back/Close preserves pending requests, drafts and active listening; successful SMS submission returns according to entry origin. Form outcomes remain visible until closed.

Executed on an isolated API 36 Google APIs emulator using an unconfigured debug build and synthetic data:

| Check | Result |
| --- | --- |
| Android JVM unit suite | **18 passed**, including destination restoration, return policy, waiting through authentication/registration and both busy sessions, and abandoning a queued target |
| Compose/activity suite | **28 passed**, zero skipped, at normal 411×914dp and compact 360×640dp with 1.3 font scaling |
| Entry/lifecycle coverage | Cold notification, entry from Inbox/Settings, repeated taps, rotation, connection-link routing, retained wizard answers/step, and Close backgrounding without finishing the activity |
| Response coverage | System Back/Close with busy response state, explicit Cancel, manual code validation/Send, candidate selection, server-confirmed success, form actions/confirmation, wizard validation/review, expiry and competing-phone outcomes |
| Layout coverage | Inbox rows match safe list width and keep SMS/forms ordering; completed/expired entries are absent; arriving SMS does not interrupt Settings |
| Visual checks | Inbox, Settings and SMS response exercised and captured at normal size, compact with large text, 640×360dp landscape and dark theme; **12 additional layout/screenshot cases passed** |
| Debug build and instrumentation APK | Passed `assembleDebug assembleDebugAndroidTest` |
| Lint | Passed `lintDebug`: zero errors and 15 dependency-version warnings |

[UX documentation and checked-in screenshots](UX.md) describe the updated behavior. Manual-entry instrumentation exercises keyboard/focus and scrolling. State-driven response tests verify submission callbacks and acknowledged outcomes; they do not establish authenticated backend upload, real FCM delivery, real SMS consent or carrier/two-phone races for this change. Those remain physical acceptance cases in [PILOT.md](PILOT.md). No production service, signed release or physical-phone installation was changed.

## SMS discovery and navigation regression coverage — 2026-11-09

Unopened SMS discovery now follows the device's current server request on Refresh, including replacement or removal after remote termination, without starting reception. An unopened cached request does not block opening a different notification; a bound active listening session still does.

Executed with an unconfigured debug build and synthetic data:

| Check | Result |
| --- | --- |
| Android JVM unit suite | **24 passed**, including six discovery checks for successor replacement, an empty server pointer, remote terminal status, bound-session preservation, a listener binding during a fetch, and notification conflict rules |
| Compose/activity suite | **29 passed**, zero skipped, on an isolated API 36 emulator at 411×914dp and at 360×640dp with 1.3 font scaling |
| Activity navigation | Exact request ID, kind and origin asserted after notification entry and recreation; notification Back waits for the activity to stop while remaining unfinished |
| Draft retention | Actual Inbox Close and system Back retain the same RelayViewModel, request, code draft and busy state; state is seeded in memory, with no real upload or SMS listener started |
| Debug builds and lint | `assembleDebug assembleDebugAndroidTest` and `lintDebug` passed; zero lint errors and 15 dependency-version warnings |

The busy-state Compose check asserts navigation and cancellation callbacks only. The activity check separately exercises the production navigation handlers and mutable ViewModel draft. Discovery uses deterministic server-response fixtures. Authenticated uploads, real SMS reception/consent, FCM delivery and physical-phone races remain outside these checks.


## Independent Inbox and Administration entries (2026-11-09)

One installation now exposes separate Inbox and Administration launcher activities, icons and Android tasks. Connection links resolve to Administration; notifications resolve to Inbox. Administration has its own ViewModel and skips SMS recovery/discovery. Inbox refreshes request data without fetching administration lists. Account and device changes synchronize when an activity resumes and on its next automatic refresh.

Validated locally with an unconfigured debug build and synthetic data:

- All **30 Android unit tests** passed.
- Debug lint, APK and instrumentation APK builds passed.
- All **41 Compose/activity tests** passed at **360×640dp with 1.3 font scaling**, including empty/populated pull-to-refresh, independent tasks/ViewModels, connection-link routing and recreation, explicit interactive permissions, notification navigation, retained SMS drafts and wizard answers.
- The connection-link close/recreation test also passed at the normal viewport. Its lifecycle assertion now waits for Android to finish destroying the activity.
- Inbox and Administration screenshots were refreshed at normal, compact, landscape and dark settings. These previews contain synthetic data only.

Automatic list refresh runs while the UI is visible and on resume; background delivery continues through the existing FCM path. Only a manual pull displays the refresh indicator. SMS listening still requires explicitly opening a request. Production authentication, carrier delivery and Play-services consent acceptance are unchanged from the earlier records above.


## Signed v0.7.0 installation and example notifications (2026-11-09)

The configured **v0.7.0 (9)** APK and AAB were built with the existing pilot signing key; unit tests and release lint passed. The APK certificate SHA-256 remains `ac32575608bdccf302625cb45b842bd46497adba9bf36e486141076abee8f0e2`. APK SHA-256: `675f568cd2dca4859292473021df7b7c0000a90123f10abf4d1e0c3df60af4bf`.

Installed successfully over USB on the Samsung SM-G996B using an in-place, non-streaming install. Android reports version 0.7.0 (9), both Inbox and Administration launcher activities, and retained notification permission. Both activities launched successfully. Three fresh interactive examples (expense approval, form controls and multi-step wizard) were accepted by FCM and observed in the phone's notification list. A fourth example, a synthetic SMS-code request, reached `completed`. No actual SMS was triggered and no response values or SMS codes were logged.

Metadata-only installation and notification records are retained privately in `artifacts/pilot-setup/v070-install-verification.json` and the adjacent v070 demo ledgers.


## Request-opening transition fix (v0.7.1)

Inbox selection now leaves the feed visible while the selected request loads, with an inline progress indicator. It navigates directly to a ready response. Notification entry and retry initialize loading before rendering, and retained responses stay visible during repeated entry. Back abandons a pending navigation without cancelling the request; recreation retains the target metadata.

All **30 Android unit tests**, debug lint and APK builds passed. All **44 Compose/activity tests** passed on the API 36 emulator, including new coverage for delayed Inbox opening, retained form reopening, pending-navigation Back, and the initial notification loading state.
