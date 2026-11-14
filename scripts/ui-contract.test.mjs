import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { contract } from '../docs/ui/contract.mjs';
import { checkDocuments, renderDocuments, validateContract } from './ui-contract.mjs';

const flow = (data, id = 'FLOW-LOGIN') => data.flows.find(f => f.id === id);
const page = (data, id) => data.pages.find(p => p.id === id);
function rejects(change, expected) {
  const data = structuredClone(contract);
  change(data);
  const errors = validateContract(data);
  assert.ok(errors.some(error => expected.test(error)), `Expected ${expected}, got:\n${errors.join('\n')}`);
}

test('canonical design validates with all declared platform/agent scenarios', () => {
  assert.deepEqual(validateContract(contract), []);
});

test('duplicate IDs cannot make a control shadow a page', () => {
  rejects(data => { page(data, 'LOGIN').controls[0].id = 'LOGIN'; }, /Duplicate ID LOGIN/);
});

test('unknown control references are rejected', () => {
  rejects(data => { flow(data).nodes[0].action = 'LOGIN-MISSING'; }, /unknown control LOGIN-MISSING/);
});

test('a primary action cannot be omitted from a navigation step', () => {
  rejects(data => { delete flow(data, 'FLOW-SEARCH').nodes[0].action; }, /primary action: unknown control undefined/);
});

test('a control cannot be borrowed from another page', () => {
  rejects(data => { flow(data).nodes[0].action = 'AGENT-CREATE-SUBMIT'; }, /belongs to another page/);
});

test('unknown glossary references are rejected', () => {
  rejects(data => { page(data, 'LOGIN').terms.push('TERM-MISSING'); }, /unknown reference TERM-MISSING/);
});

test('glossary definitions must have real page or flow backlinks', () => {
  rejects(data => { data.terms.push({ id: 'TERM-ORPHAN', name: 'Unused', definition: 'Unused term.', related: ['TERM-OWNER'] }); }, /TERM-ORPHAN: glossary term has no page\/flow backlink/);
});

test('flow references in explanatory text are validated too', () => {
  rejects(data => { flow(data).preconditions = 'Complete FLOW-DOES-NOT-EXIST.'; }, /Text cross-reference: unknown reference FLOW-DOES-NOT-EXIST/);
});

test('a transition cannot point to a missing step', () => {
  rejects(data => { flow(data).nodes[0].outcomes[0].to = 'missing'; }, /missing destination missing/);
});

test('success cannot disappear behind retry loops', () => {
  rejects(data => { flow(data).nodes[0].outcomes[0].to = 'login'; }, /success unreachable/);
});

test('a leaf without outcomes is a dead end', () => {
  rejects(data => { flow(data).nodes[0].outcomes = []; }, /no outcomes \(dead end\)/);
});

test('reachable multi-node closed cycles are rejected even if entry can succeed', () => {
  rejects(data => {
    const f = flow(data);
    const template = structuredClone(f.nodes[0]);
    for (const [id, destination] of [['trap-a', 'trap-b'], ['trap-b', 'trap-a']]) {
      const node = structuredClone(template); node.id = id;
      node.outcomes.forEach(edge => { edge.to = destination; });
      f.nodes.push(node);
    }
    f.nodes[0].outcomes.find(e => e.event === 'failure').to = 'trap-a';
  }, /no path to success or safe stop \(trapped cycle\/dead end\)/);
});

test('unreachable steps cannot sit outside validated user paths', () => {
  rejects(data => { flow(data).nodes.push({ id: 'unused', terminal: 'safe-stop', result: 'Stopped.', exit: 'Close.' }); }, /orphan step unused/);
});

test('terminal outcomes need an explicit exit', () => {
  rejects(data => { delete flow(data).nodes.find(n => n.id === 'done').exit; }, /exit: nonempty text required/);
});

test('failure, denial and cancellation cannot be omitted', () => {
  for (const event of ['failure', 'denied', 'cancelled']) {
    rejects(data => { flow(data).nodes[0].outcomes = flow(data).nodes[0].outcomes.filter(e => e.event !== event); }, new RegExp(`missing ${event} outcome`));
  }
});

test('waits must handle timeout, revocation and finite deadlines', () => {
  for (const event of ['timeout', 'revoked']) {
    rejects(data => {
      const n = flow(data, 'FLOW-TUI-TOOLS').nodes.find(n => n.id === 'check');
      n.outcomes = n.outcomes.filter(e => e.event !== event);
    }, new RegExp(`missing ${event} outcome`));
  }
  rejects(data => { delete page(data, 'TUI-CLIENT').controls.find(c => c.id === 'TUI-CLIENT-CHECK').timeoutSeconds; }, /bounded wait deadline/);
});

test('timeout cannot silently restart the same waiting operation', () => {
  rejects(data => {
    const n = flow(data, 'FLOW-TUI-TOOLS').nodes.find(n => n.id === 'check');
    n.outcomes.find(e => e.event === 'timeout').to = 'check';
  }, /timeout cannot silently restart the same wait/);
});

test('Back cannot be disguised as another retry loop', () => {
  rejects(data => { flow(data).nodes[0].outcomes.find(e => e.event === 'cancelled').to = 'login'; }, /Back\/Close cannot be a self-loop/);
});

test('a browser flow cannot visit a native response page', () => {
  rejects(data => { flow(data, 'FLOW-SMS-IOS').platforms.push('BROWSER'); }, /page (INBOX|SMS) unavailable/);
});

test('iOS cannot execute an Android-only consent control', () => {
  rejects(data => {
    const n = flow(data, 'FLOW-SMS-IOS').nodes.find(n => n.id === 'send');
    n.action = 'SMS-CONSENT';
  }, /control SMS-CONSENT unavailable/);
});

