import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/store.mjs';
import { GatewayClient, GatewayError } from '../src/gateway.mjs';
import { createAskService } from '../src/service.mjs';

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const ENDPOINT_ID = '22222222-2222-4222-8222-222222222222';
const EXTERNAL_ID = '44444444-4444-4444-8444-444444444444';
const clone = value => structuredClone(value);
const requestId = result => result.structuredContent?.request_id ?? result.structuredContent?.raw?.id;
const stateOf = result => result.structuredContent?.raw;
const textOf = result => JSON.stringify(result);

function discovery({ partial = false, external = false } = {}) {
  const candidates = ['Alpha B.V.', 'Beta B.V.'].map((name, index) => ({
    id: `choice-${index + 1}`, origin: 'apiosk', name: 'Example register', source_slug: 'example-register',
    description: `Company profile for ${name}`, subject_id: `company-${index + 1}`, endpoint_id: ENDPOINT_ID,
    api_id: ENDPOINT_ID, capability: 'company.profile', requested_capability: 'company.profile',
    availability: 'supported', executable: true, price: '0.070000 USD', method: 'GET', url: 'https://register.example',
    input_values: { 'company.id': `1234567${index}` }, missing_inputs: [], inputs: [{ field: 'company.id', required: true, schema: { type: 'string' } }], outputs: [],
    buyer_price: { buyer_atomic: '70000', provider_atomic: '60000', currency: 'USD' },
    endpoint: { input_values: { 'company.id': `1234567${index}` }, missing_inputs: [], inputs: [{ field: 'company.id', required: true, schema: { type: 'string' } }] },
  }));
  if (external) candidates.push({ id: 'external', origin: 'coinbase', name: 'External register', source_slug: 'external-register', endpoint_id: null,
    api_id: 'bazaar:fixture', capability: 'external.request', availability: 'supported', executable: true, method: 'GET', url: 'https://external.example/profile',
    input_values: { 'query.company_name': 'Alpha' }, missing_inputs: [], inputs: [{ field: 'query.company_name', required: true, schema: { type: 'string' } }],
    price: '0.010000 USD', buyer_price: { currency: 'USD', buyer_atomic: '10000' } });
  return { status: partial ? 'partial' : 'choices', question: 'Compare Alpha B.V. and Beta B.V.', search_id: 'signed-search', discovery_id: 'signed-external',
    parsed_request: { language: 'en', subjects: candidates.filter(candidate => candidate.origin === 'apiosk').map((candidate, index) => ({ id: candidate.subject_id, label: index ? 'Beta B.V.' : 'Alpha B.V.', type: 'company', identifiers: { 'company.id': candidate.input_values['company.id'] } })), capabilities: candidates.filter(candidate => candidate.origin === 'apiosk').map(candidate => ({ slug: 'company.profile', subject_id: candidate.subject_id })), deliverable: { format: 'chat' }, meta: { text_sha256: 'fixture', model: 'fixture' } },
    apis: candidates,
    searches: { apiosk: { search_id: 'signed-search', matches: candidates.filter(candidate => candidate.origin === 'apiosk').map(candidate => ({ slug: 'company.profile', subject_id: candidate.subject_id, query: candidate.description, apiosk: [candidate], coinbase: [], coinbase_status: partial ? 'unavailable' : 'complete' })) }, ...(partial ? {} : { coinbase: { matches: external ? [{ slug: 'company.profile', query: 'Alpha', apiosk: [], coinbase: [candidates.at(-1)], coinbase_status: 'complete' }] : [] } }) },
    errors: partial ? [{ origin: 'coinbase', code: 'search_unavailable' }] : [], company_context: [],
  };
}

function preparedTask() {
  return { protocol_version: '2', request_id: 'gateway-request', status: 'ready',
    state: { schema_version: '2', state_ref: TASK_ID, revision: 1, state_token: 'signed-state', expires_at: '2099-01-01T00:00:00Z', focus: { entity_refs: [], goal_refs: [] } },
    context_view: { execution_mode: 'server', worker_active: false, results: [], analysis: null },
    proposal: { label: 'Selected company profiles', quote_ref: 'quote-original', max_total_atomic: '140000', currency: 'USD', expires_at: '2099-01-01T00:00:00Z', approval_url: 'https://app.example/approve', steps: ['Read the selected profiles'], step_details: [] },
    next_actions: [{ action_id: 'execute-step', kind: 'execute_quoted_step', label: 'Get profiles', requires_authorization: true, input_schema: {} }],
    result: null, errors: [],
  };
}

