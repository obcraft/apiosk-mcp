import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { createCardHtml, CARD_URI, CHATGPT_CARD_URI, CARD_READ_TOOL, CARD_APPROVE_TOOL } from '../src/card-ui.mjs';
import { withEmbeddedCards, presentCard, sourceCard } from '../src/card-adapter.mjs';

const local = { id: 'local1', origin: 'apiosk', endpoint_id: 'registry', capability: 'company.profile', subject_id: 'asml',
  name: 'Official register', availability: 'supported', input_values: { company: 'ASML' },
  endpoint: { endpoint_id: 'registry', capability: 'company.profile', inputs: [{ field: 'company', required: true, schema: { type: 'string' } }], price: { buyer_atomic: '10000' } } };
const external = { id: 'external1', origin: 'coinbase', api_id: 'bazaar:source', url: 'https://example.test/profile', method: 'GET',
  subject_id: 'asml', name: 'External company data', availability: 'discovery_only' };
const selection = { endpoint_id: 'registry', capability: 'company.profile', subject_id: 'asml', input: { company: 'ASML' } };
function state(overrides = {}) {
  return { id: 'request1', type: 'ask', question: 'What does ASML do?', status: 'sources_ready', sources: [structuredClone(local), structuredClone(external)],
    tasks: [], active_task_ids: [], selected: [], discovery: { search_id: 'search1', parsed_request: { subjects: [{ id: 'asml', label: 'ASML' }], capabilities: [{ slug: 'company.profile', subject_id: 'asml' }] },
      searches: { apiosk: { matches: [{ slug: 'company.profile', subject_id: 'asml', apiosk: [structuredClone(local)] }] },
        coinbase: { matches: [{ slug: 'company.profile', subject_id: 'asml', coinbase: [structuredClone(external)], coinbase_status: 'complete' }] } },
      source_options: [{ source: { endpoint_id: 'registry', capability: 'company.profile' }, subject_id: 'asml', endpoint: structuredClone(local.endpoint), input_values: { company: 'ASML' } }] }, ...overrides };
}
function endpointTask(id = 'task1') {
  return { id, kind: 'endpoint', view: { state: { state_ref: id, revision: 1, state_token: 'fixture-token' }, status: 'ready',
    proposal: { quote_ref: `quote-${id}`, max_total_atomic: '10000', currency: 'USD', expires_at: '2099-01-01T00:00:00Z', approval_url: 'https://example.test/approve' },
    billing: { authorization_active: false, total_charged: '0', currency: 'USD' }, context_view: { question: 'What does ASML do?' },
    next_actions: [{ action_id: `execute-${id}`, kind: 'execute_quoted_step', requires_authorization: true }] } };
}
function fixture(saved = state()) {
  const calls = [], names = ['apiosk_ask', 'apiosk_prepare', 'apiosk_approve', 'apiosk_status', 'apiosk_requote', 'apiosk_sources', 'apiosk_continue', 'apiosk_result_page', 'apiosk_result', 'apiosk_follow_up', 'apiosk_retry_search'];
  const response = () => ({ structuredContent: { request_id: saved.id, raw: saved, ...saved.result_presentation }, content: [{ type: 'text', text: 'fixture' }] });
  const service = { tools: names.map(name => ({ name, inputSchema: { type: 'object' }, handler: async args => {
    calls.push({ name, args });
    if (name === 'apiosk_sources' && args.source_id) return { structuredContent: { request_id: saved.id, descriptor: { name: 'External company data', inputs: [], total_atomic: '25000' } } };
    if (name === 'apiosk_approve' && (args.approval_id !== saved.approval?.approval_id || args.max_total_atomic !== saved.approval.max_total_atomic)) return { isError: true, structuredContent: { error: { message: 'Approval does not match current saved total.' } } };
    return response();
  } })), listResources: async () => [], readResource: async () => { throw new Error('Unknown resource'); } };
  const wrapped = withEmbeddedCards(service, { store: { get: async id => id === saved.id ? saved : null }, gateway: { baseUrl: 'https://api.example.test' } });
  return { saved, calls, wrapped, run: (name, args) => wrapped.tools.find(tool => tool.name === name).handler(args, {}) };
}

