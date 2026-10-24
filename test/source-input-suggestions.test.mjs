import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suggestSourceInputs } from '../src/source-input-suggestions.mjs';
import { createAskService } from '../src/service.mjs';
import { StateStore } from '../src/store.mjs';
import { sourceCard } from '../src/card-adapter.mjs';
import { createCardHtml } from '../src/card-ui.mjs';
import { JSDOM, VirtualConsole } from 'jsdom';

// The published TradePulse descriptor and parsed identifier spelling from the
// reported Mollie request, with unrelated request/account data omitted.
const entity = 'source_input.e25c5f48c43d84d9a980ea9fcb9c7fec2.entity';
const field = (name, schema = { type: 'string', ...(name === entity ? { description: 'Company or individual name to screen' } : {}) }) => ({ field: name, required: true, schema });
const parsed = { subjects: [{ id: 'mollie', type: 'company', label: 'Mollie B.V.', identifiers: { kvk_number: '30204462' } },
  { id: 'person', type: 'person', label: 'Jane Example', identifiers: {} }], capabilities: [{ slug: 'company.sanctions', subject_id: 'mollie' }] };

test('source-specific Entity gets the matched company name; person names and identifiers remain separate', () => {
  const descriptor = { inputs: [field(entity), field('person.name'), field('company_registry.kvknummer'), field('company.watchlist_entity_id')] };
  assert.deepEqual(suggestSourceInputs({ subject_id: 'mollie' }, descriptor, parsed), { [entity]: 'Mollie B.V.', 'company_registry.kvknummer': '30204462' });
  assert.deepEqual(suggestSourceInputs({ subject_id: 'person' }, descriptor, parsed), { [entity]: 'Jane Example', 'person.name': 'Jane Example' });
  assert.deepEqual(suggestSourceInputs({}, descriptor, parsed), {}, 'multiple subjects require the selected row identity');
  assert.deepEqual(suggestSourceInputs({ subject_id: 'missing' }, descriptor, parsed), {});
  assert.deepEqual(suggestSourceInputs({ subject_id: 'mollie' }, { inputs: [field(entity), field(entity.replace(/entity$/, 'country'))] },
    { subjects: [{ ...parsed.subjects[0], identifiers: { country: 'NL' } }] }), { [entity]: 'Mollie B.V.' }, 'a company country must not become a provider-specific country-to-screen filter');
});

test('lookup uses a known company name without inventing the missing registry number', () => {
  const descriptor = { inputs: [field('company_registry.kvknummer')], lookup: { field: 'company.name', resolves: ['company_registry.kvknummer'], schema: { type: 'string' } } };
  const noId = { subjects: [{ id: 'company', type: 'company', label: 'Example B.V.', identifiers: {} }] };
  assert.deepEqual(suggestSourceInputs({ subject_id: 'company' }, descriptor, noId), { 'company.name': 'Example B.V.' });
  assert.deepEqual(suggestSourceInputs({ subject_id: 'mollie' }, descriptor, parsed), { 'company_registry.kvknummer': '30204462', 'company.name': 'Mollie B.V.' });
});

test('canonical values and deliberate blanks win; only descriptor-accepted defaults are returned', () => {
  const source = { subject_id: 'mollie', endpoint: { input_values: { [entity]: 'Previous value', unused: 'not an input' } }, input_values: { [entity]: '' } };
  assert.deepEqual(suggestSourceInputs(source, { inputs: [field(entity)] }, parsed), { [entity]: '' });
  assert.equal(source.endpoint.input_values[entity], 'Previous value');
  assert.deepEqual(suggestSourceInputs({ subject_id: 'mollie', input_values: { 'company.name': 'Mollie registered name' } }, { inputs: [field(entity)] }, parsed), { [entity]: 'Mollie registered name' });
});

test('prefill does not cross generic IDs, schema types, enums, or patterns and never applies defaults', () => {
  const descriptor = { inputs: [field('company.id'), field('entity', { type: 'object' }), field('company.name', { enum: ['Other'] }),
    field('company_registry.kvknummer', { type: 'string', pattern: '^ABC' }), field('limit', { type: 'integer', default: 10 })] };
  assert.deepEqual(suggestSourceInputs({ subject_id: 'mollie' }, descriptor, { subjects: [{ ...parsed.subjects[0], identifiers: { id: 'unrelated-id', 'company_registry.kvknummer': '30204462' } }] }), {});
  assert.deepEqual(suggestSourceInputs({ subject_id: 'mollie' }, { inputs: [field(entity)] }, { subjects: [parsed.subjects[0], parsed.subjects[0]] }), {});
});