function succeededTask(before) {
  const result = { result_ref: 'result-company', coverage: 'source_response', source: { provider: 'example-register', name: 'Example register', endpoint_id: ENDPOINT_ID, retrieved_at: '2026-10-23T12:00:00Z' }, data: [{ company: 'Alpha B.V.', value: 0, active: false }], charged_atomic: '140000' };
  return { ...clone(before), status: 'succeeded', state: { ...before.state, revision: before.state.revision + 1 }, context_view: { ...before.context_view, results: [result], worker_active: false, analysis: { status: 'completed', observations: [{ text: 'The saved profile contains zero and false values.', evidence: [{ result_ref: result.result_ref, pointer: '/0/value', value: 0 }] }], limitations: [] } }, result,
    next_actions: [{ action_id: 'read-saved', kind: 'read_result', label: 'Read saved result', requires_authorization: false, input_schema: {} }], billing: { currency: 'USD', unit: 'micro_usd', total_charged: '140000', status: 'charged' } };
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'apiosk-mcp2-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore({ directory, scope: 'service-fixture' }), calls = [];
  let currentTask = preparedTask(), lostApproval = false, descriptorFailure = false;
  const historical = new Map();
  let currentExternal = { purchase_id: EXTERNAL_ID, status: 'requires_approval', quote: { quote_ref: 'quote-external', max_total_atomic: '10000', currency: 'USD', expires_at: '2099-01-01T00:00:00Z' }, result: null, billing: null };
  const gateway = { credentialKind: 'connection', baseUrl: 'http://127.0.0.1:8082', async request(path, request = {}) {
    calls.push({ path, body: clone(request.body), headers: clone(request.headers), responseType: request.responseType, method: request.method ?? (request.body === undefined ? 'GET' : 'POST') });
    if (request.responseType === 'bytes') return new TextEncoder().encode('%PDF fixture');
    if (path === '/v2/ask') return discovery(options);
    if (path === '/v2/ask/prepare' || path === '/v2/ask/research') return clone(currentTask);
    if (path === '/v2/ask/conversation') return { kind: 'saved_answer', task_refs: [TASK_ID] };
    if (path === `/v2/tasks/${TASK_ID}`) return clone(currentTask);
    if (path.startsWith('/v2/tasks/') && historical.has(path.slice('/v2/tasks/'.length))) return clone(historical.get(path.slice('/v2/tasks/'.length)));
    if (path === '/v2/ask/external/source') return { resource: 'https://external.example/profile', method: 'GET', name: 'External register', total_atomic: 10000, provider_atomic: 9000, inputs: [{ field: 'query.company_name', name: 'company_name', location: 'query', required: true, schema: { type: 'string' } }] };
    if (path === '/v2/ask/external/prepare') {
      if (options.failExternalPrepare) throw new GatewayError('External source unavailable', { code: 'external_unavailable', status: 503 });
      return clone(currentExternal);
    }
    if (path === `/v2/ask/external/${EXTERNAL_ID}`) return clone(currentExternal);
    if (path === `/v2/ask/external/${EXTERNAL_ID}/authorize`) { currentExternal = { ...currentExternal, status: 'succeeded', result: { name: 'Alpha' }, billing: { charged_micro_usd: 10000 } }; return clone(currentExternal); }
    if (path === `/v2/asks/${TASK_ID}/continue`) {
      currentTask = options.afterContinuation ? options.afterContinuation(clone(currentTask), clone(request.body)) : { ...currentTask, status: 'succeeded' };
      return { id: TASK_ID, status: currentTask.status, source: 'public-envelope-only' };
    }
    if (path === '/v2/approve') {
      currentTask = succeededTask(currentTask);
      if (options.loseApprovalResponse && !lostApproval) { lostApproval = true; throw new GatewayError('Connection interrupted after approval', { code: 'gateway_connection_error', outcomeUnknown: true }); }
      return clone(currentTask);
    }
    if (path === '/v2/execute' && request.body?.action_id === 'read-saved') return clone(currentTask);
    if (path === '/v2/execute' && currentTask.next_actions?.some(action => action.action_id === request.body?.action_id && ['cancel', 'retry_analysis'].includes(action.kind))) {
      const action = currentTask.next_actions.find(action => action.action_id === request.body.action_id);
      assert.equal(request.body.input, null);
      currentTask = { ...currentTask, status: action.kind === 'cancel' ? 'cancelled' : 'succeeded', proposal: null, state: { ...currentTask.state, revision: currentTask.state.revision + 1 }, context_view: { ...currentTask.context_view, worker_active: false } };
      return clone(currentTask);
    }
    if (path === '/v2/execute' && options.savedDocument && request.body?.action_id === options.savedDocument.result_ref) {
      const text = Array.from(JSON.stringify(options.savedDocument)), offset = request.body.input.offset, chunk = text.slice(offset, offset + 8000).join('');
      return { ...clone(currentTask), result: { result_ref: options.savedDocument.result_ref, encoding: 'json_text', text: chunk, next_offset: offset + Array.from(chunk).length < text.length ? offset + Array.from(chunk).length : null } };
    }
    if (path === `/v2/tasks/${TASK_ID}/results/result-company`) return clone(currentTask.result);
    if (path.startsWith('/v2/ask-v2/endpoints/') || path.startsWith('/v2/sources/')) {
      if (descriptorFailure) throw new GatewayError('Endpoint metadata unavailable', { code: 'descriptor_unavailable', status: 503 });
      return { endpoint_id: ENDPOINT_ID, name: 'Company profile', source: { name: 'Example register', slug: 'example-register' }, inputs: [{ field: 'company.id', required: true, schema: { type: 'string' } }], outputs: [], price: { currency: 'USD', provider_atomic: '60000', buyer_atomic: '70000' } };
    }
    throw new Error(`Unexpected Gateway request: ${path} ${JSON.stringify(request.body)}`);
  } };
  const service = createAskService({ gateway, store });
  const invoke = async (name, args = {}) => {
    const tool = service.tools.find(tool => tool.name === name);
    assert.ok(tool, `Tool exists: ${name}`);
    return tool.handler(args, { signal: new AbortController().signal });
  };
  const ask = async () => {
    const result = await invoke('apiosk_ask', { question: 'Compare Alpha B.V. and Beta B.V.', mode: 'sources' });
    assert.ok(requestId(result), 'Ask returns a reopenable request ID');
    return result;
  };
  const prepare = async () => {
    const asked = await ask(), request_id = requestId(asked), sources = stateOf(asked).sources;
    const selections = sources.map(source => ({ source_id: source.id, input: clone(source.input_values ?? source.endpoint?.input_values ?? {}) }));
    const result = await invoke('apiosk_prepare', { request_id, selections });
    return { request_id, selections, result, approval: stateOf(result).approval };
  };
  const approvalArgs = prepared => ({ request_id: prepared.request_id, approval_id: prepared.approval.approval_id, max_total_atomic: prepared.approval.max_total_atomic, currency: prepared.approval.currency, confirm: true });
  return { store, calls, invoke, ask, prepare, approvalArgs, setDescriptorFailure: value => { descriptorFailure = value; }, setTask: value => { currentTask = clone(value); }, setHistorical: (id, value) => historical.set(id, clone(value)), getTask: () => clone(currentTask), paidCalls: () => calls.filter(call => call.path === '/v2/approve' || call.path.endsWith('/authorize') || call.path === '/v2/execute' && !['read-saved', options.savedDocument?.result_ref].includes(call.body?.action_id)) };
}

