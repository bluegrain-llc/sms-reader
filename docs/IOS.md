# Native iOS companion

The `ios` directory contains a SwiftUI iOS 17+ companion. Inbox contains SMS responses and information/decision requests; Administration contains connection permissions, agent creation/ticket export, devices, history, provider linking and account deletion. Native `Form`, `List`, `NavigationStack`, text styles and controls follow system appearance and Dynamic Type. Agent approval runs in a separate sheet so navigating onboarding does not replace in-memory Inbox drafts.

## Build and configuration

On macOS with Xcode 16+ and an installed iOS simulator:

```sh
brew install xcodegen
cd ios
xcodegen generate
xcodebuild -resolvePackageDependencies -project RequestRelay.xcodeproj -scheme RequestRelay
xcodebuild test -project RequestRelay.xcodeproj -scheme RequestRelay \
  -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
```

The macOS workflow selects an available iPhone simulator, builds and runs unit/UI tests, and uploads its xcresult bundle. XcodeGen creates the project, Info.plist and entitlements from tracked `project.yml`; these generated files are ignored. An unconfigured debug app displays a setup screen and cannot register a device.

Before a signed build:

1. Register `com.bluegrain.smsrelay` (or consistently replace the bundle ID) with the Apple Developer team. Enable Associated Domains, Push Notifications and Sign in with Apple. Set `RELAY_APPLE_TEAM`, `RELAY_URL`, `RELAY_HOST`, `GOOGLE_REVERSED_CLIENT_ID` and `APNS_ENVIRONMENT` build settings. Use `production` APNs entitlement for distribution. Generated entitlements must match the signed app and provisioning profile.
2. Download this project’s iOS `GoogleService-Info.plist` from Firebase to `ios/RequestRelay/GoogleService-Info.plist` before project generation. It supplies the Firebase client configuration and Google client ID. Configure its URL scheme using the reversed client ID. Keep deployment configuration outside Git.
3. Enable Google and Apple providers in the same Firebase project as Android/browser clients. Configure Apple’s service ID, team/key identifiers, private key and Firebase authorized return URL; configure Apple private email relay if needed. Configure Firebase Authentication to create separate accounts for different identity providers (allow duplicate emails), disabling implicit email-based provider linking. Firebase UID is the account boundary. Matching emails never authorize linking or merging; only the explicit authenticated link action joins sign-in methods. This project-level setting must be verified before enabling Apple sign-in in production.
4. Upload an APNs authentication key to Firebase Cloud Messaging and match the Apple team/app configuration. The app explicitly maps the APNs token to FCM, requests alert permission through **Connect this device**, registers `platform: ios` and `wizardVersion: 1`, and fetches authenticated request content when opened. No notification contains codes, responses, request titles or purposes.
5. Deploy both backends with `APPLE_APP_IDS=TEAMID.com.bluegrain.smsrelay` (comma-separated if multiple apps). Both serve `/.well-known/apple-app-site-association` as JSON without redirects. It covers registration, temporary/reusable pairing, connection management, hosted OAuth consent, legacy `/connect` and `/owned-services`. Configure `iosInstallUrl` alongside `androidInstallUrl` in Firebase web config when distributing an install URL.

Association and signing requirements follow [Apple Associated Domains](https://developer.apple.com/documentation/xcode/supporting-associated-domains); APNs mapping/setup follows [Firebase Apple messaging setup](https://firebase.google.com/docs/cloud-messaging/ios/get-started).

## Manual code readiness and response handling

An iOS phone opens an SMS request and sends `POST /v1/devices/DEVICE/requests/REQUEST/events` with `{"status":"ready","mode":"manual"}`. The server, rather than the client clock, starts a five-minute window capped by request expiry. `manualEntryDeadline` is returned to the phone and caller. iOS phone views have `listeningDeadline: null`; internal aggregation still enforces the hard readiness deadline. Repeated readiness never extends it. iOS cannot send Android listener/consent events, request listener leases, or submit `android_consent` responses. Android registration defaults to `platform: android` for older clients; an installation’s platform cannot change.

Manual submission uses `{"status":"completed","source":"manual","code":"123456"}`. The same transaction and first-device-wins behavior applies across Android and iOS. No SMS is read automatically. Users type, deliberately paste, or select system AutoFill and then tap **Send**. `.oneTimeCode` does not bypass [domain-bound AutoFill restrictions](https://developer.apple.com/documentation/security/enabling-autofill-for-domain-bound-sms-codes); manual entry remains available when another service’s code is ineligible.

Form wizards evaluate conditions against earlier reachable steps and omit hidden answers. They support native text, multiline, numbers, checkboxes, single/multiple choices and dates, with Previous/Next, final review and explicit submission. Form SMS helper fields use manual entry and never send Android `input.ready` observations from iOS. Existing connection permissions still authorize each request type independently.

Draft answers and codes exist only in memory. They are cleared on terminal outcomes, expiry, account changes and termination; process death naturally discards them. They never enter Keychain, UserDefaults, state restoration, notifications, background work or logs. A privacy cover hides responses when the scene is inactive. Only public link/request identifiers and pairing attempt IDs enter UserDefaults. The installation ID and tickets use separate device-only Keychain entries; export is an explicit user file operation.

## Authentication and deletion

Google and Apple sign-in are available on iOS, Android and browser entry points. Both backends verify Firebase ID tokens and allow only `google.com` or `apple.com` sign-in providers. Linking is an explicit authenticated action with consent, retaining the Firebase UID. Credential conflicts require user action; there is no email-based merge.

Deletion requires recent authentication as the same Firebase user. If Apple is linked, the client reauthenticates through Apple and revokes Apple authorization before submitting relay deletion. iOS uses Firebase’s authorization-code revocation API; Android/browser revoke the Apple access token. Relay deletion immediately blocks account access and queues existing durable cleanup, including Firebase identity deletion. See [Firebase Apple authentication and revocation](https://firebase.google.com/docs/auth/ios/apple).

## Release gates

Source, configuration and automated tests do not establish App Store readiness. This Linux implementation environment cannot run Xcode, simulator UI tests or signed-device acceptance. The macOS workflow must pass before release. Keep these external gates explicit:

- Validate signed-device Universal Links while signed out, running and cold launched; preserve the target through sign-in/relaunch. Test invalid origins, expired/denied sessions, browser approval without either app installed, and reopening/rescanning after installation.
- Validate live Google/Apple authentication, explicit linking, cancellation/conflicting accounts, provider-aware reauthentication and Apple revocation/deletion.
- Validate FCM/APNs alerts, authenticated notification opening, token refresh, denied notifications, foreground Inbox refresh and mixed Android/iOS submissions on real devices.
- Validate VoiceOver, accessibility text sizes, light/dark mode, all conditional wizard branches, deliberate paste and eligible/ineligible AutoFill. Verify no submission occurs before Send and memory clears on expiry/process death/account change.
- Complete distribution signing, privacy policy/operator contact, App Store privacy answers, screenshots, support URL, age/content declarations and review instructions. Review instructions should supply a test account/agent, explain that SMS is manually entered with explicit Send, identify account deletion, and describe notification/camera usage.

Deploy backend authorization/device/notification support and both domain associations before mobile releases. Deployment, signed-device acceptance, TestFlight/App Store submission and Apple approval are separate release steps.
