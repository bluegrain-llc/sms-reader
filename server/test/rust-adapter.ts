/** Test-only bridge: same scenarios and real Firestore data, native Rust handlers. */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { after } from 'node:test';
import { RelayError } from '../src/model.js';
import type { Relay, Notify } from '../src/relay.js';
import type { HttpOptions } from '../src/http.js';
import type { Firestore } from 'firebase-admin/firestore';
import { sendWebhook } from '../src/webhooks.js';
import { telemetry } from '../src/telemetry.js';
import type { RecordSecurity } from '../src/security-ledger.js';
let host: Promise<string> | undefined, child: ChildProcess | undefined, callbacks: Server | undefined;
let callbackPort = 0, next = 0;
const clients = new Map<number, RustRelay>();
let nextDelete = 0;
const deleteCallbacks = new Map<number, (uid: string) => Promise<void>>();
async function init() {
  if (!host) host = (async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Rust contracts require emulator');
    callbacks = createServer(async (req, res) => {
      const cancellation = new AbortController();
      req.once('aborted', () => cancellation.abort());
      res.once('close', () => { if (!res.writableFinished) cancellation.abort(); });
      try {
        const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk);
        const { kind, args } = JSON.parse(Buffer.concat(parts).toString());
        const url = new URL(req.url!, 'http://127.0.0.1');
        const relay = clients.get(Number(url.pathname.slice(1)))!;
        if (kind === 'now') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(relay.now())); return; }
        if (kind === 'telemetry') { telemetry.emit(args[0]); res.end('null'); return; }
        if (kind === 'security') { await relay.recordSecurity(args[0], cancellation.signal); res.end('null'); return; }
        if (kind === 'serving') { relay.options!.assertServing!(); res.end('null'); return; }
        const remove = deleteCallbacks.get(Number(url.searchParams.get('delete')));
        const fn = (kind === 'notify' ? relay.notify : kind === 'wake' ? relay.wake : kind === 'webhook' ? relay.callback
          : kind === 'owner' ? relay.options!.verifyOwner : kind === 'worker' ? relay.options!.verifyScheduler : remove ?? relay.options!.deleteIdentity) as (...args: unknown[]) => Promise<unknown>;
        const value = await fn(...args as unknown[]);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value ?? null));
      } catch (error) {
        res.statusCode = 500; res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error && typeof error === 'object' && 'code' in error && error.code === 'auth/user-not-found' ? 'auth/user-not-found' : 'callback_failed' }));
      }
    }).listen(0, '127.0.0.1');
    await once(callbacks, 'listening'); callbackPort = (callbacks.address() as { port: number }).port;
    const executable = new URL('../../server-rust/target/debug/examples/contract-server', import.meta.url).pathname;
    child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await Promise.race([new Promise<string>((resolve, reject) => {
      let output = ''; child!.stdout!.on('data', d => { output += d; if (output.includes('\n')) resolve(output.trim()); });
      child!.once('error', reject); child!.once('exit', code => reject(Error(`Rust test host exited ${code}`)));
    }), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(Error('Rust test host startup timed out')), 15_000); timer.unref(); })]);
    return `http://127.0.0.1:${port}`;
  })();
  return host;
}
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit'); child.kill();
    const killTimer = setTimeout(() => child?.kill('SIGKILL'), 2000);
    try { await exited; } finally { clearTimeout(killTimer); }
  }
  if (callbacks) { callbacks.closeAllConnections(); await new Promise<void>(resolve => callbacks!.close(() => resolve())); }
});
export class RustRelay {
  id = ++next;
  options?: HttpOptions;
  callback = sendWebhook;
  readonly forms: any;
  readonly connections: any;
  readonly access: any;
  readonly deletions: any;
  constructor(readonly db: Firestore, readonly notify: Notify, readonly now = Date.now, readonly wake: () => Promise<void> = async () => {}, readonly recordSecurity: RecordSecurity = async () => {}) {
    clients.set(this.id, this);
    this.forms = new Proxy({}, { get: (target, method) => method in target ? Reflect.get(target, method) : (...args: unknown[]) => this.call(`forms.${String(method)}`, args) });
    this.connections = new Proxy({}, { get: (_t, method) => (...args: unknown[]) => this.call(`connections.${String(method)}`, args) });
    this.deletions = new Proxy({}, { get: (target, method) => method in target ? Reflect.get(target, method) : (...args: unknown[]) => {
      const remove = (method === 'step' ? args[1] : method === 'dispatch' ? args[0] : undefined) as ((uid: string) => Promise<void>) | undefined;
      return this.call(`deletions.${String(method)}`, typeof remove === 'function' ? args.slice(0, method === 'step' ? 1 : 0) : args, remove);
    } });
    this.access = new Proxy({}, { get: (target, method) => method in target ? Reflect.get(target, method) : method === 'stream' ? async (...args: unknown[]) => {
      const lease = await this.call('access.stream', args) as { deadline: number };
      let released = false;
      return Object.assign(async () => { if (released) return; released = true; await this.call('access.release', [lease]); }, { deadline: lease.deadline });
    } : (...args: unknown[]) => this.call(`access.${String(method)}`, args) });
    return new Proxy(this, { get: (target, key) => key in target ? Reflect.get(target, key) : (...args: unknown[]) => target.call(String(key), args) });
  }
  async payload() { await init(); return { now: this.now(), callback: `http://127.0.0.1:${callbackPort}/${this.id}` }; }
  async call(method: string, args: unknown[], deleteIdentity?: (uid: string) => Promise<void>) {
    const base = await init(), payload = await this.payload();
    const deleteId = deleteIdentity ? ++nextDelete : undefined;
    if (deleteId) { deleteCallbacks.set(deleteId, deleteIdentity!); payload.callback += `?delete=${deleteId}`; }
    try {
      const response = await fetch(`${base}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, method, args }), signal: AbortSignal.timeout(60_000) });
      const result = await response.json() as { error?: string; status: number; value: unknown };
      if (result.error) throw new RelayError(result.status, result.error);
      return result.value;
    } finally { if (deleteId) deleteCallbacks.delete(deleteId); }
  }
}
export class RustForms {
  constructor(relay: RustRelay, wake: () => Promise<void>, callback: typeof sendWebhook) {
    const instance = new RustRelay(relay.db, relay.notify, relay.now, wake); instance.callback = callback;
    return instance.forms;
  }
}
class RustServer extends EventEmitter {
  port = 0; id = ''; pending: Promise<void>; stopped?: Promise<void>;
  constructor(relay: RustRelay, options: HttpOptions) {
    super(); relay.options = options;
    this.pending = (async () => {
      const response = await fetch(`${await init()}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...await relay.payload(), options, hasServing: typeof options.assertServing === 'function' }), signal: AbortSignal.timeout(15_000) });
      const result = await response.json() as { port: number; id: string }; this.port = result.port; this.id = result.id; this.emit('listening');
    })();
    this.pending.catch(error => this.emit('error', error));
  }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.port }; }
  private stop() {
    return this.stopped ??= this.pending.then(async () => {
      const response = await fetch(`${await init()}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.id }), signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw Error('Rust test server shutdown failed');
    });
  }
  closeAllConnections() { void this.stop().catch(() => {}); }
  close(callback?: (error?: Error) => void) {
    this.stop().then(() => { callback?.(); this.emit('close'); }).catch(error => callback?.(error));
    return this;
  }
}
export function rustApp(relay: Relay, options: HttpOptions) { return { listen: () => new RustServer(relay as unknown as RustRelay, options) }; }
