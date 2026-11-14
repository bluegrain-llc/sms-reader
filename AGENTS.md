# Repository instructions

## UI work

Before planning, implementing, or reviewing any UI or navigation change, read
[docs/UX.md](docs/UX.md). It is the governing UI contract for Android, iOS, and
browser surfaces. Existing screens, screenshots, tests, and older navigation
descriptions may predate this contract; do not treat them as permission to retain
or introduce conflicting designs.

Also read [docs/ui/README.md](docs/ui/README.md) and follow its linked
[flows](docs/ui/FLOWS.md), [page/control inventory](docs/ui/INVENTORY.md), and
[glossary](docs/ui/GLOSSARY.md). Their canonical source is
[docs/ui/contract.mjs](docs/ui/contract.mjs). Preserve stable page/control IDs such
as `LOGIN` and `LOGIN-SUBMIT`; cite affected `FLOW-*` IDs in implementation/review
descriptions and use the IDs in UI tests/selectors where practical. Check the
actual platform and agent-kind matrix: never assume Android SMS consent on iOS,
a browser Inbox, or local ticket/credential setup for a hosted OAuth recipient.

- Every page has one purpose. Include only information and active elements needed
  to complete that purpose. Selection lists and navigation menus are single-purpose
  pages; do not put creation forms, editors, or unrelated management actions inside
  them.
- The administrative UI follows Android Settings: a searchable hierarchy of
  category rows and focused child pages, not a dashboard or a page containing all
  settings. Preserve this organization on iOS and the web while using accessible
  platform-appropriate controls.
- Organize pages into Administration, Peering, Account, and Initial Login, with
  Requests for Inbox and responses. Initial Login is a conditional flow, not a
  permanent settings category.
- History belongs exclusively to Administration. Inbox shows pending requests
  only: no history tab, completed-request feed, history shortcut, or history search.
- Settings search navigates to the relevant page. It never changes settings,
  grants access, submits responses, or searches private request content or secrets.
- Separate agent ownership/registration from recipient connection approval.
  Separate device settings from account settings. Preserve explicit confirmation
  for destructive actions and existing request, consent, and credential semantics.

For each UI change, check its pages against the contract's page inventory and
acceptance criteria. Verify relevant navigation, search, accessibility, and request
return behavior where affected. Do not change an old assertion merely to preserve
a UI that violates the contract. Report any remaining migration gaps honestly;
documentation changes alone do not implement the redesign.

When UI behavior or navigation changes, update the canonical pages, controls,
flows, glossary, and required coverage together, then run `npm run docs:ui`,
`npm run check:ui`, and `npm run test:ui`. Generated Markdown is not edited directly.
Do not remove an outcome, platform/agent requirement, or failure/exit branch just
to make validation pass. Run relevant runtime tests as well; the design graph
cannot prove that the app or an external provider implements it.
