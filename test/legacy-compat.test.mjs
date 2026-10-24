import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.mjs';
import { createAskService } from '../src/service.mjs';
import { withEmbeddedCards } from '../src/card-adapter.mjs';
import { withLegacyCompatibility } from '../src/legacy-compat.mjs';
import { StateStore } from '../src/store.mjs';

const TASK = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const QUOTE = '33333333-3333-4333-8333-333333333333';
const NEXT_QUOTE = '44444444-4444-4444-8444-444444444444';
const REQUEST = '55555555-5555-4555-8555-555555555555';
const NEXT_REQUEST = '66666666-6666-4666-8666-666666666666';
const PURCHASE = '77777777-7777-4777-8777-777777777777';
const ACTION = '88888888-8888-4888-8888-888888888888';
const question = 'Get the company profile for Fixture B.V.';
const parsed = { language: 'en', subjects: [{ id: 's1', label: 'Fixture B.V.', type: 'company', identifiers: {} }],
  capabilities: [{ slug: 'company.profile', name: 'Company profile', description: 'Registered profile', domain: 'company', inputs: ['company.name'], outputs: ['company.profile'], subject_id: 's1', source_hint: null, confidence: 1 }],
  deliverable: { format: 'chat', operations: [] } };
const selection = { endpoint_id: ENDPOINT, capability: 'company.profile', subject_id: 's1', input: { 'company.name': 'Fixture B.V.' } };
const state = { schema_version: '2', state_ref: TASK, state_token: 'synthetic-signed-state', revision: 1, expires_at: '2099-01-01T00:00:00Z', focus: { entity_refs: [], goal_refs: [] } };
const clone = value => structuredClone(value);
const task = () => ({ protocol_version: '2', status: 'ready', state: clone(state), next_actions: [], errors: [],
  proposal: { quote_ref: QUOTE, currency: 'USD', max_total_atomic: '70000', expires_at: '2099-01-01T00:00:00Z', steps: [], step_details: [] },
  context_view: { question, execution_mode: 'server', worker_active: false, results: [] }, result: null });
const approve = () => ({ state: clone(state), quote_ref: QUOTE, max_total_atomic: '70000' });
const selected = () => ({ question, parsed_request: clone(parsed), search_id: 'synthetic-search', selections: [clone(selection)] });

async function fixture(t, options = {}) {
  const directory = options.directory || await mkdtemp(join(tmpdir(), 'apiosk-legacy-contract-'));
  if (!options.directory) t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore({ directory, scope: options.scope || 'buyer-a' });
  const calls = [];
  let current = task();
  const gateway = { credentialKind: 'connection', baseUrl: 'https://gateway.example', async request(path, request = {}) {
    calls.push({ path, method: request.method || (request.body === undefined ? 'GET' : 'POST'), body: clone(request.body) });
    if (options.respond) {
      const custom = await options.respond(path, request, calls.length);
      if (custom !== undefined) return custom;
    }
    if (path === '/v2/ask/source/prepare' || path === '/v2/ask/prepare' || path === '/v2/ask/research' || path === '/v2/discover' || path === '/v2/ask-v2/prepare') return clone(current);
    if (path === '/v2/ask/conversation') return { kind: 'saved_answer', task_refs: [TASK] };
    if (path === `/v2/tasks/${TASK}`) return clone(current);
    if (path === '/v2/approve' || path === '/v2/execute') {
      current = { ...current, status: 'succeeded', state: { ...current.state, revision: current.state.revision + 1 },
        result: { result_ref: 'saved-fixture', source: { name: 'Fixture register', retrieved_at: '2026-10-23T12:00:00Z' }, data: { count: 0, active: false } },
        billing: { currency: 'USD', total_charged: '70000', authorization_active: false } };
      return clone(current);
    }
    if (path === '/v2/ask/requote') {
      current = { ...current, status: 'ready', state: { ...current.state, revision: current.state.revision + 1 }, billing: { authorization_active: false },
        proposal: { ...current.proposal, quote_ref: NEXT_QUOTE, max_total_atomic: '80000' } };
      return clone(current);
    }
    if (path === '/v2/ask/external/source') return { resource: 'https://external.example/data', inputs: [], total_atomic: 70000 };
    if (path === '/v2/ask/external/prepare' || path === `/v2/ask/external/${PURCHASE}` || path === `/v2/ask/external/${PURCHASE}/authorize`) return {
      purchase_id: path.endsWith('/prepare') ? request.body.request_id : PURCHASE,
      status: path.endsWith('/authorize') ? 'succeeded' : 'requires_approval', result: path.endsWith('/authorize') ? { value: 0 } : null,
      quote: { quote_ref: QUOTE, currency: 'USD', max_total_atomic: '70000', expires_at: '2099-01-01T00:00:00Z' } };
    throw new Error(`Unexpected fixture route: ${path}`);
  } };
  const core = createAskService({ gateway, store });
  const service = withLegacyCompatibility(withEmbeddedCards(core, { gateway, store }), { gateway, store });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ service });
  const client = new Client({ name: 'legacy-compat-test', version: '1' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport); await client.connect(clientTransport);
  const invoke = (name, args) => client.callTool({ name, arguments: args });
  return { directory, store, calls, client, core, invoke, setTask(value) { current = clone(value); } };
}
const ok = result => assert.equal(result.isError, undefined, JSON.stringify(result));
const paid = fixture => fixture.calls.filter(call => ['/v2/approve', '/v2/execute'].includes(call.path) || call.path.endsWith('/authorize'));

