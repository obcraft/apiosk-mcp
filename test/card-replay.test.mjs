import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { cardHarness, flatten, flush, plain } from './helpers/card-harness.mjs';
import { gatewayV2CardHtml } from '../src/ask-ui/gateway-v2-card.mjs';
import { createCardHtml, createLegacyCardHtml, CARD_READ_TOOL, CARD_APPROVE_TOOL } from '../src/card-ui.mjs';
import { presentSearch } from '../src/ask-ui/gateway-v2-ask.mjs';
import { withEmbeddedCards, presentCard, decorateTaskView } from '../src/card-adapter.mjs';

// Recorded MCP1 result fixtures copied unchanged from its retained snapshot.
const fixtures = await Promise.all(['cbs-annual-ui', 'uk-supplier-ui'].map(async name => ({ name,
  view: JSON.parse(await readFile(new URL(`fixtures/${name}.json`, import.meta.url))),
})));
const buttons = h => h.nodes.get('sections').querySelectorAll('button');
const button = (h, label) => buttons(h).find(button => button.textContent === label);
const texts = h => flatten(h.nodes.get('sections')).filter(Boolean);
const wrap = view => ({ id: 'request1', type: 'ask', question: view.context_view?.conversation?.at(-1)?.question || 'Saved company check',
  status: view.status, mode: 'sources', tasks: [{ id: view.state.state_ref, kind: 'endpoint', view }], active_task_ids: [view.state.state_ref], sources: [], selected: [] });
const quote = () => ({ protocol_version: '2', status: 'ready', state: { state_ref: 'task1', revision: 1 }, errors: [],
  proposal: { quote_ref: 'quote1', currency: 'USD', max_total_atomic: '40000', expires_at: '2099-01-01', approval_url: 'https://app.apiosk.com/approve', steps: ['company.profile'], step_details: [{ title: 'Company profile', source: { name: 'Register' } }] },
  billing: { authorization_active: false, quote_ref: 'quote1', currency: 'USD', total_charged: '0' },
  context_view: { execution_mode: 'server', approval_mode: 'chatbot', execution_enabled: true, worker_active: false },
  next_actions: [{ action_id: 'run1', kind: 'execute_quoted_step' }, { action_id: 'cancel1', kind: 'cancel', requires_authorization: false }] });

async function mount(kind, saved, onCall = () => {}, hostOptions = {}) {
  const calls = [], coreNames = ['apiosk_status', 'apiosk_prepare', 'apiosk_approve', 'apiosk_continue', 'apiosk_requote', 'apiosk_follow_up', 'apiosk_result_page'];
  const wrapped = withEmbeddedCards({ instructions: 'Use apiosk_ask', tools: coreNames.map(name => ({ name, handler: async args => {
    calls.push({ name, args: plain(args) }); await onCall(name, args, saved);
    return { structuredContent: { request_id: saved.id, raw: saved }, content: [{ type: 'text', text: 'Saved response' }] };
  } })), listResources: async () => [], readResource: async () => { throw new Error('Unknown resource'); } },
  { store: { get: async id => id === saved.id ? saved : null }, gateway: { baseUrl: 'https://api.apiosk.com' } });
  const initial = { structuredContent: { request_id: saved.id, view: 'task' }, _meta: { apiosk_card_data: presentCard(saved, undefined, 'https://api.apiosk.com') } };
  const call = (name, args) => wrapped.tools.find(tool => tool.name === name).handler(plain(args), {});
  const h = cardHarness(createCardHtml('https://api.apiosk.com'), kind === 'skybridge' ? {
    toolOutput: initial.structuredContent, toolResponseMetadata: initial._meta, callTool: call, setWidgetState() {}, ...hostOptions,
  } : null);
  const handled = new Set();
  async function pump() {
    for (let round = 0; round < 8; round++) {
      await flush();
      for (const message of h.sent.filter(message => message.id && !handled.has(message.id))) {
        if (!['tools/call', 'ui/update-model-context'].includes(message.method)) continue;
        handled.add(message.id);
        const result = message.method === 'tools/call' ? await call(message.params.name, message.params.arguments) : {};
        await h.message({ jsonrpc: '2.0', id: message.id, result });
      }
    }
  }
  if (kind === 'mcp-apps') { await h.initialize('Claude'); await h.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: initial }); }
  await pump();
  async function click(target) { const pending = target.onclick(); await pump(); await pending; await pump(); }
  return { h, calls, wrapped, pump, click };
}

