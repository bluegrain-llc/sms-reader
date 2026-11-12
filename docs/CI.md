# CI and delivery

[CI and delivery](../.github/workflows/check.yml) runs on pushes to `main`, pull requests and manual dispatches. Feature-branch pushes use the pull-request run rather than starting a second full suite; a branch without a pull request can be checked by manual dispatch. It uses Node 24, JDK 21 and Android SDK 36 without production credentials.

The required jobs check:

- Server TypeScript compilation, unit tests and production dependency audit. Python acceptance-recorder tests verify that missing physical metadata, incomplete matrices, duplicate devices and invalid artifacts cannot produce a passing gate.
- Firestore and Firebase Auth Emulator integration tests with both backend selections, bidirectional migration and native runtime contracts, transactional lifecycle, races, expiry, caller isolation, REST authentication and MCP client requests. Missing emulators fail this suite. Strict test-source type checking and compatibility fixture regeneration run before these contracts.
- Rust formatting, Clippy with warnings denied, unit tests, dependency audit, and a production Rust Docker build with HTTP/authentication smoke checks.
- A production Docker build with startup, health and unauthenticated-request smoke checks.
- Cloud-acceptance guard/signature/evidence tests and a separate staging callback
  probe container build, syntax check and fail-closed unconfigured startup check.
- Android unit tests, lint, debug APK and instrumentation APK builds.
- Connected Compose UI tests on API 26, 33 and 36 Android emulators; each matrix job must pass. These cover approval, manual entry, automatic submission, cancellation, expiry and navigation. The separate opt-in `SmsInjectionTest` needs the telephony/Play-services runner in `scripts/test-sms-injection.py` and is not included in this UI suite.

Each run retains Android test/lint reports, debug APKs and both tested relay container archives as private workflow artifacts. The Rust image is `relay-rust-container`, with `relay-rust-image.tar.gz` and its SHA-256 checksum; it carries the workflow commit revision label (`GITHUB_SHA`). On pull requests this is the temporary merge commit; deployment uses the successful `main`-push artifact and its matching commit. Failed backend integration runs also retain emulator logs. Debug APKs have no production configuration and show the setup screen.

The separate [iOS companion workflow](../.github/workflows/ios.yml) runs on macOS 15. It generates the Xcode project with XcodeGen, resolves Firebase and Google Sign-In packages, then builds and runs unit and simulator UI tests without distribution signing. It retains the xcresult bundle. Tests cover public routing, ticket key binding, wizard validation, draft clearing, QR decoding and explicit manual submission using synthetic fixtures. Live provider authentication, APNs and signed-device Universal Links remain separate [iOS release gates](IOS.md).

The `staging-callback-probe-container` artifact retains the tested callback image
for seven days. It is separate from the production relay image and is deployed
only in an explicitly selected staging project; see [cloud acceptance](CLOUD_ACCEPTANCE.md).

After all jobs pass on a push to `main`, delivery loads the exact container archive that passed its smoke test and publishes it to GitHub Container Registry:

```text
ghcr.io/bluegrain-llc/sms-reader:<full-commit-sha>
ghcr.io/bluegrain-llc/sms-reader:latest
```

Publishing uses the repository's temporary `GITHUB_TOKEN` with `packages: write`; no registry secret is required. New container packages are private by default. The image's source label links package access to this repository. Keep package visibility private in the organization's package settings.

Protect `main` with up-to-date required status checks from the GitHub Actions app, applying the rules to administrators as well. Require every validation job in `check.yml`, including each Android API variant, plus `Play release gate unit tests` from `play-readiness.yml`. Do not require `Publish tested container` before merging: that job runs only after a push to `main`. Require pull requests and resolved review conversations, and prohibit branch deletion and force pushes. Repository settings enforce these requirements; workflow YAML alone does not configure them.

Delivery publishes installable/build artifacts; deploying to the existing Cloud Run service uses the explicit project and signing fingerprint procedure in [DEPLOYMENT.md](DEPLOYMENT.md). Signed pilot APKs require the private signing key and release configuration described there. These credentials are never needed by CI.

The Android UI job removes unused .NET and Android NDK installations from its disposable hosted runner before starting the emulator. API 36 images can require over 7 GiB for userdata despite the requested 2 GiB data-partition setting; a low-space runner can exit before ADB starts. This cleanup preserves the Java/Kotlin toolchain and Android SDK packages used by the tests.

## Protected production release

The separate manually dispatched `Protected production release` workflow accepts a successful `main` push CI run ID, verifies that run's archived image/checksum/commit, builds and verifies signed release artifacts and deploys the tested image by Artifact Registry digest. It uses a protected GitHub environment and Google Workload Identity Federation. Repository administrators must configure the environment approval and branch restrictions before use.

Deployment stages a fully configured zero-traffic revision, verifies its tagged URL and promotes 5%, 25%, then 100% with observation windows and rollback on failure. The image is not rebuilt during cloud deployment. Five application review/fix cycles, required CI and external release acceptance remain independent gates; this workflow does not submit anything to Google Play. See [deployment configuration and recovery](DEPLOYMENT.md).
