# Physical-phone pilot acceptance

**Release gate: current release requires dated physical acceptance.** Historical v0.3–v0.4.2 runs passed real SMS approval, retrieval, expiry and automatic submission; see [verification chronology](VERIFICATION.md). Those results do not establish acceptance of later inbox, navigation, form or wizard changes. Emulator/unit tests cannot validate carrier delivery or consent behavior on a physical phone. Record date, phone model, Android/Play-services versions, APK hash/signing certificate, project/region, and each outcome without recording SMS bodies or codes.


## Current release acceptance records

Build the configured signed release candidate using `scripts/build-pilot.sh`. The
record tool verifies APK signing and rejects debuggable or non-relay APKs. It
collects physical device model, Android/API and Google Play-services version using
fixed ADB metadata commands. Device-reported hardware serials are replaced with
SHA-256 hashes, so USB and network aliases of one phone share an identity. Phones
without a usable hardware serial are refused. The tool never reads SMS, app files,
screen contents, account identities or credentials.
The artifact hash identifies the APK selected by the operator; the tool does not
prove that this exact APK is installed. Install that candidate on both phones
before testing. Bind the record to the explicitly selected project, region and
backend revision from the private deployment record.

```sh
python3 scripts/phone-acceptance.py init \
  --file artifacts/acceptance/current-release.json \
  --apk artifacts/sms-code-relay-pilot.apk --commit "$(git rev-parse HEAD)" \
  --project "$PROJECT_ID" --region "$REGION" --backend-revision "$REVISION" \
  --apksigner "$ANDROID_HOME/build-tools/36.0.0/apksigner" \
  --aapt "$ANDROID_HOME/build-tools/36.0.0/aapt" \
  --adb "$ANDROID_HOME/platform-tools/adb" \
  --serial PHONE_ONE --serial PHONE_TWO
```

The initial matrix is entirely pending. Use a new record for each new candidate;
initialization refuses to overwrite records. Omitting serials can prepare a
pending matrix, but passing observations then fail validation. Emulator devices
are refused, and two-phone cases require two distinct physical device identities.

After performing each case below, record the observed result explicitly:

```sh
python3 scripts/phone-acceptance.py record \
  --file artifacts/acceptance/current-release.json \
  --case consent_approval --outcome pass --reason observed_expected_behavior
python3 scripts/phone-acceptance.py summary \
  --file artifacts/acceptance/current-release.json --require-pass
```

The summary exits nonzero while any required case is pending, blocked or failed.
Only enumerated case IDs, outcomes and reasons are accepted; there is no free-text
notes field for accidentally recording a message, code or credential. Failed and
blocked cases use `unexpected_behavior`, `device_unavailable`,
`owner_action_required` or `service_unavailable`. Records are created with owner-only
permissions under ignored `artifacts/`. They are operator attestations, not
cryptographic proof or an automated replacement for the tests. Do not upload them
or sensitive phone screenshots to public CI artifacts.

| Recorder cases | Required exercise |
| --- | --- |
| `google_sign_in`, `pairing_approval_revocation`, `generic_notification`, `ready_before_sms` | Feasibility steps 1–4; verify isolation before approval |
| `consent_approval`, `consent_denial_manual_entry`, `result_expiry_cleanup` | Feasibility steps 5–7; approval does not establish denial |
| `multiple_candidates`, `leading_zero_numeric`, `alphanumeric_code`, `unsupported_format`, `sender_filter`, `contacts_exclusion`, `pre_ready_sms`, `no_inbox_access` | Eligibility table below; use a fresh request/window where needed |
| `cancel_upload_race`, `revoke_completed_result` | One terminal winner; originator loses access immediately after revocation |
| `background_locked`, `notification_permission`, `offline_before_after_deadline`, `rotation_during_consent`, `process_death`, `listener_cooldown` | Lifecycle matrix below; no late result or renewed deadline |
| `two_phone_first_wins`, `two_phone_withdrawal`, `two_callers_isolation_queue` | Two physical phones and distinct callers; losing phones never receive answers |
| `forms_wizards_with_sms` | Two pending forms plus serialized SMS; conditional wizard review, decline, first-submission wins, manual/SMS autofill, explicit form submission, cancellation and expiry |
| `offline_observation_replay` | Tap/open offline, restart, recover observation upload; replay events and callback retries without answers in notifications/events |

Use the exact candidate APK and backend revision for final acceptance after the
cloud delivery, release pipeline and deletion changes are deployed and verified.
API 26/33/36 UI CI proves only the synthetic regression suite. Physical carrier,
FCM, system-consent denial/approval and two-phone tests remain separate gates.

## Optional injected-SMS check

An isolated Google APIs emulator can exercise simulated SMS reception and the real Google Play services consent dialog without a sender account or another phone. This is a separate instrumentation probe: it uses the production `ConsentGate` and `CodeExtractor`, but does not sign in, contact the production relay, receive FCM, or upload a result. It does not establish carrier delivery or consent behavior on a physical phone.

Start an isolated emulator with Google Play services, then build and run:

```sh
cd android
./gradlew assembleDebug assembleDebugAndroidTest
cd ..
ANDROID_SERIAL=emulator-5584 ANDROID_HOME=/path/to/android-sdk \
  python3 scripts/test-sms-injection.py
```

The runner refuses physical devices. The instrumentation test requires explicit `smsInjection=true` and emulator hardware; ordinary test runs skip it. Once the public SMS User Consent listener reports success, the host injects a synthetic SMS through the Android emulator console. The probe checks that the code is unavailable before approval, opens the system dialog, approves that synthetic message, and verifies code extraction. Only status metadata is written to `artifacts/sms-injection-verification.json`; no message or code is recorded. A full physical acceptance run below is still required.