test('cached Ask selections and cached input envelope retain exact signed manual preparation', async t => {
  const f = await fixture(t);
  for (const args of [selected(), { question, request_id: REQUEST, input: { apiosk_source_selection_v1: { parsed_request: parsed, search_id: 'synthetic-search', selections: [selection] } } }]) {
    const result = await f.invoke('apiosk_ask', args); ok(result);
    const body = f.calls.at(-1).body;
    assert.equal(f.calls.at(-1).path, '/v2/ask/prepare');
    assert.deepEqual({ ...body, request_id: REQUEST }, { request_id: REQUEST, ...selected() });
    assert.equal(result.structuredContent.proposal.max_total_atomic, '70000');
    assert.ok(result._meta.apiosk_card_data);
  }
  assert.equal(paid(f).length, 0);
});

test('cached research reuses the signed interpretation and does not call discover', async t => {
  const f = await fixture(t), research = { parsed_request: parsed, search_id: 'synthetic-search', discovery_id: 'synthetic-external' };
  ok(await f.invoke('apiosk_ask', { question, request_id: REQUEST, research }));
  assert.deepEqual(f.calls, [{ path: '/v2/ask/research', method: 'POST', body: { request_id: REQUEST, question, ...research } }]);
  assert.equal(paid(f).length, 0);
});

test('cached saved task and follow-up signatures only read saved evidence', async t => {
  const f = await fixture(t);
  const status = await f.invoke('apiosk_status', { task_ref: TASK }); ok(status);
  const follow = await f.invoke('apiosk_ask', { question: 'Summarize the saved data', task_refs: [TASK], request_id: REQUEST }); ok(follow);
  assert.equal(follow.structuredContent.kind, 'saved_answer');
  assert.deepEqual(follow.structuredContent.task_refs, [TASK]);
  ok(await f.invoke('apiosk_execute', { recover_task_ref: TASK, request_id: REQUEST }));
  assert.deepEqual(f.calls.map(call => call.path), [`/v2/tasks/${TASK}`, '/v2/ask/conversation', `/v2/tasks/${TASK}`]);
  assert.equal(paid(f).length, 0);
});

test('compatibility aliases remain app-only and protocol validation rejects malformed cached calls before dispatch', async t => {
  const f = await fixture(t), listed = (await f.client.listTools()).tools;
  assert.equal(listed[0].name, 'apiosk_ask');
  for (const name of ['apiosk_discover', 'apiosk_execute', 'apiosk_external', 'apiosk_external_approve']) {
    assert.deepEqual(listed.find(tool => tool.name === name)._meta.ui.visibility, ['app']);
  }
  assert.ok(listed.find(tool => tool.name === 'apiosk_sources').inputSchema.required.includes('request_id'));
  for (const [name, args] of [
    ['apiosk_status', { task_ref: 'not-a-uuid' }],
    ['apiosk_approve', { ...approve(), max_total_atomic: '-1' }],
    ['apiosk_ask', { ...selected(), research: { parsed_request: parsed, search_id: 'synthetic-search' } }],
    ['apiosk_execute', { recover_task_ref: TASK, state, action_id: ACTION }],
    ['apiosk_external', { action: 'status', purchase_id: PURCHASE, api_id: 'bazaar:fixture' }],
  ]) assert.equal((await f.invoke(name, args)).isError, true);
  assert.equal(f.calls.length, 0);
});

