# UI contract

This is the governing design for Android, iOS, and browser UI changes. Every page has one purpose and contains only the information and controls needed for that purpose. The administrative UI follows Android Settings, with settings search and a hierarchy of focused pages. History belongs exclusively to Administration; Inbox contains pending work only.

This contract defines the redesign target. Existing implementations, screenshots, and navigation descriptions elsewhere may still reflect the earlier UI. They do not override these requirements or establish that the redesign has been implemented.

## Single purpose pages

A page must have one clearly stated user task. Selecting an item, choosing a settings destination, approving a connection, and editing one setting are distinct tasks. A list may link to Create or Add, but the creation form opens on its own page. A settings menu contains navigation rows, not embedded forms or unrelated controls. Task pages show only the selected subject, necessary explanation, relevant inputs, validation, progress, and action outcomes.

Use a task-specific title and one primary action when an action is needed. Back/Close and relevant alternatives such as Decline or Cancel remain available. Permission and duration inputs may share a connection approval page because they define the single access decision being approved. Editing an existing connection's permissions and expiry uses separate pages. System authentication, notification permission, file pickers, and destructive confirmations may use native sheets or dialogs; this rule does not require an artificial page for each system interaction.

Do not add dashboards, summary cards, unrelated account controls, or all-settings forms to task pages. Show errors and loading beside the affected task. Show only contextual recovery links needed to continue that task.

## Entry points and groups

One APK provides two independent launcher entries and Android tasks: **Inbox** and **Administration**, with different names and icons. Inbox owns request navigation, drafts and SMS listeners. The Administration entry opens the searchable settings hierarchy. Its categories are **Administration** (devices, owned agents, history), **Peering** (recipient connections), and **Account** (identity and lifecycle). **Requests** groups Inbox and response destinations; **Initial Login** groups conditional authentication and receiving-device setup, outside the permanent settings categories.

The entries share the signed-in account and service repository, with separate activity ViewModels. Administration never recovers or opens Inbox's SMS listener. Opening or closing either entry does not reset the other's navigation or drafts. Notifications open Inbox responses. Public registration, pairing, and connection links open the specific focused destination, passing through sign-in only when required; they never land on a mixed Access page. Keep the same task boundaries on iOS and the web using platform-appropriate controls.

Both lists refresh silently while their activity is visible, and refresh on resume. SMS discovery and administration refresh every 15 seconds; form discovery refreshes every 5 seconds. Existing FCM notifications continue when the UI is closed. Pull down beyond the top of either list for an immediate refresh, including an empty list. Only a user-initiated pull shows the refresh indicator. There are no Refresh buttons or status banners.

## Inbox

Inbox shows pending work only in one scrolling list: the active SMS request first, then pending forms in their existing order. Each entire row is tappable and spans the safe content width, with no enclosing card or outer horizontal gutter. Rows have 16dp internal horizontal padding and 12dp vertical padding. Caller, title, request type/status and expiry wrap naturally. Completed SMS outcomes live in Administration → History. A form's outcome remains in its response until closed and is not included in History.

Discovery never opens requests or starts SMS reception. The owner must explicitly open an SMS request to start listening. The toolbar contains only Inbox. Inbox has no history tab, history shortcut, completed-request feed, or history search. Setup and account controls live in Administration; an unconnected Inbox offers an Open Administration action. A connected empty inbox shows only “All caught up”.

## Administration

The management entry looks and navigates like Android Settings. Its landing page has a compact title, a visible **Search settings** widget, and category rows for Administration, Peering, and Account. Rows use an optional leading icon, a clear label, an optional short explanatory summary, and a navigation affordance. Each row opens a focused list, menu, or action page. Do not use the old Access/Devices/History segmented selector, dashboard cards, or one long form containing every category.

Child pages use a compact title and Back navigation. Navigation rows open child pages; switches only appear on pages dedicated to that setting. Object menus identify the selected agent or connection and list its available destinations without embedding their forms. Keep account controls out of device pages and pairing controls out of owned-agent creation pages.

History is reached through **Administration → History**. It lists metadata-only completed SMS outcomes across phones; codes and answers never appear here. A form's immediate outcome remains in its response until closed; this redesign does not add a new form-history backend.

