# UI glossary

Generated from [contract.mjs](contract.mjs). Edit the source and run `npm run docs:ui`; `npm run check:ui` rejects stale views.

Design target, including administrative browser parity still to be implemented. Graph validation proves consistency of the declared design, not the behavior of shipped apps or third-party providers.

See [UI contract](../UX.md), [guide and validation](README.md), [flows and platform matrix](FLOWS.md), [inventory](INVENTORY.md), and [glossary](GLOSSARY.md). IDs are stable; labels may change.

## TERM-OWNER

**Owner.** Authenticated relay account that owns agents or registered devices. The same person can also be a recipient.

Related: [TERM-RECIPIENT](GLOSSARY.md#term-recipient), [TERM-AGENT](GLOSSARY.md#term-agent).

Pages: [AGENTS](INVENTORY.md#agents), [REGISTER-APPROVAL](INVENTORY.md#register-approval), [ACCOUNT](INVENTORY.md#account), [ACCOUNT-METHODS](INVENTORY.md#account-methods), [ACCOUNT-LINK](INVENTORY.md#account-link), [ACCOUNT-SIGNOUT](INVENTORY.md#account-signout), [ACCOUNT-DELETE](INVENTORY.md#account-delete), [ACCOUNT-PRIVACY](INVENTORY.md#account-privacy), [LOGIN](INVENTORY.md#login).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy).

## TERM-RECIPIENT

**Recipient.** Account explicitly allowing an agent to request responses. Its connection approval is separate from agent ownership.

Related: [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-OWNER](GLOSSARY.md#term-owner).

Pages: [PAIR-REVIEW](INVENTORY.md#pair-review).

Flows: None.

## TERM-AGENT

**Agent / service / caller.** Named requesting software. Agent is the UI term; service is the v3 API/CLI term; caller is the older request identity. An agent may be used by a script, a terminal agent, or a hosted provider.

Related: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted).

Pages: [AGENTS](INVENTORY.md#agents), [AGENT](INVENTORY.md#agent), [AGENT-AVAILABILITY](INVENTORY.md#agent-availability), [AGENT-DELETE](INVENTORY.md#agent-delete), [AGENT-CLI](INVENTORY.md#agent-cli).

Flows: [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete).

## TERM-REGISTRATION

**Agent registration.** Establishing ownership and the agent declaration. Does not grant access to any recipient, including its owner.

Related: [TERM-AGENT](GLOSSARY.md#term-agent), [TERM-CONNECTION](GLOSSARY.md#term-connection).

Pages: [AGENT-CREATE](INVENTORY.md#agent-create), [REGISTER-APPROVAL](INVENTORY.md#register-approval).

Flows: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

## TERM-CONNECTION

**Connection / peering / grant.** Recipient-approved access for one agent, with explicit capabilities and optional expiry. Peering is the settings category; grant is the authorization record.

Related: [TERM-CAPABILITY](GLOSSARY.md#term-capability), [TERM-RECIPIENT](GLOSSARY.md#term-recipient).

Pages: [AGENT-AVAILABILITY](INVENTORY.md#agent-availability), [AGENT-DELETE](INVENTORY.md#agent-delete), [PEERING](INVENTORY.md#peering), [CONNECTIONS](INVENTORY.md#connections), [PAIR-REVIEW](INVENTORY.md#pair-review), [PAIR-PROGRESS](INVENTORY.md#pair-progress), [CONNECTION](INVENTORY.md#connection), [CONNECTION-EXPIRY](INVENTORY.md#connection-expiry), [CONNECTION-DISCONNECT](INVENTORY.md#connection-disconnect).

Flows: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-SEARCH](FLOWS.md#flow-search), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing).

## TERM-CAPABILITY

**Capability.** Permission for forms/decisions or upcoming SMS codes. The agent must declare it and the recipient must approve it. A form SMS helper also needs SMS permission.

Related: [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-REQUEST](GLOSSARY.md#term-request).

Pages: [AGENT-CREATE](INVENTORY.md#agent-create), [PAIR-REVIEW](INVENTORY.md#pair-review), [CONNECTION-PERMISSIONS](INVENTORY.md#connection-permissions), [SMS](INVENTORY.md#sms), [FORM](INVENTORY.md#form), [AGENT-REQUEST](INVENTORY.md#agent-request).

Flows: [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools), [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions).

## TERM-DEVICE

**Receiving device.** Registered Android or iOS installation eligible to receive requests. Pausing stops reception without deleting the account or agent connections.

Related: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [TERM-OWNER](GLOSSARY.md#term-owner).

Pages: [DEVICES](INVENTORY.md#devices), [DEVICE-RECEIVE](INVENTORY.md#device-receive), [DEVICE-REMOVE](INVENTORY.md#device-remove), [PAIR-PROGRESS](INVENTORY.md#pair-progress), [PHONE-NOTIFICATIONS](INVENTORY.md#phone-notifications), [PHONE-REGISTER](INVENTORY.md#phone-register), [PHONE-HANDOFF](INVENTORY.md#phone-handoff).

Flows: [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device).

## TERM-TICKET

**Private session ticket.** Private file containing the service credential and delivery private keys. Save/import outside chats, model outputs, public links, and QR codes. It contains no recipient approval.

Related: [TERM-PROFILE](GLOSSARY.md#term-profile), [TERM-REGISTRATION](GLOSSARY.md#term-registration).

Pages: [AGENT-CREATE](INVENTORY.md#agent-create), [AGENT-TICKET](INVENTORY.md#agent-ticket), [AGENT-TICKET-CLEAR](INVENTORY.md#agent-ticket-clear), [AGENT-CLI](INVENTORY.md#agent-cli).

Flows: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear).

## TERM-PROFILE

**Private local profile.** CLI/SDK storage for one agent and its selected recipient connections. Profiles exist on agent software hosts, independently of the platform where the owner approves a link.

Related: [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [TERM-TICKET](GLOSSARY.md#term-ticket).

Pages: [AGENT-TICKET](INVENTORY.md#agent-ticket), [AGENT-CLI](INVENTORY.md#agent-cli), [TUI-CLIENT](INVENTORY.md#tui-client).

Flows: [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools).

## TERM-PUBLIC-LINK

**Public approval or connection link.** HTTPS link or QR identifying a registration/approval session or reusable service. Opening it never grants access. A comparison code is shown only when supplied for that session.

Related: [TERM-REGISTRATION](GLOSSARY.md#term-registration), [TERM-CONNECTION](GLOSSARY.md#term-connection).

Pages: [AGENT-SHARE](INVENTORY.md#agent-share), [INVITATION](INVENTORY.md#invitation), [PAIR-REVIEW](INVENTORY.md#pair-review), [PHONE-HANDOFF](INVENTORY.md#phone-handoff).

Flows: [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-SHARE](FLOWS.md#flow-share).

## TERM-OAUTH

**Hosted OAuth connection.** Provider-bound authorization to a named-service MCP resource. The recipient approves relay access, then returns to the provider. Credentials remain in provider/application software.

Related: [HOSTED](FLOWS.md#hosted), [TERM-CONNECTION](GLOSSARY.md#term-connection).

Pages: [PAIR-REVIEW](INVENTORY.md#pair-review), [PAIR-PROGRESS](INVENTORY.md#pair-progress), [HOSTED-CLIENT](INVENTORY.md#hosted-client).

Flows: [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator).

## TERM-REQUEST

**Request.** Pending SMS-code request or form/decision sent through one approved connection. Opening a request, leaving its page, and cancelling it have different effects.

Related: [TERM-INBOX](GLOSSARY.md#term-inbox), [TERM-CAPABILITY](GLOSSARY.md#term-capability).

Pages: [INBOX](INVENTORY.md#inbox), [SMS](INVENTORY.md#sms), [FORM](INVENTORY.md#form), [WIZARD](INVENTORY.md#wizard), [FORM-REVIEW](INVENTORY.md#form-review), [REQUEST-OUTCOME](INVENTORY.md#request-outcome), [AGENT-REQUEST](INVENTORY.md#agent-request).

Flows: [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome).

## TERM-INBOX

**Inbox.** Pending work only. Contains no completed-request feed, history tab, history shortcut, or settings search.

Related: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-HISTORY](GLOSSARY.md#term-history).

Pages: [INBOX](INVENTORY.md#inbox).

Flows: None.

## TERM-HISTORY

**History.** Metadata-only completed SMS outcomes, exclusively under Administration. Contains no codes or form answers. Form response outcomes are not a new historical feed.

Related: [TERM-INBOX](GLOSSARY.md#term-inbox), [TERM-REQUEST](GLOSSARY.md#term-request).

Pages: [SETTINGS-SEARCH](INVENTORY.md#settings-search), [HISTORY](INVENTORY.md#history).

Flows: [FLOW-SEARCH](FLOWS.md#flow-search), [FLOW-HISTORY](FLOWS.md#flow-history).

## TERM-RETURN

**Origin-aware return.** Back/Close navigates without cancelling a request. Android notification responses return to the previous app; Inbox responses return to Inbox. iOS dismisses the response sheet or pops its stack. Browser OAuth returns to the original requesting provider.

Related: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser), [TERM-OAUTH](GLOSSARY.md#term-oauth).

Pages: [LOGIN](INVENTORY.md#login), [SMS](INVENTORY.md#sms), [REQUEST-OUTCOME](INVENTORY.md#request-outcome).

Flows: [FLOW-LOGIN](FLOWS.md#flow-login), [FLOW-PHONE](FLOWS.md#flow-phone), [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome), [FLOW-SIGNOUT](FLOWS.md#flow-signout).

## TERM-RECOVERY

**Safe exit and recovery.** Retry the same operation/session after a recoverable failure, or explicitly leave without implying rollback of accepted server changes. Expired approval needs a new session; private drafts are not persisted for process recovery.

Related: [TERM-RETURN](GLOSSARY.md#term-return), [TERM-TICKET](GLOSSARY.md#term-ticket).

Pages: [PAIR-PROGRESS](INVENTORY.md#pair-progress), [ACCOUNT-DELETE](INVENTORY.md#account-delete), [ACCOUNT-DELETION](INVENTORY.md#account-deletion).

Flows: [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account).