async function refused(operation) {
  try { const result = await operation(); assert.equal(result?.isError, true, `Expected refusal, received ${JSON.stringify(result)}`); return textOf(result); }
  catch (error) { if (error.code === 'ERR_ASSERTION') throw error; return String(error.message); }
}

test('direct preparation rejects unmatched old saved options before descriptor lookup and preserves the journal', async t => {
  const f = await fixture(t, { external: true });
  const asked = await f.ask(), request_id = requestId(asked);
  const saved = await f.store.get(request_id);
  saved.discovery.searches.apiosk.matches = [];
  saved.discovery.searches.coinbase.matches = [];
  saved.discovery.source_options = saved.sources.filter(source => source.origin === 'apiosk').map(source => ({
    source: clone(source), subject_id: source.subject_id, endpoint: clone(source.endpoint), input_values: clone(source.input_values),
  }));
  await f.store.save(saved);
  const before = await f.store.get(request_id), beforeCalls = f.calls.length;
  for (const source of before.sources) {
    const refused = await f.invoke('apiosk_prepare', { request_id, selections: [{ source_id: source.id, input: clone(source.input_values) }] });
    assert.equal(refused.isError, true);
    assert.match(refused.structuredContent.error.message, /matching source_id/);
  }
  assert.deepEqual(f.calls.slice(beforeCalls), [], 'No descriptor, preparation or authorization call is sent');
  assert.deepEqual(await f.store.get(request_id), before, 'Historic source metadata and inputs remain intact');
});

test('MCP1 legacy connect tokens use the same public Ask wire contract and preserve returned options', async t => {
  for (const token of ['apk_access_fixture', 'aw_live_fixture', 'aw_test_fixture']) {
    const directory = await mkdtemp(join(tmpdir(), 'apiosk-legacy-connection-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = new StateStore({ directory, scope: 'legacy-connect' });
    const calls = [], found = discovery();
    const gateway = new GatewayClient({ baseUrl: 'https://gateway.example', token, workspaceId: null,
      fetchImpl: async (url, options) => {
        calls.push({ path: url.pathname, method: options.method, headers: options.headers, body: JSON.parse(options.body) });
        return Response.json(found);
      } });
    const service = createAskService({ gateway, store });
    const question = 'What does ASML do?';
    const result = await service.tools.find(tool => tool.name === 'apiosk_ask').handler({ question });
    assert.equal(result.isError, undefined);
    assert.equal(calls.length, 1, 'Legacy discovery must not use App-only parse or search routes');
    assert.equal(calls[0].path, '/v2/ask');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.get('authorization'), `Bearer ${token}`);
    assert.deepEqual(calls[0].body, { question });
    assert.deepEqual(stateOf(result).discovery, found);
    assert.deepEqual(stateOf(result).sources.map(source => source.endpoint_id), found.apis.map(source => source.endpoint_id));
    assert.deepEqual(stateOf(result).sources.map(source => source.input_values), found.apis.map(source => source.input_values));
  }
});

test('session discovery sends App search bodies and retains offered metadata without displaying unmatched endpoints', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'apiosk-session-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore({ directory, scope: 'session-discovery-parity' });
  const question = 'Compare Alpha B.V. and Beta B.V.';
  const found = discovery(), source = found.apis[0];
  const option = { source, endpoint: { ...source.endpoint, endpoint_id: ENDPOINT_ID, capability: source.capability },
    subject_id: source.subject_id, input_values: source.input_values, requirement: { slug: 'company.profile' } };
  const parsed = { parsed_request: found.parsed_request, planning_token: 'signed-parse' };
  const calls = [];
  const gateway = { credentialKind: 'session', async request(path, request) {
    calls.push({ path, body: clone(request.body) });
    if (path === '/v2/ask-v2/parse') return clone(parsed);
    if (path === '/v2/ask-v2/search') return request.body.origin === 'apiosk'
      ? { matches: [], source_options: [clone(option)], search_id: 'signed-local' }
      : { matches: [], discovery_id: 'signed-external' };
    if (path.startsWith('/v2/ask-v2/endpoints/')) return clone(option.endpoint);
    if (path === '/v2/ask-v2/prepare') return preparedTask();
    throw new Error(`Unexpected request: ${path}`);
  } };
  const service = createAskService({ gateway, store });
  const invoke = (name, args) => service.tools.find(tool => tool.name === name).handler(args);
  const asked = await invoke('apiosk_ask', { question });
  assert.equal(asked.isError, undefined);
  assert.equal(calls.length, 3, 'Discovery does not prepare or execute');
  assert.deepEqual(calls[0].body, { request_id: calls[0].body.request_id, question });
  assert.match(calls[0].body.request_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(calls.find(call => call.body.origin === 'apiosk').body,
    { parsed_request: parsed.parsed_request, origin: 'apiosk', question, planning_token: 'signed-parse' });
  assert.deepEqual(calls.find(call => call.body.origin === 'coinbase').body,
    { parsed_request: parsed.parsed_request, origin: 'coinbase' });
  const state = stateOf(asked);
  assert.deepEqual(state.discovery.source_options, [option], 'Offered endpoint metadata remains in the saved discovery');
  assert.deepEqual(state.sources, [], 'The App shows matching rows, not unrelated offered endpoints');
  assert.equal(state.status, 'needs_input');
  assert.equal(calls.length, 3, 'No preparation is started for an unmatched option');
  assert.equal(calls.some(call => /approve|authorize|execute/.test(call.path)), false);
});

test('discovery and preparation preserve each subject/input identity and never execute', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  assert.equal(prepared.selections.length, 2);
  assert.notEqual(prepared.selections[0].source_id, prepared.selections[1].source_id);
  const preparation = f.calls.find(call => call.path === '/v2/ask/prepare');
  assert.ok(preparation);
  assert.match(JSON.stringify(preparation.body), /12345670/);
  assert.match(JSON.stringify(preparation.body), /12345671/);
  assert.match(JSON.stringify(preparation.body), /company-1/);
  assert.match(JSON.stringify(preparation.body), /company-2/);
  assert.equal(f.paidCalls().length, 0);
  assert.equal(prepared.approval.max_total_atomic, '140000');
  assert.equal(prepared.approval.currency, 'USD');
});