test('platform-filtered edges cannot hide a missing recovery branch', () => {
  rejects(data => { flow(data).nodes[0].outcomes.find(e => e.event === 'failure').platforms = ['IOS']; }, /ANDROID\/.*missing failure outcome/);
});

test('an unavailable scope cannot hide an orphan step', () => {
  rejects(data => {
    const n = structuredClone(flow(data).nodes[0]); n.id = 'hidden'; n.platforms = ['UNKNOWN'];
    flow(data).nodes.push(n);
  }, /unknown platform UNKNOWN/);
});

test('transitions cannot jump into a step absent on that platform', () => {
  rejects(data => { flow(data, 'FLOW-PHONE').nodes.find(n => n.id === 'register').platforms = ['IOS']; }, /ANDROID\/.*destination register unavailable/);
});

test('required agent/platform coverage cannot silently shrink', () => {
  rejects(data => { flow(data, 'FLOW-DIRECT-CONNECT').agents = ['SCRIPT']; }, /required coverage missing ANDROID\/TUI/);
});

test('an orphan page cannot be hidden by giving it a Back link', () => {
  rejects(data => {
    data.pages.push({ id: 'UNREACHABLE', title: 'Orphan', purpose: 'Cannot open.', information: 'Nothing.', group: 'Administration', surface: 'relay', platforms: ['ANDROID'], terms: [], parent: 'SETTINGS', controls: [{ id: 'UNREACHABLE-BACK', label: 'Back', kind: 'navigation', detail: 'Return.', targets: ['SETTINGS'] }] });
  }, /ANDROID: orphan page UNREACHABLE/);
});

test('a new action needs a user flow', () => {
  rejects(data => { page(data, 'LOGIN').controls.push({ id: 'LOGIN-UNUSED', label: 'Unused', kind: 'submit', detail: 'An unexplained action.', targets: [] }); }, /LOGIN-UNUSED: active control has no flow coverage/);
});

test('a navigation control needs a destination available on each platform', () => {
  rejects(data => { page(data, 'SETTINGS').controls[0].targets = ['SMS']; }, /no navigation target for BROWSER/);
});

test('a navigation control cannot silently lose its destination', () => {
  rejects(data => { page(data, 'AGENT').controls[0].targets = []; }, /navigation requires an explicit destination/);
});

test('history stays under Administration and out of Inbox', () => {
  rejects(data => { page(data, 'HISTORY').group = 'Requests'; }, /HISTORY must belong exclusively to Administration/);
  rejects(data => { page(data, 'INBOX').controls[0].targets = ['HISTORY']; }, /request pages cannot navigate to history\/search/);
});

test('settings search cannot be replaced with a state mutation', () => {
  rejects(data => { page(data, 'SETTINGS-SEARCH').controls.find(c => c.id === 'SETTINGS-SEARCH-OPEN').kind = 'submit'; }, /Settings search results must navigate/);
});

test('generated views are deterministic and cross-link control, term and flow IDs', () => {
  const docs = renderDocuments(contract);
  assert.deepEqual([...docs], [...renderDocuments(structuredClone(contract))]);
  assert.match(docs.get('docs/ui/FLOWS.md'), /\[LOGIN-SUBMIT\]\(INVENTORY.md#login-submit\)/);
  assert.match(docs.get('docs/ui/FLOWS.md'), /\[TERM-OWNER\]\(GLOSSARY.md#term-owner\)/);
  assert.match(docs.get('docs/ui/INVENTORY.md'), /\[FLOW-LOGIN\]\(FLOWS.md#flow-login\)/);
  assert.match(docs.get('docs/ui/GLOSSARY.md'), /\[FLOW-LOGIN\]\(FLOWS.md#flow-login\)/);
  assert.match(docs.get('docs/ui/FLOWS.md'), /Before starting:.*\[FLOW-CREATE-AGENT\]/);
});

async function documentFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relay-ui-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docs = new Map([
    ['docs/ui/INVENTORY.md', '# Inventory\n\n<a id="login-submit"></a>\n'],
    ['docs/ui/FLOWS.md', '# Flows\n\n[Submit](INVENTORY.md#login-submit)\n'],
  ]);
  for (const [file, value] of [...docs, ...['docs/UX.md', 'docs/ui/README.md', 'AGENTS.md', 'docs/ADMIN_RELAY_DESIGN.md', 'docs/ONBOARDING.md', 'docs/IOS.md', 'integrations/README.md'].map(file => [file, '# Guide\n'])]) {
    await mkdir(dirname(join(directory, file)), { recursive: true });
    await writeFile(join(directory, file), value);
  }
  return { directory, docs };
}

test('document checking rejects hand-edited generated views', async t => {
  const { directory, docs } = await documentFixture(t);
  assert.deepEqual(await checkDocuments(docs, directory), []);
  await writeFile(join(directory, 'docs/ui/FLOWS.md'), '# Edited by hand\n');
  assert.ok((await checkDocuments(docs, directory)).some(error => /stale generated document/.test(error)));
});

test('document checking rejects broken ID anchors and missing files', async t => {
  const { directory, docs } = await documentFixture(t);
  const broken = '# Flows\n\n[Submit](INVENTORY.md#login-missing)\n[Missing](MISSING.md)\n';
  docs.set('docs/ui/FLOWS.md', broken);
  await writeFile(join(directory, 'docs/ui/FLOWS.md'), broken);
  const errors = await checkDocuments(docs, directory);
  assert.ok(errors.some(error => /broken anchor INVENTORY.md#login-missing/.test(error)));
  assert.ok(errors.some(error => /broken file link MISSING.md/.test(error)));
});