test('the vendored components are byte-identical to the recorded MCP1 renderer', async () => {
  const checksums = JSON.parse(await readFile(new URL('../src/ask-ui/upstream-checksums.json', import.meta.url)));
  assert.ok(Object.keys(checksums).length >= 30);
  for (const [name, expected] of Object.entries(checksums)) {
    const data = await readFile(new URL(`../src/ask-ui/${name}`, import.meta.url));
    assert.equal(createHash('sha256').update(data).digest('hex'), expected, name);
  }
});

test('both host resources run the same complete original UI with a private result bridge', async () => {
  const { wrapped } = fixture(), resources = await wrapped.listResources();
  assert.deepEqual(resources.slice(0, 2).map(resource => resource.uri), [CARD_URI, CHATGPT_CARD_URI]);
  const first = (await wrapped.readResource(CARD_URI)).contents[0], second = (await wrapped.readResource(CHATGPT_CARD_URI)).contents[0];
  assert.equal(first.text, second.text);
  assert.equal(first.mimeType, 'text/html;profile=mcp-app');
  assert.equal(second.mimeType, 'text/html+skybridge');
  assert.match(first.text, /toolResponseMetadata\?\.apiosk_card_data/);
  assert.match(first.text, /r\._meta\?\.apiosk_card_data/);
  for (const match of first.text.matchAll(/<script>([\s\S]*?)<\/script>/g)) new Script(match[1]);
  for (const component of ['renderSourceSearch', 'renderExternalSource', 'renderSourceBasket', 'renderInput', 'renderActions', 'renderResearch']) assert.ok(first.text.includes(component));
});

test('model response stays compact while the private card preserves full source forms', async () => {
  const f = fixture(); f.saved.discovery.searches.apiosk.matches[0].apiosk[0].endpoint.documentation = 'evidence '.repeat(70000);
  const result = await f.run('apiosk_ask', { question: f.saved.question });
  assert.equal(result._meta.apiosk_card_data.view, 'source_search');
  assert.ok(JSON.stringify(result.structuredContent).length < 12000);
  assert.ok(result._meta.apiosk_card_data.matches[0].apiosk[0].endpoint.documentation.length > 500000);
  assert.equal(f.wrapped.tools.find(tool => tool.name === 'apiosk_ask')._meta.ui.resourceUri, CARD_URI);
  assert.deepEqual(f.wrapped.tools.find(tool => tool.name === CARD_APPROVE_TOOL)._meta.ui.visibility, ['app']);
});

test('source view preserves native and external results, and exact offered source options', () => {
  const saved = state(); const result = sourceCard(saved);
  assert.equal(result.matches[0].apiosk[0].name, 'Official register');
  assert.equal(result.matches[0].coinbase[0].api_id, 'bazaar:source');
  assert.equal(result.matches[0].coinbase[0].availability, 'discovery_only');
  assert.equal(result.source_options[0].source.endpoint_id, 'registry');
  assert.equal(result.matches[0].coinbase_status, 'complete');
});

test('offered-source logos use descriptor metadata and the fixed image CSP without reclassifying matches', async () => {
  const saved = state(); saved.discovery.source_options[0].endpoint.source = { logo_url: 'https://app.apiosk.com/brands/sirenic.png' };
  const result = sourceCard(saved);
  assert.equal(result.source_options[0].source.logo_url, 'https://app.apiosk.com/brands/sirenic.png');
  assert.equal(saved.discovery.source_options[0].source.logo_url, undefined);
  assert.equal(result.matches[0].slug, saved.discovery.searches.apiosk.matches[0].slug);
  assert.equal(result.matches[0].apiosk[0].capability, saved.discovery.searches.apiosk.matches[0].apiosk[0].capability);
  const resources = await fixture(saved).wrapped.listResources();
  assert.ok(resources[0]._meta.ui.csp.resourceDomains.includes('https://app.apiosk.com'));
  assert.ok(!resources[0]._meta.ui.csp.resourceDomains.includes('*'));
});