test('concurrent cached approvals dispatch once and retrying with a new request ID reuses the journal', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.invoke('apiosk_approve', { ...approve(), request_id: REQUEST }), f.invoke('apiosk_approve', { ...approve(), request_id: NEXT_REQUEST })]);
  results.forEach(ok);
  assert.equal(paid(f).length, 1);
  const adopted = await f.store.get(`legacy_${TASK}`);
  assert.deepEqual(paid(f)[0].body, { ...approve(), request_id: adopted.tasks[0].approval_attempt.id });
  assert.equal((await f.invoke('apiosk_approve', { ...approve(), max_total_atomic: '99999' })).isError, true);
  assert.equal(paid(f).length, 1);
});

test('an uncertain cached approval remains recoverable without a second authorization', async t => {
  const f = await fixture(t, { respond(path) { if (path === '/v2/approve') throw Object.assign(new Error('Connection interrupted'), { code: 'gateway_connection_error' }); } });
  assert.equal((await f.invoke('apiosk_approve', approve())).isError, true);
  const retry = await f.invoke('apiosk_approve', { ...approve(), request_id: NEXT_REQUEST });
  assert.equal(retry.isError, true); assert.match(JSON.stringify(retry), /uncertain|recover/i);
  ok(await f.invoke('apiosk_status', { task_ref: TASK }));
  assert.equal(paid(f).length, 1);
  assert.equal((await f.store.get(`legacy_${TASK}`)).tasks[0].approval_attempt.status, 'outcome_unknown');
});

test('cached execute preserves idempotency and never redispatches after an ambiguous response', async t => {
  const f = await fixture(t, { respond(path) { if (path === '/v2/execute') throw new Error('Lost execution response'); } });
  const args = { state, action_id: ACTION, quote_ref: QUOTE, input: { choice: 'fixture' }, request_id: REQUEST };
  assert.equal((await f.invoke('apiosk_execute', args)).isError, true);
  assert.equal((await f.invoke('apiosk_execute', { ...args, request_id: NEXT_REQUEST })).isError, true);
  assert.equal(paid(f).length, 1);
  assert.deepEqual(paid(f)[0].body, { ...args, idempotency_key: ACTION });
});

test('standing-mandate discover and legacy endpoint prepare journal uncertain attempts', async t => {
  for (const [name, args, route] of [
    ['apiosk_discover', { question }, '/v2/discover'],
    ['apiosk_ask', { question, endpoint_id: ENDPOINT, capability: 'company.profile', input: selection.input }, '/v2/ask-v2/prepare'],
  ]) {
    const f = await fixture(t, { respond(path) { if (path === route) throw new Error('Uncertain standing authorization'); } });
    assert.equal((await f.invoke(name, args)).isError, true);
    assert.equal((await f.invoke(name, args)).isError, true);
    assert.equal(f.calls.length, 1);
  }
});

test('cached external contracts preserve source, quote and private approval routes', async t => {
  const f = await fixture(t);
  ok(await f.invoke('apiosk_external', { action: 'source', api_id: 'bazaar:fixture' }));
  ok(await f.invoke('apiosk_external', { action: 'prepare', api_id: 'bazaar:fixture', input: { q: 'fixture' }, request_id: PURCHASE }));
  ok(await f.invoke('apiosk_external', { action: 'status', purchase_id: PURCHASE }));
  for (let i = 0; i < 2; i++) ok(await f.invoke('apiosk_external_approve', { purchase_id: PURCHASE, quote_ref: QUOTE, max_total_atomic: '70000' }));
  assert.deepEqual(f.calls.filter(call => call.method === 'POST').map(call => call.path), ['/v2/ask/external/source', '/v2/ask/external/prepare', `/v2/ask/external/${PURCHASE}/authorize`]);
  assert.ok(f.calls.some(call => call.method === 'GET' && call.path === `/v2/ask/external/${PURCHASE}`));
  assert.deepEqual(paid(f)[0].body, { quote_ref: QUOTE, max_total_atomic: '70000' });
  assert.equal(paid(f).length, 1);
});

