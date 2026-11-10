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
let host: Promise<string> | undefined, child: ChildProcess | undefined, callbacks: Server | undefined;
let callbackPort = 0, next = 0;
const clients = new Map<number, RustRelay>();
async function init() {
  if (!host) host = (async () => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) throw Error('Rust contracts require emulator');
    callbacks = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []; for await (const chunk of req) parts.push(chunk);
        const { kind, args } = JSON.parse(Buffer.concat(parts).toString());
        const relay = clients.get(Number(req.url?.slice(1)))!;
        if (kind === 'now') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(relay.now())); return; }
        const fn = (kind === 'notify' ? relay.notify : kind === 'wake' ? relay.wake : kind === 'webhook' ? relay.callback
          : kind === 'owner' ? relay.options!.verifyOwner : kind === 'worker' ? relay.options!.verifyScheduler : relay.options!.deleteIdentity) as (...args: unknown[]) => Promise<unknown>;
        const value = await fn(...args as unknown[]);
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value ?? null));
      } catch { res.statusCode = 500; res.end('{}'); }
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
  constructor(readonly db: Firestore, readonly notify: Notify, readonly now = Date.now, readonly wake: () => Promise<void> = async () => {}) {
    clients.set(this.id, this);
    this.forms = new Proxy({}, { get: (_t, method) => (...args: unknown[]) => this.call(`forms.${String(method)}`, args) });
    this.connections = new Proxy({}, { get: (_t, method) => (...args: unknown[]) => this.call(`connections.${String(method)}`, args) });
    return new Proxy(this, { get: (target, key) => key in target ? Reflect.get(target, key) : (...args: unknown[]) => target.call(String(key), args) });
  }
  async payload() { await init(); return { now: this.now(), callback: `http://127.0.0.1:${callbackPort}/${this.id}` }; }
  async call(method: string, args: unknown[]) {
    const base = await init();
    const response = await fetch(`${base}/call`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...await this.payload(), method, args }), signal: AbortSignal.timeout(60_000) });
    const result = await response.json() as { error?: string; status: number; value: unknown };
    if (result.error) throw new RelayError(result.status, result.error);
    return result.value;
  }
}
export class RustForms {
  constructor(relay: RustRelay, wake: () => Promise<void>, callback: typeof sendWebhook) {
    const instance = new RustRelay(relay.db, relay.notify, relay.now, wake); instance.callback = callback;
    return instance.forms;
  }
}
class RustServer extends EventEmitter {
  port = 0; id = ''; pending: Promise<void>;
  constructor(relay: RustRelay, options: HttpOptions) {
    super(); relay.options = options;
    this.pending = (async () => {
      const response = await fetch(`${await init()}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...await relay.payload(), options }), signal: AbortSignal.timeout(15_000) });
      const result = await response.json() as { port: number; id: string }; this.port = result.port; this.id = result.id; this.emit('listening');
    })();
    this.pending.catch(error => this.emit('error', error));
  }
  address() { return { address: '127.0.0.1', family: 'IPv4', port: this.port }; }
  close(callback?: (error?: Error) => void) { this.pending.then(async () => {
    await fetch(`${await init()}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: this.id }), signal: AbortSignal.timeout(15_000) });
    callback?.(); this.emit('close');
  }).catch(error => callback?.(error)); return this; }
}
export function rustApp(relay: Relay, options: HttpOptions) { return { listen: () => new RustServer(relay as unknown as RustRelay, options) }; }
