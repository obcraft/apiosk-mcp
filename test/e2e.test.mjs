import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOKEN = 'apk_access_fake_e2e_no_provider_credentials';
const WORKSPACE = 'aa000000-0000-4000-8000-000000000001';
const ENDPOINT = 'aa000000-0000-4000-8000-000000000002';
const TASK = 'aa000000-0000-4000-8000-000000000003';
const QUOTE = 'aa000000-0000-4000-8000-000000000004';
const RESULT = 'aa000000-0000-4000-8000-000000000005';
const CAPABILITY = 'company.registry_profile';
const QUESTION = 'Show the registered profile for Example Test B.V., KVK 01234567.';
const INPUT = { 'company_registry.kvknummer': '01234567' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function gatewayFixture() {
  const requests = [], failures = [];
  const counts = { discovery: 0, prepare: 0, approval: 0, sourceExecutions: 0 };
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  const retrieved = new Date().toISOString();
  const descriptor = {
    answer_supported: true, api_id: ENDPOINT, endpoint_id: ENDPOINT, capability: CAPABILITY,
    name: 'Official company registration', description: 'Local test fixture; no real registry is contacted.',
    source: { slug: 'test-registry', name: 'Test Registry', logo_url: null, url: 'https://example.invalid/registry' },
    inputs: [{ field: 'company_registry.kvknummer', required: true, schema: { type: 'string', pattern: '^[0-9]{8}$' } }],
    outputs: [{ field: 'company_registry.profile', schema: { type: 'object' } }], lookup: null,
    price: { currency: 'USDC', provider_atomic: '60000', buyer_atomic: '70000' },
  };
  const parsed = {
    language: 'en', subjects: [{ id: 'subject_1', label: 'Example Test B.V.', type: 'company', identifiers: { kvk_number: '01234567' } }],
    capabilities: [{ slug: CAPABILITY, name: 'Company registry profile', description: 'Read the registered profile.', domain: 'company',
      inputs: ['company_registry.kvknummer'], outputs: ['company_registry.profile'], subject_id: 'subject_1', source_hint: null, confidence: 1, status: 'existing', missing: [] }],
    deliverable: { format: 'chat', operations: ['summarize'] },
    meta: { model: 'local-test-fixture', parsed_at: retrieved, text_sha256: '0'.repeat(64) },
  };
  const proposal = { label: 'Read one company profile', quote_ref: QUOTE, price_status: 'quoted', currency: 'USDC', max_total_atomic: '70000',
    expires_at: expires, approval_url: 'https://example.invalid/approve', steps: ['Read the registered company profile'],
    step_details: [{ number: 1, title: 'Company registry profile', max_total_atomic: '70000', currency: 'USDC', status: 'pending',
      source: descriptor.source, dependencies: [] }] };
  const envelope = { schema_version: '2', state_ref: TASK, revision: 1, expires_at: expires,
    focus: { entity_refs: [], goal_refs: [] }, state_token: 'signed-fixture-envelope' };
  const sourceResult = { result_ref: RESULT, endpoint_id: ENDPOINT, source: descriptor.source, retrieved_at: retrieved,
    data: { kvk_number: '01234567', registered_name: 'Example Test B.V.', active: true, employees: 0 } };
  let view = {
    protocol_version: '2', request_id: 'aa000000-0000-4000-8000-000000000006', intent_ref: null,
    status: 'ready', state: envelope, context_view: { worker_active: false, analyzing: false, results: [], result_refs: [] },
    proposal, billing: null, result: null, errors: [],
    next_actions: [{ action_id: 'aa000000-0000-4000-8000-000000000007', kind: 'execute_quoted_step', label: 'Run selected source', requires_authorization: true, input_schema: { type: 'null' } }],
  };
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bytes = Buffer.concat(chunks).toString('utf8');
      const body = bytes ? JSON.parse(bytes) : undefined;
      requests.push({ method: req.method, path: req.url, body, headers: req.headers });
      assert.equal(req.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(req.headers['x-apiosk-workspace'], WORKSPACE);
      assert.match(req.headers.accept, /application\/json/);
      if (req.method === 'POST') assert.match(req.headers['content-type'], /application\/json/);
      let response;
      if (req.method === 'GET' && req.url === '/v2/display-context') {
        response = { money_display: { base_currency: 'USD', preferred_currency: 'EUR', currency: 'EUR', rate: '0.92', as_of_date: '2026-10-24', fallback_reason: null } };
      } else if (req.method === 'POST' && req.url === '/v2/ask/page') {
        counts.discovery++;
        assert.deepEqual(body, { question: QUESTION });
        response = { status: 'choices', question: QUESTION, parsed_request: parsed, model: 'local-test-fixture', attempts: 1,
          timing: { parse_ms: 1, search_ms: 1 }, errors: [], search_id: 'signed-search-fixture', discovery_id: 'signed-external-fixture',
          source_options: [], company_context: [], context_status: 'complete', execution: { method: 'POST', path: '/v2/execute' },
          searches: { apiosk: { matches: [] }, coinbase: { matches: [] } },
          apis: [{ origin: 'apiosk', name: descriptor.name, description: descriptor.description, source_slug: descriptor.source.slug,
            endpoint_id: ENDPOINT, capability: CAPABILITY, requested_capability: CAPABILITY, subject_id: 'subject_1',
            availability: 'supported', executable: true, price: '0.07 USD', input_values: INPUT, inputs: descriptor.inputs,
            outputs: descriptor.outputs, lookup: null, missing_inputs: [], buyer_price: descriptor.price, discovery_query: QUESTION }] };
        response.searches.apiosk.matches = [{ slug: CAPABILITY, subject_id: 'subject_1', apiosk: response.apis, coinbase: [] }];
      } else if (req.method === 'GET' && req.url === `/v2/ask-v2/endpoints/${ENDPOINT}?capability=${CAPABILITY}`) {
        assert.equal(body, undefined);
        response = descriptor;
      } else if (req.method === 'POST' && req.url === '/v2/ask/source/prepare') {
        counts.prepare++;
        assert.match(body.request_id, UUID);
        assert.deepEqual(body, { request_id: body.request_id, endpoint_id: ENDPOINT, capability: CAPABILITY, input: INPUT, question: QUESTION });
        assert.equal(counts.sourceExecutions, 0, 'Preparing may not execute the source.');
        response = view;
      } else if (req.method === 'GET' && req.url === `/v2/tasks/${TASK}`) {
        assert.equal(body, undefined);
        response = view;
      } else if (req.method === 'POST' && req.url === '/v2/approve') {
        counts.approval++;
        assert.equal(counts.approval, 1, 'A saved approval must never be dispatched twice.');
        assert.match(body.request_id, UUID);
        assert.deepEqual(body, { request_id: body.request_id, state: envelope, quote_ref: QUOTE, max_total_atomic: '70000' });
        // This counter simulates the Gateway's source execution. No provider
        // endpoint exists in this fixture, and no real credentials are used.
        counts.sourceExecutions++;
        view = { ...view, status: 'succeeded', state: { ...envelope, revision: 2, state_token: 'signed-completed-fixture' },
          context_view: { worker_active: false, analyzing: false, result_refs: [RESULT], results: [sourceResult],
            analysis: { status: 'succeeded', observations: [{ text: 'Example Test B.V. is registered.', evidence: [{ result_ref: RESULT, pointer: '/data/registered_name', value: 'Example Test B.V.' }] }], limitations: [] } },
          result: sourceResult, next_actions: [],
          billing: { authorization_active: true, quote_ref: QUOTE, status: 'settled', funding_source: 'wallet', currency: 'USDC', unit: 'atomic',
            provider_cost: '60000', apiosk_fee: '10000', total_charged: '70000', reserved: '0', balance_available: null,
            executions: [{ execution_id: 'aa000000-0000-4000-8000-000000000008', receipt_ref: null, status: 'succeeded', total_charged: '70000' }] } };
        response = view;
      } else throw new Error(`Unexpected Gateway request: ${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      failures.push(error);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'fixture_contract_mismatch', message: 'The local test request did not match the Gateway contract.' }));
    }
  });
  return { server, counts, requests, failures, descriptor, sourceResult };
}

test('real stdio MCP persists discovery, exact approval and source evidence across restart without purchasing again', { timeout: 30_000 }, async t => {
  const fixture = gatewayFixture();
  const stateDir = await mkdtemp(join(tmpdir(), 'apiosk-mcp2-e2e-'));
  let client, lastResponse;
  t.after(async () => {
    await client?.close();
    fixture.server.closeAllConnections();
    await new Promise(resolve => fixture.server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    fixture.server.once('error', reject);
    fixture.server.listen(0, '127.0.0.1', resolve);
  });
  const gatewayUrl = `http://127.0.0.1:${fixture.server.address().port}`;
  async function connect() {
    const transport = new StdioClientTransport({
      command: process.execPath, args: [join(ROOT, 'bin/mcp-2.mjs'), '--stdio'], cwd: ROOT, stderr: 'pipe',
      env: { PATH: process.env.PATH || '', APIOSK_GATEWAY_V2_URL: gatewayUrl, APIOSK_CONNECT_TOKEN: TOKEN,
        APIOSK_TOKEN: '', APIOSK_WORKSPACE_ID: WORKSPACE, APIOSK_MCP_STATE_DIR: stateDir },
    });
    const next = new Client({ name: 'apiosk-local-e2e', version: '1.0.0' }, { capabilities: {} });
    client = next;
    await next.connect(transport);
    return next;
  }
  async function call(name, args = {}) {
    const response = await client.callTool({ name, arguments: args });
    lastResponse = response;
    if (fixture.failures.length) throw fixture.failures[0];
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(response.structuredContent, 'Every tool result needs portable structured content.');
    assert.ok(response.content.some(item => item.type === 'text'), 'Every tool result needs a text fallback.');
    return response.structuredContent;
  }

  await connect();
  const tools = (await client.listTools()).tools;
  assert.equal(tools[0].name, 'apiosk_ask', 'Ask is the default entry point.');
  assert.ok(tools[0]._meta?.ui?.resourceUri, 'Ask returns the embedded UI in compatible hosts.');
  assert.ok(tools.some(tool => tool.name === 'apiosk_approve' && tool.annotations.destructiveHint));
  assert.equal((await call('apiosk_capabilities')).credential_kind, 'connection');
  assert.equal(fixture.requests.length, 0);

  const discovered = await call('apiosk_ask', { question: QUESTION });
  const requestId = discovered.request_id;
  assert.match(requestId, UUID);
  assert.equal(discovered.status, 'sources_ready');
  assert.equal(discovered.sources.length, 1);
  const sourceId = discovered.sources[0].source_id;
  assert.ok(sourceId);
  assert.equal(lastResponse._meta.apiosk_card_data.view, 'source_search');
  assert.ok(lastResponse._meta.apiosk_card_data.matches.length, 'The card shows the offered source.');
  const source = await call('apiosk_sources', { request_id: requestId, source_id: sourceId });
  assert.deepEqual(source.descriptor, fixture.descriptor);
  assert.deepEqual(source.suggested_input, INPUT);
  assert.equal(source.charged, false);

  const prepared = await call('apiosk_prepare', { request_id: requestId, selections: [{ source_id: sourceId, input: INPUT }] });
  assert.equal(prepared.status, 'requires_approval');
  assert.equal(prepared.tasks[0].status, 'ready', 'The raw Gateway ready status must produce a reviewable MCP quote.');
  assert.equal(lastResponse._meta.apiosk_card_data.proposal.quote_ref, QUOTE);
  const approval = { request_id: requestId, approval_id: prepared.approval.approval_id, currency: 'USDC', max_total_atomic: '70000', confirm: true };
  assert.equal(prepared.approval.quotes[0].quote_ref, QUOTE);
  assert.equal(fixture.counts.sourceExecutions, 0);
  const beforeRejectedApproval = fixture.requests.length;
  const invalid = await client.callTool({ name: 'apiosk_approve', arguments: { ...approval, confirm: false } });
  assert.equal(invalid.isError, true);
  assert.equal(invalid.structuredContent.error.code, 'invalid_arguments');
  assert.equal(fixture.requests.length, beforeRejectedApproval, 'MCP input validation must reject an unconfirmed purchase before Gateway access.');

  assert.equal((await call('apiosk_approve', approval)).status, 'finished');
  const status = await call('apiosk_status', { request_id: requestId });
  assert.equal(status.status, 'finished');
  assert.equal(lastResponse._meta.apiosk_card_data.billing.total_charged, '70000');
  const resultView = await call('apiosk_result', { request_id: requestId, task_id: TASK });
  assert.ok(JSON.stringify(resultView).includes('Example Test B.V.'), 'The model can inspect actual saved answer data.');
  const beforeSavedReads = fixture.requests.length;
  const exported = await call('apiosk_result', { request_id: requestId, task_id: TASK, format: 'json' });
  assert.equal(exported.mimeType, 'application/json');
  assert.equal(exported.local_only, true);
  assert.deepEqual(JSON.parse(exported.text).context_view.results, [fixture.sourceResult]);
  const resourceUri = `apiosk://requests/${requestId}`;
  assert.ok((await client.listResources()).resources.some(resource => resource.uri === resourceUri));
  const saved = JSON.parse((await client.readResource({ uri: resourceUri })).contents[0].text);
  assert.equal(saved.approved_id, approval.approval_id);
  assert.equal(saved.tasks[0].approval_attempt.status, 'response_received');
  assert.deepEqual(saved.tasks[0].view.context_view.results, [fixture.sourceResult]);
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  assert.equal(fixture.requests.length, beforeSavedReads, 'Saved exports and resources must make no Gateway calls.');

  await client.close();
  client = undefined;
  await connect();
  const chats = await call('apiosk_chats', { action: 'list' });
  assert.equal(chats.chats.length, 1);
  assert.equal(chats.chats[0].request_id, requestId);
  const reopened = await call('apiosk_chats', { action: 'open', request_id: requestId });
  assert.equal(reopened.status, 'finished');
  assert.deepEqual(lastResponse._meta.apiosk_card_data.context_view.results, [fixture.sourceResult]);
  assert.equal((await call('apiosk_approve', approval)).status, 'finished');
  const persisted = JSON.parse((await client.readResource({ uri: resourceUri })).contents[0].text);
  assert.equal(persisted.tasks[0].approval_attempt.id, saved.tasks[0].approval_attempt.id);
  assert.equal(fixture.requests.length, beforeSavedReads, 'Restart recovery and repeated approval must reuse the durable journal.');
  assert.deepEqual(fixture.counts, { discovery: 1, prepare: 1, approval: 1, sourceExecutions: 1 });
  assert.deepEqual(fixture.failures, []);
  assert.equal(fixture.requests.some(request => request.path === '/v2/execute'), false);
});
