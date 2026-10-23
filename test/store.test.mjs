import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore, scopeKey } from '../src/store.mjs';

test('durable state, caller isolation and serialized edits across store instances', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mcp2-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = scopeKey({ token: 'a', workspace: 'one' });
  const a = new StateStore({ directory, scope }), b = new StateStore({ directory, scope });
  const saved = await a.create({ type: 'ask', count: 0 });
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).withLock(saved.id, async () => {
    const value = await b.get(saved.id); value.count++; await b.save(value);
  })));
  assert.equal((await a.get(saved.id)).count, 8);
  assert.equal((await stat(a.path(saved.id))).mode & 0o777, 0o600);
  assert.equal(await new StateStore({ directory, scope: scopeKey({ token: 'b', workspace: 'one' }) }).get(saved.id), null);
  assert.throws(() => a.path('../../credentials'));
  assert.equal((await b.list()).length, 1);
});