test('approval binds explicit ID, currency and maximum before executing once', async t => {
  const f = await fixture(t), prepared = await f.prepare(), args = f.approvalArgs(prepared);
  await refused(() => f.invoke('apiosk_approve', { ...args, approval_id: 'unknown' }));
  await refused(() => f.invoke('apiosk_approve', { ...args, currency: 'EUR' }));
  await refused(() => f.invoke('apiosk_approve', { ...args, max_total_atomic: '140001' }));
  await refused(() => f.invoke('apiosk_approve', { ...args, confirm: false }));
  assert.equal(f.paidCalls().length, 0);
  const completed = await f.invoke('apiosk_approve', args);
  assert.notEqual(completed.isError, true);
  assert.equal(f.paidCalls().length, 1);
  await f.invoke('apiosk_approve', args);
  assert.equal(f.paidCalls().length, 1, 'Repeated consent must read the saved outcome, not buy again');
  const approval = f.calls.find(call => call.path === '/v2/approve');
  assert.match(JSON.stringify(approval.body), /quote-original/);
  assert.match(JSON.stringify(approval.body), /140000/);
});

test('changed saved quote is detected before approval is sent', async t => {
  const f = await fixture(t), prepared = await f.prepare(), changed = f.getTask();
  changed.proposal.quote_ref = 'quote-changed';
  changed.proposal.max_total_atomic = '170000';
  changed.state.revision += 1;
  f.setTask(changed);
  await refused(() => f.invoke('apiosk_approve', f.approvalArgs(prepared)));
  assert.equal(f.paidCalls().length, 0);
  assert.ok(f.calls.some(call => call.path === `/v2/tasks/${TASK_ID}`));
});

test('partial origin failure remains visible with available source choices', async t => {
  const f = await fixture(t, { partial: true }), result = await f.ask(), state = stateOf(result);
  assert.ok(state.sources.length > 0);
  assert.match(JSON.stringify(state.discovery), /coinbase/);
  assert.match(JSON.stringify(state.discovery), /search_unavailable/);
  assert.match(textOf(result), /partial/);
  assert.equal(f.paidCalls().length, 0);
});

test('saved status, reopen and export never repeat source execution', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const before = f.paidCalls().length;
  await f.invoke('apiosk_status', { request_id: prepared.request_id });
  await f.invoke('apiosk_chats', { action: 'open', request_id: prepared.request_id });
  const viewed = await f.invoke('apiosk_result', { request_id: prepared.request_id, task_id: TASK_ID, format: 'view' });
  assert.match(textOf(viewed), /Alpha B\.V\./);
  assert.match(textOf(viewed), /false/);
  for (const format of ['json', 'csv', 'html']) {
    const result = await f.invoke('apiosk_result', { request_id: prepared.request_id, task_id: TASK_ID, format });
    assert.notEqual(result.isError, true, `${format}: ${textOf(result)}`);
    assert.match(textOf(result), /Alpha B\.V\./);
  }
  assert.equal(f.paidCalls().length, before);
});

test('unknown continuation action never reaches execution', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await refused(() => f.invoke('apiosk_continue', { request_id: prepared.request_id, task_id: TASK_ID, action_id: 'invented-action', input: {} }));
  assert.equal(f.paidCalls().length, 0);
});

