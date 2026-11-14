# Relay and Admin

The Administration launcher entry manages app/bot access directly, in its own Android task. Inbox handles requests in a separate task. Both entries share the account and service repository. See [the interface contract](UX.md). The earlier external-manager approach is superseded and its issuance endpoints have been removed.

The governing UI target is an Android Settings-style hierarchy with a visible settings search widget. Group focused pages under Administration (devices, owned agents, history), Peering (connections), and Account; keep Initial Login conditional. Every page serves one task. History lives only in Administration and has no Inbox tab or shortcut. Existing Access/Devices/History navigation is pending migration and must not guide new UI work; use the [page inventory and acceptance criteria](UX.md#page-inventory).

See [direct pairing design](PAIRING_DESIGN.md): bot requests connection → owner opens its link → owner approves in Admin → the bot's individual credential becomes usable. No master credential is created or copied on the phone.

Relay keeps the message-by-message Android consent flow. A user may register multiple phones; active SMS requests notify all available phones, each has its own consent gate, and the first approved result wins. Further callers queue without competing for one incoming SMS.
