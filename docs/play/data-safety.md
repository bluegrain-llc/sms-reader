# Data safety preparation inventory

This is a source-backed inventory for the operator's Console answers, not a submitted declaration. Full SMS stays on device; approved codes and submitted forms leave it. Do not answer “no data collected” just because broad SMS permission is absent. Review the actual release's SDK behavior and backend configuration before signing off. See [Google's Data safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en), including service-provider, user-initiated sharing and ephemeral-processing rules.

| Data | Purpose and recipient | Persistence and controls | Declaration review |
| --- | --- | --- | --- |
| Google/Firebase UID, email and authentication state | Account authentication; Firebase Auth and relay | Account lifetime; recent sign-in for deletion; minimal deletion markers | Personal info/email, user IDs; confirm actual SDK collection |
| Installation ID, device name, FCM token | Device registration and notifications; relay/FCM | Until removal/deletion; pause and token refresh | Device or other IDs; inspect SDK network data |
| Caller labels, pairing purpose, comparison-code hashes and grants | Owner-controlled caller access; relay | Short pairing windows; connection metadata seven days; grants until revocation/expiry/deletion | User IDs/other user-provided data as applicable |
| SMS code explicitly approved or manually submitted | Send one code to originating authorized caller; relay/Firestore | Two-minute live retrieval window; scheduled removal/TTL | Review SMS/MMS content classification; no full SMS body uploaded |
| Form definitions, explanations, actions and answers | Authorized interactive requests and replies; relay/Firestore/originating caller | Answers 24 hours; definitions/events seven days after termination | Other user-generated content and actual sensitive categories requested by deployed callers; do not assume arbitrary form values are nonsensitive |
| Request IDs, states, timestamps, device observations and audit events | Delivery, expiry and operational recovery; relay/Firestore, subscribed webhook receiver | Metadata seven days after termination; webhooks omit answers | App interactions and diagnostics as applicable; opening does not mean agreement |
| Infrastructure route/status and sanitized error metrics | Reliability and abuse response; Google Cloud | Actual configured log/metric retention; never body/header/code dumps | Diagnostics and provider metadata; verify actual access-log policy |
| Account/access metadata backup and deletion/revocation record | Disaster recovery without resurrecting removed access | Planned daily encrypted metadata export, seven-day retention; no codes, answers, definitions or event payloads | Only claim after #10 deploys and is verified; disclose residual backup deletion timing |

## SDK and service review

- Firebase Authentication and Google Identity/Credential Manager authenticate Google accounts; FCM transports opaque request IDs. Firestore's Android direct-client rules deny data access; backend Admin SDK uses IAM. Cloud Run, Cloud Tasks and Scheduler operate backend delivery. Check the release dependency graph, providers' disclosures and network behavior.
- CommonMark renders native text with inert HTML and no remote resources. No analytics/crash-report SDK or advertising SDK is currently installed. Adding one invalidates this inventory until its collection/retention is reviewed.
- Codes/results go to the caller the owner approved; events can go to its signed webhook. Evaluate Console's sharing exceptions against this exact user-facing behavior, rather than declaring every external transfer exempt.
- HTTPS is required. Server operators remain able to process live results; do not claim end-to-end encryption.
- Required notification consent does not replace prominent explanation of SMS approval or per-caller permission. Forms require their own access approval and explicit final submission.

## Operator sign-off gates

Record actual legal operator, privacy/support contacts, hosting region, public policy/deletion URLs, collection purposes, optional/required choices, sharing classifications and retention configuration in the private candidate record. Verify in-app links and web self-service deletion after #9. Include the seven-day metadata backup policy only once #10 is live; explicitly distinguish it from two-minute/24-hour live result deadlines. Minimal deletion/revocation markers and backups need their actual retention disclosed. Ensure the web policy and Console answers agree, including sensitive categories allowed in form requests.

Google requires [in-app and external account-deletion paths](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en). Removing the APK alone does not delete an account. Verify completed deletion across Firebase identity, devices, grants, pairing, SMS/forms, results, events, jobs and webhook secrets. Neither an accepted job nor an HTTP 202 proves cleanup completed.