test('buyer scopes do not share compatibility journals or adopted task records', async t => {
  const a = await fixture(t), b = await fixture(t, { directory: a.directory, scope: 'buyer-b' });
  ok(await a.invoke('apiosk_approve', approve()));
  const otherRead = await b.invoke('apiosk_chats', { action: 'open', request_id: `legacy_${TASK}` });
  assert.equal(otherRead.isError, true); assert.equal(b.calls.length, 0);
  ok(await b.invoke('apiosk_approve', approve()));
  assert.equal(paid(a).length, 1); assert.equal(paid(b).length, 1);
  assert.notEqual(a.store.directory, b.store.directory);
});

test('legacy approval after current-card approval does not dispatch the same quote twice', async t => {
  const f = await fixture(t);
  ok(await f.invoke('apiosk_ask', selected()));
  const adopted = await f.store.get(`legacy_${TASK}`), approval = adopted.approval;
  ok(await f.invoke('apiosk_approve', { request_id: adopted.id, approval_id: approval.approval_id, currency: approval.currency, max_total_atomic: approval.max_total_atomic, confirm: true }));
  const repeated = await f.invoke('apiosk_approve', approve());
  assert.equal(paid(f).length, 1, 'Cached and current cards share the same authorization attempt');
  assert.ok(repeated.isError || repeated.structuredContent.status === 'succeeded');
});

test('adopting a revised unapproved quote requires fresh consent and archives earlier consent', async t => {
  const f = await fixture(t);
  ok(await f.invoke('apiosk_approve', approve()));
  const latest = (await f.store.get(`legacy_${TASK}`)).tasks[0].view;
  ok(await f.invoke('apiosk_requote', { state: latest.state, quote_ref: QUOTE }));
  const adopted = await f.store.get(`legacy_${TASK}`);
  assert.equal(adopted.approval?.quotes[0].quote_ref, NEXT_QUOTE);
  assert.equal(adopted.approval.max_total_atomic, '80000');
  assert.equal(adopted.approved_id, null);
  assert.equal(adopted.tasks[0].approval_attempt, undefined);
  assert.ok(adopted.tasks[0].approval_history.length);
  assert.equal(paid(f).length, 1);
});

test('current and cached approval racing on the same saved quote share one dispatch', async t => {
  const f = await fixture(t);
  ok(await f.invoke('apiosk_ask', selected()));
  const adopted = await f.store.get(`legacy_${TASK}`), approval = adopted.approval;
  const results = await Promise.all([
    f.invoke('apiosk_approve', { request_id: adopted.id, approval_id: approval.approval_id, currency: approval.currency, max_total_atomic: approval.max_total_atomic, confirm: true }),
    f.invoke('apiosk_approve', approve()),
  ]);
  results.forEach(ok);
  assert.equal(paid(f).length, 1);
});

test('cached approval cannot approve one member of a combined current quote', async t => {
  const f = await fixture(t);
  ok(await f.invoke('apiosk_ask', selected()));
  const adopted = await f.store.get(`legacy_${TASK}`);
  adopted.active_task_ids.push(PURCHASE);
  adopted.approval.quotes.push({ ...adopted.approval.quotes[0], task_id: PURCHASE });
  await f.store.save(adopted);
  const result = await f.invoke('apiosk_approve', approve());
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result), /combined total/);
  assert.equal(paid(f).length, 0);
});

