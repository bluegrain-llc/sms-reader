# Phone approval interface

One APK provides two independent launcher entries and Android tasks: **Inbox** and **Administration**, with different names and icons. Inbox owns request navigation, drafts and SMS listeners. Administration owns connection review, access, devices, history and account controls. They share the signed-in account and service repository, with separate activity ViewModels. Administration never recovers or opens Inbox's SMS listener. Opening or closing either entry does not reset the other's navigation or drafts. Notifications open Inbox responses; connection links open Administration → Access directly.

Both lists refresh silently while their activity is visible, and refresh on resume. SMS discovery and administration refresh every 15 seconds; form discovery refreshes every 5 seconds. Existing FCM notifications continue when the UI is closed. Pull down beyond the top of either list for an immediate refresh, including an empty list. Only a user-initiated pull shows the refresh indicator. There are no Refresh buttons or status banners.

## Inbox

Inbox shows pending work only in one scrolling list: the active SMS request first, then pending forms in their existing order. Each entire row is tappable and spans the safe content width, with no enclosing card or outer horizontal gutter. Rows have 16dp internal horizontal padding and 12dp vertical padding. Caller, title, request type/status and expiry wrap naturally. Completed SMS outcomes live in Administration → History. A form's outcome remains in its response until closed and is not included in History.

Discovery never opens requests or starts SMS reception. The owner must explicitly open an SMS request to start listening. The toolbar contains only Inbox. Setup and account controls live in Administration; an unconnected Inbox offers an Open Administration action. A connected empty inbox shows only “All caught up”.

## Administration

The Administration title and Access/Devices/History selector stay above the scrolling configuration content. Access reviews connection links or comparison codes, approves/declines connections, controls interactive-request permission and revokes callers. Devices holds phone registration, availability, pause/resume, removal and account controls. History lists metadata-only SMS outcomes across phones; codes and answers never appear here.

Configuration has one 16dp horizontal content inset, 16dp section gaps and 8dp control gaps. Fields and primary actions fill the width. Switches occupy full-width rows. Sections have no nested rounded-card padding or oversized introductory heading. Device/account deletion retains explicit confirmation.

## Responses and returning

Tapping an Inbox row keeps the feed visible while its request loads, with an inline opening indicator on that row. Navigation switches directly to the loaded response, without an intermediate loading or error page. Back abandons a pending navigation without cancelling the request; pending target metadata survives recreation.

A notification selects only its request response destination, including on cold launch. Its loading state is initialized before the first frame so an error appears only after an actual failed load. Request-specific setup, authentication, loading and retry states stay within that destination. Inbox and Administration do not appear behind these states. The target remains pending through registration or busy operations; repeated taps retry the target in the existing activity. A different request never displays the previous request's content while it loads.

Back and Close perform navigation only. A request opened from Inbox returns to Inbox. A request opened from a notification backgrounds the retained task, returning to the previous app. Neither action cancels the request, clears its draft nor stops active SMS reception. System Back closes the whole response, including a wizard; **Previous step** is the explicit wizard navigation control. Drafts remain in ViewModel memory while the process lives. Saved activity state contains navigation and consent-launch metadata only, never codes or form answers. Process death starts a form again; existing SMS process-recovery rules still apply.

Response screens have 16dp content padding, full-width fields/actions, compact headers and no administration navigation. Requester identity and the requested action lead the hierarchy. Markdown, expiry, validation, wizard progress, terminal outcomes and competing-phone messages remain visible. The page scrolls with the keyboard and safe drawing insets.

SMS responses show the requester/title, Markdown explanation, code field, Send and explicit **Cancel request**. Android consent automatically submits a single extracted code; choosing among multiple candidates submits the chosen code. Manual entry requires Send. Declining Android message access still permits manual entry. A successful server-confirmed submission follows the entry's return behavior. Cancel retains its server meaning. Other terminal outcomes show their outcome until closed, including “Handled on another phone” without exposing a code.

Forms use native text, number, checkbox, choice and date controls. Opening and autofilling never submit. Declared actions explicitly Submit/Approve/Decline/Acknowledge. Wizards validate each step, prune hidden branches, preserve answers during Previous/Next and show a final review before submission. A form's submitted/declined/expired outcome remains visible until closed. A form's SMS helper also continues after Close; reopening the request allows Android consent and review of the filled draft.

## Visual direction

The domain is a private handoff: requester, explanation, permission, listening window, expiry, decision and receipt. The color world is paper, graphite, muted slate, teal and error red. The signature is the requester-bound response with its independent SMS listening window and origin-aware return. Full-width pending rows, independent administration and focused responses replace dashboard cards, nested tab areas and large welcome headings.

Intent: let the phone owner read and respond promptly, then return to their work. Hierarchy: caller and requested action lead; status and expiry are supporting text. Palette: retain the established Material light/dark semantic colors, with teal for primary actions and red for errors. Depth/surfaces: quiet tonal surfaces without decorative shadows or enclosing cards. Typography: native Android sans, title sizes and semibold identities, body text for explanations, muted labels for metadata, monospace for SMS values. Spacing: 4dp grid; Inbox 16/12dp row padding; Administration 16dp inset, 16dp sections and 8dp controls; responses 16dp inset/sections and 8–12dp controls. Touch targets remain at least 48dp.

Use native Material controls for focus, selection, dialogs and feedback. Support wrapping, large fonts, compact phone and landscape sizes, light/dark themes and keyboard visibility. Markdown uses local CommonMark rendering: HTML is inert and remote images/links do not fetch resources.

## Synthetic previews

The screenshots contain test data only.

| View | Normal | 360×640dp, 1.3 text | Landscape | Dark |
| --- | --- | --- | --- | --- |
| Inbox | [Preview](images/inbox.png) | [Preview](images/inbox-compact.png) | [Preview](images/inbox-landscape.png) | [Preview](images/inbox-dark.png) |
| Administration | [Preview](images/administration.png) | [Preview](images/administration-compact.png) | [Preview](images/administration-landscape.png) | [Preview](images/administration-dark.png) |
| SMS response | [Preview](images/sms-response.png) | [Preview](images/sms-response-compact.png) | [Preview](images/sms-response-landscape.png) | [Preview](images/sms-response-dark.png) |

Verification scope and remaining physical acceptance cases are recorded in [VERIFICATION.md](VERIFICATION.md).
