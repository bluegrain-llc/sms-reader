import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { PrivateStore } from './store.mjs';

/** Software-only storage hook. Private state crosses stdin/stdout, never process arguments. */
export class CommandStore {
  constructor(command, directory, profile, signal) {
    if (!isAbsolute(command)) throw Error('Storage hook must be an absolute executable path.');
    this.command = command; this.local = new PrivateStore(directory, profile); this.signal = signal;
  }
  lock() { return this.local.lock(); }
  async invoke(operation, state) {
    const value = await new Promise((resolve, reject) => {
      const child = execFile(this.command, [], { timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', signal: this.signal }, (error, stdout) => {
        if (error) { reject(Error('storage_hook_failed')); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(Error('storage_hook_failed')); }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({operation, profile:this.local.profile, ...(operation === 'save' ? {state} : {})}));
    });
    if (value?.ok !== true || (operation === 'load' && value.state !== null && (typeof value.state !== 'object' || Array.isArray(value.state)))) throw Error('storage_hook_failed');
    return operation === 'load' ? value.state : undefined;
  }
  load() { return this.invoke('load'); }
  read() { return this.load(); }
  save(state) { return this.invoke('save', state); }
  write(state) { return this.save(state); }
}
