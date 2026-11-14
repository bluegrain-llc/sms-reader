#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { contract } from '../docs/ui/contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const groups = ['Administration', 'Peering', 'Account', 'Initial Login', 'Requests', 'External'];
const kinds = ['input', 'edit', 'navigation', 'observe', 'submit', 'system', 'wait', 'command'];
const idPattern = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*$/;
const requiredEvents = kind => kind === 'wait' ? ['ready', 'timeout', 'revoked', 'failure', 'cancelled']
  : kind === 'system' ? ['success', 'denied', 'failure', 'cancelled']
    : kind === 'submit' ? ['success', 'invalid', 'failure', 'cancelled']
      : ['success', 'failure', 'cancelled'];
const nodeRefs = node => [node.action, node.back, ...(node.inputs ?? []), ...(node.extraControls ?? [])].filter(Boolean);
const selected = (item, platform, agent) => (!item.platforms || item.platforms.includes(platform)) && (!item.agents || item.agents.includes(agent));

export function validateContract(data) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(message); };
  const text = (value, label) => check(typeof value === 'string' && value.trim().length > 0, `${label}: nonempty text required`);
  const registry = new Map();
  const register = (item, type) => {
    check(idPattern.test(item.id), `${type}: invalid ID ${item.id}`);
    check(!registry.has(item.id), `Duplicate ID ${item.id}`);
    registry.set(item.id, { item, type });
  };
  for (const [key, type] of [['platforms', 'platform'], ['agents', 'agent'], ['terms', 'term'], ['pages', 'page'], ['flows', 'flow']]) {
    if (!Array.isArray(data[key]) || !data[key].length) { errors.push(`${key}: nonempty array required`); continue; }
    for (const item of data[key]) register(item, type);
  }
  if (errors.length) return errors;
  const pages = new Map(data.pages.map(p => [p.id, p]));
  const actions = new Map();
  for (const p of data.pages) for (const c of p.controls ?? []) { register(c, 'control'); actions.set(c.id, { ...c, page: p.id }); }
  const ref = (id, type, label) => check(registry.has(id) && (!type || registry.get(id).type === type), `${label}: unknown ${type ?? 'reference'} ${id}`);
  const refs = (ids, type, label, allowEmpty = false) => {
    if (!Array.isArray(ids) || (!allowEmpty && !ids.length)) { errors.push(`${label}: ${allowEmpty ? 'an' : 'nonempty'} array required`); return; }
    check(new Set(ids).size === ids.length, `${label}: duplicate references`);
    for (const id of ids) ref(id, type, label);
  };
  const sourceRef = (source, label) => check(typeof source === 'string' && !source.startsWith('/') && !source.split('/').includes('..'), `${label}: source must be repository-relative`);
  const checkProse = value => {
    if (typeof value === 'string') for (const match of value.matchAll(/\b(?:FLOW|TERM)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)) ref(match[0], null, 'Text cross-reference');
    else if (Array.isArray(value)) value.forEach(checkProse);
    else if (value && typeof value === 'object') Object.values(value).forEach(checkProse);
  };
  checkProse(data);
  for (const item of [...data.platforms, ...data.agents]) {
    text(item.name, item.id); text(item.detail, item.id);
    for (const source of item.sources ?? []) sourceRef(source, item.id);
  }
  for (const t of data.terms) { text(t.name, t.id); text(t.definition, t.id); refs(t.related, null, t.id); }
  for (const p of data.pages) {
    text(p.title, p.id); text(p.purpose, p.id); text(p.information, p.id);
    check(groups.includes(p.group), `${p.id}: invalid group`);
    check(['relay', 'external', 'system'].includes(p.surface), `${p.id}: invalid surface`);
    refs(p.platforms, 'platform', p.id); refs(p.terms, null, p.id, true);
    if (p.parent) ref(p.parent, 'page', `${p.id} parent`);
    check(Array.isArray(p.controls) && p.controls.length > 0, `${p.id}: controls required`);
    const back = actions.get(`${p.id}-BACK`);
    check(back?.page === p.id && back.kind === 'navigation', `${p.id}: explicit Back/Close control required`);
    for (const c of p.controls ?? []) {
      check(c.id.startsWith(`${p.id}-`), `${c.id}: control ID must start with its page ID`);
      check(kinds.includes(c.kind), `${c.id}: invalid control kind`);
      text(c.label, c.id); text(c.detail, c.id);
      refs(c.targets, 'page', `${c.id} targets`, true);
      if (c.kind === 'navigation' && c.id !== `${p.id}-BACK`) check(c.targets.length > 0, `${c.id}: navigation requires an explicit destination`);
      if (c.platforms) refs(c.platforms, 'platform', c.id);
      if (c.kind === 'wait') check(Number.isInteger(c.timeoutSeconds) && c.timeoutSeconds > 0 && c.timeoutSeconds <= 600, `${c.id}: bounded wait deadline (1–600s) required`);
      for (const platform of c.platforms ?? p.platforms) {
        check(p.platforms.includes(platform), `${c.id}: control platform outside owning page`);
        if (c.targets?.length) check(c.targets.some(target => pages.get(target)?.platforms.includes(platform)), `${c.id}: no navigation target for ${platform}`);
      }
    }
    // Parent links are menu placement, not proof that forward navigation exists.
    const ancestors = new Set([p.id]); let parent = p.parent;
    while (parent && pages.has(parent)) { if (ancestors.has(parent)) { errors.push(`${p.id}: cyclic page parent`); break; } ancestors.add(parent); parent = pages.get(parent).parent; }
  }
  refs(data.entries, 'page', 'Entry points');
  for (const f of data.flows) {
    text(f.title, f.id); text(f.preconditions, f.id);
    refs(f.platforms, 'platform', f.id); refs(f.agents, 'agent', f.id); refs(f.terms, null, f.id);
    if (f.continuations) refs(f.continuations, 'flow', f.id);
    const nodes = new Map();
    for (const n of f.nodes ?? []) {
      check(typeof n.id === 'string' && /^[a-z][a-z0-9-]*$/.test(n.id), `${f.id}: invalid step ID ${n.id}`);
      check(!nodes.has(n.id), `${f.id}: duplicate step ${n.id}`); nodes.set(n.id, n);
    }
    check(nodes.has(f.entry), `${f.id}: missing entry step ${f.entry}`);
    for (const n of nodes.values()) {
      if (n.platforms) { refs(n.platforms, 'platform', `${f.id}/${n.id}`); check(n.platforms.every(p => f.platforms.includes(p)), `${f.id}/${n.id}: step platform outside flow`); }
      if (n.agents) { refs(n.agents, 'agent', `${f.id}/${n.id}`); check(n.agents.every(a => f.agents.includes(a)), `${f.id}/${n.id}: step agent outside flow`); }
      if (n.terminal) {
        check(['success', 'safe-stop'].includes(n.terminal), `${f.id}/${n.id}: invalid terminal kind`);
        text(n.result, `${f.id}/${n.id} result`); text(n.exit, `${f.id}/${n.id} exit`);
        check(!n.outcomes?.length && !n.action, `${f.id}/${n.id}: terminal cannot hide further actions`);
        continue;
      }
      ref(n.page, 'page', `${f.id}/${n.id}`);
      ref(n.action, 'control', `${f.id}/${n.id} primary action`);
      text(n.instruction, `${f.id}/${n.id}`);
      for (const controlId of nodeRefs(n)) {
        ref(controlId, 'control', `${f.id}/${n.id}`);
        check(actions.get(controlId)?.page === n.page, `${f.id}/${n.id}: ${controlId} belongs to another page`);
      }
      check(n.back === `${n.page}-BACK`, `${f.id}/${n.id}: task-local Back/Close required`);
      for (const input of n.inputs ?? []) check(actions.get(input)?.kind === 'input', `${f.id}/${n.id}: ${input} is not an input`);
      check(!['input', 'edit'].includes(actions.get(n.action)?.kind), `${f.id}/${n.id}: primary step needs an actionable control`);
      check(Array.isArray(n.outcomes) && n.outcomes.length > 0, `${f.id}/${n.id}: no outcomes (dead end)`);
      for (const edge of n.outcomes ?? []) {
        check(nodes.has(edge.to), `${f.id}/${n.id}: missing destination ${edge.to}`);
        text(edge.detail, `${f.id}/${n.id}/${edge.event} recovery/result`);
        text(edge.event, `${f.id}/${n.id} event`);
        if (edge.platforms) refs(edge.platforms, 'platform', f.id);
        if (edge.agents) refs(edge.agents, 'agent', f.id);
      }
    }
    for (const platform of f.platforms) for (const agent of f.agents) {
      const label = `${f.id} [${platform}/${agent}]`;
      const active = new Map([...nodes].filter(([, n]) => selected(n, platform, agent)));
      check(active.has(f.entry), `${label}: entry unavailable`);
      for (const n of active.values()) {
        if (n.terminal) continue;
        check(pages.get(n.page)?.platforms.includes(platform), `${label}/${n.id}: page ${n.page} unavailable`);
        for (const id of nodeRefs(n)) check(selected(actions.get(id) ?? {}, platform, agent), `${label}/${n.id}: control ${id} unavailable`);
        const edges = (n.outcomes ?? []).filter(e => selected(e, platform, agent));
        const events = edges.map(e => e.event);
        check(new Set(events).size === events.length, `${label}/${n.id}: ambiguous duplicate outcome`);
        for (const event of requiredEvents(actions.get(n.action)?.kind)) check(events.includes(event), `${label}/${n.id}: missing ${event} outcome`);
        check(events.every(event => requiredEvents(actions.get(n.action)?.kind).includes(event)), `${label}/${n.id}: unknown outcome event`);
        for (const edge of edges) check(active.has(edge.to), `${label}/${n.id}: destination ${edge.to} unavailable`);
        const cancel = edges.find(e => e.event === 'cancelled');
        check(cancel?.to !== n.id, `${label}/${n.id}: Back/Close cannot be a self-loop`);
        if (actions.get(n.action)?.kind === 'wait') for (const edge of edges.filter(e => ['timeout', 'revoked'].includes(e.event))) check(edge.to !== n.id, `${label}/${n.id}: ${edge.event} cannot silently restart the same wait`);
      }
      const reachable = walk([f.entry], id => (active.get(id)?.outcomes ?? []).filter(e => selected(e, platform, agent)).map(e => e.to));
      check([...reachable].some(id => active.get(id)?.terminal === 'success'), `${label}: success unreachable`);
      for (const id of active.keys()) check(reachable.has(id), `${label}: orphan step ${id}`);
      // Reverse fixed point catches closed cycles as well as leaf dead ends.
      const escapable = new Set([...active].filter(([, n]) => n.terminal).map(([id]) => id));
      let changed = true;
      while (changed) {
        changed = false;
        for (const [id, n] of active) if (!escapable.has(id) && (n.outcomes ?? []).some(e => selected(e, platform, agent) && escapable.has(e.to))) { escapable.add(id); changed = true; }
      }
      for (const id of reachable) check(escapable.has(id), `${label}/${id}: no path to success or safe stop (trapped cycle/dead end)`);
    }
  }
  for (const c of data.coverage ?? []) {
    ref(c.flow, 'flow', 'Required coverage'); refs(c.platforms, 'platform', 'Required coverage'); refs(c.agents, 'agent', 'Required coverage');
    const f = data.flows.find(f => f.id === c.flow);
    for (const p of c.platforms) for (const a of c.agents) check(f?.platforms.includes(p) && f?.agents.includes(a), `${c.flow}: required coverage missing ${p}/${a}`);
  }
  check(Array.isArray(data.coverage) && data.coverage.length > 0, 'Required coverage matrix is missing');
  // Every declared page must be reachable on each platform, using forward
  // navigation or an actual flow edge, not merely a Back link.
  for (const platform of data.platforms.map(p => p.id)) {
    const neighbors = new Map(data.pages.filter(p => p.platforms.includes(platform)).map(p => [p.id, new Set()]));
    for (const p of data.pages) for (const c of p.controls ?? []) if (c.id !== `${p.id}-BACK` && selected(c, platform)) {
      for (const target of c.targets ?? []) if (neighbors.has(target)) neighbors.get(p.id)?.add(target);
    }
    for (const f of data.flows.filter(f => f.platforms.includes(platform))) {
      const nodes = new Map(f.nodes.map(n => [n.id, n]));
      for (const n of f.nodes.filter(n => !n.terminal && selected(n, platform))) for (const edge of n.outcomes ?? []) {
        const next = nodes.get(edge.to);
        if (selected(edge, platform) && next?.page && selected(next, platform)) neighbors.get(n.page)?.add(next.page);
      }
    }
    const reached = walk(data.entries.filter(id => neighbors.has(id)), id => [...(neighbors.get(id) ?? [])]);
    for (const id of neighbors.keys()) check(reached.has(id), `${platform}: orphan page ${id}`);
  }
  for (const [id, action] of actions) {
    const used = data.flows.some(f => f.nodes.some(n => nodeRefs(n).includes(id)));
    check(used || action.kind === 'navigation' || action.kind === 'observe' || action.kind === 'edit', `${id}: active control has no flow coverage`);
  }
  for (const t of data.terms) check([...data.pages, ...data.flows].some(x => x.terms.includes(t.id)), `${t.id}: glossary term has no page/flow backlink`);
  const history = pages.get('HISTORY');
  check(history?.group === 'Administration', 'HISTORY must belong exclusively to Administration');
  check(actions.get('SETTINGS-OPEN-SEARCH')?.kind === 'navigation' && actions.get('SETTINGS-OPEN-SEARCH')?.targets.includes('SETTINGS-SEARCH'), 'SETTINGS must expose its search widget');
  for (const id of ['SETTINGS-SEARCH-QUERY', 'SETTINGS-SEARCH-CLEAR', 'SETTINGS-SEARCH-OPEN']) check(actions.has(id), `Search control ${id} missing`);
  check(actions.get('SETTINGS-SEARCH-OPEN')?.kind === 'navigation', 'Settings search results must navigate, not mutate state');
  for (const p of data.pages.filter(p => p.group === 'Requests')) {
    check(!p.platforms.includes('BROWSER'), `${p.id}: browser response/Inbox is unsupported; use phone handoff`);
    for (const c of p.controls) check(!c.targets.some(id => ['HISTORY', 'SETTINGS-SEARCH'].includes(id)), `${c.id}: request pages cannot navigate to history/search`);
  }
  return errors;
}