test('source selections and mixed baskets prepare one request without approving', async () => {
  const f = fixture();
  const result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'prepare_basket', args: { selections: [selection], external: [{ api_id: 'bazaar:source', input: { company: 'ASML' } }] } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.calls, [{ name: 'apiosk_prepare', args: { request_id: 'request1', mode: 'sources', selections: [
    { source_id: 'local1', input: { company: 'ASML' } }, { source_id: 'external1', input: { company: 'ASML' } },
  ] } }]);
});

test('offer-only sources are selectable through their exact saved source identity', async () => {
  const saved = state(); saved.discovery.searches.apiosk.matches[0].apiosk = [];
  const f = fixture(saved);
  const result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'apiosk_ask', args: { question: saved.question, input: { apiosk_source_selection_v1: { selections: [selection] } } } });
  assert.equal(result.isError, undefined);
  assert.equal(f.calls[0].args.selections[0].source_id, 'local1');
});

test('changed subjects, ambiguous duplicates and unknown requests are rejected before calling core', async () => {
  const f = fixture();
  let result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'prepare_basket', args: { selections: [{ ...selection, subject_id: 'other-company' }] } });
  assert.equal(result.isError, true);
  f.saved.sources.push({ ...local, id: 'duplicate', input_values: { company: 'Other' } });
  result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'prepare_basket', args: { selections: [{ ...selection, input: { company: 'Edited unbound company' } }] } });
  assert.equal(result.isError, true);
  result = await f.run(CARD_READ_TOOL, { request_id: 'unrelated', operation: 'status_basket', args: {} });
  assert.equal(result.isError, true);
  assert.equal(f.calls.length, 0);
});

test('approval uses exactly one current combined core approval and cannot enter via the read dispatcher', async () => {
  const f = fixture(state({ tasks: [endpointTask(), endpointTask('task2')], active_task_ids: ['task1', 'task2'], approval: { approval_id: 'total1', currency: 'USD', max_total_atomic: '20000' } }));
  assert.equal(presentCard(f.saved).view, 'source_basket');
  let result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'approve_basket', args: {} });
  assert.equal(result.isError, true); assert.equal(f.calls.length, 0);
  result = await f.run(CARD_APPROVE_TOOL, { request_id: 'request1', operation: 'approve_basket', args: {}, approval: f.saved.approval });
  assert.equal(result.isError, undefined);
  assert.deepEqual(f.calls, [{ name: 'apiosk_approve', args: { request_id: 'request1', approval_id: 'total1', currency: 'USD', max_total_atomic: '20000', confirm: true } }]);
  result = await f.run(CARD_APPROVE_TOOL, { request_id: 'request1', operation: 'apiosk_approve', args: { state: { state_ref: 'task1' }, quote_ref: 'quote-task1', max_total_atomic: '10000' }, approval: f.saved.approval });
  assert.equal(result.isError, true); assert.equal(f.calls.length, 1);
});

test('card can inspect external inputs freely and only resume a previously approved action', async () => {
  const f = fixture(state({ tasks: [endpointTask()], active_task_ids: ['task1'] }));
  let result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'apiosk_external', args: { action: 'source', api_id: 'bazaar:source' } });
  assert.equal(result._meta.apiosk_card_data.view, 'external_source');
  assert.deepEqual(result._meta.apiosk_card_data.source.inputs, []);
  const args = { request_id: 'request1', operation: 'apiosk_execute', args: { state: { state_ref: 'task1' }, action_id: 'execute-task1' } };
  result = await f.run(CARD_READ_TOOL, args); assert.equal(result.isError, true);
  f.saved.tasks[0].approval_attempt = { status: 'response_received' };
  result = await f.run(CARD_READ_TOOL, args); assert.equal(result.isError, undefined);
  assert.deepEqual(f.calls.at(-1), { name: 'apiosk_status', args: { request_id: 'request1', recover: true } });
});