test('lost approval response is recovered without sending a second approval', async t => {
  const f = await fixture(t, { loseApprovalResponse: true }), prepared = await f.prepare(), args = f.approvalArgs(prepared);
  try { await f.invoke('apiosk_approve', args); } catch { /* Response may be unknown, but the journal must retain consent and task identity. */ }
  await f.invoke('apiosk_status', { request_id: prepared.request_id });
  try { await f.invoke('apiosk_approve', args); } catch { /* A refusal requiring status/review is also safe. */ }
  assert.equal(f.calls.filter(call => call.path === '/v2/approve').length, 1);
});

test('automatic planning prepares one reviewable total without authorization', async t => {
  const f = await fixture(t);
  const response = await f.invoke('apiosk_ask', { question: 'Compare Alpha B.V. and Beta B.V.', mode: 'automatic' });
  assert.notEqual(response.isError, true);
  assert.equal(stateOf(response).tasks.length, 1);
  assert.equal(stateOf(response).approval.max_total_atomic, '140000');
  assert.equal(f.calls.filter(call => call.path === '/v2/ask/research').length, 1);
  assert.equal(f.paidCalls().length, 0);
});

test('source schema inspection is read-only and remains bound to the selected row', async t => {
  const f = await fixture(t), asked = await f.ask(), request_id = requestId(asked), source = stateOf(asked).sources[1];
  const response = await f.invoke('apiosk_sources', { request_id, source_id: source.id });
  assert.notEqual(response.isError, true);
  assert.equal(response.structuredContent.source.subject_id, 'company-2');
  assert.equal(response.structuredContent.suggested_input['company.id'], '12345671');
  assert.equal(f.paidCalls().length, 0);
});

test('saved-evidence follow-up reads purchased tasks without starting discovery or repurchasing', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const paid = f.paidCalls().length, discoveries = f.calls.filter(call => call.path === '/v2/ask').length;
  const response = await f.invoke('apiosk_follow_up', { request_id: prepared.request_id, question: 'What does the zero mean in this saved result?' });
  assert.notEqual(response.isError, true);
  assert.equal(requestId(response), prepared.request_id);
  assert.equal(f.paidCalls().length, paid);
  assert.equal(f.calls.filter(call => call.path === '/v2/ask').length, discoveries);
  const route = f.calls.find(call => call.path === '/v2/ask/conversation');
  assert.deepEqual(route.body.task_refs, [TASK_ID]);
});

test('an active worker is not offered as a fresh approvable quote', async t => {
  const f = await fixture(t), running = preparedTask();
  running.context_view.worker_active = true;
  f.setTask(running);
  const response = await f.invoke('apiosk_ask', { question: 'Compare Alpha B.V. and Beta B.V.', mode: 'automatic' });
  assert.notEqual(response.isError, true);
  assert.equal(stateOf(response).approval, null);
  assert.equal(f.paidCalls().length, 0);
});

test('inactive historical task cannot override the active run status', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const state = await f.store.get(prepared.request_id);
  const oldTask = { id: '33333333-3333-4333-8333-333333333333', kind: 'endpoint', view: { ...preparedTask(), status: 'needs_input' } };
  state.tasks.unshift(oldTask);
  f.setHistorical(oldTask.id, oldTask.view);
  await f.store.save(state);
  const current = f.getTask(); current.status = 'running'; current.context_view.worker_active = true; f.setTask(current);
  // Historical tasks may still be refreshed, but their state must not become the active run's state.
  const response = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(response.isError, true);
  assert.deepEqual(stateOf(response).active_task_ids, [TASK_ID]);
  assert.equal(stateOf(response).status, 'running');
});

test('missing required input is shown before any task preparation', async t => {
  const f = await fixture(t), asked = await f.ask(), request_id = requestId(asked), source = stateOf(asked).sources[0];
  const response = await f.invoke('apiosk_prepare', { request_id, selections: [{ source_id: source.id, input: { 'company.id': '' } }] });
  assert.notEqual(response.isError, true);
  assert.equal(stateOf(response).status, 'needs_input');
  assert.equal(stateOf(response).approval, null);
  assert.equal(f.calls.filter(call => call.path === '/v2/ask/prepare').length, 0);
  assert.equal(f.paidCalls().length, 0);
  assert.match(textOf(response), /company\.id/);
});

test('a failed later preparation cannot turn the successful subset into an approvable total', async t => {
  const f = await fixture(t, { external: true, failExternalPrepare: true }), prepared = await f.prepare();
  assert.equal(stateOf(prepared.result).status, 'preparation_incomplete');
  assert.equal(prepared.approval, null);
  assert.equal(stateOf(prepared.result).tasks.length, 1, 'Already saved preparation remains available for recovery');
  const response = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(response.isError, true);
  assert.equal(stateOf(response).approval, null);
  assert.notEqual(stateOf(response).status, 'requires_approval');
  assert.equal(f.paidCalls().length, 0);
});

test('repeating approved group recovery sends only the never-dispatched source', async t => {
  const f = await fixture(t, { external: true, loseApprovalResponse: true }), prepared = await f.prepare(), args = f.approvalArgs(prepared);
  assert.equal(prepared.approval.max_total_atomic, '150000');
  await f.invoke('apiosk_approve', args);
  assert.equal(f.calls.filter(call => call.path === '/v2/approve').length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith('/authorize')).length, 0);
  const read = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(read.isError, true);
  assert.equal(f.calls.filter(call => call.path.endsWith('/authorize')).length, 0, 'Status does not dispatch the remaining source');
  await f.invoke('apiosk_approve', args);
  assert.equal(f.calls.filter(call => call.path === '/v2/approve').length, 1, 'The source with an uncertain response is never replayed');
  assert.equal(f.calls.filter(call => call.path.endsWith('/authorize')).length, 1, 'The original approved, undispatched source can resume');
});

