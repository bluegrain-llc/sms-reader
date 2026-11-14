# Page and UI inventory

Generated from [contract.mjs](contract.mjs). Edit the source and run `npm run docs:ui`; `npm run check:ui` rejects stale views.

Design target, including administrative browser parity still to be implemented. Graph validation proves consistency of the declared design, not the behavior of shipped apps or third-party providers.

See [UI contract](../UX.md), [guide and validation](README.md), [flows and platform matrix](FLOWS.md), [inventory](INVENTORY.md), and [glossary](GLOSSARY.md). IDs are stable; labels may change.

Each page has one purpose. Back/Close is always explicit and never silently submits, cancels a request, or rolls back accepted changes. Platform lists describe relay UI availability; external agent software runs on its own host independently of the approval platform. Runtime-generated request fields use the declared field ID beneath their stable control family.

| Page ID | Name | Group | Platforms |
| --- | --- | --- | --- |
| [SETTINGS](INVENTORY.md#settings) | Settings | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [SETTINGS-SEARCH](INVENTORY.md#settings-search) | Search settings | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ADMINISTRATION](INVENTORY.md#administration) | Administration | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [DEVICES](INVENTORY.md#devices) | Devices | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [DEVICE-RECEIVE](INVENTORY.md#device-receive) | Receive requests on device | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [DEVICE-REMOVE](INVENTORY.md#device-remove) | Remove device | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [HISTORY](INVENTORY.md#history) | History | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENTS](INVENTORY.md#agents) | My agents | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT](INVENTORY.md#agent) | Agent menu | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-CREATE](INVENTORY.md#agent-create) | Create agent | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-TICKET](INVENTORY.md#agent-ticket) | Save session ticket | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-TICKET-CLEAR](INVENTORY.md#agent-ticket-clear) | Clear retained ticket | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-SHARE](INVENTORY.md#agent-share) | Share connection link | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-AVAILABILITY](INVENTORY.md#agent-availability) | Agent availability | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-DELETE](INVENTORY.md#agent-delete) | Delete agent | Administration | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [PEERING](INVENTORY.md#peering) | Peering | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [CONNECTIONS](INVENTORY.md#connections) | Connections | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [INVITATION](INVENTORY.md#invitation) | Open connection invitation | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [PAIR-REVIEW](INVENTORY.md#pair-review) | Approve connection | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [PAIR-PROGRESS](INVENTORY.md#pair-progress) | Connection progress | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [CONNECTION](INVENTORY.md#connection) | Connection menu | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [CONNECTION-PERMISSIONS](INVENTORY.md#connection-permissions) | Change permissions | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [CONNECTION-EXPIRY](INVENTORY.md#connection-expiry) | Change expiry | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [CONNECTION-DISCONNECT](INVENTORY.md#connection-disconnect) | Disconnect | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [REGISTER-APPROVAL](INVENTORY.md#register-approval) | Approve agent registration | Peering | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT](INVENTORY.md#account) | Account | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT-METHODS](INVENTORY.md#account-methods) | Sign-in methods | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT-LINK](INVENTORY.md#account-link) | Link sign-in method | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT-SIGNOUT](INVENTORY.md#account-signout) | Sign out | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT-DELETE](INVENTORY.md#account-delete) | Delete account | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT-DELETION](INVENTORY.md#account-deletion) | Deletion status | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [ACCOUNT-PRIVACY](INVENTORY.md#account-privacy) | Privacy | Account | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [LOGIN](INVENTORY.md#login) | Sign in | Initial Login | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [PHONE-NOTIFICATIONS](INVENTORY.md#phone-notifications) | Enable notifications | Initial Login | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [PHONE-REGISTER](INVENTORY.md#phone-register) | Register this phone | Initial Login | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [PHONE-HANDOFF](INVENTORY.md#phone-handoff) | Continue on a phone | Initial Login | [BROWSER](FLOWS.md#browser) |
| [INBOX](INVENTORY.md#inbox) | Inbox | Requests | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [SMS](INVENTORY.md#sms) | Respond with SMS code | Requests | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [FORM](INVENTORY.md#form) | Answer form | Requests | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [WIZARD](INVENTORY.md#wizard) | Wizard step | Requests | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [FORM-REVIEW](INVENTORY.md#form-review) | Review answers | Requests | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [REQUEST-OUTCOME](INVENTORY.md#request-outcome) | Request outcome | Requests | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios) |
| [AGENT-CLI](INVENTORY.md#agent-cli) | Agent software terminal | External | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [AGENT-REQUEST](INVENTORY.md#agent-request) | Requesting agent software | External | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [TUI-CLIENT](INVENTORY.md#tui-client) | Terminal coding agent configuration | External | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |
| [HOSTED-CLIENT](INVENTORY.md#hosted-client) | Hosted agent connection | External | [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser) |

## SETTINGS

**Settings** — Choose an administrative destination.

Show only: Search widget and category rows only.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: None. Direct flows: [FLOW-SEARCH](FLOWS.md#flow-search). Flows through child pages: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-HISTORY](FLOWS.md#flow-history), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear), [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="settings-open-search"></a>`SETTINGS-OPEN-SEARCH` | Search settings / navigation | Open settings search. Targets: [SETTINGS-SEARCH](INVENTORY.md#settings-search). | [FLOW-SEARCH](FLOWS.md#flow-search) |
| <a id="settings-administration"></a>`SETTINGS-ADMINISTRATION` | Administration / navigation | Devices, owned agents, and history. Targets: [ADMINISTRATION](INVENTORY.md#administration). | Navigation to the linked destination or invoking context. |
| <a id="settings-peering"></a>`SETTINGS-PEERING` | Peering / navigation | Recipient connections. Targets: [PEERING](INVENTORY.md#peering). | Navigation to the linked destination or invoking context. |
| <a id="settings-account"></a>`SETTINGS-ACCOUNT` | Account / navigation | Identity and lifecycle. Targets: [ACCOUNT](INVENTORY.md#account). | Navigation to the linked destination or invoking context. |
| <a id="settings-back"></a>`SETTINGS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-SEARCH](FLOWS.md#flow-search) |

## SETTINGS-SEARCH

**Search settings** — Find a settings destination.

Show only: Query, destination labels/breadcrumbs, no-results state; no request content.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [SETTINGS](INVENTORY.md#settings).

Glossary: [TERM-HISTORY](GLOSSARY.md#term-history). Direct flows: [FLOW-SEARCH](FLOWS.md#flow-search). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="settings-search-query"></a>`SETTINGS-SEARCH-QUERY` | Search query / input | Match labels and synonyms. | [FLOW-SEARCH](FLOWS.md#flow-search) |
| <a id="settings-search-clear"></a>`SETTINGS-SEARCH-CLEAR` | Clear query / edit | Empty the query; stay here. | [FLOW-SEARCH](FLOWS.md#flow-search) |
| <a id="settings-search-open"></a>`SETTINGS-SEARCH-OPEN` | Open result / navigation | Navigate without executing actions. Select an object before object-specific edits. Targets: [DEVICES](INVENTORY.md#devices), [AGENTS](INVENTORY.md#agents), [HISTORY](INVENTORY.md#history), [CONNECTIONS](INVENTORY.md#connections), [ACCOUNT-METHODS](INVENTORY.md#account-methods), [ACCOUNT-PRIVACY](INVENTORY.md#account-privacy), [ACCOUNT-SIGNOUT](INVENTORY.md#account-signout), [ACCOUNT-DELETE](INVENTORY.md#account-delete). | [FLOW-SEARCH](FLOWS.md#flow-search) |
| <a id="settings-search-back"></a>`SETTINGS-SEARCH-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [SETTINGS](INVENTORY.md#settings). | [FLOW-SEARCH](FLOWS.md#flow-search) |

## ADMINISTRATION

**Administration** — Choose a device, agent, or history task.

Show only: Navigation rows only.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [SETTINGS](INVENTORY.md#settings).

Glossary: None. Direct flows: None. Flows through child pages: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-HISTORY](FLOWS.md#flow-history), [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="administration-devices"></a>`ADMINISTRATION-DEVICES` | Devices / navigation | Select a device. Targets: [DEVICES](INVENTORY.md#devices). | Navigation to the linked destination or invoking context. |
| <a id="administration-agents"></a>`ADMINISTRATION-AGENTS` | My agents / navigation | Select an owned agent. Targets: [AGENTS](INVENTORY.md#agents). | Navigation to the linked destination or invoking context. |
| <a id="administration-history"></a>`ADMINISTRATION-HISTORY` | History / navigation | Read completed SMS metadata. Targets: [HISTORY](INVENTORY.md#history). | Navigation to the linked destination or invoking context. |
| <a id="administration-back"></a>`ADMINISTRATION-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [SETTINGS](INVENTORY.md#settings). | Navigation to the linked destination or invoking context. |

## DEVICES

**Devices** — Select a receiving device.

Show only: Names, receive/paused status, this-phone marker.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ADMINISTRATION](INVENTORY.md#administration).

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device). Direct flows: None. Flows through child pages: [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception), [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="devices-open"></a>`DEVICES-OPEN` | Select device / navigation | Open selected device. Targets: [DEVICE-RECEIVE](INVENTORY.md#device-receive). | Navigation to the linked destination or invoking context. |
| <a id="devices-add"></a>`DEVICES-ADD` | Add this phone / navigation | Native platforms register this phone; browser hands off. Targets: [PHONE-REGISTER](INVENTORY.md#phone-register), [PHONE-HANDOFF](INVENTORY.md#phone-handoff). | Navigation to the linked destination or invoking context. |
| <a id="devices-refresh"></a>`DEVICES-REFRESH` | Pull to refresh / observe | Refresh device metadata. | Local edit/refresh; remains on this page, with Back available. |
| <a id="devices-back"></a>`DEVICES-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ADMINISTRATION](INVENTORY.md#administration). | Navigation to the linked destination or invoking context. |

## DEVICE-RECEIVE

**Receive requests on device** — Change reception on one device.

Show only: Selected device and current receive state.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [DEVICES](INVENTORY.md#devices).

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device). Direct flows: [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="device-receive-toggle"></a>`DEVICE-RECEIVE-TOGGLE` | Receive requests / submit | Pause or resume selected device. | [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception) |
| <a id="device-receive-remove"></a>`DEVICE-RECEIVE-REMOVE` | Remove device / navigation | Open dedicated confirmation. Targets: [DEVICE-REMOVE](INVENTORY.md#device-remove). | Navigation to the linked destination or invoking context. |
| <a id="device-receive-back"></a>`DEVICE-RECEIVE-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [DEVICES](INVENTORY.md#devices). | [FLOW-DEVICE-RECEPTION](FLOWS.md#flow-device-reception) |

## DEVICE-REMOVE

**Remove device** — Confirm removal of one device.

Show only: Device identity and removal consequence.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [DEVICES](INVENTORY.md#devices).

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device). Direct flows: [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="device-remove-submit"></a>`DEVICE-REMOVE-SUBMIT` | Remove device / submit | Stop reception on this installation; other devices/connections remain. | [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device) |
| <a id="device-remove-back"></a>`DEVICE-REMOVE-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [DEVICES](INVENTORY.md#devices). | [FLOW-REMOVE-DEVICE](FLOWS.md#flow-remove-device) |

## HISTORY

**History** — Read completed SMS metadata.

Show only: Caller, status, reason; no codes or answers.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ADMINISTRATION](INVENTORY.md#administration).

Glossary: [TERM-HISTORY](GLOSSARY.md#term-history). Direct flows: [FLOW-HISTORY](FLOWS.md#flow-history). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="history-refresh"></a>`HISTORY-REFRESH` | Pull to refresh / observe | Refresh metadata; an empty history is a valid result. | [FLOW-HISTORY](FLOWS.md#flow-history) |
| <a id="history-back"></a>`HISTORY-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ADMINISTRATION](INVENTORY.md#administration). | [FLOW-HISTORY](FLOWS.md#flow-history) |

## AGENTS

**My agents** — Select an owned agent.

Show only: Names and enabled state.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ADMINISTRATION](INVENTORY.md#administration).

Glossary: [TERM-AGENT](GLOSSARY.md#term-agent), [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: None. Flows through child pages: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agents-open"></a>`AGENTS-OPEN` | Select agent / navigation | Open an agent task menu. Targets: [AGENT](INVENTORY.md#agent). | Navigation to the linked destination or invoking context. |
| <a id="agents-create"></a>`AGENTS-CREATE` | Create agent / navigation | Open creation form. Targets: [AGENT-CREATE](INVENTORY.md#agent-create). | Navigation to the linked destination or invoking context. |
| <a id="agents-refresh"></a>`AGENTS-REFRESH` | Pull to refresh / observe | Refresh owned agents. | Local edit/refresh; remains on this page, with Back available. |
| <a id="agents-back"></a>`AGENTS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ADMINISTRATION](INVENTORY.md#administration). | Navigation to the linked destination or invoking context. |

## AGENT

**Agent menu** — Choose a task for one agent.

Show only: Selected name and task rows only.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENTS](INVENTORY.md#agents).

Glossary: [TERM-AGENT](GLOSSARY.md#term-agent). Direct flows: None. Flows through child pages: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent), [FLOW-SHARE](FLOWS.md#flow-share), [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability), [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete), [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-open-share"></a>`AGENT-OPEN-SHARE` | Connection link / navigation | Open public sharing. Targets: [AGENT-SHARE](INVENTORY.md#agent-share). | Navigation to the linked destination or invoking context. |
| <a id="agent-open-availability"></a>`AGENT-OPEN-AVAILABILITY` | Availability / navigation | Open enable/disable. Targets: [AGENT-AVAILABILITY](INVENTORY.md#agent-availability). | Navigation to the linked destination or invoking context. |
| <a id="agent-open-ticket"></a>`AGENT-OPEN-TICKET` | Save session ticket / navigation | Only when private provisioning state is retained. Targets: [AGENT-TICKET](INVENTORY.md#agent-ticket). | Navigation to the linked destination or invoking context. |
| <a id="agent-clear"></a>`AGENT-CLEAR` | Clear retained ticket / navigation | Only when private provisioning state is retained. Targets: [AGENT-TICKET-CLEAR](INVENTORY.md#agent-ticket-clear). | Navigation to the linked destination or invoking context. |
| <a id="agent-open-delete"></a>`AGENT-OPEN-DELETE` | Delete agent / navigation | Open deletion confirmation. Targets: [AGENT-DELETE](INVENTORY.md#agent-delete). | Navigation to the linked destination or invoking context. |
| <a id="agent-back"></a>`AGENT-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENTS](INVENTORY.md#agents). | Navigation to the linked destination or invoking context. |

## AGENT-CREATE

**Create agent** — Declare a new owned agent.

Show only: Declaration fields; registration never grants recipient access.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENTS](INVENTORY.md#agents).

Glossary: [TERM-REGISTRATION](GLOSSARY.md#term-registration), [TERM-CAPABILITY](GLOSSARY.md#term-capability), [TERM-TICKET](GLOSSARY.md#term-ticket). Direct flows: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-create-name"></a>`AGENT-CREATE-NAME` | Name / input | Agent display name. | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |
| <a id="agent-create-description"></a>`AGENT-CREATE-DESCRIPTION` | Description / input | Purpose of requests. | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |
| <a id="agent-create-capabilities"></a>`AGENT-CREATE-CAPABILITIES` | Forms / SMS / input | Choose declared capabilities. | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |
| <a id="agent-create-submit"></a>`AGENT-CREATE-SUBMIT` | Create agent / submit | Retain private provisioning state before registration; proceed to ticket saving. | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |
| <a id="agent-create-back"></a>`AGENT-CREATE-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENTS](INVENTORY.md#agents). | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |

## AGENT-TICKET

**Save session ticket** — Save the retained private ticket.

Show only: Agent name, file-save state, private-file guidance.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENT](INVENTORY.md#agent).

Glossary: [TERM-TICKET](GLOSSARY.md#term-ticket), [TERM-PROFILE](GLOSSARY.md#term-profile). Direct flows: [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-ticket-save"></a>`AGENT-TICKET-SAVE` | Save ticket / system | Android document picker; iOS file exporter; browser file download/save. | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |
| <a id="agent-ticket-done"></a>`AGENT-TICKET-DONE` | Done / navigation | Return to the agent menu without clearing retained state. Targets: [AGENT](INVENTORY.md#agent). | Navigation to the linked destination or invoking context. |
| <a id="agent-ticket-back"></a>`AGENT-TICKET-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENT](INVENTORY.md#agent). | [FLOW-CREATE-AGENT](FLOWS.md#flow-create-agent) |

## AGENT-TICKET-CLEAR

**Clear retained ticket** — Explicitly discard a safely exported retained copy.

Show only: Selected ticket and private-key recovery consequence.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENT](INVENTORY.md#agent).

Glossary: [TERM-TICKET](GLOSSARY.md#term-ticket). Direct flows: [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-ticket-clear-ack"></a>`AGENT-TICKET-CLEAR-ACK` | Ticket safely saved or agent deleted / input | Acknowledge the recovery consequence. | [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear) |
| <a id="agent-ticket-clear-submit"></a>`AGENT-TICKET-CLEAR-SUBMIT` | Clear retained copy / submit | Verify selected owner/ticket still match; never clear on failed export. | [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear) |
| <a id="agent-ticket-clear-back"></a>`AGENT-TICKET-CLEAR-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENT](INVENTORY.md#agent). | [FLOW-TICKET-CLEAR](FLOWS.md#flow-ticket-clear) |

## AGENT-SHARE

**Share connection link** — Share one public agent link.

Show only: Public HTTPS link and QR only.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENT](INVENTORY.md#agent).

Glossary: [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link). Direct flows: [FLOW-SHARE](FLOWS.md#flow-share). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-share-copy"></a>`AGENT-SHARE-COPY` | Copy link / system | Copy the public link only. | [FLOW-SHARE](FLOWS.md#flow-share) |
| <a id="agent-share-share"></a>`AGENT-SHARE-SHARE` | Share link / system | Use platform share/copy fallback. | [FLOW-SHARE](FLOWS.md#flow-share) |
| <a id="agent-share-back"></a>`AGENT-SHARE-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENT](INVENTORY.md#agent). | [FLOW-SHARE](FLOWS.md#flow-share) |

## AGENT-AVAILABILITY

**Agent availability** — Enable or disable one agent.

Show only: Selected name, current state, effect on every connection.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENT](INVENTORY.md#agent).

Glossary: [TERM-AGENT](GLOSSARY.md#term-agent), [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-availability-submit"></a>`AGENT-AVAILABILITY-SUBMIT` | Enable / disable agent / submit | Change parent service availability without deleting it. | [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability) |
| <a id="agent-availability-back"></a>`AGENT-AVAILABILITY-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENT](INVENTORY.md#agent). | [FLOW-AGENT-AVAILABILITY](FLOWS.md#flow-agent-availability) |

## AGENT-DELETE

**Delete agent** — Confirm deletion of one agent.

Show only: Selected name and effect on every recipient connection.

Group: Administration. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [AGENT](INVENTORY.md#agent).

Glossary: [TERM-AGENT](GLOSSARY.md#term-agent), [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-delete-submit"></a>`AGENT-DELETE-SUBMIT` | Delete agent / submit | Block all its connections and queue cleanup. | [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete) |
| <a id="agent-delete-back"></a>`AGENT-DELETE-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [AGENT](INVENTORY.md#agent). | [FLOW-AGENT-DELETE](FLOWS.md#flow-agent-delete) |

## PEERING

**Peering** — Choose a recipient connection task.

Show only: Connection and invitation-entry rows.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [SETTINGS](INVENTORY.md#settings).

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: None. Flows through child pages: [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="peering-connections"></a>`PEERING-CONNECTIONS` | Connections / navigation | Select current access. Targets: [CONNECTIONS](INVENTORY.md#connections). | Navigation to the linked destination or invoking context. |
| <a id="peering-invitation"></a>`PEERING-INVITATION` | Open invitation / navigation | Enter a public link/code. Targets: [INVITATION](INVENTORY.md#invitation). | Navigation to the linked destination or invoking context. |
| <a id="peering-back"></a>`PEERING-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [SETTINGS](INVENTORY.md#settings). | Navigation to the linked destination or invoking context. |

## CONNECTIONS

**Connections** — Select an approved connection.

Show only: Agent names, effective permissions, status/expiry.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [PEERING](INVENTORY.md#peering).

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: None. Flows through child pages: [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="connections-open"></a>`CONNECTIONS-OPEN` | Select connection / navigation | Select before editing. Targets: [CONNECTION](INVENTORY.md#connection). | Navigation to the linked destination or invoking context. |
| <a id="connections-new"></a>`CONNECTIONS-NEW` | New connection / navigation | Locate an invitation. Targets: [INVITATION](INVENTORY.md#invitation). | Navigation to the linked destination or invoking context. |
| <a id="connections-refresh"></a>`CONNECTIONS-REFRESH` | Pull to refresh / observe | Refresh connection metadata. | Local edit/refresh; remains on this page, with Back available. |
| <a id="connections-back"></a>`CONNECTIONS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [PEERING](INVENTORY.md#peering). | Navigation to the linked destination or invoking context. |

## INVITATION

**Open connection invitation** — Locate a public approval session.

Show only: Public link/code input; no credentials.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [PEERING](INVENTORY.md#peering).

Glossary: [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link). Direct flows: [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="invitation-value"></a>`INVITATION-VALUE` | Public link or code / input | Android camera links/iOS scanner may fill/open this destination. | [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation) |
| <a id="invitation-open"></a>`INVITATION-OPEN` | Open invitation / submit | Resolve link/code on the configured relay; opening grants no access. | [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation) |
| <a id="invitation-back"></a>`INVITATION-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [PEERING](INVENTORY.md#peering). | [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation) |

## PAIR-REVIEW

**Approve connection** — Decide one recipient access grant.

Show only: Agent purpose, recipient identity, requested permissions/duration, comparison code if present; hosted client details when applicable.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [PEERING](INVENTORY.md#peering).

Glossary: [TERM-RECIPIENT](GLOSSARY.md#term-recipient), [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-CAPABILITY](GLOSSARY.md#term-capability), [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link), [TERM-OAUTH](GLOSSARY.md#term-oauth). Direct flows: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="pair-review-capabilities"></a>`PAIR-REVIEW-CAPABILITIES` | Allowed forms / SMS / input | Narrow declared/requested permissions. | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
| <a id="pair-review-duration"></a>`PAIR-REVIEW-DURATION` | Access duration / input | Narrow to permitted duration. | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
| <a id="pair-review-submit"></a>`PAIR-REVIEW-SUBMIT` | Connect / submit | Approve this session only. | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
| <a id="pair-review-decline"></a>`PAIR-REVIEW-DECLINE` | Decline / submit | Deny this session explicitly. | [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing) |
| <a id="pair-review-account"></a>`PAIR-REVIEW-ACCOUNT` | Use another account / navigation | Authenticate the intended account before deciding; re-evaluate session binding. Targets: [LOGIN](INVENTORY.md#login). | Navigation to the linked destination or invoking context. |
| <a id="pair-review-restart"></a>`PAIR-REVIEW-RESTART` | Open fresh invitation / navigation | Expired links require a fresh invitation/attempt, never a silent approval. Targets: [INVITATION](INVENTORY.md#invitation). | Navigation to the linked destination or invoking context. |
| <a id="pair-review-back"></a>`PAIR-REVIEW-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [PEERING](INVENTORY.md#peering). | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-OPEN-INVITATION](FLOWS.md#flow-open-invitation), [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect), [FLOW-DECLINE-PAIRING](FLOWS.md#flow-decline-pairing) |

## PAIR-PROGRESS

**Connection progress** — Finish the approved connection handoff.

Show only: Direct encrypted delivery or hosted OAuth return status; receiving-device readiness.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [PEERING](INVENTORY.md#peering).

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection), [TERM-OAUTH](GLOSSARY.md#term-oauth), [TERM-DEVICE](GLOSSARY.md#term-device), [TERM-RECOVERY](GLOSSARY.md#term-recovery). Direct flows: [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="pair-progress-wait"></a>`PAIR-PROGRESS-WAIT` | Check connection progress / wait | Wait with a deadline; retry same session after transient failure. Check deadline: ≤600s, capped by server expiry. | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect) |
| <a id="pair-progress-phone"></a>`PAIR-PROGRESS-PHONE` | Set up receiving phone / navigation | Only if no suitable receiving device exists. Targets: [PHONE-NOTIFICATIONS](INVENTORY.md#phone-notifications), [PHONE-HANDOFF](INVENTORY.md#phone-handoff). | Navigation to the linked destination or invoking context. |
| <a id="pair-progress-return"></a>`PAIR-PROGRESS-RETURN` | Done / Return to requesting app / navigation | Direct flow closes; hosted flow returns through the original validated callback. Targets: [HOSTED-CLIENT](INVENTORY.md#hosted-client). | Navigation to the linked destination or invoking context. |
| <a id="pair-progress-back"></a>`PAIR-PROGRESS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [PEERING](INVENTORY.md#peering). | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect) |

## CONNECTION

**Connection menu** — Choose a task for one connection.

Show only: Selected agent and task rows only.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [CONNECTIONS](INVENTORY.md#connections).

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: None. Flows through child pages: [FLOW-PERMISSIONS](FLOWS.md#flow-permissions), [FLOW-EXPIRY](FLOWS.md#flow-expiry), [FLOW-DISCONNECT](FLOWS.md#flow-disconnect).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="connection-open-permissions"></a>`CONNECTION-OPEN-PERMISSIONS` | Change permissions / navigation | Open one permissions form. Targets: [CONNECTION-PERMISSIONS](INVENTORY.md#connection-permissions). | Navigation to the linked destination or invoking context. |
| <a id="connection-open-expiry"></a>`CONNECTION-OPEN-EXPIRY` | Change expiry / navigation | Open one expiry form. Targets: [CONNECTION-EXPIRY](INVENTORY.md#connection-expiry). | Navigation to the linked destination or invoking context. |
| <a id="connection-open-disconnect"></a>`CONNECTION-OPEN-DISCONNECT` | Disconnect / navigation | Open revocation confirmation. Targets: [CONNECTION-DISCONNECT](INVENTORY.md#connection-disconnect). | Navigation to the linked destination or invoking context. |
| <a id="connection-back"></a>`CONNECTION-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [CONNECTIONS](INVENTORY.md#connections). | Navigation to the linked destination or invoking context. |

## CONNECTION-PERMISSIONS

**Change permissions** — Edit effective capabilities.

Show only: Selected agent and current allowed capabilities.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [CONNECTION](INVENTORY.md#connection).

Glossary: [TERM-CAPABILITY](GLOSSARY.md#term-capability). Direct flows: [FLOW-PERMISSIONS](FLOWS.md#flow-permissions). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="connection-permissions-value"></a>`CONNECTION-PERMISSIONS-VALUE` | Forms / SMS / input | Select permitted capabilities. | [FLOW-PERMISSIONS](FLOWS.md#flow-permissions) |
| <a id="connection-permissions-submit"></a>`CONNECTION-PERMISSIONS-SUBMIT` | Save permissions / submit | Reauthorize changes; SMS removal may cancel SMS helper work. | [FLOW-PERMISSIONS](FLOWS.md#flow-permissions) |
| <a id="connection-permissions-back"></a>`CONNECTION-PERMISSIONS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [CONNECTION](INVENTORY.md#connection). | [FLOW-PERMISSIONS](FLOWS.md#flow-permissions) |

## CONNECTION-EXPIRY

**Change expiry** — Edit connection duration.

Show only: Selected agent and current expiry.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [CONNECTION](INVENTORY.md#connection).

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: [FLOW-EXPIRY](FLOWS.md#flow-expiry). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="connection-expiry-value"></a>`CONNECTION-EXPIRY-VALUE` | Duration / input | Choose a supported duration. | [FLOW-EXPIRY](FLOWS.md#flow-expiry) |
| <a id="connection-expiry-submit"></a>`CONNECTION-EXPIRY-SUBMIT` | Save expiry / submit | Save explicitly. | [FLOW-EXPIRY](FLOWS.md#flow-expiry) |
| <a id="connection-expiry-back"></a>`CONNECTION-EXPIRY-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [CONNECTION](INVENTORY.md#connection). | [FLOW-EXPIRY](FLOWS.md#flow-expiry) |

## CONNECTION-DISCONNECT

**Disconnect** — Revoke one recipient connection.

Show only: Selected connection and access consequence.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [CONNECTION](INVENTORY.md#connection).

Glossary: [TERM-CONNECTION](GLOSSARY.md#term-connection). Direct flows: [FLOW-DISCONNECT](FLOWS.md#flow-disconnect). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="connection-disconnect-submit"></a>`CONNECTION-DISCONNECT-SUBMIT` | Disconnect / submit | Block requests/results for this connection. | [FLOW-DISCONNECT](FLOWS.md#flow-disconnect) |
| <a id="connection-disconnect-back"></a>`CONNECTION-DISCONNECT-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [CONNECTION](INVENTORY.md#connection). | [FLOW-DISCONNECT](FLOWS.md#flow-disconnect) |

## REGISTER-APPROVAL

**Approve agent registration** — Accept ownership of an agent declaration.

Show only: Declaration, ownership account, comparison code when supplied; no recipient approval.

Group: Peering. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [PEERING](INVENTORY.md#peering).

Glossary: [TERM-REGISTRATION](GLOSSARY.md#term-registration), [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="register-approval-submit"></a>`REGISTER-APPROVAL-SUBMIT` | Register agent / submit | Approve ownership only. | [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent) |
| <a id="register-approval-decline"></a>`REGISTER-APPROVAL-DECLINE` | Decline / submit | Decline ownership. | [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration) |
| <a id="register-approval-restart"></a>`REGISTER-APPROVAL-RESTART` | Open fresh registration link / navigation | Ask agent software for a new registration attempt. Targets: [AGENT-CLI](INVENTORY.md#agent-cli). | Navigation to the linked destination or invoking context. |
| <a id="register-approval-back"></a>`REGISTER-APPROVAL-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [PEERING](INVENTORY.md#peering). | [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DECLINE-REGISTRATION](FLOWS.md#flow-decline-registration) |

## ACCOUNT

**Account** — Choose an identity/lifecycle task.

Show only: Current identity and task rows only.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [SETTINGS](INVENTORY.md#settings).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: None. Flows through child pages: [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider), [FLOW-SIGNOUT](FLOWS.md#flow-signout), [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account), [FLOW-PRIVACY](FLOWS.md#flow-privacy).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-open-methods"></a>`ACCOUNT-OPEN-METHODS` | Sign-in methods / navigation | View linked providers. Targets: [ACCOUNT-METHODS](INVENTORY.md#account-methods). | Navigation to the linked destination or invoking context. |
| <a id="account-open-privacy"></a>`ACCOUNT-OPEN-PRIVACY` | Privacy / navigation | Read policy. Targets: [ACCOUNT-PRIVACY](INVENTORY.md#account-privacy). | Navigation to the linked destination or invoking context. |
| <a id="account-open-signout"></a>`ACCOUNT-OPEN-SIGNOUT` | Sign out / navigation | Open sign-out confirmation. Targets: [ACCOUNT-SIGNOUT](INVENTORY.md#account-signout). | Navigation to the linked destination or invoking context. |
| <a id="account-open-delete"></a>`ACCOUNT-OPEN-DELETE` | Delete account / navigation | Open deletion flow. Targets: [ACCOUNT-DELETE](INVENTORY.md#account-delete). | Navigation to the linked destination or invoking context. |
| <a id="account-back"></a>`ACCOUNT-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [SETTINGS](INVENTORY.md#settings). | Navigation to the linked destination or invoking context. |

## ACCOUNT-METHODS

**Sign-in methods** — Choose a provider to link.

Show only: Linked and available providers.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ACCOUNT](INVENTORY.md#account).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: None. Flows through child pages: [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider).

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-methods-link"></a>`ACCOUNT-METHODS-LINK` | Link provider / navigation | Select provider; never merge by matching email. Targets: [ACCOUNT-LINK](INVENTORY.md#account-link). | Navigation to the linked destination or invoking context. |
| <a id="account-methods-back"></a>`ACCOUNT-METHODS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ACCOUNT](INVENTORY.md#account). | Navigation to the linked destination or invoking context. |

## ACCOUNT-LINK

**Link sign-in method** — Link one provider to the current account.

Show only: Current account, selected provider, explicit linking consequence.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ACCOUNT-METHODS](INVENTORY.md#account-methods).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-link-submit"></a>`ACCOUNT-LINK-SUBMIT` | Continue with provider / system | Require linking consent; preserve original account identity on error/cancellation. | [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider) |
| <a id="account-link-back"></a>`ACCOUNT-LINK-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ACCOUNT-METHODS](INVENTORY.md#account-methods). | [FLOW-LINK-PROVIDER](FLOWS.md#flow-link-provider) |

## ACCOUNT-SIGNOUT

**Sign out** — Sign out on this installation.

Show only: Current account and local effect.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ACCOUNT](INVENTORY.md#account).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: [FLOW-SIGNOUT](FLOWS.md#flow-signout). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-signout-submit"></a>`ACCOUNT-SIGNOUT-SUBMIT` | Sign out / submit | Clear private response drafts and local session, then show login. | [FLOW-SIGNOUT](FLOWS.md#flow-signout) |
| <a id="account-signout-back"></a>`ACCOUNT-SIGNOUT-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ACCOUNT](INVENTORY.md#account). | [FLOW-SIGNOUT](FLOWS.md#flow-signout) |

## ACCOUNT-DELETE

**Delete account** — Confirm permanent account deletion.

Show only: Identity, concrete cleanup/access consequences.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ACCOUNT](INVENTORY.md#account).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner), [TERM-RECOVERY](GLOSSARY.md#term-recovery). Direct flows: [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-delete-ack"></a>`ACCOUNT-DELETE-ACK` | I understand deletion / input | Acknowledge permanent removal. | [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account) |
| <a id="account-delete-submit"></a>`ACCOUNT-DELETE-SUBMIT` | Verify identity and delete / system | Reauthenticate the same account; revoke linked Apple authorization when required; submit deletion once. | [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account) |
| <a id="account-delete-back"></a>`ACCOUNT-DELETE-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ACCOUNT](INVENTORY.md#account). | [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account) |

## ACCOUNT-DELETION

**Deletion status** — Read acceptance/cleanup state.

Show only: Accepted vs uncertain deletion; cleanup continues server-side.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [TERM-RECOVERY](GLOSSARY.md#term-recovery). Direct flows: [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-deletion-check"></a>`ACCOUNT-DELETION-CHECK` | Check deletion status / wait | Use retained receipt/status; reconcile uncertain acceptance before resubmitting. Check deadline: ≤600s, capped by server expiry. | [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account) |
| <a id="account-deletion-back"></a>`ACCOUNT-DELETION-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-DELETE-ACCOUNT](FLOWS.md#flow-delete-account) |

## ACCOUNT-PRIVACY

**Privacy** — Read the privacy policy.

Show only: Policy and necessary operator contact.

Group: Account. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Parent: [ACCOUNT](INVENTORY.md#account).

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner). Direct flows: [FLOW-PRIVACY](FLOWS.md#flow-privacy). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="account-privacy-contact"></a>`ACCOUNT-PRIVACY-CONTACT` | Operator contact / system | Open published contact method when configured; otherwise remain on policy with clear unavailable text. | [FLOW-PRIVACY](FLOWS.md#flow-privacy) |
| <a id="account-privacy-back"></a>`ACCOUNT-PRIVACY-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [ACCOUNT](INVENTORY.md#account). | [FLOW-PRIVACY](FLOWS.md#flow-privacy) |

## LOGIN

**Sign in** — Authenticate for the pending task.

Show only: Minimal purpose and provider choice; no account-management form.

Group: Initial Login. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [TERM-OWNER](GLOSSARY.md#term-owner), [TERM-RETURN](GLOSSARY.md#term-return). Direct flows: [FLOW-LOGIN](FLOWS.md#flow-login). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="login-provider"></a>`LOGIN-PROVIDER` | Google / Apple / input | Choose a configured provider. | [FLOW-LOGIN](FLOWS.md#flow-login) |
| <a id="login-submit"></a>`LOGIN-SUBMIT` | Continue with selected provider / system | Authenticate and resume the retained public destination; never auto-approve. | [FLOW-LOGIN](FLOWS.md#flow-login) |
| <a id="login-privacy"></a>`LOGIN-PRIVACY` | Privacy / navigation | Read policy and return to this sign-in task. Targets: [ACCOUNT-PRIVACY](INVENTORY.md#account-privacy). | Navigation to the linked destination or invoking context. |
| <a id="login-back"></a>`LOGIN-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-LOGIN](FLOWS.md#flow-login) |

## PHONE-NOTIFICATIONS

**Enable notifications** — Enable reception notifications.

Show only: Permission/channel requirement for this device.

Group: Initial Login. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Entry/return follows its invoking context.

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device). Direct flows: [FLOW-PHONE](FLOWS.md#flow-phone). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="phone-notifications-submit"></a>`PHONE-NOTIFICATIONS-SUBMIT` | Enable notifications / system | Request Android notification/channel or iOS notification authorization. | [FLOW-PHONE](FLOWS.md#flow-phone) |
| <a id="phone-notifications-settings"></a>`PHONE-NOTIFICATIONS-SETTINGS` | Open system settings / system | Recover denied permission, then recheck on return. | [FLOW-PHONE](FLOWS.md#flow-phone) |
| <a id="phone-notifications-back"></a>`PHONE-NOTIFICATIONS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-PHONE](FLOWS.md#flow-phone) |

## PHONE-REGISTER

**Register this phone** — Register a receiving installation.

Show only: Signed-in account and device registration purpose.

Group: Initial Login. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Entry/return follows its invoking context.

Glossary: [TERM-DEVICE](GLOSSARY.md#term-device). Direct flows: [FLOW-PHONE](FLOWS.md#flow-phone). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="phone-register-submit"></a>`PHONE-REGISTER-SUBMIT` | Register phone / submit | Register platform-specific device; recheck notification prerequisites. | [FLOW-PHONE](FLOWS.md#flow-phone) |
| <a id="phone-register-back"></a>`PHONE-REGISTER-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-PHONE](FLOWS.md#flow-phone) |

## PHONE-HANDOFF

**Continue on a phone** — Move a phone-only task to a native app.

Show only: Public destination link/QR, configured install guidance, same-account instruction.

Group: Initial Login. Surface: relay. Platforms: [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [TERM-PUBLIC-LINK](GLOSSARY.md#term-public-link), [TERM-DEVICE](GLOSSARY.md#term-device). Direct flows: [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="phone-handoff-open"></a>`PHONE-HANDOFF-OPEN` | Open / install app / system | Use configured Android/iOS installation guidance; reopen the same public link after installation. | [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone) |
| <a id="phone-handoff-check"></a>`PHONE-HANDOFF-CHECK` | Check receiving-device setup / wait | Recheck server readiness; browser never registers as a phone. Check deadline: ≤600s, capped by server expiry. | [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone) |
| <a id="phone-handoff-back"></a>`PHONE-HANDOFF-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-BROWSER-PHONE](FLOWS.md#flow-browser-phone) |

## INBOX

**Inbox** — Select pending work.

Show only: Pending rows only; empty state.

Group: Requests. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Entry/return follows its invoking context.

Glossary: [TERM-INBOX](GLOSSARY.md#term-inbox), [TERM-REQUEST](GLOSSARY.md#term-request). Direct flows: [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="inbox-open-sms"></a>`INBOX-OPEN-SMS` | Open SMS request / navigation | Explicitly start native readiness/listening. Targets: [SMS](INVENTORY.md#sms). | [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios) |
| <a id="inbox-open-form"></a>`INBOX-OPEN-FORM` | Open form / navigation | Load without submitting. Targets: [FORM](INVENTORY.md#form). | [FLOW-FORM](FLOWS.md#flow-form) |
| <a id="inbox-refresh"></a>`INBOX-REFRESH` | Pull to refresh / observe | Discover pending work only. | Local edit/refresh; remains on this page, with Back available. |
| <a id="inbox-setup"></a>`INBOX-SETUP` | Open Administration / navigation | Only for unmet receiving setup. Targets: [SETTINGS](INVENTORY.md#settings). | Navigation to the linked destination or invoking context. |
| <a id="inbox-back"></a>`INBOX-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-FORM](FLOWS.md#flow-form) |

## SMS

**Respond with SMS code** — Share one approved code.

Show only: Requester/purpose, deadline, listener/manual-entry state, candidate/code field.

Group: Requests. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Entry/return follows its invoking context.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RETURN](GLOSSARY.md#term-return), [TERM-CAPABILITY](GLOSSARY.md#term-capability). Direct flows: [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="sms-open"></a>`SMS-OPEN` | Open / retry this response / wait | Notification deep link loads only this response; complete necessary authentication/registration within the retained destination before starting native readiness. Check deadline: ≤600s, capped by server expiry. | [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms) |
| <a id="sms-code"></a>`SMS-CODE` | Code / input | Type deliberately; iOS may offer eligible AutoFill. | [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios) |
| <a id="sms-send"></a>`SMS-SEND` | Send / submit | Manual submission after validation. | [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios) |
| <a id="sms-consent"></a>`SMS-CONSENT` | Android SMS consent / choose candidate / system | Android only: consent submits a single candidate or chosen candidate. Only: [ANDROID](FLOWS.md#android). | [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android) |
| <a id="sms-cancel"></a>`SMS-CANCEL` | Cancel / decline request / submit | Explicit terminal action; Back is navigation only. | [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request) |
| <a id="sms-back"></a>`SMS-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-NOTIFICATION-SMS](FLOWS.md#flow-notification-sms), [FLOW-SMS-ANDROID](FLOWS.md#flow-sms-android), [FLOW-SMS-IOS](FLOWS.md#flow-sms-ios), [FLOW-DECLINE-REQUEST](FLOWS.md#flow-decline-request) |

## FORM

**Answer form** — Answer one information/decision request.

Show only: Requester, purpose, visible fields, declared actions.

Group: Requests. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Entry/return follows its invoking context.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-CAPABILITY](GLOSSARY.md#term-capability). Direct flows: [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="form-open"></a>`FORM-OPEN` | Open / retry this response / wait | Notification deep link loads this form and retains its target through necessary authentication/setup; never submit on opening. Check deadline: ≤600s, capped by server expiry. | [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form) |
| <a id="form-fields"></a>`FORM-FIELDS` | Requested fields / input | Native typed inputs; SMS helper requires SMS permission and platform-specific entry. | [FLOW-FORM](FLOWS.md#flow-form) |
| <a id="form-submit"></a>`FORM-SUBMIT` | Submit / Approve / Acknowledge / submit | Only the declared action submits. | [FLOW-FORM](FLOWS.md#flow-form) |
| <a id="form-decline"></a>`FORM-DECLINE` | Decline / submit | Only when the definition declares it. | [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form) |
| <a id="form-wizard"></a>`FORM-WIZARD` | Start multi-step response / navigation | Use wizard when defined. Targets: [WIZARD](INVENTORY.md#wizard). | [FLOW-WIZARD](FLOWS.md#flow-wizard) |
| <a id="form-back"></a>`FORM-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-NOTIFICATION-FORM](FLOWS.md#flow-notification-form), [FLOW-FORM](FLOWS.md#flow-form), [FLOW-WIZARD](FLOWS.md#flow-wizard), [FLOW-DECLINE-FORM](FLOWS.md#flow-decline-form) |

## WIZARD

**Wizard step** — Complete the current step.

Show only: Current fields and progress only.

Group: Requests. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Parent: [FORM](INVENTORY.md#form).

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request). Direct flows: [FLOW-WIZARD](FLOWS.md#flow-wizard). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="wizard-fields"></a>`WIZARD-FIELDS` | Current step fields / input | Retain in memory; prune hidden branches. | [FLOW-WIZARD](FLOWS.md#flow-wizard) |
| <a id="wizard-next"></a>`WIZARD-NEXT` | Next / submit | Validate current step; advance or review. | [FLOW-WIZARD](FLOWS.md#flow-wizard) |
| <a id="wizard-previous"></a>`WIZARD-PREVIOUS` | Previous step / navigation | Move within wizard without closing response. Targets: [WIZARD](INVENTORY.md#wizard). | [FLOW-WIZARD](FLOWS.md#flow-wizard) |
| <a id="wizard-back"></a>`WIZARD-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [FORM](INVENTORY.md#form). | [FLOW-WIZARD](FLOWS.md#flow-wizard) |

## FORM-REVIEW

**Review answers** — Confirm answers before final submission.

Show only: Only reachable answers to be sent.

Group: Requests. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Parent: [WIZARD](INVENTORY.md#wizard).

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request). Direct flows: [FLOW-WIZARD](FLOWS.md#flow-wizard). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="form-review-edit"></a>`FORM-REVIEW-EDIT` | Edit step / navigation | Return to the relevant step. Targets: [WIZARD](INVENTORY.md#wizard). | [FLOW-WIZARD](FLOWS.md#flow-wizard) |
| <a id="form-review-submit"></a>`FORM-REVIEW-SUBMIT` | Final declared action / submit | Submit once; reconcile uncertain result before retry. | [FLOW-WIZARD](FLOWS.md#flow-wizard) |
| <a id="form-review-back"></a>`FORM-REVIEW-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. Targets: [WIZARD](INVENTORY.md#wizard). | [FLOW-WIZARD](FLOWS.md#flow-wizard) |

## REQUEST-OUTCOME

**Request outcome** — Acknowledge the current response outcome.

Show only: Submitted/declined/expired/handled-elsewhere state without secret values.

Group: Requests. Surface: relay. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios). Entry/return follows its invoking context.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-RETURN](GLOSSARY.md#term-return). Direct flows: [FLOW-FORM](FLOWS.md#flow-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="request-outcome-back"></a>`REQUEST-OUTCOME-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-FORM](FLOWS.md#flow-form), [FLOW-REQUEST-OUTCOME](FLOWS.md#flow-request-outcome) |

## AGENT-CLI

**Agent software terminal** — Operate private agent software.

Show only: Public setup links/status; private configuration stays in files.

Group: External. Surface: external. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [TERM-PROFILE](GLOSSARY.md#term-profile), [TERM-TICKET](GLOSSARY.md#term-ticket), [TERM-AGENT](GLOSSARY.md#term-agent). Direct flows: [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-cli-register"></a>`AGENT-CLI-REGISTER` | relay service register / command | Create a private profile; present registration link/QR. | [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent) |
| <a id="agent-cli-import"></a>`AGENT-CLI-IMPORT` | relay service import-ticket / command | Import a private ticket into an unused profile outside model tools. | [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket) |
| <a id="agent-cli-connect"></a>`AGENT-CLI-CONNECT` | relay service connect / command | Present pairing link/QR and comparison code. | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect) |
| <a id="agent-cli-deliveries"></a>`AGENT-CLI-DELIVERIES` | relay service deliveries / relay resume / wait | Save/decrypt delivery durably before acknowledgement; resume after interruption. Check deadline: ≤600s, capped by server expiry. | [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect) |
| <a id="agent-cli-hosted-link"></a>`AGENT-CLI-HOSTED-LINK` | relay service hosted-link / command | Return public named-service MCP URL only. | [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator) |
| <a id="agent-cli-resume"></a>`AGENT-CLI-RESUME` | relay resume / relay status / command | Reconcile retained registration/pairing/delivery state; fresh expired sessions require explicit restart. | [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent) |
| <a id="agent-cli-back"></a>`AGENT-CLI-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-IMPORT-TICKET](FLOWS.md#flow-import-ticket), [FLOW-REGISTER-AGENT](FLOWS.md#flow-register-agent), [FLOW-DIRECT-CONNECT](FLOWS.md#flow-direct-connect), [FLOW-HOSTED-OPERATOR](FLOWS.md#flow-hosted-operator) |

## AGENT-REQUEST

**Requesting agent software** — Run one authorized request from script, terminal, or hosted software.

Show only: Request status and authorized result; lifecycle credentials stay outside model tools.

Group: External. Surface: external. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [TERM-REQUEST](GLOSSARY.md#term-request), [TERM-CAPABILITY](GLOSSARY.md#term-capability), [SCRIPT](FLOWS.md#script), [TUI](FLOWS.md#tui), [HOSTED](FLOWS.md#hosted). Direct flows: [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="agent-request-wait"></a>`AGENT-REQUEST-WAIT` | Create request and retrieve result / wait | Use the selected local connection or hosted named-resource MCP tools; SMS external trigger waits for ready. Check deadline: ≤600s, capped by server expiry. | [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request) |
| <a id="agent-request-back"></a>`AGENT-REQUEST-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-SCRIPT-REQUEST](FLOWS.md#flow-script-request) |

## TUI-CLIENT

**Terminal coding agent configuration** — Configure local MCP tools for a coding agent.

Show only: Private profile and selected connection ID; no credentials in prompts.

Group: External. Surface: external. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [TUI](FLOWS.md#tui), [TERM-PROFILE](GLOSSARY.md#term-profile). Direct flows: [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="tui-client-configure"></a>`TUI-CLIENT-CONFIGURE` | Configure relay-mcp / command | Launch relay-mcp --profile NAME --connection ID in host software. | [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools) |
| <a id="tui-client-check"></a>`TUI-CLIENT-CHECK` | Check relay_setup_status and authorized tools / wait | Setup-only public link until ready; permission-limited tools afterwards. Check deadline: ≤600s, capped by server expiry. | [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools) |
| <a id="tui-client-back"></a>`TUI-CLIENT-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-TUI-TOOLS](FLOWS.md#flow-tui-tools) |

## HOSTED-CLIENT

**Hosted agent connection** — Configure or resume hosted MCP authorization.

Show only: Public named-service endpoint and provider connection status.

Group: External. Surface: external. Platforms: [ANDROID](FLOWS.md#android), [IOS](FLOWS.md#ios), [BROWSER](FLOWS.md#browser). Entry/return follows its invoking context.

Glossary: [HOSTED](FLOWS.md#hosted), [TERM-OAUTH](GLOSSARY.md#term-oauth). Direct flows: [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect). Flows through child pages: None.

| Control ID | Label / kind | Behavior and targets | Flow references |
| --- | --- | --- | --- |
| <a id="hosted-client-configure"></a>`HOSTED-CLIENT-CONFIGURE` | Configure remote MCP endpoint / system | Use the provider-supported remote connection UI; account/plan/policy may prevent availability. | [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
| <a id="hosted-client-authorize"></a>`HOSTED-CLIENT-AUTHORIZE` | Authorize relay connection / system | Provider starts discovery/PKCE and opens relay consent. | [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
| <a id="hosted-client-return"></a>`HOSTED-CLIENT-RETURN` | Complete provider return / system | Resume original validated callback, then check provider reports connected. | [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
| <a id="hosted-client-back"></a>`HOSTED-CLIENT-BACK` | Back / Close / navigation | Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable. | [FLOW-HOSTED-CONNECT](FLOWS.md#flow-hosted-connect) |