function walk(entries, neighbors) {
  const visited = new Set(); const pending = [...entries];
  while (pending.length) { const id = pending.pop(); if (visited.has(id)) continue; visited.add(id); pending.push(...neighbors(id)); }
  return visited;
}

export function renderDocuments(data) {
  const files = new Map();
  const locations = new Map();
  for (const [key, file] of [['platforms', 'FLOWS.md'], ['agents', 'FLOWS.md'], ['terms', 'GLOSSARY.md'], ['pages', 'INVENTORY.md'], ['flows', 'FLOWS.md']]) {
    for (const item of data[key]) locations.set(item.id, file);
  }
  for (const p of data.pages) for (const c of p.controls) locations.set(c.id, 'INVENTORY.md');
  const link = id => `[${id}](${locations.get(id)}#${id.toLowerCase()})`;
  const links = ids => ids.map(link).join(', ') || 'None';
  const clean = value => value.replaceAll('|', '\\|').replaceAll('\n', ' ');
  const prose = value => clean(value).replace(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g, id => locations.has(id) ? link(id) : id);
  const sourceLinks = sources => (sources ?? []).map(s => `[${s}](${relative('docs/ui', s).split('\\').join('/')})`).join(', ');
  const header = title => `# ${title}\n\nGenerated from [contract.mjs](contract.mjs). Edit the source and run \`npm run docs:ui\`; \`npm run check:ui\` rejects stale views.\n\n${data.scope}\n\nSee [UI contract](../UX.md), [guide and validation](README.md), [flows and platform matrix](FLOWS.md), [inventory](INVENTORY.md), and [glossary](GLOSSARY.md). IDs are stable; labels may change.\n\n`;
  const directFlows = pageId => data.flows.filter(f => f.nodes.some(n => n.page === pageId));
  const descendantFlows = pageId => data.flows.filter(f => f.nodes.some(n => {
    let p = data.pages.find(p => p.id === n.page); const seen = new Set();
    while (p && !seen.has(p.id)) { if (p.id === pageId) return true; seen.add(p.id); p = data.pages.find(parent => parent.id === p.parent); }
    return false;
  }));
  let inventory = header('Page and UI inventory');
  inventory += 'Each page has one purpose. Back/Close is always explicit and never silently submits, cancels a request, or rolls back accepted changes. Platform lists describe relay UI availability; external agent software runs on its own host independently of the approval platform. Runtime-generated request fields use the declared field ID beneath their stable control family.\n\n';
  inventory += '| Page ID | Name | Group | Platforms |\n| --- | --- | --- | --- |\n';
  for (const p of data.pages) inventory += `| ${link(p.id)} | ${p.title} | ${p.group} | ${links(p.platforms)} |\n`;
  for (const p of data.pages) {
    inventory += `\n## ${p.id}\n\n**${p.title}** — ${p.purpose}\n\nShow only: ${p.information}\n\nGroup: ${p.group}. Surface: ${p.surface}. Platforms: ${links(p.platforms)}.${p.parent ? ` Parent: ${link(p.parent)}.` : ' Entry/return follows its invoking context.'}\n\nGlossary: ${links(p.terms)}. Direct flows: ${links(directFlows(p.id).map(f => f.id))}. Flows through child pages: ${links(descendantFlows(p.id).filter(f => !directFlows(p.id).includes(f)).map(f => f.id))}.\n\n| Control ID | Label / kind | Behavior and targets | Flow references |\n| --- | --- | --- | --- |\n`;
    for (const c of p.controls) {
      const flows = data.flows.filter(f => f.nodes.some(n => nodeRefs(n).includes(c.id)));
      const targets = c.targets.length ? ` Targets: ${links(c.targets)}.` : '';
      const platforms = c.platforms ? ` Only: ${links(c.platforms)}.` : '';
      inventory += `| <a id="${c.id.toLowerCase()}"></a>\`${c.id}\` | ${clean(c.label)} / ${c.kind} | ${clean(c.detail)}${targets}${platforms}${c.timeoutSeconds ? ` Check deadline: ≤${c.timeoutSeconds}s, capped by server expiry.` : ''} | ${flows.length ? links(flows.map(f => f.id)) : c.kind === 'navigation' ? 'Navigation to the linked destination or invoking context.' : 'Local edit/refresh; remains on this page, with Back available.'} |\n`;
    }
  }
  files.set('docs/ui/INVENTORY.md', `${inventory.trimEnd()}\n`);
  let glossary = header('UI glossary');
  for (const t of data.terms) {
    glossary += `## ${t.id}\n\n**${t.name}.** ${t.definition}\n\nRelated: ${links(t.related)}.\n\nPages: ${links(data.pages.filter(p => p.terms.includes(t.id)).map(p => p.id))}.\n\nFlows: ${links(data.flows.filter(f => f.terms.includes(t.id)).map(f => f.id))}.\n\n`;
  }
  files.set('docs/ui/GLOSSARY.md', `${glossary.trimEnd()}\n`);
  let flows = header('User flows and platform differences');
  flows += 'The platform is where the person approves or manages the relay, not the machine running agent software. A TUI/CLI on a laptop can be approved on Android, iOS, or a browser. Preconditions explicitly reference prior tasks; continuation links explain related tasks, not an automatic grant. Initial login never approves a pending task. Every transition below is checked separately for each declared platform/agent pair.\n\n';
  for (const item of [...data.platforms, ...data.agents]) flows += `## ${item.id}\n\n**${item.name}.** ${item.detail}\n\n${sourceLinks(item.sources) ? `Repository evidence: ${sourceLinks(item.sources)}.\n\n` : ''}Flows: ${links(data.flows.filter(f => [...f.platforms, ...f.agents].includes(item.id)).map(f => f.id))}.\n\n`;
  flows += '## Flow index\n\n| Flow | Typical task | Approval/management platforms | Agent types |\n| --- | --- | --- | --- |\n';
  for (const f of data.flows) flows += `| ${link(f.id)} | ${f.title} | ${links(f.platforms)} | ${links(f.agents)} |\n`;
  for (const f of data.flows) {
    flows += `\n## ${f.id}\n\n**${f.title}.** Platforms: ${links(f.platforms)}. Agents: ${links(f.agents)}.\n\nBefore starting: ${prose(f.preconditions)}\n\nGlossary: ${links(f.terms)}.${f.continuations?.length ? ` Related/continuing tasks: ${links(f.continuations)}.` : ''}\n\nStart at [${f.entry}](#${f.id.toLowerCase()}-${f.entry}).\n\n`;
    for (const n of f.nodes) {
      flows += `<a id="${f.id.toLowerCase()}-${n.id}"></a>\n\n### ${n.id}\n\n`;
      if (n.terminal) { flows += `**${n.terminal}.** ${n.result}\n\nExit: ${n.exit}\n\n`; continue; }
      flows += `${link(n.page)} → ${link(n.action)}: ${prose(n.instruction)}\n\nOther controls: ${links([...n.inputs, ...(n.extraControls ?? []), n.back])}.\n\n| Result | Next step | User-visible recovery / continuation |\n| --- | --- | --- |\n`;
      for (const e of n.outcomes) flows += `| ${e.event}${e.platforms ? ` (${links(e.platforms)})` : ''}${e.agents ? ` (${links(e.agents)})` : ''} | [${e.to}](#${f.id.toLowerCase()}-${e.to}) | ${clean(e.detail)} |\n`;
      flows += '\n';
    }
  }
  files.set('docs/ui/FLOWS.md', `${flows.trimEnd()}\n`);
  return files;
}