test('loading a full saved page makes complete data available to view and CSV without paid execution', async t => {
  const savedDocument = { result_ref: 'result-company', coverage: 'source_response', source: { name: 'Example register', provider: 'example-register' }, data: [{ company: '😀 Alpha', value: 0, active: false }] };
  const f = await fixture(t, { savedDocument }), prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const current = f.getTask(), chars = Array.from(JSON.stringify(savedDocument)), first = chars.slice(0, 35).join('');
  const initial = { result_ref: savedDocument.result_ref, encoding: 'json_text', text: first, next_offset: 35, source: savedDocument.source };
  current.result = initial; current.context_view.results = [initial];
  current.next_actions = [{ action_id: savedDocument.result_ref, kind: 'read_result', requires_authorization: false, input_schema: {} }];
  f.setTask(current);
  await f.invoke('apiosk_status', { request_id: prepared.request_id });
  const before = f.paidCalls().length;
  const loaded = await f.invoke('apiosk_result_page', { request_id: prepared.request_id, task_id: TASK_ID, action_id: savedDocument.result_ref, offset: 35 });
  assert.notEqual(loaded.isError, true, textOf(loaded));
  assert.deepEqual(loaded.structuredContent.results[0].data, savedDocument.data);
  const csv = await f.invoke('apiosk_result', { request_id: prepared.request_id, task_id: TASK_ID, format: 'csv' });
  assert.notEqual(csv.isError, true, textOf(csv));
  assert.match(csv.structuredContent.text, /😀 Alpha,0,false/);
  assert.equal(f.paidCalls().length, before);
  assert.equal(f.calls.filter(call => call.path === '/v2/execute' && call.body.action_id === savedDocument.result_ref).length, 1);
});

test('connected entity/input continuations use public idempotent route and then read the raw task', async t => {
  for (const kind of ['select_entity', 'supply_input']) {
    const f = await fixture(t), prepared = await f.prepare(), current = f.getTask();
    current.status = kind === 'select_entity' ? 'needs_selection' : 'needs_input';
    current.next_actions = [{ action_id: `action-${kind}`, kind, requires_authorization: false, input_schema: { type: 'object', required: ['value'], properties: { value: { type: 'string' } }, additionalProperties: false } }];
    f.setTask(current);
    const marker = f.calls.length;
    const response = await f.invoke('apiosk_continue', { request_id: prepared.request_id, task_id: TASK_ID, action_id: `action-${kind}`, input: { value: 'chosen-id' } });
    assert.notEqual(response.isError, true, textOf(response));
    const calls = f.calls.slice(marker), continuation = calls.find(call => call.path === `/v2/asks/${TASK_ID}/continue`);
    assert.ok(continuation);
    assert.ok(continuation.headers?.['idempotency-key']);
    assert.deepEqual(continuation.body.input, { value: 'chosen-id' });
    assert.equal(continuation.body.action_id, `action-${kind}`);
    assert.equal(calls.some(call => call.path === '/v2/execute'), false);
    assert.equal(calls.at(-1).path, `/v2/tasks/${TASK_ID}`);
    assert.ok(stateOf(response).tasks[0].view.state, 'The saved view is the raw Gateway task, not the public continuation envelope');
  }
});

test('a new unapproved ready quote archives the old attempt and requires new exact approval', async t => {
  const f = await fixture(t, { afterContinuation: current => ({ ...current, status: 'ready', state: { ...current.state, revision: current.state.revision + 1 },
    billing: { authorization_active: false }, context_view: { ...current.context_view, worker_active: false },
    proposal: { ...preparedTask().proposal, quote_ref: 'new-unapproved-quote', max_total_atomic: '210000' }, next_actions: preparedTask().next_actions }) });
  const prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const current = f.getTask(); current.status = 'needs_input';
  current.next_actions = [{ action_id: 'supply-more', kind: 'supply_input', requires_authorization: false, input_schema: { type: 'object' } }]; f.setTask(current);
  const response = await f.invoke('apiosk_continue', { request_id: prepared.request_id, task_id: TASK_ID, action_id: 'supply-more', input: { 'company.id': 'new-company' } });
  assert.notEqual(response.isError, true, textOf(response));
  const state = stateOf(response), savedTask = state.tasks.find(task => task.id === TASK_ID);
  assert.equal(state.approved_id, null);
  assert.equal(state.approval.max_total_atomic, '210000');
  assert.notEqual(state.approval.approval_id, prepared.approval.approval_id);
  assert.equal(savedTask.approval_attempt, undefined);
  assert.equal(savedTask.approval_history.length, 1);
  assert.equal(f.calls.filter(call => call.path === '/v2/approve').length, 1, 'Continuation did not authorize the new quote');
});

test('offered cancel and retry_analysis actions accept null input', async t => {
  for (const kind of ['cancel', 'retry_analysis']) {
    const f = await fixture(t), prepared = await f.prepare(), current = f.getTask();
    current.next_actions = [{ action_id: `action-${kind}`, kind, requires_authorization: false, input_schema: { type: 'null' } }];
    f.setTask(current);
    const response = await f.invoke('apiosk_continue', { request_id: prepared.request_id, task_id: TASK_ID, action_id: `action-${kind}`, input: null });
    assert.notEqual(response.isError, true, textOf(response));
    const dispatch = f.calls.find(call => call.path === '/v2/execute');
    assert.equal(dispatch.body.input, null);
    assert.equal(dispatch.body.action_id, `action-${kind}`);
    assert.equal(f.calls.filter(call => call.path === '/v2/approve').length, 0);
  }
});