test('legacy status reuses an approved current request and preserves sibling tasks before cached approval', async t => {
  const f = await fixture(t, { respond(path) {
    if (path === '/v2/ask') {
      const source = { origin: 'apiosk', name: 'Fixture register', endpoint_id: ENDPOINT, capability: 'company.profile', subject_id: 's1', availability: 'supported', input_values: selection.input };
      return { question, parsed_request: parsed, search_id: 'synthetic-search', errors: [], apis: [source],
        searches: { apiosk: { matches: [{ slug: 'company.profile', subject_id: 's1', apiosk: [source], coinbase: [] }] }, coinbase: { matches: [] } } };
    }
    if (path.startsWith('/v2/ask-v2/endpoints/')) return { endpoint_id: ENDPOINT, inputs: [{ field: 'company.name', required: true, schema: { type: 'string' } }] };
  } });
  const asked = await f.invoke('apiosk_ask', { question }); ok(asked);
  const requestId = asked.structuredContent.request_id;
  assert.notEqual(requestId, `legacy_${TASK}`);
  const original = await f.store.get(requestId);
  const prepared = await f.invoke('apiosk_prepare', { request_id: requestId, selections: [{ source_id: original.sources[0].id, input: selection.input }] }); ok(prepared);
  const approval = prepared.structuredContent.approval;
  ok(await f.invoke('apiosk_approve', { request_id: requestId, approval_id: approval.approval_id, currency: approval.currency, max_total_atomic: approval.max_total_atomic, confirm: true }));
  const approved = await f.store.get(requestId);
  const sibling = { id: PURCHASE, kind: 'endpoint', view: { ...task(), status: 'failed', state: { ...state, state_ref: PURCHASE }, proposal: null } };
  approved.tasks.push(sibling); await f.store.save(approved);
  const status = await f.invoke('apiosk_status', { task_ref: TASK }); ok(status);
  ok(await f.invoke('apiosk_approve', approve()));
  assert.equal(paid(f).length, 1, 'Reading with an old signature cannot create a fresh authorization path');
  const records = (await f.store.list()).filter(record => record.type === 'ask' && record.tasks.some(task => task.id === TASK));
  assert.equal(records.length, 1);
  assert.equal(records[0].id, requestId);
  assert.equal(records[0].tasks.length, 2);
  assert.deepEqual(records[0].tasks.find(task => task.id === PURCHASE), sibling);
  assert.equal(records[0].tasks.find(task => task.id === TASK).approval_attempt.id, approved.tasks[0].approval_attempt.id);
});

test('explicit discover request conflicts retry once with the exact MCP1 deterministic identity', async t => {
  // Golden identity produced by archived MCP1 planningRetryId for this body.
  const retryId = '4475a33d-f29d-4b3e-8b28-5787429d6824';
  for (const representation of ['http_rejection', 'http_200_errors']) {
    let discoveries = 0;
    const f = await fixture(t, { respond(path) {
      if (path !== '/v2/discover') return;
      discoveries++;
      if (discoveries === 1) {
        if (representation === 'http_rejection') throw Object.assign(new Error('Request identity already used'), { code: 'request_conflict', status: 409 });
        return { errors: [{ code: 'request_conflict', message: 'Request identity already used' }] };
      }
      return task();
    } });
    const args = { question, request_id: REQUEST };
    ok(await f.invoke('apiosk_discover', args));
    assert.equal(discoveries, 2);
    assert.deepEqual(f.calls.filter(call => call.path === '/v2/discover').map(call => call.body), [args, { ...args, request_id: retryId }]);
    ok(await f.invoke('apiosk_discover', args));
    assert.equal(discoveries, 2, 'A completed retry is replayed from its journal');
  }
});

test('conflict recovery stays bounded and never retries timeouts or approval conflicts', async t => {
  for (const [name, args, route, code, expected] of [
    ['apiosk_discover', { question, request_id: REQUEST }, '/v2/discover', 'request_conflict', 2],
    ['apiosk_discover', { question, request_id: REQUEST }, '/v2/discover', 'gateway_timeout', 1],
    ['apiosk_approve', approve(), '/v2/approve', 'request_conflict', 1],
  ]) {
    const f = await fixture(t, { respond(path) {
      if (path === route) throw Object.assign(new Error('Fixture rejection'), { code, status: code === 'request_conflict' ? 409 : 0 });
    } });
    assert.equal((await f.invoke(name, args)).isError, true);
    assert.equal((await f.invoke(name, args)).isError, true);
    assert.equal(f.calls.filter(call => call.path === route).length, expected);
  }
});