for (const kind of ['skybridge', 'mcp-apps']) for (const fixture of fixtures) {
  test(`${kind}: recorded ${fixture.name} renders the same answer, source values and collapsed details as MCP1`, async () => {
    const view = { status: 'succeeded', state: { state_ref: 'cbs-task', revision: 1 }, next_actions: [], errors: [], ...structuredClone(fixture.view) };
    const legacy = cardHarness(gatewayV2CardHtml('https://api.apiosk.com'), { toolOutput: view, callTool: async () => ({ structuredContent: view }) });
    await flush();
    const saved = wrap(view), before = JSON.stringify(saved), client = await mount(kind, saved);
    assert.deepEqual(texts(client.h), texts(legacy));
    assert.equal(client.h.nodes.get('title').textContent, legacy.nodes.get('title').textContent);
    assert.equal(JSON.stringify(saved), before, 'display never modifies saved evidence');
    const details = client.h.nodes.get('sections').querySelectorAll('details');
    assert.ok(details.length); assert.ok(details.every(detail => !detail.open));
    assert.ok(client.calls.every(call => call.name === 'apiosk_status'), 'mount only reads saved status');
    for (const detail of details) { detail.open = true; detail.ontoggle?.(); }
    assert.ok(client.calls.every(call => call.name === 'apiosk_status'), 'opening evidence never buys');
  });
}

for (const kind of ['skybridge', 'mcp-apps']) test(`${kind}: restored source inputs, explicit approval and cancel use the new saved request`, async () => {
  const saved = wrap(quote());
  saved.approval = { approval_id: 'total1', currency: 'USD', max_total_atomic: '40000' };
  saved.sources = [{ id: 'source1', origin: 'apiosk', name: 'Register', endpoint_id: 'registry', capability: 'company.profile', subject_id: 's1', input_values: { 'company.name': 'ACME' } }];
  saved.selected = [{ source_id: 'source1', input: { 'company.name': 'ACME edited' } }];
  saved.discovery = { search_id: 'search1', parsed_request: { subjects: [{ id: 's1', label: 'ACME' }], capabilities: [{ slug: 'company.profile', subject_id: 's1' }] },
    searches: { apiosk: { matches: [{ slug: 'company.profile', subject_id: 's1', apiosk: [{ ...saved.sources[0], availability: 'supported' }] }] } },
    source_options: [{ subject_id: 's1', source: { ...saved.sources[0], availability: 'supported' }, endpoint: { endpoint_id: 'registry', capability: 'company.profile', inputs: [{ field: 'company.name', required: true, schema: { type: 'string' } }], input_values: { 'company.name': 'ACME' } } }] };
  let client = await mount(kind, saved);
  assert.ok(button(client.h, 'Change sources'), 'a restored quote retains its original source chooser');
  await client.click(button(client.h, 'Change sources'));
  assert.equal(client.h.nodes.get('sections').querySelector('.source-input').value, 'ACME edited');
  assert.ok(client.calls.every(call => call.name === 'apiosk_status'));
  client = await mount(kind, saved, (name, _args, state) => {
    if (name === 'apiosk_approve') { state.tasks[0].approval_attempt = { status: 'response_received' }; state.tasks[0].view.billing.authorization_active = true; }
    if (name === 'apiosk_continue') { state.tasks[0].view.status = 'cancelled'; state.tasks[0].view.next_actions = []; }
  });
  const approve = buttons(client.h).find(button => button.textContent.startsWith('Approve up to'));
  assert.ok(approve); await client.click(approve);
  assert.deepEqual(client.calls.find(call => call.name === 'apiosk_approve').args, { request_id: 'request1', approval_id: 'total1', currency: 'USD', max_total_atomic: '40000', confirm: true });
  await client.click(button(client.h, 'Cancel request'));
  assert.deepEqual(client.calls.find(call => call.name === 'apiosk_continue').args, { request_id: 'request1', task_id: 'task1', action_id: 'cancel1', input: null });
});

