# User flows and platform differences

Generated from [contract.mjs](contract.mjs). Edit the source and run `npm run docs:ui`; `npm run check:ui` rejects stale views.

Design target, including administrative browser parity still to be implemented. Graph validation proves consistency of the declared design, not the behavior of shipped apps or third-party providers.

See [UI contract](../UX.md), [guide and validation](README.md), [flows and platform matrix](FLOWS.md), [inventory](INVENTORY.md), and [glossary](GLOSSARY.md). IDs are stable; labels may change.

The platform is where the person approves or manages the relay, not the machine running agent software. A TUI/CLI on a laptop can be approved on Android, iOS, or a browser. Preconditions explicitly reference prior tasks; continuation links explain related tasks, not an automatic grant. Initial login never approves a pending task. Every transition below is checked separately for each declared platform/agent pair.

## ANDROID

**Android.** Independent Inbox and Administration launcher tasks. Verified HTTPS App Links; scan public QR links with the system camera. SMS User Consent can submit a single extracted candidate, or a selected candidate; manual entry remains available. Notification setup uses Android permission/channel settings.

Repository evidence: [docs/UX.md](../UX.md), [docs/ONBOARDING.md](../ONBOARDING.md).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator), [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SEARCH](FLOWS.md#flow-search), [FLOW-HISTORY](FLOWS.md#flow-history), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

## IOS

**iOS.** Separate navigation stacks/sheets retain drafts. Universal Links and the existing QR scanner open focused approval. SMS is manual entry, deliberate paste, or eligible system AutoFill followed by Send; never Android consent or automatic SMS reading. APNs/notification setup registers the receiving device.

Repository evidence: [docs/IOS.md](../IOS.md).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator), [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SEARCH](FLOWS.md#flow-search), [FLOW-HISTORY](FLOWS.md#flow-history), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

## BROWSER

**Browser.** Supports sign-in, approval, OAuth return, ticket download, and administrative pages. Full settings hierarchy/search/device/history parity is a design target, not a claim about existing routes. No browser Inbox, receiving-device registration, SMS listener, or request-response UI: hand off to Android/iOS. No phone is required merely to own/manage an agent.

Repository evidence: [docs/ONBOARDING.md](../ONBOARDING.md), [integrations/README.md](../../integrations/README.md).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator), [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-SEARCH](FLOWS.md#flow-search), [FLOW-HISTORY](FLOWS.md#flow-history), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

## NONE

**Agent type not relevant.** Owner-side tasks that do not require selecting or knowing the requesting agent runtime, including account/device/settings work. An incoming request still always identifies its requester.

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SEARCH](FLOWS.md#flow-search), [FLOW-HISTORY](FLOWS.md#flow-history), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing).

## SCRIPT

**Script or backend application.** Software manages a private CLI/SDK profile, service credential, delivery keys, and recipient credentials. REST or MCP requests use only the selected connection. Registration/delivery operations stay outside model tools.

Repository evidence: [cli/relay.mjs](../../cli/relay.mjs), [sdks/README.md](../../sdks/README.md).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

## TUI

**Terminal coding agent.** For a coding agent such as Codex, software configures relay-mcp --profile NAME --connection ID. The terminal presents public approval links and setup status; private ticket import and credential storage happen outside prompts and model tool results. Host-specific configuration menus are outside this contract.

Repository evidence: [cli/mcp.mjs](../../cli/mcp.mjs), [docs/ONBOARDING.md](../ONBOARDING.md).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator), [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

## HOSTED

**Hosted browser agent.** For a browser agent such as ChatGPT, the operator supplies the public named-service remote MCP URL. The user authorizes through the provider and relay OAuth flow. The provider holds OAuth credentials; no local CLI profile, ticket upload into chat, or direct recipient bearer token is required for the recipient.

Repository evidence: [integrations/README.md](../../integrations/README.md), [docs/ONBOARDING.md](../ONBOARDING.md).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing).

## Flow index

