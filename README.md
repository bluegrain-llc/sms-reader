# Request Relay

Production publication follows the [Google Play release gates and preparation package](docs/play/README.md). The package does not claim that Console, closed testing, or physical acceptance is complete.

An Android 8+ request inbox and Firebase-backed Cloud Run service for owner-approved, upcoming SMS codes. One installation provides two independent launcher entries: **Inbox** for requests and **Administration** for access, devices and history. Each has its own Android task and navigation. Lists update automatically; pull down from the top to refresh immediately. Apps and bots pair directly through a link approved in Administration; each user/app connection gets its own credential for REST or MCP. The relay never triggers an SMS and never reads the inbox.

UI changes must follow the [UI contract](docs/UX.md) and [agent instructions](AGENTS.md): one purpose per page, an Android Settings-style administrative hierarchy with settings search, and history exclusively in Administration. The contract defines the redesign target; existing screens and navigation examples may still reflect the earlier UI.

The linked [user flows, page/control IDs, glossary, and validation guide](docs/ui/README.md) distinguish Android, iOS, and browser tasks and script, terminal, and hosted agents. Run `npm run check:ui` and `npm run test:ui` to verify references, platform/agent coverage, generated documentation, and declared flow exits.


Apps and agents can also ask for information and decisions through native forms: Markdown messages, text, numbers, checkboxes, choices and dates, with explicit Submit/Approve/Decline/Acknowledge actions. Forms can also become multi-step wizards with Next/Previous, conditional steps, a retained in-memory draft, and one final review/submission. Pending forms remain available in any order while SMS capture stays serialized. Each existing connection starts with SMS-only permission; enable interactive requests explicitly in **Administration → Access**. The additive `/v2` API and MCP tools provide request/result operations, durable event polling, SSE and signed webhooks. Answers are retrieved separately and expire after 24 hours. See the [request inbox API, delivery contract and rollout](docs/REQUEST_INBOX.md).

The owner opens a notification, Android starts SMS User Consent, and the service reports `ready`. Only then should a separate workflow trigger the SMS. The request shows “Bot name — short title”, the bot’s Markdown explanation, an SMS code input and Send. Approve Android’s SMS prompt to send a single extracted code automatically. If there are multiple candidates, choose the code to send. Manual entry remains available with Send. After server confirmation, a notification entry returns to the previous app and an Inbox entry returns to Inbox.

```
Caller → queued (if busy) → pending_phone → owner opens app → listener starts → ready
External system sends SMS → awaiting_consent → Android approval fills input → owner taps Send → completed
Manual entry while ready → owner taps Send → completed
```

The phone can decline, cancel, pause requests, revoke tokens, unregister, or delete its account. Calls return after their database transaction and clients poll. FCM delivery is queued and dispatched by the maintenance job, usually within one minute. Each owner has one active request; additional callers queue. Requests notify every available registered phone, and the first approved code wins. Stopping on one phone leaves the others available. Requests time out after ten minutes; the listening window ends at five minutes. Codes are available to the originating token for two minutes. Request metadata and audit events expire after seven days. Expiry is enforced in the API independently of asynchronous Firestore TTL deletion.

## Local verification

Requires Node 22+ and JDK 21 for Firebase Emulator Suite; Android uses JDK 17+ and SDK 36.

```sh
npm ci
npm run build
npm test                   # server unit tests
npm run test:integration   # Firestore + Auth emulators, REST and MCP integration tests
cd android
./gradlew testDebugUnitTest lintDebug assembleDebug assembleDebugAndroidTest
./gradlew connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.bluegrain.smsrelay.ApprovalScreenTest
```

Set `JAVA_HOME` and place that JDK's `bin` first in `PATH` when Java 8 is the machine default. Android requires `ANDROID_HOME` or an ignored `android/local.properties` containing `sdk.dir=/path/to/sdk`.

The connected Android tests require a running emulator. The opt-in SMS injection probe is separate; see [CI and delivery](docs/CI.md) for automated coverage and artifacts. `npm run test:emulator` remains an alias for the integration suite. Running the server integration suite directly without both emulators fails rather than silently skipping tests.

The debug APK compiles without cloud credentials and displays a setup screen. It cannot register a phone until configured. No Firebase project, billing account, signing identity, or attached phone is assumed.

## Pilot setup