test('expired prices retain task context and refresh without approval', async () => {
  const saved = wrap(quote()); saved.tasks[0].view.proposal.expires_at = '2001-01-01';
  saved.approval = { approval_id: 'total1', currency: 'USD', max_total_atomic: '40000' };
  const client = await mount('skybridge', saved, name => {
    if (name === 'apiosk_requote') saved.tasks[0].view.proposal = { ...saved.tasks[0].view.proposal, expires_at: '2099-01-01', quote_ref: 'quote2' };
  });
  await client.click(button(client.h, 'Get new price'));
  assert.ok(client.calls.some(call => call.name === 'apiosk_requote'));
  assert.ok(client.calls.every(call => ['apiosk_status', 'apiosk_requote'].includes(call.name)));
  assert.ok(buttons(client.h).some(button => button.textContent.startsWith('Approve up to')));
});

test('follow-up clarification retains the original input component and sends only the person’s answer', async () => {
  const saved = wrap(quote()); saved.follow_up_clarification = { question: 'Compare the saved figures', message: 'Which reporting year?' };
  const client = await mount('skybridge', saved, name => { if (name === 'apiosk_follow_up') delete saved.follow_up_clarification; });
  const form = client.h.nodes.get('sections').querySelector('form');
  assert.ok(form); await client.h.change(form.querySelector('input'), '2024');
  const pending = form.onsubmit({ preventDefault() {} }); await client.pump(); await pending;
  assert.deepEqual(client.calls.find(call => call.name === 'apiosk_follow_up').args, { request_id: 'request1', question: '2024' });
});

test('signed PDF/evidence downloads and events are decorated without changing saved records', () => {
  const view = { state: { state_ref: 'abc-123' }, context_view: { events_path: '/v2/tasks/abc-123/events?token=signed-fixture',
    report: { format: 'pdf', download_path: '/v2/tasks/abc-123/reports/def-456/report.pdf?token=signed-fixture', evidence_download_path: '/v2/tasks/abc-123/reports/def-456/evidence.zip?token=signed-fixture' } } };
  const next = decorateTaskView(view, 'https://api.apiosk.com');
  assert.equal(next.context_view.report.url, 'https://api.apiosk.com' + view.context_view.report.download_path);
  assert.equal(next.context_view.report.evidence_url, 'https://api.apiosk.com' + view.context_view.report.evidence_download_path);
  assert.equal(next.context_view.events_url, 'https://api.apiosk.com' + view.context_view.events_path);
  assert.equal(view.context_view.report.url, undefined);
});

test('MCP1 cached resources keep legacy actions; private tools never claim the shared output template', async () => {
  const { wrapped } = await mount('skybridge', wrap(quote()));
  for (const name of [CARD_READ_TOOL, CARD_APPROVE_TOOL]) {
    const meta = wrapped.tools.find(tool => tool.name === name)._meta;
    assert.equal(meta['openai/outputTemplate'], undefined); assert.equal(meta.ui.resourceUri, undefined);
    assert.equal(meta['openai/widgetAccessible'], true);
  }
  const legacy = (await wrapped.readResource('ui://apiosk/gateway-v2-card-v66.html')).contents[0];
  assert.equal(legacy.mimeType, 'text/html;profile=mcp-app');
  assert.ok(!legacy.text.includes('mcp2OriginalCall'));
  assert.ok(legacy.text.includes('toolResponseMetadata?.apiosk_card_data'));
  const guide = (await wrapped.readResource('apiosk://v2/host-contract')).contents[0];
  assert.equal(guide.text, 'Use apiosk_ask');
  const previous = (await wrapped.readResource('ui://apiosk/mcp-2-ask-v1.html')).contents[0];
  assert.ok(previous.text.includes('mcp2OriginalCall'), 'the previous MCP2 resource retains its saved-request dispatcher');
  assert.ok(!previous.text.includes('About these results'));
});