## Feasibility gate — do this first on the configured signed APK

1. Sign in with Google and grant notifications; verify automatic registration. Have the test bot request a connection. Open its HTTPS link on the phone, compare its code, and approve it in Settings → Access; verify the bot can then authenticate. For the single-phone denial gate, pause any other registered phones.
2. Create a request with that token. Verify FCM presents a generic notification without purpose or code.
3. Tap it. Confirm the app shows the configured caller name and request purpose. Verify the caller observes `ready` only after Android's listener starts.
4. Trigger a real eligible SMS from a separate workflow. Neither this app nor the relay service has an SMS-trigger endpoint.
5. Confirm Android's own consent dialog appears. Before approving, verify agent GET has no code. Decline Android message access once; verify the focused screen keeps manual input available and no result is returned before Send. Cancel the request to end participation.
6. Wait out the old five-minute listener window, create a fresh request, repeat and approve. Verify a single extracted code is submitted automatically, the app closes after server acknowledgement, and only the code is returned to the originating token. Verify no SMS body exists in Firestore or logs.
7. Poll after two minutes: no code must be returned, independently of TTL/cron. Confirm scheduled deletion removes the result document.

Do not consider the pilot usable until this gate passes. On failure capture only status/failure reason and timing metadata, investigate platform behavior, and repeat with a new request and a fresh SMS.

## Eligibility and extraction

| Case | Expected outcome |
| --- | --- |
| 4–10 numeric characters, including leading zeros | Approved code preserved exactly |
| Alphanumeric with at least one digit | Supported candidate returned after approval |
| Multiple code-like values | Owner sees candidates and must select; only selection uploaded |
| No eligible candidate / unsupported format | Timeout or explicit extraction failure; no fabricated result |
| Expected E.164 sender | Matching sender works; nonmatching sender does not complete request |
| Sender in Contacts | API excludes it; request times out |
| SMS arrives before `ready` | Not recoverable; timeout/failure, start a new request before another SMS |
| Old SMS already in inbox | No recovery and no inbox access |

## Android lifecycle

- Foreground, app backgrounded after `ready`, screen locked, and app reopened: no background activity launches; pending consent prompts reopening and stays bound to the same request.
- Rotate during listening, system consent, and candidate selection: no duplicate listener/readiness or upload; timer does not reset.
- Kill the process during each phase, then reopen: explicit `process_restarted` or terminal timeout; no recovered full SMS/code, no silent listener restart.
- Disable notifications before registration, after registration, and just before posting: actionable failure; no crash.
- Turn network off before notification, readiness, consent acknowledgement, and upload. Reconnect before/after deadlines: bounded retries, unchanged readiness deadline, no late result acceptance.
- Leave a notification unopened past ten minutes, then tap: terminal expired result, no listener starts.
- Open another request while one is active, cancel during listener start, and cancel while upload is in flight: one terminal result and no reassignment of consent.
- Deny/cancel and request again before the old five-minute window ends: the caller queues if every available phone is cooling down, then activates after a window ends. A still-cooling individual phone must not take over another phone’s listener.
- Confirm original SMS still appears in the existing messaging app and no broad SMS/Contacts permission is requested.

## Access and service verification

- Separate owner/device/token cannot read or mutate another request. A token cannot register phones, create grants, or upload results.
- Revoke while pending/ready/awaiting consent and after completion: request cancellation where active; completed-result retrieval blocked immediately.
- Expire a token, pause/unregister a device, delete an account, and retry with cached bearer tokens.
- Duplicate create with same payload, changed payload under same idempotency key, duplicate same/different code uploads, simultaneous create calls, and caller cancellation during upload.
- Transient FCM failure and duplicate FCM delivery: one request, one notification identity, retries without added quota consumption.
- Run `connectedDebugAndroidTest` on a configured emulator/device for Compose selection coverage. This UI test supplements the physical consent test.
- Inspect application/cloud logs, Firestore requests/audit, WorkManager input, backups/transfers and crash-report settings: no SMS body or code leakage.
- Verify Scheduler OIDC rejects ordinary agent/owner tokens; monitor failed jobs, delivery backlog, due-result backlog, and TTL policies.

## Multiple phones and apps (v0.2)

These cases are covered by backend emulators but still need a physical two-phone run:

- Sign in with the same account on two phones. One request must produce a generic notification on both. Starting a listener on one phone must not mark the other phone ready.
- Trigger SMS only after ready. Approve on one phone; the other must show Handled on another phone without receiving the winning code. With two eligible messages and two approvals racing, only one result may be stored/retrieved.
- Stop/decline on one phone; the other must remain available. Global denied/failed/cancelled follows only when all phone participation ends (or the caller cancels).
- Pause/remove one phone in Settings; only the remaining available phones receive subsequent notifications. Removing one phone must preserve caller credentials and other phones. Removing the current phone must not reconnect it on relaunch without an explicit action.
- Create two caller requests concurrently. One activates, the other queues without a notification until activation. A credential must never read the other caller’s result.
- Revoke one paired app during queued work and after an approved result. It loses access immediately; unrelated callers continue.

Direct pairing cases: inspect a link without approving (bot cannot request SMS); decline; expire; retry approval; compare two separate bot credentials; open a link signed out and continue after Google sign-in; open while registration/refresh is busy; verify Android App Links and manual code fallback; verify no credential appears in the link, phone UI, screenshots, or logs.