Configuration has one 16dp horizontal content inset, 16dp section gaps and 8dp control gaps. Fields and primary actions fill the width. Switches occupy full-width rows. Sections have no nested rounded-card padding or oversized introductory heading. Device/account deletion retains explicit confirmation.

### Settings search

The landing page's Search settings widget searches all administrative settings destinations, including Peering and Account. Search is not a separate permanent category. Typing opens a focused results view with the query input, Clear, Back, and matching destination rows. Results show a setting label and its category breadcrumb, such as **History — Administration** or **Sign-in methods — Account**. Match labels and useful synonyms, including pairing/connection, phone/device, and app/agent. An empty query shows no result feed; an unmatched query shows a simple no-results state.

Selecting a result navigates to that setting. For object-specific operations such as changing a connection's permissions, first open the relevant selection list rather than choosing an object implicitly. Search never executes actions or bypasses approval, authentication, or confirmation. Search indexes settings labels and navigation metadata only, not codes, form answers, request history records, credentials, or session tickets. History can be found as a settings destination, not searched as request content. Search is absent from Inbox and request-response pages.

## Page inventory

Use the canonical [page and control inventory](ui/INVENTORY.md), [user flows and platform/agent matrix](ui/FLOWS.md), and [glossary](ui/GLOSSARY.md). These generated views link to each other by stable IDs, such as [LOGIN](ui/INVENTORY.md#login), [LOGIN-SUBMIT](ui/INVENTORY.md#login-submit), and [FLOW-LOGIN](ui/FLOWS.md#flow-login), rather than depending on display labels.

The source is [ui/contract.mjs](ui/contract.mjs); follow the [editing and validation guide](ui/README.md). Run `npm run docs:ui` after changing it, then `npm run check:ui` and `npm run test:ui`. The checker verifies every declared platform/agent scenario, references, outcomes, bounded waits, and escape paths, and rejects generated-document drift. CI requires these checks. It validates the declared design; actual app/provider behavior still needs runtime acceptance.

The inventory separates Administration (devices, owned agents, history), Peering (recipient connections and registration approval), Account, Initial Login, Requests, and explicit external boundaries. Native request-response pages are Android/iOS only; browser tasks hand off to a native phone when needed. The platform where a person approves is independent of where agent software executes. Scripts and terminal agents use private local profiles and explicit delivery consumption; hosted agent recipients use provider-managed OAuth without private ticket upload or local credential setup.

Do not duplicate the inventory in another unvalidated table. Keep current implementation notes distinct from the design target. A page/control rename must update affected flow references, glossary backlinks, generated documents, and relevant UI selectors/tests together.

## Responses and returning

Tapping an Inbox row keeps the feed visible while its request loads, with an inline opening indicator on that row. Navigation switches directly to the loaded response, without an intermediate loading or error page. Back abandons a pending navigation without cancelling the request; pending target metadata survives recreation.

A notification selects only its request response destination, including on cold launch. Its loading state is initialized before the first frame so an error appears only after an actual failed load. Request-specific setup, authentication, loading and retry states stay within that destination. Inbox and Administration do not appear behind these states. The target remains pending through registration or busy operations; repeated taps retry the target in the existing activity. A different request never displays the previous request's content while it loads.

Back and Close perform navigation only. On Android, a request opened from Inbox returns to Inbox; a notification response backgrounds the retained task, returning to the previous app. On iOS, pop the Inbox navigation stack or dismiss the notification response sheet. Neither action cancels the request, clears its draft nor stops active Android SMS reception. System Back closes the whole response, including a wizard; **Previous step** is the explicit wizard navigation control. Drafts remain in native ViewModel/model memory while the process lives. Saved activity/navigation state contains navigation and consent-launch metadata only, never codes or form answers. Process death starts a form again; existing platform-specific SMS process-recovery rules still apply. Browser has no request-response UI; its phone handoff and hosted OAuth return follow the [platform-specific flows](ui/FLOWS.md).

Response screens have 16dp content padding, full-width fields/actions, compact headers and no administration navigation. Requester identity and the requested action lead the hierarchy. Markdown, expiry, validation, wizard progress, terminal outcomes and competing-phone messages remain visible. The page scrolls with the keyboard and safe drawing insets.

SMS responses show the requester/title, Markdown explanation, code field, Send and explicit **Cancel request**. Android consent automatically submits a single extracted code; choosing among multiple candidates submits the chosen code. Manual entry requires Send. Declining Android message access still permits manual entry. A successful server-confirmed submission follows the entry's return behavior. Cancel retains its server meaning. Other terminal outcomes show their outcome until closed, including “Handled on another phone” without exposing a code.

iOS uses manual readiness and manual submission: type, deliberately paste, or select eligible system AutoFill, then tap Send. It does not read SMS automatically or emit Android consent/listener events. See [FLOW-SMS-IOS](ui/FLOWS.md#flow-sms-ios) and [the iOS implementation contract](IOS.md).

Forms use native text, number, checkbox, choice and date controls. Opening and autofilling never submit. Declared actions explicitly Submit/Approve/Decline/Acknowledge. Wizards validate each step, prune hidden branches, preserve answers during Previous/Next and show a final review before submission. A form's submitted/declined/expired outcome remains visible until closed. On Android, a form's SMS helper also continues after Close; reopening the request allows Android consent and review of the filled draft. iOS form SMS helpers use manual entry and never emit Android helper-readiness events.

## Visual direction

The domain is a private handoff: requester, explanation, permission, listening window, expiry, decision and receipt. The color world is paper, graphite, muted slate, teal and error red. The signature is the requester-bound response with its independent SMS listening window and origin-aware return. Full-width pending rows, independent administration and focused responses replace dashboard cards, nested tab areas and large welcome headings.

Intent: let the phone owner read and respond promptly, then return to their work. Hierarchy: caller and requested action lead; status and expiry are supporting text. Palette: retain the established Material light/dark semantic colors, with teal for primary actions and red for errors. Depth/surfaces: quiet tonal surfaces without decorative shadows or enclosing cards. Typography: native Android sans, title sizes and semibold identities, body text for explanations, muted labels for metadata, monospace for SMS values. Spacing: 4dp grid; Inbox 16/12dp row padding; Administration 16dp inset, 16dp sections and 8dp controls; responses 16dp inset/sections and 8–12dp controls. Touch targets remain at least 48dp.

Use native Material controls for focus, selection, dialogs and feedback. Support wrapping, large fonts, compact phone and landscape sizes, light/dark themes and keyboard visibility. Markdown uses local CommonMark rendering: HTML is inert and remote images/links do not fetch resources.

## Synthetic previews

The screenshots contain test data only and predate the settings hierarchy redesign. In particular, Administration previews with the Access/Devices/History selector are historical examples, not the target design. Update affected previews when implementing the corresponding redesign.

| View | Normal | 360×640dp, 1.3 text | Landscape | Dark |
| --- | --- | --- | --- | --- |
| Inbox | [Preview](images/inbox.png) | [Preview](images/inbox-compact.png) | [Preview](images/inbox-landscape.png) | [Preview](images/inbox-dark.png) |
| Administration | [Preview](images/administration.png) | [Preview](images/administration-compact.png) | [Preview](images/administration-landscape.png) | [Preview](images/administration-dark.png) |
| SMS response | [Preview](images/sms-response.png) | [Preview](images/sms-response-compact.png) | [Preview](images/sms-response-landscape.png) | [Preview](images/sms-response-dark.png) |

Verification scope and remaining physical acceptance cases are recorded in [VERIFICATION.md](VERIFICATION.md).

## Acceptance criteria for UI changes

- Each page has one identifiable task; every displayed detail and control supports it.
- Administrative navigation follows the settings hierarchy, with a visible search widget on its landing page and focused child pages. Search results navigate without executing actions.
- Administration owns History. Inbox and request responses expose neither historical feeds nor history navigation/search.
- Agent creation, ticket saving, public-link sharing, ownership approval, recipient connection approval, and existing connection edits retain their separate page boundaries.
- Device controls do not contain account management; account deletion is confined to its dedicated flow.
- Deep links and notifications reach their intended task, resume it after necessary authentication/setup, and preserve Inbox drafts and origin-aware return behavior.
- Relevant controls remain accessible with large fonts, keyboard, compact/landscape layouts, light/dark themes, and screen readers. Search has a visible label, clear/back controls, and understandable no-results behavior.
- Preserve existing request/consent semantics, explicit destructive confirmations, and secret-handling boundaries. Update affected navigation tests and previews for implemented changes; report remaining migration gaps instead of claiming the entire contract is already implemented.