test('artifacts only download exact saved task URLs as read-only bytes', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const current = f.getTask(), pdf = `/v2/tasks/${TASK_ID}/reports/report-1/report.pdf?signature=exact`, sourcePdf = `/v2/tasks/${TASK_ID}/results/result-company/report.pdf?signature=source`, map = `/v2/tasks/${TASK_ID}/results/result-company/assets/0?signature=map`;
  current.context_view.report = { format: 'pdf', filename: 'analysis.pdf', download_path: pdf, evidence_download_path: `/v2/tasks/${TASK_ID}/reports/report-1/evidence.zip?signature=zip` };
  current.context_view.results[0].report = { format: 'pdf', filename: 'source.pdf', download_path: sourcePdf };
  current.context_view.results[0].report_assets = { assets: [{ kind: 'map', format: 'png', download_path: map }] };
  f.setTask(current); await f.invoke('apiosk_status', { request_id: prepared.request_id });
  const listed = await f.invoke('apiosk_artifact', { request_id: prepared.request_id, task_id: TASK_ID });
  assert.notEqual(listed.isError, true);
  assert.ok(listed.structuredContent.artifacts.some(artifact => artifact.url === sourcePdf));
  assert.ok(listed.structuredContent.artifacts.some(artifact => artifact.url === map));
  const before = f.calls.length;
  for (const artifact_url of ['https://other.example/private', `${pdf}&extra=changed`, `/v2/tasks/other/results/x/report.pdf?signature=exact`]) await refused(() => f.invoke('apiosk_artifact', { request_id: prepared.request_id, task_id: TASK_ID, artifact_url }));
  assert.equal(f.calls.length, before, 'Unsaved URLs are refused before transport');
  const response = await f.invoke('apiosk_artifact', { request_id: prepared.request_id, task_id: TASK_ID, artifact_url: sourcePdf });
  assert.notEqual(response.isError, true, textOf(response));
  const download = f.calls.at(-1);
  assert.equal(download.path, sourcePdf);
  assert.equal(download.method, 'GET');
  assert.equal(download.body, undefined);
  assert.equal(download.responseType, 'bytes');
  assert.equal(response.structuredContent.source_purchase, false);
  assert.equal(response.content.find(item => item.type === 'resource').resource.mimeType, 'application/pdf');
});

test('pending unresolved update prevents status from restoring an approvable quote', async t => {
  const f = await fixture(t), prepared = await f.prepare(), saved = await f.store.get(prepared.request_id);
  saved.tasks[0].pending_update = { status: 'outcome_unknown', request_id: 'edit-1' };
  await f.store.save(saved);
  const response = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(response.isError, true);
  assert.equal(stateOf(response).approval, null);
  await refused(() => f.invoke('apiosk_approve', f.approvalArgs(prepared)));
  assert.equal(f.paidCalls().length, 0);
});

test('saved-page transport is blocked while an unapproved quote can trigger standing autoapproval', async t => {
  const f = await fixture(t), prepared = await f.prepare(), current = f.getTask();
  current.context_view.auto_approval = { active: true };
  delete current.context_view.manual_approval_required;
  current.next_actions = [{ action_id: 'read-unapproved', kind: 'read_result', requires_authorization: false, input_schema: {} }];
  f.setTask(current);
  const message = await refused(() => f.invoke('apiosk_result_page', { request_id: prepared.request_id, task_id: TASK_ID, action_id: 'read-unapproved', offset: 0 }));
  assert.match(message, /standing approval/);
  assert.equal(f.calls.filter(call => call.path === '/v2/execute').length, 0);
  assert.equal(f.paidCalls().length, 0);
});

test('failed metadata review for edited inputs invalidates old approval before status or consent can reuse it', async t => {
  const f = await fixture(t), prepared = await f.prepare();
  const selections = prepared.selections.map((selection, index) => index === 0 ? { ...selection, input: { 'company.id': '87654321' } } : selection);
  const prepareCount = f.calls.filter(call => call.path === '/v2/ask/prepare').length;
  f.setDescriptorFailure(true);
  await f.invoke('apiosk_prepare', { request_id: prepared.request_id, selections });
  const failed = await f.store.get(prepared.request_id);
  assert.equal(failed.approval, null);
  assert.equal(failed.pending_input_review, true);
  assert.equal(failed.status, 'input_review_incomplete');
  assert.equal(f.calls.filter(call => call.path === '/v2/ask/prepare').length, prepareCount);
  const status = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(status.isError, true);
  assert.equal(stateOf(status).approval, null);
  assert.equal(stateOf(status).pending_input_review, true);
  await refused(() => f.invoke('apiosk_approve', f.approvalArgs(prepared)));
  assert.equal(f.paidCalls().length, 0);
});