export async function checkDocuments(documents, repositoryRoot = root) {
  const errors = [];
  const contents = new Map();
  for (const [file, expected] of documents) {
    let actual;
    try { actual = await readFile(resolve(repositoryRoot, file), 'utf8'); }
    catch { errors.push(`${file}: generated document missing; run npm run docs:ui`); continue; }
    if (actual !== expected) errors.push(`${file}: stale generated document; run npm run docs:ui`);
    contents.set(file, actual);
  }
  // Include the hand-written contract/guide and agent instructions in link checks.
  for (const file of ['docs/UX.md', 'docs/ui/README.md', 'AGENTS.md', 'docs/ADMIN_RELAY_DESIGN.md', 'docs/ONBOARDING.md', 'docs/IOS.md', 'integrations/README.md']) {
    try { contents.set(file, await readFile(resolve(repositoryRoot, file), 'utf8')); }
    catch { errors.push(`${file}: missing governing documentation`); }
  }
  const anchors = content => new Set([
    ...[...content.matchAll(/^#{1,6} (.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N}_\- ]/gu, '').replaceAll(' ', '-')),
    ...[...content.matchAll(/<a id="([^"]+)"><\/a>/g)].map(m => m[1]),
  ]);
  for (const [file, content] of contents) for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const [path, fragment] = target.split('#'); const destination = path ? relative(repositoryRoot, resolve(repositoryRoot, dirname(file), path)) : file;
    let linked = contents.get(destination);
    if (linked === undefined) { try { linked = await readFile(resolve(repositoryRoot, destination), 'utf8'); } catch { errors.push(`${file}: broken file link ${target}`); continue; } }
    if (fragment && destination.endsWith('.md') && !anchors(linked).has(fragment)) errors.push(`${file}: broken anchor ${target}`);
  }
  return errors;
}

export async function main(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--write')) throw Error('Usage: node scripts/ui-contract.mjs [--write]');
  const errors = validateContract(contract);
  if (errors.length) throw Error(errors.join('\n'));
  const documents = renderDocuments(contract);
  if (args.includes('--write')) for (const [file, contents] of documents) await writeFile(resolve(root, file), contents);
  const docErrors = await checkDocuments(documents);
  if (docErrors.length) throw Error(docErrors.join('\n'));
  const scenarios = contract.flows.reduce((sum, f) => sum + f.platforms.length * f.agents.length, 0);
  console.log(`UI contract valid: ${contract.pages.length} pages, ${contract.pages.reduce((sum, p) => sum + p.controls.length, 0)} controls, ${contract.terms.length} terms, ${contract.flows.length} flows, ${scenarios} platform/agent scenarios. No declared dead ends or broken cross-references; generated views match.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