The Firebase project `dk-sms-relay-20261108` has a verified Cloud Run, Firestore, and Scheduler deployment under `bluegrain.llc@gmail.com`. Google sign-in and the release certificate's Android OAuth client are configured. The [signed pilot APK](artifacts/sms-code-relay-pilot.apk) and [release AAB](artifacts/sms-code-relay-release.aab) are built, with unit tests, release lint, signatures, and emulator startup checked. Physical-phone acceptance remains pending. See [current setup, signing backup, and installation steps](docs/PERSONAL_PROJECT.md).

1. Follow [deployment setup](docs/DEPLOYMENT.md) to select a Firebase project, enable Google sign-in, create Firestore, and deploy Cloud Run plus scheduled maintenance.
2. Supply the Android configuration in [pilot.properties.example](android/pilot.properties.example) using environment variables or private Gradle properties. Register the signing certificate SHA-1/SHA-256 in Firebase and configure the OAuth web client ID.
3. Run [build-pilot.sh](scripts/build-pilot.sh) to create or reuse a private signing key, verify release lint, and produce a signed APK and release AAB. Keep the key and passwords outside the repository. The script refuses incomplete configuration.
4. Install the signed APK on a physical Google Play-services phone and complete the [pilot acceptance checklist](docs/PILOT.md). This physical test is a release gate; unit tests cannot prove carrier/Play-services behavior.
5. Sign in and allow notifications; the phone registers automatically. The app/bot shows a connection link. Open it on your phone and approve in **Administration → Access**; its individual credential becomes usable automatically. No master credential or phone-side token copying is needed. Add phones by signing in with the same Google account.

## Caller connections

First use [direct pairing](examples/connect.mjs) to connect the caller to the owner's account. The bot shows an HTTPS link/comparison code, the owner approves in Administration, and the bot polls with its private pending credential until approved. Google credentials stay on the owner side; the bot cannot choose a user account or phone arbitrarily.

REST and MCP then use `Authorization: Bearer smsr_…`; MCP's endpoint is `https://SERVICE/mcp`. Each credential is restricted to that owner and caller. It cannot register devices, submit codes, approve other callers, or retrieve another caller's results. Automatic MCP OAuth discovery is outside this pilot.

See [API and lifecycle](docs/API.md), [connection design](docs/PAIRING_DESIGN.md), [caller integration](examples/caller.mjs), and [MCP smoke client](examples/mcp-smoke.mjs). The caller waits for `ready`, invokes its external SMS callback, then polls for the approved code. Keep returned codes in memory.
```js
import { readFile } from 'node:fs/promises';
import { receiveSmsCode } from './examples/caller.mjs';
const code = await receiveSmsCode({
  baseUrl: process.env.RELAY_URL,
  token: process.env.RELAY_TOKEN,
  title: 'Verify sign-in',
  purpose: await readFile('./examples/sms-request.md', 'utf8'),
  signal: AbortSignal.timeout(11 * 60_000),
  triggerSms: async () => { await yourSeparateSystem.requestVerification(); },
});
await yourSeparateSystem.finishVerification(code);
```

SMS User Consent requires an eligible 4–10 character alphanumeric code with at least one digit, excludes senders in Contacts, and cannot recover messages delivered before listening. See Google's [consent API](https://developers.google.com/identity/sms-retriever/user-consent/request) and [eligibility guidance](https://developers.google.com/identity/sms-retriever/choose-an-api).

[Privacy disclosure](docs/PRIVACY.md) explains data handling and deletion. [Security notes](docs/SECURITY.md) describe the trust boundaries and operational assumptions. [Verification record](docs/VERIFICATION.md) distinguishes executed checks from remaining phone and cloud validation.

## QR and service onboarding

The additive v3 implementation supports named services, focused Android/browser registration and approval, reusable service links, temporary pairing, separate service/recipient credentials, explicit forms/SMS capabilities, and encrypted credential delivery. Start with `relay service register`, or create an agent in Administration and use `relay service import-ticket --file PATH`. Registration and account access require separate approvals. A native iOS 17+ companion and macOS CI configuration are in [ios](ios); see [iOS setup and release gates](docs/IOS.md). See [onboarding and rollout](docs/ONBOARDING.md), [SDKs](sdks/README.md), and [developer integrations](integrations/README.md). Named-resource OAuth supports hosted MCP connections; physical-device/live provider acceptance and SDK registry publication remain outstanding. Every connection uses the configured relay server.
