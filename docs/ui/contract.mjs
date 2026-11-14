// Canonical design data. Regenerate its Markdown views with npm run docs:ui.
const all = ['ANDROID', 'IOS', 'BROWSER'];
const phones = ['ANDROID', 'IOS'];
const local = ['SCRIPT', 'TUI'];
const agentKinds = ['NONE', ...local, 'HOSTED'];
const controls = (prefix, rows) => rows.map(([suffix, label, kind, detail, targets = [], options = {}]) => ({
  id: `${prefix}-${suffix}`, label, kind, detail, targets,
  ...(kind === 'wait' ? { timeoutSeconds: 600 } : {}), ...options,
}));
const page = (id, title, group, purpose, information, rows, options = {}) => ({
  id, title, group, purpose, information, platforms: all, surface: 'relay',
  terms: [], ...options,
  controls: [...controls(id, rows), ...controls(id, [
    ['BACK', options.backLabel ?? 'Back / Close', 'navigation',
      'Leave without submitting. Keep already accepted changes; preserve the pending destination and in-memory draft where applicable.',
      options.parent ? [options.parent] : []],
  ])],
});

export const contract = {
  version: 1,
  scope: 'Design target, including administrative browser parity still to be implemented. Graph validation proves consistency of the declared design, not the behavior of shipped apps or third-party providers.',
  platforms: [
    { id: 'ANDROID', name: 'Android', detail: 'Independent Inbox and Administration launcher tasks. Verified HTTPS App Links; scan public QR links with the system camera. SMS User Consent can submit a single extracted candidate, or a selected candidate; manual entry remains available. Notification setup uses Android permission/channel settings.', sources: ['docs/UX.md', 'docs/ONBOARDING.md'] },
    { id: 'IOS', name: 'iOS', detail: 'Separate navigation stacks/sheets retain drafts. Universal Links and the existing QR scanner open focused approval. SMS is manual entry, deliberate paste, or eligible system AutoFill followed by Send; never Android consent or automatic SMS reading. APNs/notification setup registers the receiving device.', sources: ['docs/IOS.md'] },
    { id: 'BROWSER', name: 'Browser', detail: 'Supports sign-in, approval, OAuth return, ticket download, and administrative pages. Full settings hierarchy/search/device/history parity is a design target, not a claim about existing routes. No browser Inbox, receiving-device registration, SMS listener, or request-response UI: hand off to Android/iOS. No phone is required merely to own/manage an agent.', sources: ['docs/ONBOARDING.md', 'integrations/README.md'] },
  ],
  agents: [
    { id: 'NONE', name: 'Agent type not relevant', detail: 'Owner-side tasks that do not require selecting or knowing the requesting agent runtime, including account/device/settings work. An incoming request still always identifies its requester.' },
    { id: 'SCRIPT', name: 'Script or backend application', detail: 'Software manages a private CLI/SDK profile, service credential, delivery keys, and recipient credentials. REST or MCP requests use only the selected connection. Registration/delivery operations stay outside model tools.', sources: ['cli/relay.mjs', 'sdks/README.md'] },
    { id: 'TUI', name: 'Terminal coding agent', detail: 'For a coding agent such as Codex, software configures relay-mcp --profile NAME --connection ID. The terminal presents public approval links and setup status; private ticket import and credential storage happen outside prompts and model tool results. Host-specific configuration menus are outside this contract.', sources: ['cli/mcp.mjs', 'docs/ONBOARDING.md'] },
    { id: 'HOSTED', name: 'Hosted browser agent', detail: 'For a browser agent such as ChatGPT, the operator supplies the public named-service remote MCP URL. The user authorizes through the provider and relay OAuth flow. The provider holds OAuth credentials; no local CLI profile, ticket upload into chat, or direct recipient bearer token is required for the recipient.', sources: ['integrations/README.md', 'docs/ONBOARDING.md'] },
  ],
  terms: [
    { id: 'TERM-OWNER', name: 'Owner', definition: 'Authenticated relay account that owns agents or registered devices. The same person can also be a recipient.', related: ['TERM-RECIPIENT', 'TERM-AGENT'] },
    { id: 'TERM-RECIPIENT', name: 'Recipient', definition: 'Account explicitly allowing an agent to request responses. Its connection approval is separate from agent ownership.', related: ['TERM-CONNECTION', 'TERM-OWNER'] },
    { id: 'TERM-AGENT', name: 'Agent / service / caller', definition: 'Named requesting software. Agent is the UI term; service is the v3 API/CLI term; caller is the older request identity. An agent may be used by a script, a terminal agent, or a hosted provider.', related: ['SCRIPT', 'TUI', 'HOSTED'] },
    { id: 'TERM-REGISTRATION', name: 'Agent registration', definition: 'Establishing ownership and the agent declaration. Does not grant access to any recipient, including its owner.', related: ['TERM-AGENT', 'TERM-CONNECTION'] },
    { id: 'TERM-CONNECTION', name: 'Connection / peering / grant', definition: 'Recipient-approved access for one agent, with explicit capabilities and optional expiry. Peering is the settings category; grant is the authorization record.', related: ['TERM-CAPABILITY', 'TERM-RECIPIENT'] },
    { id: 'TERM-CAPABILITY', name: 'Capability', definition: 'Permission for forms/decisions or upcoming SMS codes. The agent must declare it and the recipient must approve it. A form SMS helper also needs SMS permission.', related: ['TERM-CONNECTION', 'TERM-REQUEST'] },
    { id: 'TERM-DEVICE', name: 'Receiving device', definition: 'Registered Android or iOS installation eligible to receive requests. Pausing stops reception without deleting the account or agent connections.', related: ['ANDROID', 'IOS', 'TERM-OWNER'] },
    { id: 'TERM-TICKET', name: 'Private session ticket', definition: 'Private file containing the service credential and delivery private keys. Save/import outside chats, model outputs, public links, and QR codes. It contains no recipient approval.', related: ['TERM-PROFILE', 'TERM-REGISTRATION'] },
    { id: 'TERM-PROFILE', name: 'Private local profile', definition: 'CLI/SDK storage for one agent and its selected recipient connections. Profiles exist on agent software hosts, independently of the platform where the owner approves a link.', related: ['SCRIPT', 'TUI', 'TERM-TICKET'] },
    { id: 'TERM-PUBLIC-LINK', name: 'Public approval or connection link', definition: 'HTTPS link or QR identifying a registration/approval session or reusable service. Opening it never grants access. A comparison code is shown only when supplied for that session.', related: ['TERM-REGISTRATION', 'TERM-CONNECTION'] },
    { id: 'TERM-OAUTH', name: 'Hosted OAuth connection', definition: 'Provider-bound authorization to a named-service MCP resource. The recipient approves relay access, then returns to the provider. Credentials remain in provider/application software.', related: ['HOSTED', 'TERM-CONNECTION'] },
    { id: 'TERM-REQUEST', name: 'Request', definition: 'Pending SMS-code request or form/decision sent through one approved connection. Opening a request, leaving its page, and cancelling it have different effects.', related: ['TERM-INBOX', 'TERM-CAPABILITY'] },
    { id: 'TERM-INBOX', name: 'Inbox', definition: 'Pending work only. Contains no completed-request feed, history tab, history shortcut, or settings search.', related: ['TERM-REQUEST', 'TERM-HISTORY'] },
    { id: 'TERM-HISTORY', name: 'History', definition: 'Metadata-only completed SMS outcomes, exclusively under Administration. Contains no codes or form answers. Form response outcomes are not a new historical feed.', related: ['TERM-INBOX', 'TERM-REQUEST'] },
    { id: 'TERM-RETURN', name: 'Origin-aware return', definition: 'Back/Close navigates without cancelling a request. Android notification responses return to the previous app; Inbox responses return to Inbox. iOS dismisses the response sheet or pops its stack. Browser OAuth returns to the original requesting provider.', related: ['ANDROID', 'IOS', 'BROWSER', 'TERM-OAUTH'] },
    { id: 'TERM-RECOVERY', name: 'Safe exit and recovery', definition: 'Retry the same operation/session after a recoverable failure, or explicitly leave without implying rollback of accepted server changes. Expired approval needs a new session; private drafts are not persisted for process recovery.', related: ['TERM-RETURN', 'TERM-TICKET'] },
  ],
  pages: [
    page('SETTINGS', 'Settings', 'Administration', 'Choose an administrative destination.', 'Search widget and category rows only.', [
      ['OPEN-SEARCH', 'Search settings', 'navigation', 'Open settings search.', ['SETTINGS-SEARCH']],
      ['ADMINISTRATION', 'Administration', 'navigation', 'Devices, owned agents, and history.', ['ADMINISTRATION']],
      ['PEERING', 'Peering', 'navigation', 'Recipient connections.', ['PEERING']],
      ['ACCOUNT', 'Account', 'navigation', 'Identity and lifecycle.', ['ACCOUNT']],
    ]),
    page('SETTINGS-SEARCH', 'Search settings', 'Administration', 'Find a settings destination.', 'Query, destination labels/breadcrumbs, no-results state; no request content.', [
      ['QUERY', 'Search query', 'input', 'Match labels and synonyms.'], ['CLEAR', 'Clear query', 'edit', 'Empty the query; stay here.'],
      ['OPEN', 'Open result', 'navigation', 'Navigate without executing actions. Select an object before object-specific edits.', ['DEVICES', 'AGENTS', 'HISTORY', 'CONNECTIONS', 'ACCOUNT-METHODS', 'ACCOUNT-PRIVACY', 'ACCOUNT-SIGNOUT', 'ACCOUNT-DELETE']],
    ], { parent: 'SETTINGS', terms: ['TERM-HISTORY'] }),
    page('ADMINISTRATION', 'Administration', 'Administration', 'Choose a device, agent, or history task.', 'Navigation rows only.', [
      ['DEVICES', 'Devices', 'navigation', 'Select a device.', ['DEVICES']], ['AGENTS', 'My agents', 'navigation', 'Select an owned agent.', ['AGENTS']], ['HISTORY', 'History', 'navigation', 'Read completed SMS metadata.', ['HISTORY']],
    ], { parent: 'SETTINGS' }),
    page('DEVICES', 'Devices', 'Administration', 'Select a receiving device.', 'Names, receive/paused status, this-phone marker.', [
      ['OPEN', 'Select device', 'navigation', 'Open selected device.', ['DEVICE-RECEIVE']], ['ADD', 'Add this phone', 'navigation', 'Native platforms register this phone; browser hands off.', ['PHONE-REGISTER', 'PHONE-HANDOFF']], ['REFRESH', 'Pull to refresh', 'observe', 'Refresh device metadata.'],
    ], { parent: 'ADMINISTRATION', terms: ['TERM-DEVICE'] }),
    page('DEVICE-RECEIVE', 'Receive requests on device', 'Administration', 'Change reception on one device.', 'Selected device and current receive state.', [
      ['TOGGLE', 'Receive requests', 'submit', 'Pause or resume selected device.'], ['REMOVE', 'Remove device', 'navigation', 'Open dedicated confirmation.', ['DEVICE-REMOVE']],
    ], { parent: 'DEVICES', terms: ['TERM-DEVICE'] }),
    page('DEVICE-REMOVE', 'Remove device', 'Administration', 'Confirm removal of one device.', 'Device identity and removal consequence.', [
      ['SUBMIT', 'Remove device', 'submit', 'Stop reception on this installation; other devices/connections remain.'],
    ], { parent: 'DEVICES', terms: ['TERM-DEVICE'] }),
    page('HISTORY', 'History', 'Administration', 'Read completed SMS metadata.', 'Caller, status, reason; no codes or answers.', [
      ['REFRESH', 'Pull to refresh', 'observe', 'Refresh metadata; an empty history is a valid result.'],
    ], { parent: 'ADMINISTRATION', terms: ['TERM-HISTORY'] }),
    page('AGENTS', 'My agents', 'Administration', 'Select an owned agent.', 'Names and enabled state.', [
      ['OPEN', 'Select agent', 'navigation', 'Open an agent task menu.', ['AGENT']], ['CREATE', 'Create agent', 'navigation', 'Open creation form.', ['AGENT-CREATE']], ['REFRESH', 'Pull to refresh', 'observe', 'Refresh owned agents.'],
    ], { parent: 'ADMINISTRATION', terms: ['TERM-AGENT', 'TERM-OWNER'] }),
    page('AGENT', 'Agent menu', 'Administration', 'Choose a task for one agent.', 'Selected name and task rows only.', [
      ['OPEN-SHARE', 'Connection link', 'navigation', 'Open public sharing.', ['AGENT-SHARE']], ['OPEN-AVAILABILITY', 'Availability', 'navigation', 'Open enable/disable.', ['AGENT-AVAILABILITY']], ['OPEN-TICKET', 'Save session ticket', 'navigation', 'Only when private provisioning state is retained.', ['AGENT-TICKET']], ['CLEAR', 'Clear retained ticket', 'navigation', 'Only when private provisioning state is retained.', ['AGENT-TICKET-CLEAR']], ['OPEN-DELETE', 'Delete agent', 'navigation', 'Open deletion confirmation.', ['AGENT-DELETE']],
    ], { parent: 'AGENTS', terms: ['TERM-AGENT'] }),
    page('AGENT-CREATE', 'Create agent', 'Administration', 'Declare a new owned agent.', 'Declaration fields; registration never grants recipient access.', [
      ['NAME', 'Name', 'input', 'Agent display name.'], ['DESCRIPTION', 'Description', 'input', 'Purpose of requests.'], ['CAPABILITIES', 'Forms / SMS', 'input', 'Choose declared capabilities.'], ['SUBMIT', 'Create agent', 'submit', 'Retain private provisioning state before registration; proceed to ticket saving.'],
    ], { parent: 'AGENTS', terms: ['TERM-REGISTRATION', 'TERM-CAPABILITY', 'TERM-TICKET'] }),
    page('AGENT-TICKET', 'Save session ticket', 'Administration', 'Save the retained private ticket.', 'Agent name, file-save state, private-file guidance.', [
      ['SAVE', 'Save ticket', 'system', 'Android document picker; iOS file exporter; browser file download/save.'], ['DONE', 'Done', 'navigation', 'Return to the agent menu without clearing retained state.', ['AGENT']],
    ], { parent: 'AGENT', terms: ['TERM-TICKET', 'TERM-PROFILE'] }),
    page('AGENT-TICKET-CLEAR', 'Clear retained ticket', 'Administration', 'Explicitly discard a safely exported retained copy.', 'Selected ticket and private-key recovery consequence.', [
      ['ACK', 'Ticket safely saved or agent deleted', 'input', 'Acknowledge the recovery consequence.'], ['SUBMIT', 'Clear retained copy', 'submit', 'Verify selected owner/ticket still match; never clear on failed export.'],
    ], { parent: 'AGENT', terms: ['TERM-TICKET'] }),
    page('AGENT-SHARE', 'Share connection link', 'Administration', 'Share one public agent link.', 'Public HTTPS link and QR only.', [
      ['COPY', 'Copy link', 'system', 'Copy the public link only.'], ['SHARE', 'Share link', 'system', 'Use platform share/copy fallback.'],
    ], { parent: 'AGENT', terms: ['TERM-PUBLIC-LINK'] }),
    page('AGENT-AVAILABILITY', 'Agent availability', 'Administration', 'Enable or disable one agent.', 'Selected name, current state, effect on every connection.', [
      ['SUBMIT', 'Enable / disable agent', 'submit', 'Change parent service availability without deleting it.'],
    ], { parent: 'AGENT', terms: ['TERM-AGENT', 'TERM-CONNECTION'] }),
    page('AGENT-DELETE', 'Delete agent', 'Administration', 'Confirm deletion of one agent.', 'Selected name and effect on every recipient connection.', [
      ['SUBMIT', 'Delete agent', 'submit', 'Block all its connections and queue cleanup.'],
    ], { parent: 'AGENT', terms: ['TERM-AGENT', 'TERM-CONNECTION'] }),
    page('PEERING', 'Peering', 'Peering', 'Choose a recipient connection task.', 'Connection and invitation-entry rows.', [
      ['CONNECTIONS', 'Connections', 'navigation', 'Select current access.', ['CONNECTIONS']], ['INVITATION', 'Open invitation', 'navigation', 'Enter a public link/code.', ['INVITATION']],
    ], { parent: 'SETTINGS', terms: ['TERM-CONNECTION'] }),
    page('CONNECTIONS', 'Connections', 'Peering', 'Select an approved connection.', 'Agent names, effective permissions, status/expiry.', [
      ['OPEN', 'Select connection', 'navigation', 'Select before editing.', ['CONNECTION']], ['NEW', 'New connection', 'navigation', 'Locate an invitation.', ['INVITATION']], ['REFRESH', 'Pull to refresh', 'observe', 'Refresh connection metadata.'],
    ], { parent: 'PEERING', terms: ['TERM-CONNECTION'] }),
    page('INVITATION', 'Open connection invitation', 'Peering', 'Locate a public approval session.', 'Public link/code input; no credentials.', [
      ['VALUE', 'Public link or code', 'input', 'Android camera links/iOS scanner may fill/open this destination.'], ['OPEN', 'Open invitation', 'submit', 'Resolve link/code on the configured relay; opening grants no access.'],
    ], { parent: 'PEERING', terms: ['TERM-PUBLIC-LINK'] }),
    page('PAIR-REVIEW', 'Approve connection', 'Peering', 'Decide one recipient access grant.', 'Agent purpose, recipient identity, requested permissions/duration, comparison code if present; hosted client details when applicable.', [
      ['CAPABILITIES', 'Allowed forms / SMS', 'input', 'Narrow declared/requested permissions.'], ['DURATION', 'Access duration', 'input', 'Narrow to permitted duration.'], ['SUBMIT', 'Connect', 'submit', 'Approve this session only.'], ['DECLINE', 'Decline', 'submit', 'Deny this session explicitly.'], ['ACCOUNT', 'Use another account', 'navigation', 'Authenticate the intended account before deciding; re-evaluate session binding.', ['LOGIN']], ['RESTART', 'Open fresh invitation', 'navigation', 'Expired links require a fresh invitation/attempt, never a silent approval.', ['INVITATION']],
    ], { parent: 'PEERING', terms: ['TERM-RECIPIENT', 'TERM-CONNECTION', 'TERM-CAPABILITY', 'TERM-PUBLIC-LINK', 'TERM-OAUTH'] }),
    page('PAIR-PROGRESS', 'Connection progress', 'Peering', 'Finish the approved connection handoff.', 'Direct encrypted delivery or hosted OAuth return status; receiving-device readiness.', [
      ['WAIT', 'Check connection progress', 'wait', 'Wait with a deadline; retry same session after transient failure.'], ['PHONE', 'Set up receiving phone', 'navigation', 'Only if no suitable receiving device exists.', ['PHONE-NOTIFICATIONS', 'PHONE-HANDOFF']], ['RETURN', 'Done / Return to requesting app', 'navigation', 'Direct flow closes; hosted flow returns through the original validated callback.', ['HOSTED-CLIENT']],
    ], { parent: 'PEERING', terms: ['TERM-CONNECTION', 'TERM-OAUTH', 'TERM-DEVICE', 'TERM-RECOVERY'] }),
    page('CONNECTION', 'Connection menu', 'Peering', 'Choose a task for one connection.', 'Selected agent and task rows only.', [
      ['OPEN-PERMISSIONS', 'Change permissions', 'navigation', 'Open one permissions form.', ['CONNECTION-PERMISSIONS']], ['OPEN-EXPIRY', 'Change expiry', 'navigation', 'Open one expiry form.', ['CONNECTION-EXPIRY']], ['OPEN-DISCONNECT', 'Disconnect', 'navigation', 'Open revocation confirmation.', ['CONNECTION-DISCONNECT']],
    ], { parent: 'CONNECTIONS', terms: ['TERM-CONNECTION'] }),
    page('CONNECTION-PERMISSIONS', 'Change permissions', 'Peering', 'Edit effective capabilities.', 'Selected agent and current allowed capabilities.', [
      ['VALUE', 'Forms / SMS', 'input', 'Select permitted capabilities.'], ['SUBMIT', 'Save permissions', 'submit', 'Reauthorize changes; SMS removal may cancel SMS helper work.'],
    ], { parent: 'CONNECTION', terms: ['TERM-CAPABILITY'] }),
    page('CONNECTION-EXPIRY', 'Change expiry', 'Peering', 'Edit connection duration.', 'Selected agent and current expiry.', [
      ['VALUE', 'Duration', 'input', 'Choose a supported duration.'], ['SUBMIT', 'Save expiry', 'submit', 'Save explicitly.'],
    ], { parent: 'CONNECTION', terms: ['TERM-CONNECTION'] }),
    page('CONNECTION-DISCONNECT', 'Disconnect', 'Peering', 'Revoke one recipient connection.', 'Selected connection and access consequence.', [
      ['SUBMIT', 'Disconnect', 'submit', 'Block requests/results for this connection.'],
    ], { parent: 'CONNECTION', terms: ['TERM-CONNECTION'] }),
    page('REGISTER-APPROVAL', 'Approve agent registration', 'Peering', 'Accept ownership of an agent declaration.', 'Declaration, ownership account, comparison code when supplied; no recipient approval.', [
      ['SUBMIT', 'Register agent', 'submit', 'Approve ownership only.'], ['DECLINE', 'Decline', 'submit', 'Decline ownership.'], ['RESTART', 'Open fresh registration link', 'navigation', 'Ask agent software for a new registration attempt.', ['AGENT-CLI']],
    ], { parent: 'PEERING', terms: ['TERM-REGISTRATION', 'TERM-OWNER'] }),
    page('ACCOUNT', 'Account', 'Account', 'Choose an identity/lifecycle task.', 'Current identity and task rows only.', [
      ['OPEN-METHODS', 'Sign-in methods', 'navigation', 'View linked providers.', ['ACCOUNT-METHODS']], ['OPEN-PRIVACY', 'Privacy', 'navigation', 'Read policy.', ['ACCOUNT-PRIVACY']], ['OPEN-SIGNOUT', 'Sign out', 'navigation', 'Open sign-out confirmation.', ['ACCOUNT-SIGNOUT']], ['OPEN-DELETE', 'Delete account', 'navigation', 'Open deletion flow.', ['ACCOUNT-DELETE']],
    ], { parent: 'SETTINGS', terms: ['TERM-OWNER'] }),
    page('ACCOUNT-METHODS', 'Sign-in methods', 'Account', 'Choose a provider to link.', 'Linked and available providers.', [
      ['LINK', 'Link provider', 'navigation', 'Select provider; never merge by matching email.', ['ACCOUNT-LINK']],
    ], { parent: 'ACCOUNT', terms: ['TERM-OWNER'] }),
    page('ACCOUNT-LINK', 'Link sign-in method', 'Account', 'Link one provider to the current account.', 'Current account, selected provider, explicit linking consequence.', [
      ['SUBMIT', 'Continue with provider', 'system', 'Require linking consent; preserve original account identity on error/cancellation.'],
    ], { parent: 'ACCOUNT-METHODS', terms: ['TERM-OWNER'] }),
    page('ACCOUNT-SIGNOUT', 'Sign out', 'Account', 'Sign out on this installation.', 'Current account and local effect.', [
      ['SUBMIT', 'Sign out', 'submit', 'Clear private response drafts and local session, then show login.'],
    ], { parent: 'ACCOUNT', terms: ['TERM-OWNER'] }),
    page('ACCOUNT-DELETE', 'Delete account', 'Account', 'Confirm permanent account deletion.', 'Identity, concrete cleanup/access consequences.', [
      ['ACK', 'I understand deletion', 'input', 'Acknowledge permanent removal.'], ['SUBMIT', 'Verify identity and delete', 'system', 'Reauthenticate the same account; revoke linked Apple authorization when required; submit deletion once.'],
    ], { parent: 'ACCOUNT', terms: ['TERM-OWNER', 'TERM-RECOVERY'] }),
    page('ACCOUNT-DELETION', 'Deletion status', 'Account', 'Read acceptance/cleanup state.', 'Accepted vs uncertain deletion; cleanup continues server-side.', [
      ['CHECK', 'Check deletion status', 'wait', 'Use retained receipt/status; reconcile uncertain acceptance before resubmitting.'],
    ], { terms: ['TERM-RECOVERY'] }),
    page('ACCOUNT-PRIVACY', 'Privacy', 'Account', 'Read the privacy policy.', 'Policy and necessary operator contact.', [
      ['CONTACT', 'Operator contact', 'system', 'Open published contact method when configured; otherwise remain on policy with clear unavailable text.'],
    ], { parent: 'ACCOUNT', terms: ['TERM-OWNER'] }),
    page('LOGIN', 'Sign in', 'Initial Login', 'Authenticate for the pending task.', 'Minimal purpose and provider choice; no account-management form.', [
      ['PROVIDER', 'Google / Apple', 'input', 'Choose a configured provider.'], ['SUBMIT', 'Continue with selected provider', 'system', 'Authenticate and resume the retained public destination; never auto-approve.'], ['PRIVACY', 'Privacy', 'navigation', 'Read policy and return to this sign-in task.', ['ACCOUNT-PRIVACY']],
    ], { terms: ['TERM-OWNER', 'TERM-RETURN'] }),
    page('PHONE-NOTIFICATIONS', 'Enable notifications', 'Initial Login', 'Enable reception notifications.', 'Permission/channel requirement for this device.', [
      ['SUBMIT', 'Enable notifications', 'system', 'Request Android notification/channel or iOS notification authorization.'], ['SETTINGS', 'Open system settings', 'system', 'Recover denied permission, then recheck on return.'],
    ], { platforms: phones, terms: ['TERM-DEVICE'] }),
    page('PHONE-REGISTER', 'Register this phone', 'Initial Login', 'Register a receiving installation.', 'Signed-in account and device registration purpose.', [
      ['SUBMIT', 'Register phone', 'submit', 'Register platform-specific device; recheck notification prerequisites.'],
    ], { platforms: phones, terms: ['TERM-DEVICE'] }),
    page('PHONE-HANDOFF', 'Continue on a phone', 'Initial Login', 'Move a phone-only task to a native app.', 'Public destination link/QR, configured install guidance, same-account instruction.', [
      ['OPEN', 'Open / install app', 'system', 'Use configured Android/iOS installation guidance; reopen the same public link after installation.'], ['CHECK', 'Check receiving-device setup', 'wait', 'Recheck server readiness; browser never registers as a phone.'],
    ], { platforms: ['BROWSER'], terms: ['TERM-PUBLIC-LINK', 'TERM-DEVICE'] }),
    page('INBOX', 'Inbox', 'Requests', 'Select pending work.', 'Pending rows only; empty state.', [
      ['OPEN-SMS', 'Open SMS request', 'navigation', 'Explicitly start native readiness/listening.', ['SMS']], ['OPEN-FORM', 'Open form', 'navigation', 'Load without submitting.', ['FORM']], ['REFRESH', 'Pull to refresh', 'observe', 'Discover pending work only.'], ['SETUP', 'Open Administration', 'navigation', 'Only for unmet receiving setup.', ['SETTINGS']],
    ], { platforms: phones, terms: ['TERM-INBOX', 'TERM-REQUEST'] }),
    page('SMS', 'Respond with SMS code', 'Requests', 'Share one approved code.', 'Requester/purpose, deadline, listener/manual-entry state, candidate/code field.', [
      ['OPEN', 'Open / retry this response', 'wait', 'Notification deep link loads only this response; complete necessary authentication/registration within the retained destination before starting native readiness.'],
      ['CODE', 'Code', 'input', 'Type deliberately; iOS may offer eligible AutoFill.'], ['SEND', 'Send', 'submit', 'Manual submission after validation.'], ['CONSENT', 'Android SMS consent / choose candidate', 'system', 'Android only: consent submits a single candidate or chosen candidate.', [], { platforms: ['ANDROID'] }], ['CANCEL', 'Cancel / decline request', 'submit', 'Explicit terminal action; Back is navigation only.'],
    ], { platforms: phones, terms: ['TERM-REQUEST', 'TERM-RETURN', 'TERM-CAPABILITY'] }),
    page('FORM', 'Answer form', 'Requests', 'Answer one information/decision request.', 'Requester, purpose, visible fields, declared actions.', [
      ['OPEN', 'Open / retry this response', 'wait', 'Notification deep link loads this form and retains its target through necessary authentication/setup; never submit on opening.'],
      ['FIELDS', 'Requested fields', 'input', 'Native typed inputs; SMS helper requires SMS permission and platform-specific entry.'], ['SUBMIT', 'Submit / Approve / Acknowledge', 'submit', 'Only the declared action submits.'], ['DECLINE', 'Decline', 'submit', 'Only when the definition declares it.'], ['WIZARD', 'Start multi-step response', 'navigation', 'Use wizard when defined.', ['WIZARD']],
    ], { platforms: phones, terms: ['TERM-REQUEST', 'TERM-CAPABILITY'] }),
    page('WIZARD', 'Wizard step', 'Requests', 'Complete the current step.', 'Current fields and progress only.', [
      ['FIELDS', 'Current step fields', 'input', 'Retain in memory; prune hidden branches.'], ['NEXT', 'Next', 'submit', 'Validate current step; advance or review.'], ['PREVIOUS', 'Previous step', 'navigation', 'Move within wizard without closing response.', ['WIZARD']],
    ], { platforms: phones, parent: 'FORM', terms: ['TERM-REQUEST'] }),
    page('FORM-REVIEW', 'Review answers', 'Requests', 'Confirm answers before final submission.', 'Only reachable answers to be sent.', [
      ['EDIT', 'Edit step', 'navigation', 'Return to the relevant step.', ['WIZARD']], ['SUBMIT', 'Final declared action', 'submit', 'Submit once; reconcile uncertain result before retry.'],
    ], { platforms: phones, parent: 'WIZARD', terms: ['TERM-REQUEST'] }),
    page('REQUEST-OUTCOME', 'Request outcome', 'Requests', 'Acknowledge the current response outcome.', 'Submitted/declined/expired/handled-elsewhere state without secret values.', [], { platforms: phones, terms: ['TERM-REQUEST', 'TERM-RETURN'] }),
    page('AGENT-CLI', 'Agent software terminal', 'External', 'Operate private agent software.', 'Public setup links/status; private configuration stays in files.', [
      ['REGISTER', 'relay service register', 'command', 'Create a private profile; present registration link/QR.'], ['IMPORT', 'relay service import-ticket', 'command', 'Import a private ticket into an unused profile outside model tools.'], ['CONNECT', 'relay service connect', 'command', 'Present pairing link/QR and comparison code.'], ['DELIVERIES', 'relay service deliveries / relay resume', 'wait', 'Save/decrypt delivery durably before acknowledgement; resume after interruption.'], ['HOSTED-LINK', 'relay service hosted-link', 'command', 'Return public named-service MCP URL only.'], ['RESUME', 'relay resume / relay status', 'command', 'Reconcile retained registration/pairing/delivery state; fresh expired sessions require explicit restart.'],
    ], { surface: 'external', terms: ['TERM-PROFILE', 'TERM-TICKET', 'TERM-AGENT'] }),
    page('AGENT-REQUEST', 'Requesting agent software', 'External', 'Run one authorized request from script, terminal, or hosted software.', 'Request status and authorized result; lifecycle credentials stay outside model tools.', [
      ['WAIT', 'Create request and retrieve result', 'wait', 'Use the selected local connection or hosted named-resource MCP tools; SMS external trigger waits for ready.'],
    ], { surface: 'external', terms: ['TERM-REQUEST', 'TERM-CAPABILITY', 'SCRIPT', 'TUI', 'HOSTED'] }),
    page('TUI-CLIENT', 'Terminal coding agent configuration', 'External', 'Configure local MCP tools for a coding agent.', 'Private profile and selected connection ID; no credentials in prompts.', [
      ['CONFIGURE', 'Configure relay-mcp', 'command', 'Launch relay-mcp --profile NAME --connection ID in host software.'], ['CHECK', 'Check relay_setup_status and authorized tools', 'wait', 'Setup-only public link until ready; permission-limited tools afterwards.'],
    ], { surface: 'external', terms: ['TUI', 'TERM-PROFILE'] }),
    page('HOSTED-CLIENT', 'Hosted agent connection', 'External', 'Configure or resume hosted MCP authorization.', 'Public named-service endpoint and provider connection status.', [
      ['CONFIGURE', 'Configure remote MCP endpoint', 'system', 'Use the provider-supported remote connection UI; account/plan/policy may prevent availability.'], ['AUTHORIZE', 'Authorize relay connection', 'system', 'Provider starts discovery/PKCE and opens relay consent.'], ['RETURN', 'Complete provider return', 'system', 'Resume original validated callback, then check provider reports connected.'],
    ], { surface: 'external', terms: ['HOSTED', 'TERM-OAUTH'] }),
  ],
  // Public/launcher destinations. Other pages must be reachable through actual
  // navigation controls or a declared flow transition on every supported platform.
  entries: ['SETTINGS', 'LOGIN', 'INBOX', 'PAIR-REVIEW', 'REGISTER-APPROVAL', 'CONNECTION', 'ACCOUNT-DELETE', 'AGENT-CLI', 'AGENT-REQUEST', 'TUI-CLIENT', 'HOSTED-CLIENT', 'PHONE-HANDOFF'],
  flows: [],
};

