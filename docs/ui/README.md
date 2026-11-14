# UI flows and inventory

The [UI contract](../UX.md) defines one purpose per page and an Android Settings-style administrative hierarchy with search. History belongs exclusively to Administration. This directory gives that design stable names and executable consistency checks.

Start with [user flows and platform differences](FLOWS.md), then follow their links to the [page/control inventory](INVENTORY.md) and [glossary](GLOSSARY.md). Every generated view links back to the others. For example, [FLOW-LOGIN](FLOWS.md#flow-login) uses [LOGIN-SUBMIT](INVENTORY.md#login-submit) on [LOGIN](INVENTORY.md#login), explained by [TERM-OWNER](GLOSSARY.md#term-owner). The inventory and glossary link back to their flows.

## Source and stable IDs

[contract.mjs](contract.mjs) is the canonical machine-readable source. Its arrays declare platforms, agent kinds, glossary terms, pages, controls, entry points, flows, and required platform/agent coverage. Small constructors expand repeated Back/Close controls and complete result partitions; the exported object is the data the validator examines.

Pages use task names such as `LOGIN` or `CONNECTION-PERMISSIONS`. Controls add a name, such as `LOGIN-SUBMIT`; flows use `FLOW-`, terms use `TERM-`. IDs are unique across all entity types. Flow step IDs are local to a flow, with document anchors composed from flow and step IDs. Keep IDs stable when changing labels. A retired ID must have all references migrated in the same change; never silently reuse it for another task. Dynamic form inputs append their declared request field ID to the stable input family in implementation test selectors.

The platform is where the person approves/manages the relay, not where agent software executes. A terminal agent can run on a computer while its recipient approves on Android, iOS, or a browser. Browser management parity in the inventory is a redesign target. Browser Inbox/SMS/form responses and browser receiving-device registration are unsupported; their flow hands off to a native phone. External provider screens and OS dialogs appear as external boundaries, not relay pages to implement.

Scripts and terminal agents import/store private configuration outside model tools, then use a selected recipient connection. Hosted browser agents use provider-managed OAuth to a public named-service MCP endpoint. ChatGPT and Codex are examples of those agent types; this contract does not prescribe current third-party menu names or claim live provider acceptance. See [onboarding](../ONBOARDING.md), [iOS behavior](../IOS.md), and [integration boundaries](../../integrations/README.md).

## Editing and validation

1. Edit the source definitions, including platform support, flow instructions, required outcomes, recovery text, and glossary references.
2. Keep all affected page/control IDs, flow references, and required platform/agent coverage synchronized. Add a focused flow when adding a new submit/system/command/wait control. Local edit and refresh controls stay on their page; navigation controls explicitly identify targets or the invoking context.
3. Run `npm run docs:ui` to validate the model and regenerate the three Markdown views.
4. Run `npm run check:ui` and `npm run test:ui`. CI runs both independently of app builds, without installing packages or accessing the network.
5. For implemented UI changes, also verify actual navigation, state handling, accessibility, and platform behavior. Use the page/control IDs in test names/selectors where practical and cite the affected flow IDs in the change description.

The validator rejects duplicate/unknown IDs; controls belonging to another page; unavailable platform pages/controls/transitions; missing declared outcome branches; missing bounded wait deadlines; unreachable success; orphan steps/pages; terminal states without an explicit result/exit; and reachable closed cycles without a success or safe-stop path. It checks every declared platform/agent combination, the required coverage matrix, History placement, request-page isolation, glossary backlinks, local document links/anchors, and generated-file drift.

Submission steps include success, invalid input, transient failure, and cancellation. System operations also include denial. Waits include ready, timeout, revocation, failure, and cancellation, with a maximum check interval of ten minutes capped by the protocol/server deadline. Timeout/revocation ends the attempt with a safe stop or a distinct explicit recovery action, never a silent restart of the same wait. These are checking bounds, not an extension of SMS listening or approval lifetimes. Transient failures show recovery on the same focused page and await an explicit retry; Back/Close remains an independent safe exit. A safe stop never implies undoing accepted server changes or cancelling a request.

This is a deterministic check of the declared design graph. It cannot prove that running Android/iOS/browser code, OS dialogs, network services, or third-party provider UIs implement that graph. A green contract check is not an end-to-end acceptance claim. Runtime checks must demonstrate the affected flows before marking a redesign task implemented.