test('cards hide host protocol notices while retaining source scope, pricing, recovery and saved evidence', async () => {
  const source = { origin: 'apiosk', name: 'Official register', endpoint_id: 'registry', capability: 'company.profile', availability: 'supported',
    description: 'Registered company information; ownership is not included.', price: '0.01',
    endpoint: { endpoint_id: 'registry', capability: 'company.profile', inputs: [], price: { currency: 'USD', buyer_atomic: '10000' } } };
  const search = presentSearch({ search_id: 'search1', parsed_request: { subjects: [{ id: 's1', label: 'ACME' }], capabilities: [{ slug: 'company.profile', subject_id: 's1' }] },
    source_options: [{ source, subject_id: 's1' }], searches: { apiosk: { matches: [{ slug: 'company.profile', subject_id: 's1', apiosk: [source] }] } } }, 'Show ACME');
  assert.match(search.notice, /input\.apiosk_source_selection_v1/);
  search.message = 'Some sources could not be searched. Try again shortly.';
  const views = [
    { data: search, keep: ['Registered company information; ownership is not included.', search.message, 'Review selected sources'] },
    { data: { view: 'conversation', kind: 'clarification', question: 'Which company?', message: 'Which country is the company registered in?', notice: 'Continue with task_refs and call apiosk_ask.' },
      keep: ['Which country is the company registered in?'] },
    { data: { view: 'external_source', api_id: 'bazaar:fixture', source: { name: 'External records', inputs: [], total_atomic: 10000 }, notice: 'Use apiosk_external action prepare with api_id.' },
      keep: ['Source inputs', 'Review price'] },
    { data: { view: 'external_purchase', purchase_id: 'purchase1', status: 'succeeded', source: { name: 'External records' },
      quote: { quote_ref: 'quote1', currency: 'USD', max_total_atomic: '10000' }, result_present: true, result_truncated: true,
      result: { company: 'ACME' }, notice: 'Call apiosk_external with purchase_id to recover this result.' },
      keep: ['Check status', 'Full saved source data', 'This saved result is truncated; it does not contain every source record.'] },
  ];
  for (const html of [createCardHtml(), createLegacyCardHtml()]) for (const { data, keep } of views) {
    const before = JSON.stringify(data), h = cardHarness(html, { toolOutput: data, callTool: async () => ({ structuredContent: data }) });
    await flush();
    const rendered = texts(h);
    assert.ok(!rendered.includes(data.notice));
    assert.ok(!rendered.some(text => /About these results|About this source|About this purchase|apiosk_source_selection_v1|task_refs|purchase_id|apiosk_external/.test(text)));
    for (const text of keep) assert.ok(rendered.includes(text), `Keep useful buyer information: ${text}`);
    assert.equal(JSON.stringify(data), before, 'raw protocol guidance stays available to the host');
  }
});