test('successful metadata retry for the already prepared fingerprint clears review hold and restores its quote', async t => {
  const f = await fixture(t), prepared = await f.prepare(), prepareCount = f.calls.filter(call => call.path === '/v2/ask/prepare').length;
  f.setDescriptorFailure(true);
  await f.invoke('apiosk_prepare', { request_id: prepared.request_id, selections: prepared.selections });
  assert.equal((await f.store.get(prepared.request_id)).pending_input_review, true);
  f.setDescriptorFailure(false);
  const recovered = await f.invoke('apiosk_prepare', { request_id: prepared.request_id, selections: prepared.selections });
  assert.notEqual(recovered.isError, true, textOf(recovered));
  const state = stateOf(recovered);
  assert.notEqual(state.pending_input_review, true);
  assert.equal(state.status, 'requires_approval');
  assert.equal(state.approval.max_total_atomic, prepared.approval.max_total_atomic);
  assert.equal(state.approval.currency, prepared.approval.currency);
  assert.equal(state.approval.quotes[0].quote_ref, prepared.approval.quotes[0].quote_ref);
  assert.equal(f.calls.filter(call => call.path === '/v2/ask/prepare').length, prepareCount, 'The identical saved preparation is reused after successful input review');
  assert.equal(f.paidCalls().length, 0);
});

test('a crash after per-task dispatch journaling remains recovery-required and never replays approval', async t => {
  const f = await fixture(t), prepared = await f.prepare(), state = await f.store.get(prepared.request_id);
  state.approved_id = prepared.approval.approval_id;
  state.approved_quotes = prepared.approval;
  state.approval = null;
  state.tasks[0].approval_attempt = { id: 'recorded-before-dispatch', status: 'dispatching', at: '2026-10-23T12:00:00Z' };
  await f.store.save(state);
  // Gateway still reports ready/unbilled: whether the process sent approval is unknowable.
  const status = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(status.isError, true);
  assert.equal(stateOf(status).status, 'recovery_required');
  assert.equal(stateOf(status).approval, null);
  const repeated = await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  assert.notEqual(repeated.isError, true);
  assert.equal(f.paidCalls().length, 0);
  const persisted = await f.store.get(prepared.request_id);
  assert.equal(persisted.tasks[0].approval_attempt.id, 'recorded-before-dispatch');
  assert.equal(persisted.tasks[0].approval_attempt.status, 'dispatching');
  assert.equal(persisted.status, 'recovery_required');
});

test('an approved unfinished sibling stays observed after continuation creates a new quote for one task', async t => {
  const siblingId = '55555555-5555-4555-8555-555555555555';
  const f = await fixture(t, { afterContinuation: current => ({ ...current, status: 'ready', state: { ...current.state, revision: current.state.revision + 1 },
    billing: { authorization_active: false }, context_view: { ...current.context_view, worker_active: false },
    proposal: { ...preparedTask().proposal, quote_ref: 'changed-task-only', max_total_atomic: '210000' }, next_actions: preparedTask().next_actions }) });
  const prepared = await f.prepare();
  await f.invoke('apiosk_approve', f.approvalArgs(prepared));
  const state = await f.store.get(prepared.request_id);
  const siblingView = { ...preparedTask(), status: 'running', state: { ...preparedTask().state, state_ref: siblingId, revision: 2 },
    proposal: null, context_view: { worker_active: true, results: [] }, billing: { authorization_active: true, status: 'reserved' } };
  state.tasks.push({ id: siblingId, kind: 'endpoint', view: siblingView, approval_attempt: { id: 'earlier-sibling-consent', status: 'response_received' } });
  state.active_task_ids.push(siblingId);
  await f.store.save(state);
  f.setHistorical(siblingId, siblingView);
  const current = f.getTask(); current.status = 'needs_input';
  current.next_actions = [{ action_id: 'supply-renewed', kind: 'supply_input', requires_authorization: false, input_schema: { type: 'object' } }];
  f.setTask(current);
  const renewed = await f.invoke('apiosk_continue', { request_id: prepared.request_id, task_id: TASK_ID, action_id: 'supply-renewed', input: { 'company.id': 'new-subject' } });
  assert.notEqual(renewed.isError, true, textOf(renewed));
  assert.deepEqual(stateOf(renewed).active_task_ids, [TASK_ID]);
  assert.deepEqual(stateOf(renewed).approval.quotes.map(quote => quote.task_id), [TASK_ID]);
  assert.equal(stateOf(renewed).approval.max_total_atomic, '210000');
  const before = f.calls.length;
  const reviewed = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.notEqual(reviewed.isError, true);
  assert.ok(f.calls.slice(before).some(call => call.path === `/v2/tasks/${siblingId}`), 'The prior approved sibling is refreshed despite being outside the new quote');
  const approval = stateOf(reviewed).approval;
  assert.deepEqual(approval.quotes.map(quote => quote.task_id), [TASK_ID]);
  await f.invoke('apiosk_approve', { request_id: prepared.request_id, approval_id: approval.approval_id, currency: approval.currency, max_total_atomic: approval.max_total_atomic, confirm: true });
  const running = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.equal(stateOf(running).tasks.find(task => task.id === TASK_ID).view.status, 'succeeded');
  assert.equal(stateOf(running).status, 'running', 'Completed new quote cannot hide an unfinished earlier approved sibling');
  f.setHistorical(siblingId, { ...siblingView, status: 'succeeded', state: { ...siblingView.state, revision: 3 }, context_view: { ...siblingView.context_view, worker_active: false } });
  const finished = await f.invoke('apiosk_status', { request_id: prepared.request_id });
  assert.equal(stateOf(finished).status, 'finished');
  assert.equal(stateOf(finished).tasks.find(task => task.id === siblingId).view.status, 'succeeded');
  assert.equal(f.calls.filter(call => call.path === '/v2/approve').length, 2, 'Only the original and newly reviewed task quotes were approved');
});
