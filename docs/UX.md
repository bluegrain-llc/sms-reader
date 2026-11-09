# Phone approval interface

The app has three destinations in one activity: **Inbox**, **Settings**, and a focused **request response**. The existing ViewModels retain the signed-in session, code drafts, wizard answers and Android SMS listeners. Normal launcher entry opens Inbox. Settings Back returns to Inbox; connection links open Settings → Access. The notification-shade presentation and single launcher entry are unchanged.

## Inbox

Inbox shows pending work only in one scrolling list: the active SMS request first, then pending forms in their existing order. Each entire row is tappable and spans the safe content width, with no enclosing card or outer horizontal gutter. Rows have 16dp internal horizontal padding and 12dp vertical padding. Caller, title, request type/status and expiry wrap naturally. Completed outcomes live in Settings → History.

Refresh discovers requests without opening them, starting SMS reception or redirecting Settings. The owner must explicitly open an SMS request to start listening. The compact toolbar provides Refresh and Settings. Setup and account controls live in Settings; an unconnected Inbox offers an Open Settings action.

## Settings

A compact toolbar and Access/Devices/History selector stay above the scrolling configuration content. Access reviews connection links or comparison codes, approves/declines connections, controls interactive-request permission and revokes callers. Devices holds phone registration, availability, pause/resume, removal and account controls. History lists metadata-only outcomes across phones; codes and answers never appear here.

Configuration has one 12dp horizontal content inset, 16dp section gaps and 8dp control gaps. Fields and primary actions fill the width. Switches occupy full-width rows. Sections have no nested rounded-card padding or oversized introductory heading. Device/account deletion retains explicit confirmation.

## Responses and returning

A notification selects only its request response destination, including on cold launch. Request-specific setup, authentication, loading and retry states stay within that destination. Inbox and Settings do not appear behind these states. The target remains pending through registration or busy operations; repeated taps retry the target in the existing activity. A different request never displays the previous request's content while it loads.

Back and Close perform navigation only. A request opened from Inbox returns to Inbox. A request opened from a notification backgrounds the retained task, returning to the previous app. Neither action cancels the request, clears its draft nor stops active SMS reception. System Back closes the whole response, including a wizard; **Previous step** is the explicit wizard navigation control. Drafts remain in ViewModel memory while the process lives. Saved activity state contains navigation and consent-launch metadata only, never codes or form answers. Process death starts a form again; existing SMS process-recovery rules still apply.

Response screens have 16dp content padding, full-width fields/actions, compact headers and no configuration navigation. Requester identity and the requested action lead the hierarchy. Markdown, expiry, validation, wizard progress, terminal outcomes and competing-phone messages remain visible. The page scrolls with the keyboard and safe drawing insets.

SMS responses show the requester/title, Markdown explanation, code field, Send and explicit **Cancel request**. Android consent automatically submits a single extracted code; choosing among multiple candidates submits the chosen code. Manual entry requires Send. Declining Android message access still permits manual entry. A successful server-confirmed submission follows the entry's return behavior. Cancel retains its server meaning. Other terminal outcomes show their outcome until closed, including “Handled on another phone” without exposing a code.

Forms use native text, number, checkbox, choice and date controls. Opening and autofilling never submit. Declared actions explicitly Submit/Approve/Decline/Acknowledge. Wizards validate each step, prune hidden branches, preserve answers during Previous/Next and show a final review before submission. A form's submitted/declined/expired outcome remains visible until closed. A form's SMS helper also continues after Close; reopening the request allows Android consent and review of the filled draft.

## Visual direction

The domain is a private handoff: requester, explanation, permission, listening window, expiry, decision and receipt. The color world is paper, graphite, muted slate, teal and error red. The signature is the requester-bound response with its independent SMS listening window and origin-aware return. Full-width pending rows, compact configuration and focused responses replace dashboard cards, nested tab areas and large welcome headings.

Intent: let the phone owner read and respond promptly, then return to their work. Hierarchy: caller and requested action lead; status and expiry are supporting text. Palette: retain the established Material light/dark semantic colors, with teal for primary actions and red for errors. Depth/surfaces: quiet tonal surfaces without decorative shadows or enclosing cards. Typography: native Android sans, title sizes and semibold identities, body text for explanations, muted labels for metadata, monospace for SMS values. Spacing: 4dp grid; Inbox 16/12dp row padding; Settings 12dp inset, 16dp sections and 8dp controls; responses 16dp inset/sections and 8–12dp controls. Touch targets remain at least 48dp.

Use native Material controls for focus, selection, dialogs and feedback. Support wrapping, large fonts, compact phone and landscape sizes, light/dark themes and keyboard visibility. Markdown uses local CommonMark rendering: HTML is inert and remote images/links do not fetch resources.

## Synthetic previews

The screenshots contain test data only.

| View | Normal | 360×640dp, 1.3 text | Landscape | Dark |
| --- | --- | --- | --- | --- |
| Inbox | [Preview](images/inbox.png) | [Preview](images/inbox-compact.png) | [Preview](images/inbox-landscape.png) | [Preview](images/inbox-dark.png) |
| Settings | [Preview](images/settings.png) | [Preview](images/settings-compact.png) | [Preview](images/settings-landscape.png) | [Preview](images/settings-dark.png) |
| SMS response | [Preview](images/sms-response.png) | [Preview](images/sms-response-compact.png) | [Preview](images/sms-response-landscape.png) | [Preview](images/sms-response-dark.png) |

Verification scope and remaining physical acceptance cases are recorded in [VERIFICATION.md](VERIFICATION.md).