test('table pagination, filters and column controls stay local and keep source evidence intact', async () => {
  const view = { status: 'succeeded', state: { state_ref: 'table-task', revision: 1 }, next_actions: [], context_view: {
    analysis: { status: 'completed', answer_schema_version: 2, observations: [], source_index: [{ result_ref: 'source1', name: 'Official source' }], blocks: [{
      kind: 'data_table', title: 'Companies', columns: [{ id: 'company', label: 'Company' }, { id: 'employees', label: 'Employees' }],
      rows: Array.from({ length: 25 }, (_, index) => ({ cells: [{ value: `Company ${index + 1}`, result_ref: 'source1', pointer: `/data/${index}/name` }, { value: index + 1 }] })),
      coverage: { selected: 25, fetched: 25, total_available: 30 },
    }] }, results: [{ result_ref: 'source1', source: { name: 'Official source' }, data: { count: 25 } }],
  } };
  const saved = wrap(view), before = JSON.stringify(saved), client = await mount('skybridge', saved), baseCalls = client.calls.length;
  const region = () => client.h.nodes.get('sections').querySelector('.block-table');
  assert.equal(region().querySelectorAll('tr').length, 21);
  await client.click(buttons(client.h).find(button => button.textContent.startsWith('Show more rows')));
  assert.equal(region().querySelectorAll('tr').length, 26);
  await client.h.change(client.h.nodes.get('sections').querySelector('.block-filter'), 'Company 25');
  assert.equal(region().querySelectorAll('tr').length, 2);
  assert.ok(texts(client.h).some(text => text.includes('Official source · /data/24/name')));
  const toggles = client.h.nodes.get('sections').querySelector('.block-columns').querySelectorAll('input');
  await client.h.change(toggles[1], false);
  assert.equal(region().querySelectorAll('th').length, 1);
  assert.equal(client.calls.length, baseCalls);
  assert.equal(JSON.stringify(saved), before);
});

test('PDF and evidence controls open the existing signed exports without execution', async () => {
  const view = { status: 'succeeded', state: { state_ref: 'abc-123', revision: 1 }, next_actions: [], context_view: {
    conversation: [{ question: 'Give me the PDF dossier' }], report: { format: 'pdf', download_path: '/v2/tasks/abc-123/reports/def-456/report.pdf?token=fixture', evidence_download_path: '/v2/tasks/abc-123/reports/def-456/evidence.zip?token=fixture' },
    results: [{ result_ref: 'source1', source: { name: 'Official source' }, data: { name: 'ACME' } }],
  } };
  const opened = [], client = await mount('skybridge', wrap(view), () => {}, { openExternal: value => opened.push(value.href) }), before = client.calls.length;
  await client.click(button(client.h, 'Download PDF')); await client.click(button(client.h, 'Download evidence'));
  assert.deepEqual(opened, ['https://api.apiosk.com' + view.context_view.report.download_path, 'https://api.apiosk.com' + view.context_view.report.evidence_download_path]);
  assert.equal(client.calls.length, before);
});

test('live events refresh the saved journal before exposing new action IDs', async () => {
  const streams = [];
  class EventSource {
    constructor(url) { this.url = url; this.listeners = new Map(); streams.push(this); }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    close() { this.closed = true; }
  }
  const initial = quote(); initial.status = 'running'; initial.context_view.events_path = '/v2/tasks/task1/events?token=fixture';
  initial.context_view.worker_active = true; initial.billing.authorization_active = true;
  const saved = wrap(initial); saved.tasks[0].approval_attempt = { status: 'response_received' };
  let next;
  const client = await mount('skybridge', saved, name => { if (name === 'apiosk_status' && next) saved.tasks[0].view = next; }, { EventSource });
  assert.equal(streams.length, 1);
  const unchangedCalls = client.calls.length;
  streams[0].listeners.get('task')({ data: JSON.stringify(initial) }); await client.pump();
  assert.equal(client.calls.length, unchangedCalls, 'an unchanged SSE initial snapshot cannot create a status/reconnect loop');
  next = { ...initial, state: { state_ref: 'task1', revision: 2 }, status: 'needs_input', next_actions: [{ action_id: 'input2', kind: 'supply_input', label: 'Provide company.name', input_schema: { properties: { value: { type: 'string' } } } }], context_view: { worker_active: false } };
  const before = client.calls.length;
  streams[0].listeners.get('task')({ data: JSON.stringify(next) }); await client.pump();
  assert.equal(client.calls.length, before + 1);
  assert.equal(client.calls.at(-1).name, 'apiosk_status');
  assert.equal(saved.tasks[0].view.state.revision, 2);
  assert.ok(client.h.nodes.get('sections').querySelector('form'));
  assert.ok(streams[0].closed);
});
