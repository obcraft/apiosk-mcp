import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm, lstat, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const ID = /^[a-zA-Z0-9_-]{1,100}$/;
export function scopeKey({ gatewayUrl = '', token = '', workspace = '' }) {
  return createHash('sha256').update(JSON.stringify([gatewayUrl, token, workspace])).digest('hex');
}

/** Local conversation and approval journal. Gateway remains the source of truth for money/results. */
export class StateStore {
  constructor({ directory, scope = 'local', lockTimeoutMs = 5000 } = {}) {
    if (!directory) throw new Error('A state directory is required.');
    this.directory = join(resolve(directory), createHash('sha256').update(scope).digest('hex'));
    this.lockTimeoutMs = lockTimeoutMs;
  }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if ((await lstat(this.directory)).isSymbolicLink()) throw new Error('State directory must not be a symlink.');
  }
  path(id) {
    if (!ID.test(id)) throw new Error('Invalid saved identifier.');
    return join(this.directory, `${id}.json`);
  }
  async create(value) {
    await this.init();
    const record = { ...value, id: randomUUID(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    await this.save(record);
    return record;
  }
  async get(id) {
    const path = this.path(id);
    try {
      if ((await lstat(path)).isSymbolicLink()) throw new Error('Saved records must not be symlinks.');
      const value = JSON.parse(await readFile(path, 'utf8'));
      if (value.id !== id) throw new Error('Saved record identity does not match.');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async save(value) {
    await this.init();
    const path = this.path(value.id), temporary = `${path}.${randomUUID()}.tmp`;
    value.updated_at = new Date().toISOString();
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
      const directory = await open(this.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
    return value;
  }
  async list() {
    await this.init();
    const files = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    const records = [];
    for (const name of files) records.push(await this.get(name.slice(0, -5)));
    return records.filter(Boolean).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }
  async withLock(id, callback) {
    await this.init();
    const lock = `${this.path(id)}.lock`;
    const start = Date.now();
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Serialize dead-process recovery so two waiters cannot remove a newly
        // acquired live lock after observing the same abandoned owner.
        try {
          const recovery = `${lock}.recover`;
          await mkdir(recovery, { mode: 0o700 });
          try {
            const pid = Number(await readFile(join(lock, 'pid'), 'utf8'));
            if (Number.isSafeInteger(pid) && pid > 0) {
              try { process.kill(pid, 0); } catch (probe) {
                if (probe.code === 'ESRCH') await rm(lock, { recursive: true, force: true });
              }
            }
          } finally { await rm(recovery, { recursive: true, force: true }); }
        } catch { /* A new lock may still be writing its owner. */ }
        if (Date.now() - start >= this.lockTimeoutMs) throw new Error('This saved request is busy. Read its status before retrying.');
        await delay(30);
      }
    }
    try { await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 }); return await callback(); }
    finally { await rm(lock, { recursive: true, force: true }); }
  }
}