// A step models an action plus its complete result partition. Failure stays on
// that task with explicit recovery text; Back/Close is an independently modeled
// escape, including while a remote operation has not completed.
const step = (id, pageId, action, instruction, next, recovery, options = {}) => {
  const control = contract.pages.find(p => p.id === pageId)?.controls.find(c => c.id === action);
  const events = control?.kind === 'system' ? ['success', 'denied', 'failure', 'cancelled']
    : control?.kind === 'submit' ? ['success', 'invalid', 'failure', 'cancelled']
      : control?.kind === 'wait' ? ['ready', 'timeout', 'revoked', 'failure', 'cancelled']
        : ['success', 'failure', 'cancelled'];
  const { inputs = [], overrides = {}, ...rest } = options;
  return { id, page: pageId, action, inputs, back: `${pageId}-BACK`, instruction,
    outcomes: events.map(event => ({ event,
      to: event === 'success' || event === 'ready' ? next : ['cancelled', 'timeout', 'revoked'].includes(event) ? 'cancelled' : id,
      detail: event === 'success' || event === 'ready' ? 'Continue after confirmed success.' : event === 'cancelled' ? 'Use Back/Close (Ctrl-C in terminal software). Accepted changes are not rolled back.' : recovery,
      ...overrides[event],
    })), ...rest };
};
const flow = (id, title, platforms, agents, preconditions, steps, result, terms, options = {}) => ({
  id, title, platforms, agents, preconditions, terms, entry: steps[0].id,
  nodes: [...steps,
    { id: 'done', terminal: 'success', result, exit: 'Return to the invoking page/app or close the task; accepted changes remain accepted.' },
    { id: 'cancelled', terminal: 'safe-stop', result: 'The user leaves, or a bounded wait ends with timeout/revocation. Accepted operations remain accepted; stopping never silently revokes access or cancels a request.', exit: 'Back/Close to the invoking page/app; terminal software stops with retained private state. Resume explicitly after recovery, or start a fresh approval when the old one expired or was revoked.' },
  ], ...options,
});
const S = step;
const F = flow;
contract.flows = [
  F('FLOW-LOGIN', 'Sign in and resume the intended task', all, agentKinds, 'A public destination or launcher task is retained; a provider is configured.', [
    S('login', 'LOGIN', 'LOGIN-SUBMIT', 'Choose Google or Apple, authenticate, and return to the retained task without approving it.', 'done', 'Remain at sign-in; retry the configured provider or close. A different account must re-evaluate session ownership.', { inputs: ['LOGIN-PROVIDER'] }),
  ], 'The intended account is authenticated; the original task resumes without submitting any decision.', ['TERM-OWNER', 'TERM-RETURN']),
  F('FLOW-PHONE', 'Set up a receiving phone', phones, agentKinds, 'Signed in through FLOW-LOGIN. Registration is needed only when no suitable device can receive.', [
    S('permission', 'PHONE-NOTIFICATIONS', 'PHONE-NOTIFICATIONS-SUBMIT', 'Enable notifications for this installation.', 'register', 'Permission denied or channels disabled: open system settings, return, and recheck; otherwise close.', { overrides: { denied: { to: 'settings', detail: 'Permission is denied; explicitly open OS settings or leave.' } } }),
    S('settings', 'PHONE-NOTIFICATIONS', 'PHONE-NOTIFICATIONS-SETTINGS', 'Enable the notification permission/channel in OS settings, then return.', 'permission', 'If notifications remain unavailable, explain the missing prerequisite and allow Close.'),
    S('register', 'PHONE-REGISTER', 'PHONE-REGISTER-SUBMIT', 'Register this phone for the signed-in account; resume the invoking task.', 'done', 'Keep the setup task; retry registration after notification/network/account recovery or close.'),
  ], 'A suitable native receiving device is registered. Browser ownership tasks do not require this flow.', ['TERM-DEVICE', 'TERM-RETURN']),
  F('FLOW-BROWSER-PHONE', 'Continue a phone-only task from the browser', ['BROWSER'], agentKinds, 'The browser has a public task link or a receiving-device setup requirement.', [
    S('handoff', 'PHONE-HANDOFF', 'PHONE-HANDOFF-OPEN', 'Open the installed Android/iOS app, or install from configured operator guidance and reopen the public link with the same account.', 'check', 'If install links or a suitable phone are unavailable, preserve the public destination and close; never request a browser SMS permission.'),
    S('check', 'PHONE-HANDOFF', 'PHONE-HANDOFF-CHECK', 'On the phone complete FLOW-PHONE if needed; return here to check account-wide receiving readiness.', 'done', 'Not ready/offline: keep the link and retry checking, or close. An expired approval must be reopened as a fresh attempt.'),
  ], 'The browser confirms a suitable receiving device or the user explicitly leaves with the public continuation link.', ['TERM-DEVICE', 'TERM-PUBLIC-LINK'], { continuations: ['FLOW-PHONE'] }),
  F('FLOW-CREATE-AGENT', 'Create an agent and save its private ticket', all, agentKinds, 'Signed in; open Administration → My agents → Create agent.', [
    S('create', 'AGENT-CREATE', 'AGENT-CREATE-SUBMIT', 'Enter name, description, and declared capabilities; create the owned agent.', 'save', 'Correct invalid fields; retry identical retained provisioning state after uncertain creation rather than creating another agent.', { inputs: ['AGENT-CREATE-NAME', 'AGENT-CREATE-DESCRIPTION', 'AGENT-CREATE-CAPABILITIES'] }),
    S('save', 'AGENT-TICKET', 'AGENT-TICKET-SAVE', 'Save the private ticket using Android documents, iOS file export, or browser download. Confirm the file exists before clearing anything.', 'done', 'Retain provisioning state if the picker is cancelled, download fails, or saving is uncertain; retry Save. Do not clear private keys.'),
  ], 'An owned agent and safely saved private ticket exist; no recipient access was granted.', ['TERM-REGISTRATION', 'TERM-TICKET'], { continuations: ['FLOW-IMPORT-TICKET', 'FLOW-HOSTED-CONNECT'] }),
  F('FLOW-IMPORT-TICKET', 'Import a ticket into script or terminal-agent software', all, local, 'FLOW-CREATE-AGENT completed; the file is transferred privately to the software host.', [
    S('import', 'AGENT-CLI', 'AGENT-CLI-IMPORT', 'Run relay service import-ticket --file /private/agent-ticket.json --profile NAME outside chats/model tools.', 'done', 'Use an unused profile. A stale credential/key requires an up-to-date export; never overwrite another profile or paste the ticket into chat.'),
  ], 'Agent software durably owns its private configuration; recipient connection approval is still required.', ['TERM-TICKET', 'TERM-PROFILE'], { continuations: ['FLOW-DIRECT-CONNECT'] }),
  F('FLOW-REGISTER-AGENT', 'Register an agent from script or terminal software', all, local, 'Choose a private profile and relay; registration software runs on its own host, independently of approval platform.', [
    S('start', 'AGENT-CLI', 'AGENT-CLI-REGISTER', 'Run relay service register --profile NAME --name NAME --relay https://RELAY; open its public Register agent link/QR.', 'approve', 'Retry with retained profile via relay resume; occupied profiles require another name. Never expose private credentials.'),
    S('approve', 'REGISTER-APPROVAL', 'REGISTER-APPROVAL-SUBMIT', 'Use FLOW-LOGIN if needed; review the declaration and account, then approve ownership only.', 'resume', 'A denied/expired/account-bound session cannot be reused to gain ownership; request a fresh registration link or close.'),
    S('resume', 'AGENT-CLI', 'AGENT-CLI-RESUME', 'Return to software; let registration finish or run relay resume after interruption.', 'done', 'Reconcile retained registration state; retry or stop without deleting private provisioning state.'),
  ], 'Registration is saved in the private profile. Connect separately, including to your own account.', ['TERM-REGISTRATION', 'TERM-PUBLIC-LINK', 'TERM-PROFILE'], { continuations: ['FLOW-LOGIN', 'FLOW-DIRECT-CONNECT'] }),
  F('FLOW-DIRECT-CONNECT', 'Connect a script or terminal agent to a recipient', all, local, 'Registered/imported private profile; recipient can authenticate. Another suitable receiving phone may already exist.', [
    S('start', 'AGENT-CLI', 'AGENT-CLI-CONNECT', 'Run relay service connect --profile NAME; open the public link or scan its QR on the approval platform.', 'review', 'Use relay resume for transient interruption; an expired session needs explicit relay service connect --new-session.'),
    S('review', 'PAIR-REVIEW', 'PAIR-REVIEW-SUBMIT', 'Sign in if needed, verify account and comparison code, narrow capabilities/duration, and press Connect.', 'delivery', 'Do not approve mismatched codes or accounts. Recover transient failures in the same session; expired attempts require a new link.', { inputs: ['PAIR-REVIEW-CAPABILITIES', 'PAIR-REVIEW-DURATION'] }),
    S('delivery', 'AGENT-CLI', 'AGENT-CLI-DELIVERIES', 'Return to software; consume deliveries or run relay service deliveries --profile NAME. Save credentials durably before acknowledgement.', 'progress', 'Retry relay resume without losing private keys. On timeout/expired delivery request a fresh approval; do not report ready based on approval alone.'),
    S('progress', 'PAIR-PROGRESS', 'PAIR-PROGRESS-WAIT', 'Check grant/delivery and receiving-device readiness. If a phone is missing, use the platform-specific phone setup flow.', 'done', 'Recover pending delivery on the software host; set up or resume a phone if missing. If access was revoked, start a new explicit approval.'),
  ], 'The selected recipient connection is usable by software, or the user deliberately stops with retained setup state.', ['TERM-CONNECTION', 'TERM-PROFILE', 'TERM-DEVICE'], { continuations: ['FLOW-LOGIN', 'FLOW-PHONE', 'FLOW-BROWSER-PHONE', 'FLOW-TUI-TOOLS'] }),
  F('FLOW-OPEN-INVITATION', 'Open a public invitation manually', all, agentKinds, 'An agent supplies a public invitation link/code; legacy code entry is secondary to opening links.', [
    S('open', 'INVITATION', 'INVITATION-OPEN', 'Open Peering → Open invitation, enter the public link/code, and review it.', 'review', 'Reject an invalid host/path/code. Ask the agent for a fresh link when expired; remain here or close.', { inputs: ['INVITATION-VALUE'] }),
    S('review', 'PAIR-REVIEW', 'PAIR-REVIEW-SUBMIT', 'Verify account, requester, comparison code if present, capabilities, and duration; Connect.', 'done', 'Retry the same valid session or leave; never approve on opening alone.', { inputs: ['PAIR-REVIEW-CAPABILITIES', 'PAIR-REVIEW-DURATION'] }),
  ], 'The invitation was explicitly approved; finish using the agent-specific direct-delivery or hosted-return flow.', ['TERM-PUBLIC-LINK', 'TERM-CONNECTION'], { continuations: ['FLOW-DIRECT-CONNECT', 'FLOW-HOSTED-CONNECT'] }),
  F('FLOW-HOSTED-CONNECT', 'Connect a hosted browser agent such as ChatGPT', all, ['HOSTED'], 'The operator has a registered named service and supplies its public remote MCP endpoint. The recipient provider supports and permits remote MCP/OAuth.', [
    S('configure', 'HOSTED-CLIENT', 'HOSTED-CLIENT-CONFIGURE', 'Use the public https://RELAY/mcp/services/SERVICE_ID endpoint in the provider remote connection UI; do not upload a private ticket into chat.', 'authorize', 'If account/plan/provider policy hides or rejects remote connections, explain that limitation and stop; no relay setting can bypass it.'),
    S('authorize', 'HOSTED-CLIENT', 'HOSTED-CLIENT-AUTHORIZE', 'Start provider authorization; follow the relay consent link in browser, or its public phone handoff.', 'review', 'Retry provider authorization or leave. Preserve only the public consent destination, never callback tokens in prompts.'),
    S('review', 'PAIR-REVIEW', 'PAIR-REVIEW-SUBMIT', 'Authenticate the recipient, review both service and requesting client, narrow access, and press Connect once.', 'return', 'Cancel on wrong identity/client. Expired attempts require restarting authorization from the provider.', { inputs: ['PAIR-REVIEW-CAPABILITIES', 'PAIR-REVIEW-DURATION'] }),
    S('return', 'HOSTED-CLIENT', 'HOSTED-CLIENT-RETURN', 'Return to the original browser/provider so its validated callback completes; confirm it reports connected.', 'done', 'If callback delivery or provider setup fails, return to the original provider and restart authorization explicitly; do not substitute a local bearer credential.'),
  ], 'Provider software holds its OAuth connection. No CLI profile, ticket, or encrypted-delivery consumer is required for the recipient.', ['TERM-OAUTH', 'TERM-CONNECTION', 'TERM-PUBLIC-LINK'], { continuations: ['FLOW-LOGIN', 'FLOW-PHONE', 'FLOW-BROWSER-PHONE'] }),
  F('FLOW-HOSTED-OPERATOR', 'Produce a public hosted endpoint as an operator', all, local, 'An operator private profile already contains a registered service; provider registration/acceptance is separate work.', [
    S('endpoint', 'AGENT-CLI', 'AGENT-CLI-HOSTED-LINK', 'Run relay service hosted-link --profile NAME and supply only that public named-service URL to the recipient.', 'done', 'Complete retained registration first; check relay status or stop without revealing service credentials.'),
  ], 'A public hosted endpoint is available; each recipient still authorizes separately.', ['TERM-OAUTH', 'TERM-REGISTRATION'], { continuations: ['FLOW-HOSTED-CONNECT'] }),
  F('FLOW-TUI-TOOLS', 'Enable relay tools in a terminal coding agent', all, ['TUI'], 'FLOW-DIRECT-CONNECT completed and a specific connection ID is selected.', [
    S('configure', 'TUI-CLIENT', 'TUI-CLIENT-CONFIGURE', 'Configure the host to launch relay-mcp --profile NAME --connection ID. Keep private files outside prompts.', 'check', 'Fix local launch/profile/connection selection in host software or stop; do not copy service credentials into tool arguments.'),
    S('check', 'TUI-CLIENT', 'TUI-CLIENT-CHECK', 'Check relay_setup_status and the permission-limited tools. If setup is incomplete, follow the public link and consume deliveries outside the model.', 'done', 'Setup-only tools mean configuration is incomplete, not that access is granted. Finish direct pairing or retry after relay/network recovery.'),
  ], 'The coding agent sees only tools allowed by the selected recipient connection.', ['TUI', 'TERM-PROFILE', 'TERM-CAPABILITY'], { continuations: ['FLOW-DIRECT-CONNECT'] }),
  F('FLOW-SCRIPT-REQUEST', 'Send a request from agent software and retrieve the result', all, ['SCRIPT', 'TUI', 'HOSTED'], 'A usable connection with required capabilities and at least one suitable receiving phone exists.', [
    S('request', 'AGENT-REQUEST', 'AGENT-REQUEST-WAIT', 'Software creates a form or SMS request and polls/events for its result. Hosted software uses its named-resource MCP tools. For SMS, wait for server ready before a separate workflow triggers the SMS.', 'done', 'Handle denial, cancellation, expiry, revocation, and missing phones as explicit results. Retry transport safely, not by duplicating accepted requests; stop polling at a bounded deadline.'),
  ], 'The authorized originating connection retrieves the approved result within its retrieval window, or handles a terminal failure without exposing values to unrelated parties.', ['TERM-REQUEST', 'TERM-CAPABILITY'], { continuations: ['FLOW-SMS-ANDROID', 'FLOW-SMS-IOS', 'FLOW-FORM'] }),
  F('FLOW-NOTIFICATION-SMS', 'Open an SMS response directly from a notification', phones, agentKinds, 'The notification identifies one request; cold-launch loading state is initialized before display.', [
    S('open', 'SMS', 'SMS-OPEN', 'Tap the notification. Open only this response destination; retain the target through any required sign-in/registration, then load and establish platform-specific readiness.', 'done', 'Show request-local Retry/Close on load failure. Expired or handled-elsewhere requests show their terminal outcome; do not reveal a previous response or fall back to a different request.'),
  ], 'The intended SMS response is open. Android Close backgrounds the retained task to the previous app; iOS dismisses its response sheet.', ['TERM-RETURN', 'TERM-REQUEST'], { continuations: ['FLOW-LOGIN', 'FLOW-PHONE', 'FLOW-SMS-ANDROID', 'FLOW-SMS-IOS', 'FLOW-REQUEST-OUTCOME'] }),
  F('FLOW-NOTIFICATION-FORM', 'Open a form directly from a notification', phones, agentKinds, 'The notification identifies one form; its target is retained across necessary setup.', [
    S('open', 'FORM', 'FORM-OPEN', 'Tap the notification and load only the target form response. Opening/AutoFill never submits; an in-memory draft may resume while the process lives.', 'done', 'Retry the same target or Close. After process death reopen without persisted answers; terminal requests show their actual outcome.'),
  ], 'The intended form response is open without passing through an Inbox selection; Close follows entry origin.', ['TERM-RETURN', 'TERM-REQUEST', 'TERM-RECOVERY'], { continuations: ['FLOW-LOGIN', 'FLOW-PHONE', 'FLOW-FORM', 'FLOW-WIZARD'] }),
  F('FLOW-SMS-ANDROID', 'Respond to an SMS request on Android', ['ANDROID'], agentKinds, 'A pending SMS request exists; native setup is complete or retained request-specific setup resumes it.', [
    S('open', 'INBOX', 'INBOX-OPEN-SMS', 'Open the pending row or enter this same response directly from its notification. Only explicit opening starts the SMS listener.', 'consent', 'Keep the pending target; retry loading after account/registration/network recovery or close.'),
    S('consent', 'SMS', 'SMS-CONSENT', 'Approve Android SMS User Consent. A single extracted code or selected candidate is sent; if denied, use manual entry and Send.', 'done', 'No eligible message/denied consent: retain manual entry. A competing device or expired request shows its terminal outcome.', { overrides: { denied: { to: 'manual', detail: 'Use manual entry; declining Android SMS access does not cancel the request.' }, failure: { to: 'manual', detail: 'Listener unavailable or message ineligible: type a code manually within the request window.' } } }),
    S('manual', 'SMS', 'SMS-SEND', 'Type the intended code and tap Send.', 'done', 'Correct validation errors. On uncertain submission reconcile request status; expired/handled-elsewhere requests show outcome.', { inputs: ['SMS-CODE'] }),
  ], 'Server-confirmed success returns according to entry origin. Back leaves without cancelling; expired/handled-elsewhere outcome can be closed.', ['TERM-REQUEST', 'TERM-RETURN'], { continuations: ['FLOW-PHONE', 'FLOW-REQUEST-OUTCOME'] }),
  F('FLOW-SMS-IOS', 'Respond to an SMS request on iOS', ['IOS'], agentKinds, 'A pending SMS request exists and iOS device setup is complete.', [
    S('open', 'INBOX', 'INBOX-OPEN-SMS', 'Open the pending row or notification response; the server starts manual readiness without an Android listener.', 'send', 'Retry this request after authentication/setup/network recovery or close.'),
    S('send', 'SMS', 'SMS-SEND', 'Type, deliberately paste, or choose eligible system AutoFill, then tap Send. Nothing auto-submits.', 'done', 'Use manual entry if AutoFill is unavailable; expired/manual-window or competing-device results show an outcome.', { inputs: ['SMS-CODE'] }),
  ], 'The approved code is submitted with manual source; dismiss/pop the response according to origin. No Android consent event is emitted.', ['TERM-REQUEST', 'TERM-RETURN'], { continuations: ['FLOW-REQUEST-OUTCOME'] }),
  F('FLOW-FORM', 'Answer a form or decision request', phones, agentKinds, 'Pending form exists and its required capabilities are approved.', [
    S('open', 'INBOX', 'INBOX-OPEN-FORM', 'Open the pending row or notification; read the requester and explanation.', 'answer', 'Retry the same request or close without submitting.'),
    S('answer', 'FORM', 'FORM-SUBMIT', 'Complete visible native fields and press the declared Submit, Approve, or Acknowledge action.', 'outcome', 'Show field validation inline. On uncertain submission reconcile outcome; do not submit from autofill/opening.', { inputs: ['FORM-FIELDS'] }),
    S('outcome', 'REQUEST-OUTCOME', 'REQUEST-OUTCOME-BACK', 'Read the current form outcome, then close the response.', 'done', 'If result state is uncertain, refetch the same request; do not expose previous sensitive values.'),
  ], 'The declared answer/action was accepted and the response was closed; no History entry for form answers is introduced.', ['TERM-REQUEST', 'TERM-CAPABILITY']),
  F('FLOW-WIZARD', 'Complete a multi-step form', phones, agentKinds, 'The opened form declares wizard steps.', [
    S('start', 'FORM', 'FORM-WIZARD', 'Enter the defined multi-step response.', 'step', 'Retry loading this request or close.'),
    S('step', 'WIZARD', 'WIZARD-NEXT', 'Fill the current step, use Previous step to revise, and advance through reachable steps to final review.', 'review', 'Correct current-step validation; hidden answers are pruned. Close preserves only the in-memory draft.', { inputs: ['WIZARD-FIELDS'], extraControls: ['WIZARD-PREVIOUS'] }),
    S('review', 'FORM-REVIEW', 'FORM-REVIEW-SUBMIT', 'Review answers; Edit returns to a step, final declared action submits.', 'done', 'Use Edit to correct answers, or reconcile an uncertain final submission before retrying.', { extraControls: ['FORM-REVIEW-EDIT'] }),
  ], 'One final submission contains only reachable answers; outcome remains in the response until closed.', ['TERM-REQUEST', 'TERM-RECOVERY']),
  F('FLOW-DECLINE-REQUEST', 'Explicitly cancel an SMS request', phones, agentKinds, 'SMS response is open; Back/Close must not cancel it.', [
    S('cancel', 'SMS', 'SMS-CANCEL', 'Choose the explicit Cancel/Decline request action.', 'done', 'Reconcile request state after network failure; show competing-device/expired outcome if already terminal.'),
  ], 'The explicit terminal action was applied; merely navigating away never performs it.', ['TERM-REQUEST', 'TERM-RETURN']),
  F('FLOW-DECLINE-FORM', 'Decline a form when declared', phones, agentKinds, 'The form definition explicitly offers Decline.', [
    S('decline', 'FORM', 'FORM-DECLINE', 'Press the declared Decline action.', 'done', 'Reconcile uncertain result or retry; do not manufacture a Decline action when it is not declared.'),
  ], 'The declared decline outcome is accepted and may be closed.', ['TERM-REQUEST']),
  F('FLOW-REQUEST-OUTCOME', 'Leave an expired or handled-elsewhere response', phones, agentKinds, 'The response has a terminal outcome instead of editable fields.', [
    S('close', 'REQUEST-OUTCOME', 'REQUEST-OUTCOME-BACK', 'Read expired, cancelled, or handled-on-another-device state and close.', 'done', 'Keep the terminal outcome readable and allow Close even if offline.'),
  ], 'Return follows entry origin; no secret value or historical feed is shown.', ['TERM-RETURN', 'TERM-REQUEST']),
  F('FLOW-SEARCH', 'Find an administrative setting', all, ['NONE'], 'Open the Administration entry/settings hierarchy.', [
    S('open', 'SETTINGS', 'SETTINGS-OPEN-SEARCH', 'Tap the visible Search settings widget.', 'query', 'Keep Settings usable if search fails; Back returns to categories.'),
    S('query', 'SETTINGS-SEARCH', 'SETTINGS-SEARCH-OPEN', 'Type a label or synonym; open its breadcrumb-labelled destination. Object-specific results first select an object.', 'done', 'No matches: change or clear the query, or Back to categories. Search never executes a setting action.', { inputs: ['SETTINGS-SEARCH-QUERY'], extraControls: ['SETTINGS-SEARCH-CLEAR'] }),
  ], 'The chosen settings task is open without a state mutation.', ['TERM-HISTORY', 'TERM-CONNECTION']),
  F('FLOW-HISTORY', 'Review completed SMS outcomes', all, ['NONE'], 'Open Settings → Administration → History; browser history is part of the redesign target.', [
    S('history', 'HISTORY', 'HISTORY-REFRESH', 'Read metadata-only outcomes; pull down to refresh if needed.', 'done', 'Show refresh failure inline while preserving rows or the empty state; Back remains available.'),
  ], 'Completed SMS metadata was read exclusively in Administration, without codes, answers, or Inbox history.', ['TERM-HISTORY']),
  F('FLOW-DEVICE-RECEPTION', 'Pause or resume a receiving device', all, ['NONE'], 'Open Administration → Devices and select the intended installation.', [
    S('toggle', 'DEVICE-RECEIVE', 'DEVICE-RECEIVE-TOGGLE', 'Set Receive requests for this device.', 'done', 'Retain confirmed server state after failure; retry or leave, never pretend the toggle succeeded.'),
  ], 'Only the selected device reception state changed.', ['TERM-DEVICE']),
  F('FLOW-REMOVE-DEVICE', 'Remove a receiving device', all, ['NONE'], 'Select a device and open its dedicated removal confirmation.', [
    S('remove', 'DEVICE-REMOVE', 'DEVICE-REMOVE-SUBMIT', 'Verify the selected installation and confirm removal.', 'done', 'Reconcile uncertain removal; another device/account/connection must not be removed by retry.'),
  ], 'This installation is unregistered; other phones and agent connections remain.', ['TERM-DEVICE']),
  F('FLOW-PERMISSIONS', 'Change one connection permission set', all, ['NONE'], 'Open Peering → Connections → selected connection → Change permissions.', [
    S('save', 'CONNECTION-PERMISSIONS', 'CONNECTION-PERMISSIONS-SUBMIT', 'Choose permitted forms/SMS capabilities and explicitly save.', 'done', 'Correct invalid permissions; a revoked connection requires fresh approval, not a silent re-enable.', { inputs: ['CONNECTION-PERMISSIONS-VALUE'] }),
  ], 'Effective capabilities changed and future operations reauthorize them.', ['TERM-CONNECTION', 'TERM-CAPABILITY']),
  F('FLOW-EXPIRY', 'Change one connection expiry', all, ['NONE'], 'Select a connection and open Change expiry.', [
    S('save', 'CONNECTION-EXPIRY', 'CONNECTION-EXPIRY-SUBMIT', 'Choose a supported duration and explicitly save.', 'done', 'Correct duration or reconcile current server state; expired access may require a new approval.', { inputs: ['CONNECTION-EXPIRY-VALUE'] }),
  ], 'The selected connection duration is saved.', ['TERM-CONNECTION']),
  F('FLOW-DISCONNECT', 'Disconnect one agent from this recipient', all, ['NONE'], 'Select the connection and open Disconnect.', [
    S('disconnect', 'CONNECTION-DISCONNECT', 'CONNECTION-DISCONNECT-SUBMIT', 'Verify the selected connection and confirm disconnection.', 'done', 'Reconcile revocation after a transport error; retry safely or close.'),
  ], 'This recipient connection loses request/result access; unrelated connections remain.', ['TERM-CONNECTION']),
  F('FLOW-SHARE', 'Share a public agent connection link', all, agentKinds, 'Open the owned agent → Connection link.', [
    S('share', 'AGENT-SHARE', 'AGENT-SHARE-SHARE', 'Share the public link/QR, or Copy link if a share sheet is unavailable.', 'done', 'Cancel the share sheet or use Copy link. Never substitute a private ticket.', { extraControls: ['AGENT-SHARE-COPY'] }),
  ], 'Only the public connection destination is shared; recipients still approve separately.', ['TERM-PUBLIC-LINK', 'TERM-TICKET']),
  F('FLOW-AGENT-AVAILABILITY', 'Disable or re-enable an owned agent', all, agentKinds, 'Select the owned agent → Availability.', [
    S('save', 'AGENT-AVAILABILITY', 'AGENT-AVAILABILITY-SUBMIT', 'Review the effect on all connections and set availability.', 'done', 'Show confirmed server state; reconcile failure before indicating success.'),
  ], 'All operations recheck parent availability; re-enabling restores current agent authority.', ['TERM-AGENT', 'TERM-CONNECTION']),
  F('FLOW-AGENT-DELETE', 'Delete an owned agent', all, agentKinds, 'Open the selected owned agent deletion confirmation.', [
    S('delete', 'AGENT-DELETE', 'AGENT-DELETE-SUBMIT', 'Confirm deletion after reviewing the effect on every connection.', 'done', 'Reconcile uncertain acceptance; never recreate the deleted agent as a retry.'),
  ], 'The agent is inactive/deleted and child cleanup is queued; other agents remain.', ['TERM-AGENT']),
  F('FLOW-TICKET-CLEAR', 'Clear a retained ticket after safe export', all, agentKinds, 'FLOW-CREATE-AGENT saved the file, or the agent was explicitly deleted. Retained provisioning state still exists.', [
    S('clear', 'AGENT-TICKET-CLEAR', 'AGENT-TICKET-CLEAR-SUBMIT', 'Acknowledge safe export/deletion and clear only the selected retained copy.', 'done', 'If the owner/ticket changed, reload the selected retained state; never clear another ticket.', { inputs: ['AGENT-TICKET-CLEAR-ACK'] }),
  ], 'Only the acknowledged retained provisioning state was cleared; the service cannot recover private keys.', ['TERM-TICKET']),
  F('FLOW-LINK-PROVIDER', 'Link a second sign-in provider', all, ['NONE'], 'Open Account → Sign-in methods and select an unlinked provider.', [
    S('link', 'ACCOUNT-LINK', 'ACCOUNT-LINK-SUBMIT', 'Consent to linking this provider to the current account, then authenticate it.', 'done', 'Keep the original account on provider cancellation/conflict; never merge by email or switch owner silently.'),
  ], 'The same relay account has the additional explicitly linked provider.', ['TERM-OWNER']),
  F('FLOW-SIGNOUT', 'Sign out of the current installation', all, ['NONE'], 'Open Account → Sign out.', [
    S('signout', 'ACCOUNT-SIGNOUT', 'ACCOUNT-SIGNOUT-SUBMIT', 'Confirm local sign-out and discard sensitive response drafts.', 'done', 'Keep current identity clear and retry local session cleanup or close.'),
  ], 'Login is shown; no server-side account deletion or connection revocation was implied.', ['TERM-OWNER', 'TERM-RETURN'], { continuations: ['FLOW-LOGIN'] }),
  F('FLOW-DELETE-ACCOUNT', 'Delete the relay account', all, ['NONE'], 'Open Account → Delete account; web direct links first use FLOW-LOGIN.', [
    S('confirm', 'ACCOUNT-DELETE', 'ACCOUNT-DELETE-SUBMIT', 'Acknowledge deletion, verify the same account, and confirm. Required Apple revocation stays in the authenticated flow.', 'status', 'Reauthentication cancellation stops deletion. After uncertain server acceptance, reconcile the receipt/status before resubmitting.', { inputs: ['ACCOUNT-DELETE-ACK'] }),
    S('status', 'ACCOUNT-DELETION', 'ACCOUNT-DELETION-CHECK', 'Read accepted/cleanup status; access is blocked on acceptance and cleanup continues after Close.', 'done', 'Keep acceptance distinct from cleanup completion; retry status using the retained receipt or close.'),
  ], 'Accepted deletion blocks access; cleanup continues independently of the open page.', ['TERM-OWNER', 'TERM-RECOVERY']),
  F('FLOW-PRIVACY', 'Read privacy information', all, agentKinds, 'Open Privacy from Account or sign-in; preserve that calling destination.', [
    S('read', 'ACCOUNT-PRIVACY', 'ACCOUNT-PRIVACY-CONTACT', 'Read the policy; open operator contact only if needed and configured, then return.', 'done', 'If no contact is published, keep the policy readable and allow Back.'),
  ], 'Policy is readable and Back returns to the original account/sign-in task.', ['TERM-OWNER']),
  F('FLOW-DECLINE-PAIRING', 'Decline an agent access request', all, agentKinds, 'A connection review is open.', [
    S('decline', 'PAIR-REVIEW', 'PAIR-REVIEW-DECLINE', 'Choose Decline instead of granting access.', 'done', 'Reconcile session state; expired/previously decided sessions show their actual result.'),
  ], 'No new access is granted; an existing unrelated connection is not revoked.', ['TERM-CONNECTION']),
  F('FLOW-DECLINE-REGISTRATION', 'Decline agent ownership registration', all, local, 'A registration review is open.', [
    S('decline', 'REGISTER-APPROVAL', 'REGISTER-APPROVAL-DECLINE', 'Choose Decline instead of registering ownership.', 'done', 'Reconcile session state; no recipient grant is created regardless of outcome.'),
  ], 'Agent registration is declined; software can stop or explicitly start a fresh registration.', ['TERM-REGISTRATION']),
];

// Required cross-product coverage is explicit so removing a whole flow cannot
// silently reduce the platform/agent matrix that the validator checks.
contract.coverage = [
  { flow: 'FLOW-LOGIN', platforms: all, agents: agentKinds },
  { flow: 'FLOW-PHONE', platforms: phones, agents: agentKinds },
  { flow: 'FLOW-BROWSER-PHONE', platforms: ['BROWSER'], agents: agentKinds },
  { flow: 'FLOW-DIRECT-CONNECT', platforms: all, agents: local },
  { flow: 'FLOW-HOSTED-CONNECT', platforms: all, agents: ['HOSTED'] },
  { flow: 'FLOW-TUI-TOOLS', platforms: all, agents: ['TUI'] },
  { flow: 'FLOW-SMS-ANDROID', platforms: ['ANDROID'], agents: agentKinds },
  { flow: 'FLOW-SMS-IOS', platforms: ['IOS'], agents: agentKinds },
  { flow: 'FLOW-NOTIFICATION-SMS', platforms: phones, agents: agentKinds },
  { flow: 'FLOW-NOTIFICATION-FORM', platforms: phones, agents: agentKinds },
  { flow: 'FLOW-HISTORY', platforms: all, agents: ['NONE'] },
];
