# Store listing and reviewer package

Copy below describes the intended production behavior. Do not submit until policy/deletion links and all release gates are live. Reconcile it with the final build, especially the independent launcher entries.

## Store copy

App name: **SMS Code Relay**

Legal operator: **Dmitry Kropachev**. Public privacy and support email: **bluegrain.llc@gmail.com**. The developer account is personal. These public contact details do not determine a marketing developer display name, physical address, countries, audience, public policy/deletion URLs or Console access; verify those separately before submission.

Short description: **Review app requests, approve decisions, and share upcoming SMS codes.**

Full description:

SMS Code Relay brings requests from apps and bots you approve to your Android phone.

Use Inbox to review information requests, make decisions, and complete forms or step-by-step questions. Use the separate Administration entry to manage paired callers, registered phones and account controls.

For an upcoming SMS verification code, open the request before the message is sent. Android asks permission to share one eligible new message with the app. After you approve, a single extracted code is sent to the requesting caller. If there are multiple candidates, choose which one to send. You can also type a code and tap Send. The app does not read your SMS inbox or send verification messages.

Pair each caller explicitly. Interactive requests need separate permission. Pause a phone, revoke a caller, or request permanent account deletion through Administration. Deletion blocks access when accepted and cleanup continues in the background. The public account-deletion page offers the same request flow without the installed app. Multiple registered phones can receive a request; only the first valid response completes it.

Google sign-in, Google Play services and notification permission are required for phone registration. Carrier delivery, sender eligibility and Android's listening window affect SMS reception. Messages arriving before the listener starts cannot be recovered. Form drafts remain in memory and are lost if Android ends the process.

Approved SMS codes are available to the originating caller for two minutes. Submitted form answers are available for 24 hours. See the published privacy policy for live-data cleanup, metadata, backup and account-deletion details.

## Assets

Use only freshly captured synthetic fixture screens from the exact candidate. Existing repository screenshots are test data, but their older branding/layout may not match the release. Capture Inbox, Administration, SMS response and a form/wizard; no real account email, SMS body/code, caller credential or notification from another app may appear. Export Play-required phone screenshots and graphics at Console's current dimensions; record their hashes and inspect them manually. Launcher vector assets are source artwork, not automatically valid store icon/feature-graphic uploads. Do not invent a passing visual review or add production captures to the repo.

## Release notes draft

Review requests in Inbox and manage access in the separate Administration entry. Respond to forms and step-by-step questions, review upcoming SMS codes with Android permission, and control caller access and account deletion.

## Reviewer access rehearsal

The owner must rehearse an access path that works throughout review and enter it in Console's private App access fields. No production credentials belong in this file, an issue, PR or store description.

1. Explain both launcher entries, required Play services and notifications, and the Google sign-in step. Verify whether a reviewer-owned account can access all features or supply an isolated review account using Console's secure mechanism. Do not rely on the operator's personal account, location restriction or unattended second-factor challenge.
2. Provide an on-demand, non-expiring access procedure for pairing a dedicated synthetic caller. Pairing links themselves expire after ten minutes and are unsuitable as fixed review credentials. Explain caller names and optional interactive permission.
3. Demonstrate harmless form and wizard requests with explicit submit/decline. Opening a notification is not approval. Include cancellation, revocation and deletion paths.
4. For SMS, use a controlled test sender/number and fresh listening session. Do not ask reviewers to share their personal verification codes or complete a real third-party login. Manual entry can demonstrate upload, but does not prove physical SMS consent acceptance.
5. Verify that Administration → Devices account deletion and the public web deletion path work without operator intervention. Recent Google reauthentication must return to the pending deletion action for the same account. After HTTP 202, verify access is blocked immediately and receipt status eventually becomes completed. Receipts stay in browser memory and authorize status only; closing the page does not cancel cleanup. Check actual record/identity cleanup separately from the accepted-job message.

Record the rehearsal result and privately stored reviewer instructions in the candidate evidence. Missing workable reviewer access blocks submission. A textual instruction list is not evidence that review access was supplied or accepted.

Complete the actual content-rating questionnaire, audience selection, countries, ads and account-verification declarations in Console. These depend on the operator and intended audience; this package supplies no guessed answers.