test('inspection, inline cards and preparation reuse the same input while explicit edits and blanks remain authoritative', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'apiosk-prefill-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new StateStore({ directory, scope: 'prefill-test' }), calls = [];
  const descriptor = { endpoint_id: 'screen', capability: 'company.sanctions', inputs: [field(entity)], source: { name: 'TradePulse', slug: 'tradepulse' }, price: { currency: 'USD', buyer_atomic: '70000' } };
  const candidate = { origin: 'apiosk', name: 'TradePulse', source_slug: 'tradepulse', availability: 'supported', subject_id: 'mollie', endpoint_id: 'screen', capability: 'company.sanctions',
    input_values: {}, endpoint: { ...descriptor, input_values: {} } };
  const discovery = { search_id: 'search', parsed_request: parsed, searches: { apiosk: { matches: [{ slug: 'company.sanctions', subject_id: 'mollie', apiosk: [candidate], coinbase: [] }] } } };
  const gateway = { credentialKind: 'connection', async request(path, options = {}) {
    calls.push({ path, body: options.body });
    if (path === '/v2/ask/page') return structuredClone(discovery);
    if (path.startsWith('/v2/ask-v2/endpoints/')) return structuredClone(descriptor);
    if (path === '/v2/ask/source/prepare') return { status: 'ready', state: { state_ref: 'task', revision: 1 },
      proposal: { quote_ref: 'quote', currency: 'USD', max_total_atomic: '70000', expires_at: '2099-01-01' }, next_actions: [], context_view: {}, billing: {} };
    throw new Error(`Unexpected call: ${path}`);
  } };
  const service = createAskService({ gateway, store });
  const invoke = (name, args) => service.tools.find(tool => tool.name === name).handler(args);
  const asked = await invoke('apiosk_ask', { question: 'Screen Mollie B.V. against sanctions.' });
  assert.equal(asked.isError, undefined);
  const request_id = asked.structuredContent.request_id, state = await store.get(request_id), source_id = state.sources[0].id;
  const inspected = await invoke('apiosk_sources', { request_id, source_id });
  assert.deepEqual(inspected.structuredContent.suggested_input, { [entity]: 'Mollie B.V.' });
  assert.deepEqual(sourceCard(state).source_rows[0].endpoint.input_values, { [entity]: 'Mollie B.V.' });
  assert.equal(sourceCard(state).source_rows[0].id, source_id);
  assert.deepEqual(state.sources[0].input_values, {}, 'projection leaves saved discovery untouched');
  for (const [input, expected] of [[{}, 'Mollie B.V.'], [{ [entity]: '' }, ''], [{ [entity]: 'Edited name' }, 'Edited name']]) {
    const replay = sourceCard({ ...state, selected: [{ source_id, input }] });
    assert.equal(replay.selected_sources[0].input[entity], expected, 'replay fills only absent values, preserving explicit edits and blanks');
  }
  const dom = new JSDOM(createCardHtml('https://api.apiosk.com'), { url: 'https://mcp.apiosk.com/card', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.openai = { toolOutput: sourceCard(state), setWidgetState() {}, callTool: async () => { throw new Error('No source call expected while opening the form'); } };
    },
  });
  try {
    await new Promise(resolve => setTimeout(resolve, 200));
    const shadow = dom.window.document.querySelector('.ask-page-mount').shadowRoot;
    shadow.querySelector('input[type=checkbox]').closest('tr').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(shadow.querySelector('form[data-purchase-inputs] input').value, 'Mollie B.V.', 'the actual embedded form receives the suggestion');
  } finally { dom.window.close(); }
  await invoke('apiosk_prepare', { request_id, selections: [{ source_id }] });
  assert.deepEqual(calls.find(call => call.path === '/v2/ask/source/prepare').body.input, { [entity]: 'Mollie B.V.' });
  await invoke('apiosk_prepare', { request_id, selections: [{ source_id, input: { [entity]: 'Edited name' } }] });
  assert.deepEqual(calls.filter(call => call.path === '/v2/ask/source/prepare').at(-1).body.input, { [entity]: 'Edited name' });
  const before = calls.filter(call => call.path === '/v2/ask/source/prepare').length;
  const blank = await invoke('apiosk_prepare', { request_id, selections: [{ source_id, input: { [entity]: '' } }] });
  assert.equal(blank.structuredContent.status, 'needs_input');
  assert.equal(calls.filter(call => call.path === '/v2/ask/source/prepare').length, before);
  const unknown = await invoke('apiosk_prepare', { request_id, selections: [{ source_id, input: { unexpected: 'not accepted' } }] });
  assert.equal(unknown.structuredContent.status, 'needs_input');
  assert.ok(unknown.structuredContent.input_requirements[0].errors.some(error => error.code === 'unknown_input'));
  assert.ok(calls.every(call => !/authorize|approve/.test(call.path)), 'prefill and preparation never purchase a source');
});
