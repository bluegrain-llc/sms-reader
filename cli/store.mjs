import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import lockfile from 'proper-lockfile';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
export const defaultStore = () => join(homedir(), '.local', 'share', 'request-relay');
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) || st.uid !== process.getuid?.()) throw Error('Credential directory must be owned by you with mode 0700.');
}
export async function atomicWrite(path, value) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(JSON.stringify(value)); await file.sync(); await file.close(); await rename(temporary, path);
    const directory = await open(dirname(path), constants.O_RDONLY); try { await directory.sync(); } finally { await directory.close(); }
  } finally { await file.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
}
export class PrivateStore {
  constructor(directory = defaultStore(), profile = 'default') {
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(profile)) throw Error('Profile names use letters, digits, hyphens and underscores.');
    this.directory = resolve(directory); this.path = join(this.directory, `${profile}.json`); this.profile = profile;
  }
  async read() {
    await privateDirectory(this.directory);
    try {
      const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { const st = await file.stat(); if ((st.mode & 0o077) || st.uid !== process.getuid?.() || !st.isFile()) throw Error('Credential file must be owned by you with mode 0600.'); return JSON.parse(await file.readFile('utf8')); }
      finally { await file.close(); }
    } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  }
  async load() { return this.read(); }
  async save(value) { return this.write(value); }
  async write(value) { await atomicWrite(this.path, value); }
  async lock() {
    await privateDirectory(this.directory);
    return lockfile.lock(this.path, { realpath: false, stale: 10_000, update: 2000,
      retries: { retries: 5, minTimeout: 2500, maxTimeout: 2500 } });
  }
}