test('saved result pagination maps to a free read, preserving full saved evidence', async () => {
  const task = endpointTask(); task.view.next_actions = [{ action_id: 'evidence1', kind: 'read_result', requires_authorization: false }];
  task.view.result = { result_ref: 'evidence1', data: { company: 'ASML', source_record: 'saved' } };
  const f = fixture(state({ tasks: [task], active_task_ids: ['task1'] }));
  const result = await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'apiosk_execute', args: { state: { state_ref: 'task1' }, action_id: 'evidence1', input: { offset: 8000 } } });
  assert.deepEqual(f.calls[0], { name: 'apiosk_result_page', args: { request_id: 'request1', task_id: 'task1', action_id: 'evidence1', offset: 8000 } });
  assert.equal(result._meta.apiosk_card_data.result.data.source_record, 'saved');
});

test('model source inspection retains schemas and result reads retain actual saved values', async () => {
  const f = fixture(state({ tasks: [endpointTask()], active_task_ids: ['task1'], result_presentation: {
    analysis: { summary: 'Saved answer' }, blocks: [{ type: 'table', rows: [['ASML', 'active']] }], tables: [{ rows: [['ASML', 'active']] }],
    evidence: [{ source: 'Official register', value: 'active' }], results: [{ data: { company: 'ASML', state: 'active' } }],
    coverage: { requirements: [{ status: 'verified' }] }, selected_view: { rows: [['ASML']] }, task_presentations: [{ raw: 'duplicate' }],
  } }));
  const source = await f.run('apiosk_sources', { request_id: 'request1', source_id: 'external1' });
  assert.equal(source.structuredContent.descriptor.total_atomic, '25000');
  const result = await f.run('apiosk_result', { request_id: 'request1', task_id: 'task1', format: 'view' });
  assert.equal(result.structuredContent.results[0].data.company, 'ASML');
  assert.equal(result.structuredContent.evidence[0].value, 'active');
  assert.deepEqual(result.structuredContent.selected_view.rows, [['ASML']]);
  assert.equal(result.structuredContent.raw, undefined);
  assert.equal(result.structuredContent.task_presentations, undefined);
});

test('legacy apis discovery cannot silently render an empty card', () => {
  const saved = state({ discovery: { apis: [local, external], searches: { apiosk: { matches: [] } } } });
  const card = sourceCard(saved);
  assert.equal(card.matches.reduce((sum, match) => sum + match.apiosk.length + match.coinbase.length, 0), 2);
  assert.equal(card.source_options, undefined);
});

test('interrupted preparation displays the missing price and retries the saved selection without buying', async () => {
  const f = fixture(state({ tasks: [endpointTask()], active_task_ids: ['task1'], mode: 'sources',
    pending_prepare: { request_id: 'retry1', calls: { local: 'saved-prepare1' } }, requested_selection: [{ source_id: 'local1', input: { company: 'ASML' } }] }));
  const card = presentCard(f.saved);
  assert.equal(card.view, 'source_basket'); assert.equal(card.entries.length, 2);
  assert.equal(card.entries[0].response.proposal.approval_url, null);
  assert.equal(card.entries[1].response, undefined);
  await f.run(CARD_READ_TOOL, { request_id: 'request1', operation: 'retry_preparation', args: {} });
  assert.deepEqual(f.calls, [{ name: 'apiosk_prepare', args: { request_id: 'request1', mode: 'sources', selections: f.saved.requested_selection } }]);
});