| Flow | Typical task | Approval/management platforms | Agent types |
| --- | --- | --- | --- |
| [FLOW-LOGIN](FLOWS.md#flow-login) | Sign in and resume the intended task | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-PHONE](FLOWS.md#flow-phone) | Set up a receiving phone | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone) | Continue a phone-only task from the browser | [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) | Create an agent and save its private ticket | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket) | Import a ticket into script or terminal-agent software | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui) |
| [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent) | Register an agent from script or terminal software | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui) |
| [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect) | Connect a script or terminal agent to a recipient | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui) |
| [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation) | Open a public invitation manually | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) | Connect a hosted browser agent such as ChatGPT | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [HOSTED](FLOWS.md#hosted) |
| [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator) | Produce a public hosted endpoint as an operator | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui) |
| [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools) | Enable relay tools in a terminal coding agent | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [TUI](FLOWS.md#tui) |
| [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request) | Send a request from agent software and retrieve the result | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms) | Open an SMS response directly from a notification | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form) | Open a form directly from a notification | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android) | Respond to an SMS request on Android | [ANDROID](FLOWS.md#android) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios) | Respond to an SMS request on iOS | [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-FORM](FLOWS.md#flow-form) | Answer a form or decision request | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-WIZARD](FLOWS.md#flow-wizard) | Complete a multi-step form | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request) | Explicitly cancel an SMS request | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form) | Decline a form when declared | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome) | Leave an expired or handled-elsewhere response | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-SEARCH](FLOWS.md#flow-search) | Find an administrative setting | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-HISTORY](FLOWS.md#flow-history) | Review completed SMS outcomes | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception) | Pause or resume a receiving device | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device) | Remove a receiving device | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-PERMISSIONS](FLOWS.md#flow-permissions) | Change one connection permission set | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-EXPIRY](FLOWS.md#flow-expiry) | Change one connection expiry | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-DISCONNECT](FLOWS.md#flow-disconnect) | Disconnect one agent from this recipient | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-SHARE](FLOWS.md#flow-share) | Share a public agent connection link | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability) | Disable or re-enable an owned agent | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete) | Delete an owned agent | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear) | Clear a retained ticket after safe export | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider) | Link a second sign-in provider | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-SIGNOUT](FLOWS.md#flow-signout) | Sign out of the current installation | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account) | Delete the relay account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none) |
| [FLOW-PRIVACY](FLOWS.md#flow-privacy) | Read privacy information | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing) | Decline an agent access request | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted) |
| [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration) | Decline agent ownership registration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) | [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui) |

## FLOW-LOGIN

**Sign in and resume the intended task.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: A public destination or launcher task is retained; a provider is configured.

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner), [TERM-RETURN](GLOSSARY.md#term-return).

Start at [login](#flow-login-login).

<a id="flow-login-login"></a>

### login

[LOGIN](INVENTORY.md#login) → [LOGIN-SUBMIT](INVENTORY.md#login-submit): Choose Google or Apple, authenticate, and return to the retained task without approving it.

Other controls: [LOGIN-PROVIDER](INVENTORY.md#login-provider), [LOGIN-BACK](INVENTORY.md#login-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-login-done) | Continue after confirmed success. |
| denied | [login](#flow-login-login) | Remain at sign-in; retry the configured provider or close. A different account must re-evaluate session ownership. |
| failure | [login](#flow-login-login) | Remain at sign-in; retry the configured provider or close. A different account must re-evaluate session ownership. |
| cancelled | [cancelled](#flow-login-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-login-done"></a>

### done

**success.** The intended account is authenticated; the original task resumes without submitting any decision.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-login-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-PHONE

**Set up a receiving phone.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Signed in through [FLOW-LOGIN](FLOWS.md#flow-login). Registration is needed only when no suitable device can receive.

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device), [TERM-RETURN](GLOSSARY.md#term-return).

Start at [permission](#flow-phone-permission).

<a id="flow-phone-permission"></a>

### permission

[PHONE-NOTIFICATIONS](INVENTORY.md#phone-notifications) → [PHONE-NOTIFICATIONS-SUBMIT](INVENTORY.md#phone-notifications-submit): Enable notifications for this installation.

Other controls: [PHONE-NOTIFICATIONS-BACK](INVENTORY.md#phone-notifications-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [register](#flow-phone-register) | Continue after confirmed success. |
| denied | [settings](#flow-phone-settings) | Permission is denied; explicitly open OS settings or leave. |
| failure | [permission](#flow-phone-permission) | Permission denied or channels disabled: open system settings, return, and recheck; otherwise close. |
| cancelled | [cancelled](#flow-phone-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-phone-settings"></a>

### settings

[PHONE-NOTIFICATIONS](INVENTORY.md#phone-notifications) → [PHONE-NOTIFICATIONS-SETTINGS](INVENTORY.md#phone-notifications-settings): Enable the notification permission/channel in OS settings, then return.

Other controls: [PHONE-NOTIFICATIONS-BACK](INVENTORY.md#phone-notifications-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [permission](#flow-phone-permission) | Continue after confirmed success. |
| denied | [settings](#flow-phone-settings) | If notifications remain unavailable, explain the missing prerequisite and allow Close. |
| failure | [settings](#flow-phone-settings) | If notifications remain unavailable, explain the missing prerequisite and allow Close. |
| cancelled | [cancelled](#flow-phone-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-phone-register"></a>

### register

[PHONE-REGISTER](INVENTORY.md#phone-register) → [PHONE-REGISTER-SUBMIT](INVENTORY.md#phone-register-submit): Register this phone for the signed-in account; resume the invoking task.

Other controls: [PHONE-REGISTER-BACK](INVENTORY.md#phone-register-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-phone-done) | Continue after confirmed success. |
| invalid | [register](#flow-phone-register) | Keep the setup task; retry registration after notification/network/account recovery or close. |
| failure | [register](#flow-phone-register) | Keep the setup task; retry registration after notification/network/account recovery or close. |
| cancelled | [cancelled](#flow-phone-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-phone-done"></a>

### done

**success.** A suitable native receiving device is registered. Browser ownership tasks do not require this flow.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-phone-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-BROWSER-PHONE

**Continue a phone-only task from the browser.** Platforms: [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: The browser has a public task link or a receiving-device setup requirement.

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device), [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link). Related/continuing tasks: [FLOW-PHONE](FLOWS.md#flow-phone).

Start at [handoff](#flow-browser-phone-handoff).

<a id="flow-browser-phone-handoff"></a>

### handoff

[PHONE-HANDOFF](INVENTORY.md#phone-handoff) → [PHONE-HANDOFF-OPEN](INVENTORY.md#phone-handoff-open): Open the installed Android/iOS app, or install from configured operator guidance and reopen the public link with the same account.

Other controls: [PHONE-HANDOFF-BACK](INVENTORY.md#phone-handoff-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [check](#flow-browser-phone-check) | Continue after confirmed success. |
| denied | [handoff](#flow-browser-phone-handoff) | If install links or a suitable phone are unavailable, preserve the public destination and close; never request a browser SMS permission. |
| failure | [handoff](#flow-browser-phone-handoff) | If install links or a suitable phone are unavailable, preserve the public destination and close; never request a browser SMS permission. |
| cancelled | [cancelled](#flow-browser-phone-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-browser-phone-check"></a>

### check

[PHONE-HANDOFF](INVENTORY.md#phone-handoff) → [PHONE-HANDOFF-CHECK](INVENTORY.md#phone-handoff-check): On the phone complete [FLOW-PHONE](FLOWS.md#flow-phone) if needed; return here to check account-wide receiving readiness.

Other controls: [PHONE-HANDOFF-BACK](INVENTORY.md#phone-handoff-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-browser-phone-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-browser-phone-cancelled) | Not ready/offline: keep the link and retry checking, or close. An expired approval must be reopened as a fresh attempt. |
| revoked | [cancelled](#flow-browser-phone-cancelled) | Not ready/offline: keep the link and retry checking, or close. An expired approval must be reopened as a fresh attempt. |
| failure | [check](#flow-browser-phone-check) | Not ready/offline: keep the link and retry checking, or close. An expired approval must be reopened as a fresh attempt. |
| cancelled | [cancelled](#flow-browser-phone-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-browser-phone-done"></a>

### done

**success.** The browser confirms a suitable receiving device or the user explicitly leaves with the public continuation link.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-browser-phone-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-CREATE-AGENT

**Create an agent and save its private ticket.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Signed in; open Administration → My agents → Create agent.

Glossary: [TERM-REGISTRATION](GLOSSARY.md#term-registration), [TERM-TICKET](GLOSSARY.md#term-ticket). Related/continuing tasks: [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect).

Start at [create](#flow-create-agent-create).

<a id="flow-create-agent-create"></a>

### create

[AGENT-CREATE](INVENTORY.md#agent-create) → [AGENT-CREATE-SUBMIT](INVENTORY.md#agent-create-submit): Enter name, description, and declared capabilities; create the owned agent.

Other controls: [AGENT-CREATE-NAME](INVENTORY.md#agent-create-name), [AGENT-CREATE-DESCRIPTION](INVENTORY.md#agent-create-description), [AGENT-CREATE-CAPABILITIES](INVENTORY.md#agent-create-capabilities), [AGENT-CREATE-BACK](INVENTORY.md#agent-create-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [save](#flow-create-agent-save) | Continue after confirmed success. |
| invalid | [create](#flow-create-agent-create) | Correct invalid fields; retry identical retained provisioning state after uncertain creation rather than creating another agent. |
| failure | [create](#flow-create-agent-create) | Correct invalid fields; retry identical retained provisioning state after uncertain creation rather than creating another agent. |
| cancelled | [cancelled](#flow-create-agent-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-create-agent-save"></a>

### save

[AGENT-TICKET](INVENTORY.md#agent-ticket) → [AGENT-TICKET-SAVE](INVENTORY.md#agent-ticket-save): Save the private ticket using Android documents, iOS file export, or browser download. Confirm the file exists before clearing anything.

Other controls: [AGENT-TICKET-BACK](INVENTORY.md#agent-ticket-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-create-agent-done) | Continue after confirmed success. |
| denied | [save](#flow-create-agent-save) | Retain provisioning state if the picker is cancelled, download fails, or saving is uncertain; retry Save. Do not clear private keys. |
| failure | [save](#flow-create-agent-save) | Retain provisioning state if the picker is cancelled, download fails, or saving is uncertain; retry Save. Do not clear private keys. |
| cancelled | [cancelled](#flow-create-agent-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-create-agent-done"></a>

### done

**success.** An owned agent and safely saved private ticket exist; no recipient access was granted.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-create-agent-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-IMPORT-TICKET

**Import a ticket into script or terminal-agent software.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui).

Before starting: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) completed; the file is transferred privately to the software host.

Glossary: [TERM-TICKET](GLOSSARY.md#term-ticket), [TERM-PROFILE](GLOSSARY.md#term-profile). Related/continuing tasks: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect).

Start at [import](#flow-import-ticket-import).

<a id="flow-import-ticket-import"></a>

### import

[AGENT-CLI](INVENTORY.md#agent-cli) → [AGENT-CLI-IMPORT](INVENTORY.md#agent-cli-import): Run relay service import-ticket --file /private/agent-ticket.json --profile NAME outside chats/model tools.

Other controls: [AGENT-CLI-BACK](INVENTORY.md#agent-cli-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-import-ticket-done) | Continue after confirmed success. |
| failure | [import](#flow-import-ticket-import) | Use an unused profile. A stale credential/key requires an up-to-date export; never overwrite another profile or paste the ticket into chat. |
| cancelled | [cancelled](#flow-import-ticket-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-import-ticket-done"></a>

### done

**success.** Agent software durably owns its private configuration; recipient connection approval is still required.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-import-ticket-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-REGISTER-AGENT

**Register an agent from script or terminal software.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui).

Before starting: Choose a private profile and relay; registration software runs on its own host, independently of approval platform.

Glossary: [TERM-REGISTRATION](GLOSSARY.md#term-registration), [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link), [TERM-PROFILE](GLOSSARY.md#term-profile). Related/continuing tasks: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect).

Start at [start](#flow-register-agent-start).

<a id="flow-register-agent-start"></a>

### start

[AGENT-CLI](INVENTORY.md#agent-cli) → [AGENT-CLI-REGISTER](INVENTORY.md#agent-cli-register): Run relay service register --profile NAME --name NAME --relay https://RELAY; open its public Register agent link/QR.

Other controls: [AGENT-CLI-BACK](INVENTORY.md#agent-cli-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [approve](#flow-register-agent-approve) | Continue after confirmed success. |
| failure | [start](#flow-register-agent-start) | Retry with retained profile via relay resume; occupied profiles require another name. Never expose private credentials. |
| cancelled | [cancelled](#flow-register-agent-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-register-agent-approve"></a>

### approve

[REGISTER-APPROVAL](INVENTORY.md#register-approval) → [REGISTER-APPROVAL-SUBMIT](INVENTORY.md#register-approval-submit): Use [FLOW-LOGIN](FLOWS.md#flow-login) if needed; review the declaration and account, then approve ownership only.

Other controls: [REGISTER-APPROVAL-BACK](INVENTORY.md#register-approval-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [resume](#flow-register-agent-resume) | Continue after confirmed success. |
| invalid | [approve](#flow-register-agent-approve) | A denied/expired/account-bound session cannot be reused to gain ownership; request a fresh registration link or close. |
| failure | [approve](#flow-register-agent-approve) | A denied/expired/account-bound session cannot be reused to gain ownership; request a fresh registration link or close. |
| cancelled | [cancelled](#flow-register-agent-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-register-agent-resume"></a>

### resume

[AGENT-CLI](INVENTORY.md#agent-cli) → [AGENT-CLI-RESUME](INVENTORY.md#agent-cli-resume): Return to software; let registration finish or run relay resume after interruption.

Other controls: [AGENT-CLI-BACK](INVENTORY.md#agent-cli-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-register-agent-done) | Continue after confirmed success. |
| failure | [resume](#flow-register-agent-resume) | Reconcile retained registration state; retry or stop without deleting private provisioning state. |
| cancelled | [cancelled](#flow-register-agent-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-register-agent-done"></a>

### done

**success.** Registration is saved in the private profile. Connect separately, including to your own account.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-register-agent-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DIRECT-CONNECT

**Connect a script or terminal agent to a recipient.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui).

Before starting: Registered/imported private profile; recipient can authenticate. Another suitable receiving phone may already exist.

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-PROFILE](GLOSSARY.md#term-profile), [TERM-DEVICE](GLOSSARY.md#term-device). Related/continuing tasks: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools).

Start at [start](#flow-direct-connect-start).

<a id="flow-direct-connect-start"></a>

### start

[AGENT-CLI](INVENTORY.md#agent-cli) → [AGENT-CLI-CONNECT](INVENTORY.md#agent-cli-connect): Run relay service connect --profile NAME; open the public link or scan its QR on the approval platform.

Other controls: [AGENT-CLI-BACK](INVENTORY.md#agent-cli-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [review](#flow-direct-connect-review) | Continue after confirmed success. |
| failure | [start](#flow-direct-connect-start) | Use relay resume for transient interruption; an expired session needs explicit relay service connect --new-session. |
| cancelled | [cancelled](#flow-direct-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-direct-connect-review"></a>

### review

[PAIR-REVIEW](INVENTORY.md#pair-review) → [PAIR-REVIEW-SUBMIT](INVENTORY.md#pair-review-submit): Sign in if needed, verify account and comparison code, narrow capabilities/duration, and press Connect.

Other controls: [PAIR-REVIEW-CAPABILITIES](INVENTORY.md#pair-review-capabilities), [PAIR-REVIEW-DURATION](INVENTORY.md#pair-review-duration), [PAIR-REVIEW-BACK](INVENTORY.md#pair-review-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [delivery](#flow-direct-connect-delivery) | Continue after confirmed success. |
| invalid | [review](#flow-direct-connect-review) | Do not approve mismatched codes or accounts. Recover transient failures in the same session; expired attempts require a new link. |
| failure | [review](#flow-direct-connect-review) | Do not approve mismatched codes or accounts. Recover transient failures in the same session; expired attempts require a new link. |
| cancelled | [cancelled](#flow-direct-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-direct-connect-delivery"></a>

### delivery

[AGENT-CLI](INVENTORY.md#agent-cli) → [AGENT-CLI-DELIVERIES](INVENTORY.md#agent-cli-deliveries): Return to software; consume deliveries or run relay service deliveries --profile NAME. Save credentials durably before acknowledgement.

Other controls: [AGENT-CLI-BACK](INVENTORY.md#agent-cli-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [progress](#flow-direct-connect-progress) | Continue after confirmed success. |
| timeout | [cancelled](#flow-direct-connect-cancelled) | Retry relay resume without losing private keys. On timeout/expired delivery request a fresh approval; do not report ready based on approval alone. |
| revoked | [cancelled](#flow-direct-connect-cancelled) | Retry relay resume without losing private keys. On timeout/expired delivery request a fresh approval; do not report ready based on approval alone. |
| failure | [delivery](#flow-direct-connect-delivery) | Retry relay resume without losing private keys. On timeout/expired delivery request a fresh approval; do not report ready based on approval alone. |
| cancelled | [cancelled](#flow-direct-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-direct-connect-progress"></a>

### progress

[PAIR-PROGRESS](INVENTORY.md#pair-progress) → [PAIR-PROGRESS-WAIT](INVENTORY.md#pair-progress-wait): Check grant/delivery and receiving-device readiness. If a phone is missing, use the platform-specific phone setup flow.

Other controls: [PAIR-PROGRESS-BACK](INVENTORY.md#pair-progress-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-direct-connect-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-direct-connect-cancelled) | Recover pending delivery on the software host; set up or resume a phone if missing. If access was revoked, start a new explicit approval. |
| revoked | [cancelled](#flow-direct-connect-cancelled) | Recover pending delivery on the software host; set up or resume a phone if missing. If access was revoked, start a new explicit approval. |
| failure | [progress](#flow-direct-connect-progress) | Recover pending delivery on the software host; set up or resume a phone if missing. If access was revoked, start a new explicit approval. |
| cancelled | [cancelled](#flow-direct-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-direct-connect-done"></a>

### done

**success.** The selected recipient connection is usable by software, or the user deliberately stops with retained setup state.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-direct-connect-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-OPEN-INVITATION

**Open a public invitation manually.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: An agent supplies a public invitation link/code; legacy code entry is secondary to opening links.

Glossary: [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link), [TERM-CONNECTION](GLOSSARY.md#term-connection). Related/continuing tasks: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect).

Start at [open](#flow-open-invitation-open).

<a id="flow-open-invitation-open"></a>

### open

[INVITATION](INVENTORY.md#invitation) → [INVITATION-OPEN](INVENTORY.md#invitation-open): Open Peering → Open invitation, enter the public link/code, and review it.

Other controls: [INVITATION-VALUE](INVENTORY.md#invitation-value), [INVITATION-BACK](INVENTORY.md#invitation-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [review](#flow-open-invitation-review) | Continue after confirmed success. |
| invalid | [open](#flow-open-invitation-open) | Reject an invalid host/path/code. Ask the agent for a fresh link when expired; remain here or close. |
| failure | [open](#flow-open-invitation-open) | Reject an invalid host/path/code. Ask the agent for a fresh link when expired; remain here or close. |
| cancelled | [cancelled](#flow-open-invitation-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-open-invitation-review"></a>

### review

[PAIR-REVIEW](INVENTORY.md#pair-review) → [PAIR-REVIEW-SUBMIT](INVENTORY.md#pair-review-submit): Verify account, requester, comparison code if present, capabilities, and duration; Connect.

Other controls: [PAIR-REVIEW-CAPABILITIES](INVENTORY.md#pair-review-capabilities), [PAIR-REVIEW-DURATION](INVENTORY.md#pair-review-duration), [PAIR-REVIEW-BACK](INVENTORY.md#pair-review-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-open-invitation-done) | Continue after confirmed success. |
| invalid | [review](#flow-open-invitation-review) | Retry the same valid session or leave; never approve on opening alone. |
| failure | [review](#flow-open-invitation-review) | Retry the same valid session or leave; never approve on opening alone. |
| cancelled | [cancelled](#flow-open-invitation-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-open-invitation-done"></a>

### done

**success.** The invitation was explicitly approved; finish using the agent-specific direct-delivery or hosted-return flow.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-open-invitation-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-HOSTED-CONNECT

**Connect a hosted browser agent such as ChatGPT.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [HOSTED](FLOWS.md#hosted).

Before starting: The operator has a registered named service and supplies its public remote MCP endpoint. The recipient provider supports and permits remote MCP/OAuth.

Glossary: [TERM-OAUTH](GLOSSARY.md#term-oauth), [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link). Related/continuing tasks: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone).

Start at [configure](#flow-hosted-connect-configure).

<a id="flow-hosted-connect-configure"></a>

### configure

[HOSTED-CLIENT](INVENTORY.md#hosted-client) → [HOSTED-CLIENT-CONFIGURE](INVENTORY.md#hosted-client-configure): Use the public https://RELAY/mcp/services/SERVICE_ID endpoint in the provider remote connection UI; do not upload a private ticket into chat.

Other controls: [HOSTED-CLIENT-BACK](INVENTORY.md#hosted-client-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [authorize](#flow-hosted-connect-authorize) | Continue after confirmed success. |
| denied | [configure](#flow-hosted-connect-configure) | If account/plan/provider policy hides or rejects remote connections, explain that limitation and stop; no relay setting can bypass it. |
| failure | [configure](#flow-hosted-connect-configure) | If account/plan/provider policy hides or rejects remote connections, explain that limitation and stop; no relay setting can bypass it. |
| cancelled | [cancelled](#flow-hosted-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-hosted-connect-authorize"></a>

### authorize

[HOSTED-CLIENT](INVENTORY.md#hosted-client) → [HOSTED-CLIENT-AUTHORIZE](INVENTORY.md#hosted-client-authorize): Start provider authorization; follow the relay consent link in browser, or its public phone handoff.

Other controls: [HOSTED-CLIENT-BACK](INVENTORY.md#hosted-client-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [review](#flow-hosted-connect-review) | Continue after confirmed success. |
| denied | [authorize](#flow-hosted-connect-authorize) | Retry provider authorization or leave. Preserve only the public consent destination, never callback tokens in prompts. |
| failure | [authorize](#flow-hosted-connect-authorize) | Retry provider authorization or leave. Preserve only the public consent destination, never callback tokens in prompts. |
| cancelled | [cancelled](#flow-hosted-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-hosted-connect-review"></a>

### review

[PAIR-REVIEW](INVENTORY.md#pair-review) → [PAIR-REVIEW-SUBMIT](INVENTORY.md#pair-review-submit): Authenticate the recipient, review both service and requesting client, narrow access, and press Connect once.

Other controls: [PAIR-REVIEW-CAPABILITIES](INVENTORY.md#pair-review-capabilities), [PAIR-REVIEW-DURATION](INVENTORY.md#pair-review-duration), [PAIR-REVIEW-BACK](INVENTORY.md#pair-review-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [return](#flow-hosted-connect-return) | Continue after confirmed success. |
| invalid | [review](#flow-hosted-connect-review) | Cancel on wrong identity/client. Expired attempts require restarting authorization from the provider. |
| failure | [review](#flow-hosted-connect-review) | Cancel on wrong identity/client. Expired attempts require restarting authorization from the provider. |
| cancelled | [cancelled](#flow-hosted-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-hosted-connect-return"></a>

### return

[HOSTED-CLIENT](INVENTORY.md#hosted-client) → [HOSTED-CLIENT-RETURN](INVENTORY.md#hosted-client-return): Return to the original browser/provider so its validated callback completes; confirm it reports connected.

Other controls: [HOSTED-CLIENT-BACK](INVENTORY.md#hosted-client-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-hosted-connect-done) | Continue after confirmed success. |
| denied | [return](#flow-hosted-connect-return) | If callback delivery or provider setup fails, return to the original provider and restart authorization explicitly; do not substitute a local bearer credential. |
| failure | [return](#flow-hosted-connect-return) | If callback delivery or provider setup fails, return to the original provider and restart authorization explicitly; do not substitute a local bearer credential. |
| cancelled | [cancelled](#flow-hosted-connect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-hosted-connect-done"></a>

### done

**success.** Provider software holds its OAuth connection. No CLI profile, ticket, or encrypted-delivery consumer is required for the recipient.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-hosted-connect-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-HOSTED-OPERATOR

**Produce a public hosted endpoint as an operator.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui).

Before starting: An operator private profile already contains a registered service; provider registration/acceptance is separate work.

Glossary: [TERM-OAUTH](GLOSSARY.md#term-oauth), [TERM-REGISTRATION](GLOSSARY.md#term-registration). Related/continuing tasks: [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect).

Start at [endpoint](#flow-hosted-operator-endpoint).

<a id="flow-hosted-operator-endpoint"></a>

### endpoint

[AGENT-CLI](INVENTORY.md#agent-cli) → [AGENT-CLI-HOSTED-LINK](INVENTORY.md#agent-cli-hosted-link): Run relay service hosted-link --profile NAME and supply only that public named-service URL to the recipient.

Other controls: [AGENT-CLI-BACK](INVENTORY.md#agent-cli-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-hosted-operator-done) | Continue after confirmed success. |
| failure | [endpoint](#flow-hosted-operator-endpoint) | Complete retained registration first; check relay status or stop without revealing service credentials. |
| cancelled | [cancelled](#flow-hosted-operator-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-hosted-operator-done"></a>

### done

**success.** A public hosted endpoint is available; each recipient still authorizes separately.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-hosted-operator-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-TUI-TOOLS

**Enable relay tools in a terminal coding agent.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [TUI](FLOWS.md#tui).

Before starting: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect) completed and a specific connection ID is selected.

Glossary: [TUI](FLOWS.md#tui), [TERM-PROFILE](GLOSSARY.md#term-profile), [TERM-CAPABILITY](GLOSSARY.md#term-capability). Related/continuing tasks: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect).

Start at [configure](#flow-tui-tools-configure).

<a id="flow-tui-tools-configure"></a>

### configure

[TUI-CLIENT](INVENTORY.md#tui-client) → [TUI-CLIENT-CONFIGURE](INVENTORY.md#tui-client-configure): Configure the host to launch relay-mcp --profile NAME --connection ID. Keep private files outside prompts.

Other controls: [TUI-CLIENT-BACK](INVENTORY.md#tui-client-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [check](#flow-tui-tools-check) | Continue after confirmed success. |
| failure | [configure](#flow-tui-tools-configure) | Fix local launch/profile/connection selection in host software or stop; do not copy service credentials into tool arguments. |
| cancelled | [cancelled](#flow-tui-tools-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-tui-tools-check"></a>

### check

[TUI-CLIENT](INVENTORY.md#tui-client) → [TUI-CLIENT-CHECK](INVENTORY.md#tui-client-check): Check relay_setup_status and the permission-limited tools. If setup is incomplete, follow the public link and consume deliveries outside the model.

Other controls: [TUI-CLIENT-BACK](INVENTORY.md#tui-client-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-tui-tools-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-tui-tools-cancelled) | Setup-only tools mean configuration is incomplete, not that access is granted. Finish direct pairing or retry after relay/network recovery. |
| revoked | [cancelled](#flow-tui-tools-cancelled) | Setup-only tools mean configuration is incomplete, not that access is granted. Finish direct pairing or retry after relay/network recovery. |
| failure | [check](#flow-tui-tools-check) | Setup-only tools mean configuration is incomplete, not that access is granted. Finish direct pairing or retry after relay/network recovery. |
| cancelled | [cancelled](#flow-tui-tools-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-tui-tools-done"></a>

### done

**success.** The coding agent sees only tools allowed by the selected recipient connection.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-tui-tools-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-SCRIPT-REQUEST

**Send a request from agent software and retrieve the result.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: A usable connection with required capabilities and at least one suitable receiving phone exists.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-CAPABILITY](GLOSSARY.md#term-capability). Related/continuing tasks: [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form).

Start at [request](#flow-script-request-request).

<a id="flow-script-request-request"></a>

### request

[AGENT-REQUEST](INVENTORY.md#agent-request) → [AGENT-REQUEST-WAIT](INVENTORY.md#agent-request-wait): Software creates a form or SMS request and polls/events for its result. Hosted software uses its named-resource MCP tools. For SMS, wait for server ready before a separate workflow triggers the SMS.

Other controls: [AGENT-REQUEST-BACK](INVENTORY.md#agent-request-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-script-request-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-script-request-cancelled) | Handle denial, cancellation, expiry, revocation, and missing phones as explicit results. Retry transport safely, not by duplicating accepted requests; stop polling at a bounded deadline. |
| revoked | [cancelled](#flow-script-request-cancelled) | Handle denial, cancellation, expiry, revocation, and missing phones as explicit results. Retry transport safely, not by duplicating accepted requests; stop polling at a bounded deadline. |
| failure | [request](#flow-script-request-request) | Handle denial, cancellation, expiry, revocation, and missing phones as explicit results. Retry transport safely, not by duplicating accepted requests; stop polling at a bounded deadline. |
| cancelled | [cancelled](#flow-script-request-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-script-request-done"></a>

### done

**success.** The authorized originating connection retrieves the approved result within its retrieval window, or handles a terminal failure without exposing values to unrelated parties.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-script-request-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-NOTIFICATION-SMS

**Open an SMS response directly from a notification.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: The notification identifies one request; cold-launch loading state is initialized before display.

Glossary: [TERM-RETURN](GLOSSARY.md#term-return), [TERM-REQUEST](GLOSSARY.md#term-request). Related/continuing tasks: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome).

Start at [open](#flow-notification-sms-open).

<a id="flow-notification-sms-open"></a>

### open

[SMS](INVENTORY.md#sms) → [SMS-OPEN](INVENTORY.md#sms-open): Tap the notification. Open only this response destination; retain the target through any required sign-in/registration, then load and establish platform-specific readiness.

Other controls: [SMS-BACK](INVENTORY.md#sms-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-notification-sms-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-notification-sms-cancelled) | Show request-local Retry/Close on load failure. Expired or handled-elsewhere requests show their terminal outcome; do not reveal a previous response or fall back to a different request. |
| revoked | [cancelled](#flow-notification-sms-cancelled) | Show request-local Retry/Close on load failure. Expired or handled-elsewhere requests show their terminal outcome; do not reveal a previous response or fall back to a different request. |
| failure | [open](#flow-notification-sms-open) | Show request-local Retry/Close on load failure. Expired or handled-elsewhere requests show their terminal outcome; do not reveal a previous response or fall back to a different request. |
| cancelled | [cancelled](#flow-notification-sms-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-notification-sms-done"></a>

### done

**success.** The intended SMS response is open. Android Close backgrounds the retained task to the previous app; iOS dismisses its response sheet.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-notification-sms-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-NOTIFICATION-FORM

**Open a form directly from a notification.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: The notification identifies one form; its target is retained across necessary setup.

Glossary: [TERM-RETURN](GLOSSARY.md#term-return), [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RECOVERY](GLOSSARY.md#term-recovery). Related/continuing tasks: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard).

Start at [open](#flow-notification-form-open).

<a id="flow-notification-form-open"></a>

### open

[FORM](INVENTORY.md#form) → [FORM-OPEN](INVENTORY.md#form-open): Tap the notification and load only the target form response. Opening/AutoFill never submits; an in-memory draft may resume while the process lives.

Other controls: [FORM-BACK](INVENTORY.md#form-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-notification-form-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-notification-form-cancelled) | Retry the same target or Close. After process death reopen without persisted answers; terminal requests show their actual outcome. |
| revoked | [cancelled](#flow-notification-form-cancelled) | Retry the same target or Close. After process death reopen without persisted answers; terminal requests show their actual outcome. |
| failure | [open](#flow-notification-form-open) | Retry the same target or Close. After process death reopen without persisted answers; terminal requests show their actual outcome. |
| cancelled | [cancelled](#flow-notification-form-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-notification-form-done"></a>

### done

**success.** The intended form response is open without passing through an Inbox selection; Close follows entry origin.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-notification-form-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-SMS-ANDROID

**Respond to an SMS request on Android.** Platforms: [ANDROID](FLOWS.md#android). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: A pending SMS request exists; native setup is complete or retained request-specific setup resumes it.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RETURN](GLOSSARY.md#term-return). Related/continuing tasks: [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome).

Start at [open](#flow-sms-android-open).

<a id="flow-sms-android-open"></a>

### open

[INBOX](INVENTORY.md#inbox) → [INBOX-OPEN-SMS](INVENTORY.md#inbox-open-sms): Open the pending row or enter this same response directly from its notification. Only explicit opening starts the SMS listener.

Other controls: [INBOX-BACK](INVENTORY.md#inbox-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [consent](#flow-sms-android-consent) | Continue after confirmed success. |
| failure | [open](#flow-sms-android-open) | Keep the pending target; retry loading after account/registration/network recovery or close. |
| cancelled | [cancelled](#flow-sms-android-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-sms-android-consent"></a>

### consent

[SMS](INVENTORY.md#sms) → [SMS-CONSENT](INVENTORY.md#sms-consent): Approve Android SMS User Consent. A single extracted code or selected candidate is sent; if denied, use manual entry and Send.

Other controls: [SMS-BACK](INVENTORY.md#sms-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-sms-android-done) | Continue after confirmed success. |
| denied | [manual](#flow-sms-android-manual) | Use manual entry; declining Android SMS access does not cancel the request. |
| failure | [manual](#flow-sms-android-manual) | Listener unavailable or message ineligible: type a code manually within the request window. |
| cancelled | [cancelled](#flow-sms-android-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-sms-android-manual"></a>

### manual

[SMS](INVENTORY.md#sms) → [SMS-SEND](INVENTORY.md#sms-send): Type the intended code and tap Send.

Other controls: [SMS-CODE](INVENTORY.md#sms-code), [SMS-BACK](INVENTORY.md#sms-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-sms-android-done) | Continue after confirmed success. |
| invalid | [manual](#flow-sms-android-manual) | Correct validation errors. On uncertain submission reconcile request status; expired/handled-elsewhere requests show outcome. |
| failure | [manual](#flow-sms-android-manual) | Correct validation errors. On uncertain submission reconcile request status; expired/handled-elsewhere requests show outcome. |
| cancelled | [cancelled](#flow-sms-android-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-sms-android-done"></a>

### done

**success.** Server-confirmed success returns according to entry origin. Back leaves without cancelling; expired/handled-elsewhere outcome can be closed.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-sms-android-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-SMS-IOS

**Respond to an SMS request on iOS.** Platforms: [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: A pending SMS request exists and iOS device setup is complete.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RETURN](GLOSSARY.md#term-return). Related/continuing tasks: [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome).

Start at [open](#flow-sms-ios-open).

<a id="flow-sms-ios-open"></a>

### open

[INBOX](INVENTORY.md#inbox) → [INBOX-OPEN-SMS](INVENTORY.md#inbox-open-sms): Open the pending row or notification response; the server starts manual readiness without an Android listener.

Other controls: [INBOX-BACK](INVENTORY.md#inbox-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [send](#flow-sms-ios-send) | Continue after confirmed success. |
| failure | [open](#flow-sms-ios-open) | Retry this request after authentication/setup/network recovery or close. |
| cancelled | [cancelled](#flow-sms-ios-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-sms-ios-send"></a>

### send

[SMS](INVENTORY.md#sms) → [SMS-SEND](INVENTORY.md#sms-send): Type, deliberately paste, or choose eligible system AutoFill, then tap Send. Nothing auto-submits.

Other controls: [SMS-CODE](INVENTORY.md#sms-code), [SMS-BACK](INVENTORY.md#sms-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-sms-ios-done) | Continue after confirmed success. |
| invalid | [send](#flow-sms-ios-send) | Use manual entry if AutoFill is unavailable; expired/manual-window or competing-device results show an outcome. |
| failure | [send](#flow-sms-ios-send) | Use manual entry if AutoFill is unavailable; expired/manual-window or competing-device results show an outcome. |
| cancelled | [cancelled](#flow-sms-ios-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-sms-ios-done"></a>

### done

**success.** The approved code is submitted with manual source; dismiss/pop the response according to origin. No Android consent event is emitted.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-sms-ios-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-FORM

**Answer a form or decision request.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Pending form exists and its required capabilities are approved.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-CAPABILITY](GLOSSARY.md#term-capability).

Start at [open](#flow-form-open).

<a id="flow-form-open"></a>

### open

[INBOX](INVENTORY.md#inbox) → [INBOX-OPEN-FORM](INVENTORY.md#inbox-open-form): Open the pending row or notification; read the requester and explanation.

Other controls: [INBOX-BACK](INVENTORY.md#inbox-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [answer](#flow-form-answer) | Continue after confirmed success. |
| failure | [open](#flow-form-open) | Retry the same request or close without submitting. |
| cancelled | [cancelled](#flow-form-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-form-answer"></a>

### answer

[FORM](INVENTORY.md#form) → [FORM-SUBMIT](INVENTORY.md#form-submit): Complete visible native fields and press the declared Submit, Approve, or Acknowledge action.

Other controls: [FORM-FIELDS](INVENTORY.md#form-fields), [FORM-BACK](INVENTORY.md#form-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [outcome](#flow-form-outcome) | Continue after confirmed success. |
| invalid | [answer](#flow-form-answer) | Show field validation inline. On uncertain submission reconcile outcome; do not submit from autofill/opening. |
| failure | [answer](#flow-form-answer) | Show field validation inline. On uncertain submission reconcile outcome; do not submit from autofill/opening. |
| cancelled | [cancelled](#flow-form-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-form-outcome"></a>

### outcome

[REQUEST-OUTCOME](INVENTORY.md#request-outcome) → [REQUEST-OUTCOME-BACK](INVENTORY.md#request-outcome-back): Read the current form outcome, then close the response.

Other controls: [REQUEST-OUTCOME-BACK](INVENTORY.md#request-outcome-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-form-done) | Continue after confirmed success. |
| failure | [outcome](#flow-form-outcome) | If result state is uncertain, refetch the same request; do not expose previous sensitive values. |
| cancelled | [cancelled](#flow-form-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-form-done"></a>

### done

**success.** The declared answer/action was accepted and the response was closed; no History entry for form answers is introduced.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-form-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-WIZARD

**Complete a multi-step form.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: The opened form declares wizard steps.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RECOVERY](GLOSSARY.md#term-recovery).

Start at [start](#flow-wizard-start).

<a id="flow-wizard-start"></a>

### start

[FORM](INVENTORY.md#form) → [FORM-WIZARD](INVENTORY.md#form-wizard): Enter the defined multi-step response.

Other controls: [FORM-BACK](INVENTORY.md#form-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [step](#flow-wizard-step) | Continue after confirmed success. |
| failure | [start](#flow-wizard-start) | Retry loading this request or close. |
| cancelled | [cancelled](#flow-wizard-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-wizard-step"></a>

### step

[WIZARD](INVENTORY.md#wizard) → [WIZARD-NEXT](INVENTORY.md#wizard-next): Fill the current step, use Previous step to revise, and advance through reachable steps to final review.

Other controls: [WIZARD-FIELDS](INVENTORY.md#wizard-fields), [WIZARD-PREVIOUS](INVENTORY.md#wizard-previous), [WIZARD-BACK](INVENTORY.md#wizard-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [review](#flow-wizard-review) | Continue after confirmed success. |
| invalid | [step](#flow-wizard-step) | Correct current-step validation; hidden answers are pruned. Close preserves only the in-memory draft. |
| failure | [step](#flow-wizard-step) | Correct current-step validation; hidden answers are pruned. Close preserves only the in-memory draft. |
| cancelled | [cancelled](#flow-wizard-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-wizard-review"></a>

### review

[FORM-REVIEW](INVENTORY.md#form-review) → [FORM-REVIEW-SUBMIT](INVENTORY.md#form-review-submit): Review answers; Edit returns to a step, final declared action submits.

Other controls: [FORM-REVIEW-EDIT](INVENTORY.md#form-review-edit), [FORM-REVIEW-BACK](INVENTORY.md#form-review-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-wizard-done) | Continue after confirmed success. |
| invalid | [review](#flow-wizard-review) | Use Edit to correct answers, or reconcile an uncertain final submission before retrying. |
| failure | [review](#flow-wizard-review) | Use Edit to correct answers, or reconcile an uncertain final submission before retrying. |
| cancelled | [cancelled](#flow-wizard-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-wizard-done"></a>

### done

**success.** One final submission contains only reachable answers; outcome remains in the response until closed.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-wizard-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DECLINE-REQUEST

**Explicitly cancel an SMS request.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: SMS response is open; Back/Close must not cancel it.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RETURN](GLOSSARY.md#term-return).

Start at [cancel](#flow-decline-request-cancel).

<a id="flow-decline-request-cancel"></a>

### cancel

[SMS](INVENTORY.md#sms) → [SMS-CANCEL](INVENTORY.md#sms-cancel): Choose the explicit Cancel/Decline request action.

Other controls: [SMS-BACK](INVENTORY.md#sms-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-decline-request-done) | Continue after confirmed success. |
| invalid | [cancel](#flow-decline-request-cancel) | Reconcile request state after network failure; show competing-device/expired outcome if already terminal. |
| failure | [cancel](#flow-decline-request-cancel) | Reconcile request state after network failure; show competing-device/expired outcome if already terminal. |
| cancelled | [cancelled](#flow-decline-request-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-decline-request-done"></a>

### done

**success.** The explicit terminal action was applied; merely navigating away never performs it.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-decline-request-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DECLINE-FORM

**Decline a form when declared.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: The form definition explicitly offers Decline.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request).

Start at [decline](#flow-decline-form-decline).

<a id="flow-decline-form-decline"></a>

### decline

[FORM](INVENTORY.md#form) → [FORM-DECLINE](INVENTORY.md#form-decline): Press the declared Decline action.

Other controls: [FORM-BACK](INVENTORY.md#form-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-decline-form-done) | Continue after confirmed success. |
| invalid | [decline](#flow-decline-form-decline) | Reconcile uncertain result or retry; do not manufacture a Decline action when it is not declared. |
| failure | [decline](#flow-decline-form-decline) | Reconcile uncertain result or retry; do not manufacture a Decline action when it is not declared. |
| cancelled | [cancelled](#flow-decline-form-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-decline-form-done"></a>

### done

**success.** The declared decline outcome is accepted and may be closed.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-decline-form-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-REQUEST-OUTCOME

**Leave an expired or handled-elsewhere response.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: The response has a terminal outcome instead of editable fields.

Glossary: [TERM-RETURN](GLOSSARY.md#term-return), [TERM-REQUEST](GLOSSARY.md#term-request).

Start at [close](#flow-request-outcome-close).

<a id="flow-request-outcome-close"></a>

### close

[REQUEST-OUTCOME](INVENTORY.md#request-outcome) → [REQUEST-OUTCOME-BACK](INVENTORY.md#request-outcome-back): Read expired, cancelled, or handled-on-another-device state and close.

Other controls: [REQUEST-OUTCOME-BACK](INVENTORY.md#request-outcome-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-request-outcome-done) | Continue after confirmed success. |
| failure | [close](#flow-request-outcome-close) | Keep the terminal outcome readable and allow Close even if offline. |
| cancelled | [cancelled](#flow-request-outcome-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-request-outcome-done"></a>

### done

**success.** Return follows entry origin; no secret value or historical feed is shown.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-request-outcome-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-SEARCH

**Find an administrative setting.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open the Administration entry/settings hierarchy.

Glossary: [TERM-HISTORY](GLOSSARY.md#term-history), [TERM-CONNECTION](GLOSSARY.md#term-connection).

Start at [open](#flow-search-open).

<a id="flow-search-open"></a>

### open

[SETTINGS](INVENTORY.md#settings) → [SETTINGS-OPEN-SEARCH](INVENTORY.md#settings-open-search): Tap the visible Search settings widget.

Other controls: [SETTINGS-BACK](INVENTORY.md#settings-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [query](#flow-search-query) | Continue after confirmed success. |
| failure | [open](#flow-search-open) | Keep Settings usable if search fails; Back returns to categories. |
| cancelled | [cancelled](#flow-search-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-search-query"></a>

### query

[SETTINGS-SEARCH](INVENTORY.md#settings-search) → [SETTINGS-SEARCH-OPEN](INVENTORY.md#settings-search-open): Type a label or synonym; open its breadcrumb-labelled destination. Object-specific results first select an object.

Other controls: [SETTINGS-SEARCH-QUERY](INVENTORY.md#settings-search-query), [SETTINGS-SEARCH-CLEAR](INVENTORY.md#settings-search-clear), [SETTINGS-SEARCH-BACK](INVENTORY.md#settings-search-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-search-done) | Continue after confirmed success. |
| failure | [query](#flow-search-query) | No matches: change or clear the query, or Back to categories. Search never executes a setting action. |
| cancelled | [cancelled](#flow-search-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-search-done"></a>

### done

**success.** The chosen settings task is open without a state mutation.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-search-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-HISTORY

**Review completed SMS outcomes.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open Settings → Administration → History; browser history is part of the redesign target.

Glossary: [TERM-HISTORY](GLOSSARY.md#term-history).

Start at [history](#flow-history-history).

<a id="flow-history-history"></a>

### history

[HISTORY](INVENTORY.md#history) → [HISTORY-REFRESH](INVENTORY.md#history-refresh): Read metadata-only outcomes; pull down to refresh if needed.

Other controls: [HISTORY-BACK](INVENTORY.md#history-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-history-done) | Continue after confirmed success. |
| failure | [history](#flow-history-history) | Show refresh failure inline while preserving rows or the empty state; Back remains available. |
| cancelled | [cancelled](#flow-history-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-history-done"></a>

### done

**success.** Completed SMS metadata was read exclusively in Administration, without codes, answers, or Inbox history.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-history-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DEVICE-RECEPTION

**Pause or resume a receiving device.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open Administration → Devices and select the intended installation.

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device).

Start at [toggle](#flow-device-reception-toggle).

<a id="flow-device-reception-toggle"></a>

### toggle

[DEVICE-RECEIVE](INVENTORY.md#device-receive) → [DEVICE-RECEIVE-TOGGLE](INVENTORY.md#device-receive-toggle): Set Receive requests for this device.

Other controls: [DEVICE-RECEIVE-BACK](INVENTORY.md#device-receive-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-device-reception-done) | Continue after confirmed success. |
| invalid | [toggle](#flow-device-reception-toggle) | Retain confirmed server state after failure; retry or leave, never pretend the toggle succeeded. |
| failure | [toggle](#flow-device-reception-toggle) | Retain confirmed server state after failure; retry or leave, never pretend the toggle succeeded. |
| cancelled | [cancelled](#flow-device-reception-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-device-reception-done"></a>

### done

**success.** Only the selected device reception state changed.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-device-reception-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-REMOVE-DEVICE

**Remove a receiving device.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Select a device and open its dedicated removal confirmation.

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device).

Start at [remove](#flow-remove-device-remove).

<a id="flow-remove-device-remove"></a>

### remove

[DEVICE-REMOVE](INVENTORY.md#device-remove) → [DEVICE-REMOVE-SUBMIT](INVENTORY.md#device-remove-submit): Verify the selected installation and confirm removal.

Other controls: [DEVICE-REMOVE-BACK](INVENTORY.md#device-remove-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-remove-device-done) | Continue after confirmed success. |
| invalid | [remove](#flow-remove-device-remove) | Reconcile uncertain removal; another device/account/connection must not be removed by retry. |
| failure | [remove](#flow-remove-device-remove) | Reconcile uncertain removal; another device/account/connection must not be removed by retry. |
| cancelled | [cancelled](#flow-remove-device-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-remove-device-done"></a>

### done

**success.** This installation is unregistered; other phones and agent connections remain.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-remove-device-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-PERMISSIONS

**Change one connection permission set.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open Peering → Connections → selected connection → Change permissions.

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-CAPABILITY](GLOSSARY.md#term-capability).

Start at [save](#flow-permissions-save).

<a id="flow-permissions-save"></a>

### save

[CONNECTION-PERMISSIONS](INVENTORY.md#connection-permissions) → [CONNECTION-PERMISSIONS-SUBMIT](INVENTORY.md#connection-permissions-submit): Choose permitted forms/SMS capabilities and explicitly save.

Other controls: [CONNECTION-PERMISSIONS-VALUE](INVENTORY.md#connection-permissions-value), [CONNECTION-PERMISSIONS-BACK](INVENTORY.md#connection-permissions-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-permissions-done) | Continue after confirmed success. |
| invalid | [save](#flow-permissions-save) | Correct invalid permissions; a revoked connection requires fresh approval, not a silent re-enable. |
| failure | [save](#flow-permissions-save) | Correct invalid permissions; a revoked connection requires fresh approval, not a silent re-enable. |
| cancelled | [cancelled](#flow-permissions-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-permissions-done"></a>

### done

**success.** Effective capabilities changed and future operations reauthorize them.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-permissions-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-EXPIRY

**Change one connection expiry.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Select a connection and open Change expiry.

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection).

Start at [save](#flow-expiry-save).

<a id="flow-expiry-save"></a>

### save

[CONNECTION-EXPIRY](INVENTORY.md#connection-expiry) → [CONNECTION-EXPIRY-SUBMIT](INVENTORY.md#connection-expiry-submit): Choose a supported duration and explicitly save.

Other controls: [CONNECTION-EXPIRY-VALUE](INVENTORY.md#connection-expiry-value), [CONNECTION-EXPIRY-BACK](INVENTORY.md#connection-expiry-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-expiry-done) | Continue after confirmed success. |
| invalid | [save](#flow-expiry-save) | Correct duration or reconcile current server state; expired access may require a new approval. |
| failure | [save](#flow-expiry-save) | Correct duration or reconcile current server state; expired access may require a new approval. |
| cancelled | [cancelled](#flow-expiry-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-expiry-done"></a>

### done

**success.** The selected connection duration is saved.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-expiry-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DISCONNECT

**Disconnect one agent from this recipient.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Select the connection and open Disconnect.

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection).

Start at [disconnect](#flow-disconnect-disconnect).

<a id="flow-disconnect-disconnect"></a>

### disconnect

[CONNECTION-DISCONNECT](INVENTORY.md#connection-disconnect) → [CONNECTION-DISCONNECT-SUBMIT](INVENTORY.md#connection-disconnect-submit): Verify the selected connection and confirm disconnection.

Other controls: [CONNECTION-DISCONNECT-BACK](INVENTORY.md#connection-disconnect-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-disconnect-done) | Continue after confirmed success. |
| invalid | [disconnect](#flow-disconnect-disconnect) | Reconcile revocation after a transport error; retry safely or close. |
| failure | [disconnect](#flow-disconnect-disconnect) | Reconcile revocation after a transport error; retry safely or close. |
| cancelled | [cancelled](#flow-disconnect-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-disconnect-done"></a>

### done

**success.** This recipient connection loses request/result access; unrelated connections remain.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-disconnect-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-SHARE

**Share a public agent connection link.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Open the owned agent → Connection link.

Glossary: [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link), [TERM-TICKET](GLOSSARY.md#term-ticket).

Start at [share](#flow-share-share).

<a id="flow-share-share"></a>

### share

[AGENT-SHARE](INVENTORY.md#agent-share) → [AGENT-SHARE-SHARE](INVENTORY.md#agent-share-share): Share the public link/QR, or Copy link if a share sheet is unavailable.

Other controls: [AGENT-SHARE-COPY](INVENTORY.md#agent-share-copy), [AGENT-SHARE-BACK](INVENTORY.md#agent-share-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-share-done) | Continue after confirmed success. |
| denied | [share](#flow-share-share) | Cancel the share sheet or use Copy link. Never substitute a private ticket. |
| failure | [share](#flow-share-share) | Cancel the share sheet or use Copy link. Never substitute a private ticket. |
| cancelled | [cancelled](#flow-share-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-share-done"></a>

### done

**success.** Only the public connection destination is shared; recipients still approve separately.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-share-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-AGENT-AVAILABILITY

**Disable or re-enable an owned agent.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Select the owned agent → Availability.

Glossary: [TERM-AGENT](GLOSSARY.md#term-agent), [TERM-CONNECTION](GLOSSARY.md#term-connection).

Start at [save](#flow-agent-availability-save).

<a id="flow-agent-availability-save"></a>

### save

[AGENT-AVAILABILITY](INVENTORY.md#agent-availability) → [AGENT-AVAILABILITY-SUBMIT](INVENTORY.md#agent-availability-submit): Review the effect on all connections and set availability.

Other controls: [AGENT-AVAILABILITY-BACK](INVENTORY.md#agent-availability-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-agent-availability-done) | Continue after confirmed success. |
| invalid | [save](#flow-agent-availability-save) | Show confirmed server state; reconcile failure before indicating success. |
| failure | [save](#flow-agent-availability-save) | Show confirmed server state; reconcile failure before indicating success. |
| cancelled | [cancelled](#flow-agent-availability-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-agent-availability-done"></a>

### done

**success.** All operations recheck parent availability; re-enabling restores current agent authority.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-agent-availability-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-AGENT-DELETE

**Delete an owned agent.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Open the selected owned agent deletion confirmation.

Glossary: [TERM-AGENT](GLOSSARY.md#term-agent).

Start at [delete](#flow-agent-delete-delete).

<a id="flow-agent-delete-delete"></a>

### delete

[AGENT-DELETE](INVENTORY.md#agent-delete) → [AGENT-DELETE-SUBMIT](INVENTORY.md#agent-delete-submit): Confirm deletion after reviewing the effect on every connection.

Other controls: [AGENT-DELETE-BACK](INVENTORY.md#agent-delete-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-agent-delete-done) | Continue after confirmed success. |
| invalid | [delete](#flow-agent-delete-delete) | Reconcile uncertain acceptance; never recreate the deleted agent as a retry. |
| failure | [delete](#flow-agent-delete-delete) | Reconcile uncertain acceptance; never recreate the deleted agent as a retry. |
| cancelled | [cancelled](#flow-agent-delete-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-agent-delete-done"></a>

### done

**success.** The agent is inactive/deleted and child cleanup is queued; other agents remain.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-agent-delete-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-TICKET-CLEAR

**Clear a retained ticket after safe export.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) saved the file, or the agent was explicitly deleted. Retained provisioning state still exists.

Glossary: [TERM-TICKET](GLOSSARY.md#term-ticket).

Start at [clear](#flow-ticket-clear-clear).

<a id="flow-ticket-clear-clear"></a>

### clear

[AGENT-TICKET-CLEAR](INVENTORY.md#agent-ticket-clear) → [AGENT-TICKET-CLEAR-SUBMIT](INVENTORY.md#agent-ticket-clear-submit): Acknowledge safe export/deletion and clear only the selected retained copy.

Other controls: [AGENT-TICKET-CLEAR-ACK](INVENTORY.md#agent-ticket-clear-ack), [AGENT-TICKET-CLEAR-BACK](INVENTORY.md#agent-ticket-clear-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-ticket-clear-done) | Continue after confirmed success. |
| invalid | [clear](#flow-ticket-clear-clear) | If the owner/ticket changed, reload the selected retained state; never clear another ticket. |
| failure | [clear](#flow-ticket-clear-clear) | If the owner/ticket changed, reload the selected retained state; never clear another ticket. |
| cancelled | [cancelled](#flow-ticket-clear-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-ticket-clear-done"></a>

### done

**success.** Only the acknowledged retained provisioning state was cleared; the service cannot recover private keys.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-ticket-clear-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-LINK-PROVIDER

**Link a second sign-in provider.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open Account → Sign-in methods and select an unlinked provider.

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner).

Start at [link](#flow-link-provider-link).

<a id="flow-link-provider-link"></a>

### link

[ACCOUNT-LINK](INVENTORY.md#account-link) → [ACCOUNT-LINK-SUBMIT](INVENTORY.md#account-link-submit): Consent to linking this provider to the current account, then authenticate it.

Other controls: [ACCOUNT-LINK-BACK](INVENTORY.md#account-link-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-link-provider-done) | Continue after confirmed success. |
| denied | [link](#flow-link-provider-link) | Keep the original account on provider cancellation/conflict; never merge by email or switch owner silently. |
| failure | [link](#flow-link-provider-link) | Keep the original account on provider cancellation/conflict; never merge by email or switch owner silently. |
| cancelled | [cancelled](#flow-link-provider-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-link-provider-done"></a>

### done

**success.** The same relay account has the additional explicitly linked provider.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-link-provider-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-SIGNOUT

**Sign out of the current installation.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open Account → Sign out.

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner), [TERM-RETURN](GLOSSARY.md#term-return). Related/continuing tasks: [FLOW-LOGIN](FLOWS.md#flow-login).

Start at [signout](#flow-signout-signout).

<a id="flow-signout-signout"></a>

### signout

[ACCOUNT-SIGNOUT](INVENTORY.md#account-signout) → [ACCOUNT-SIGNOUT-SUBMIT](INVENTORY.md#account-signout-submit): Confirm local sign-out and discard sensitive response drafts.

Other controls: [ACCOUNT-SIGNOUT-BACK](INVENTORY.md#account-signout-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-signout-done) | Continue after confirmed success. |
| invalid | [signout](#flow-signout-signout) | Keep current identity clear and retry local session cleanup or close. |
| failure | [signout](#flow-signout-signout) | Keep current identity clear and retry local session cleanup or close. |
| cancelled | [cancelled](#flow-signout-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-signout-done"></a>

### done

**success.** Login is shown; no server-side account deletion or connection revocation was implied.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-signout-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DELETE-ACCOUNT

**Delete the relay account.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none).

Before starting: Open Account → Delete account; web direct links first use [FLOW-LOGIN](FLOWS.md#flow-login).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner), [TERM-RECOVERY](GLOSSARY.md#term-recovery).

Start at [confirm](#flow-delete-account-confirm).

<a id="flow-delete-account-confirm"></a>

### confirm

[ACCOUNT-DELETE](INVENTORY.md#account-delete) → [ACCOUNT-DELETE-SUBMIT](INVENTORY.md#account-delete-submit): Acknowledge deletion, verify the same account, and confirm. Required Apple revocation stays in the authenticated flow.

Other controls: [ACCOUNT-DELETE-ACK](INVENTORY.md#account-delete-ack), [ACCOUNT-DELETE-BACK](INVENTORY.md#account-delete-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [status](#flow-delete-account-status) | Continue after confirmed success. |
| denied | [confirm](#flow-delete-account-confirm) | Reauthentication cancellation stops deletion. After uncertain server acceptance, reconcile the receipt/status before resubmitting. |
| failure | [confirm](#flow-delete-account-confirm) | Reauthentication cancellation stops deletion. After uncertain server acceptance, reconcile the receipt/status before resubmitting. |
| cancelled | [cancelled](#flow-delete-account-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-delete-account-status"></a>

### status

[ACCOUNT-DELETION](INVENTORY.md#account-deletion) → [ACCOUNT-DELETION-CHECK](INVENTORY.md#account-deletion-check): Read accepted/cleanup status; access is blocked on acceptance and cleanup continues after Close.

Other controls: [ACCOUNT-DELETION-BACK](INVENTORY.md#account-deletion-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| ready | [done](#flow-delete-account-done) | Continue after confirmed success. |
| timeout | [cancelled](#flow-delete-account-cancelled) | Keep acceptance distinct from cleanup completion; retry status using the retained receipt or close. |
| revoked | [cancelled](#flow-delete-account-cancelled) | Keep acceptance distinct from cleanup completion; retry status using the retained receipt or close. |
| failure | [status](#flow-delete-account-status) | Keep acceptance distinct from cleanup completion; retry status using the retained receipt or close. |
| cancelled | [cancelled](#flow-delete-account-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-delete-account-done"></a>

### done

**success.** Accepted deletion blocks access; cleanup continues independently of the open page.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-delete-account-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-PRIVACY

**Read privacy information.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: Open Privacy from Account or sign-in; preserve that calling destination.

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner).

Start at [read](#flow-privacy-read).

<a id="flow-privacy-read"></a>

### read

[ACCOUNT-PRIVACY](INVENTORY.md#account-privacy) → [ACCOUNT-PRIVACY-CONTACT](INVENTORY.md#account-privacy-contact): Read the policy; open operator contact only if needed and configured, then return.

Other controls: [ACCOUNT-PRIVACY-BACK](INVENTORY.md#account-privacy-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-privacy-done) | Continue after confirmed success. |
| denied | [read](#flow-privacy-read) | If no contact is published, keep the policy readable and allow Back. |
| failure | [read](#flow-privacy-read) | If no contact is published, keep the policy readable and allow Back. |
| cancelled | [cancelled](#flow-privacy-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-privacy-done"></a>

### done

**success.** Policy is readable and Back returns to the original account/sign-in task.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-privacy-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DECLINE-PAIRING

**Decline an agent access request.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [NONE](FLOWS.md#none), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Before starting: A connection review is open.

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection).

Start at [decline](#flow-decline-pairing-decline).

<a id="flow-decline-pairing-decline"></a>

### decline

[PAIR-REVIEW](INVENTORY.md#pair-review) → [PAIR-REVIEW-DECLINE](INVENTORY.md#pair-review-decline): Choose Decline instead of granting access.

Other controls: [PAIR-REVIEW-BACK](INVENTORY.md#pair-review-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-decline-pairing-done) | Continue after confirmed success. |
| invalid | [decline](#flow-decline-pairing-decline) | Reconcile session state; expired/previously decided sessions show their actual result. |
| failure | [decline](#flow-decline-pairing-decline) | Reconcile session state; expired/previously decided sessions show their actual result. |
| cancelled | [cancelled](#flow-decline-pairing-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-decline-pairing-done"></a>

### done

**success.** No new access is granted; an existing unrelated connection is not revoked.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-decline-pairing-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.


## FLOW-DECLINE-REGISTRATION

**Decline agent ownership registration.** Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Agents: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui).

Before starting: A registration review is open.

Glossary: [TERM-REGISTRATION](GLOSSARY.md#term-registration).

Start at [decline](#flow-decline-registration-decline).

<a id="flow-decline-registration-decline"></a>

### decline

[REGISTER-APPROVAL](INVENTORY.md#register-approval) → [REGISTER-APPROVAL-DECLINE](INVENTORY.md#register-approval-decline): Choose Decline instead of registering ownership.

Other controls: [REGISTER-APPROVAL-BACK](INVENTORY.md#register-approval-back).

| Result | Next step | User-visible recovery / continuation |
| --- | --- | --- |
| success | [done](#flow-decline-registration-done) | Continue after confirmed success. |
| invalid | [decline](#flow-decline-registration-decline) | Reconcile session state; no recipient grant is created regardless of outcome. |
| failure | [decline](#flow-decline-registration-decline) | Reconcile session state; no recipient grant is created regardless of outcome. |
| cancelled | [cancelled](#flow-decline-registration-cancelled) | Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back. |

<a id="flow-decline-registration-done"></a>

### done

**success.** Agent registration is declined; software can stop or explicitly start a fresh registration.

Exit: Return to the invoking page/app or close the task; accepted changes remain accepted.

<a id="flow-decline-registration-cancelled"></a>

### cancelled

**safe-stop.** The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.

Exit: Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.
