import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM, VirtualConsole } from 'jsdom';
import { createCardHtml } from '../src/card-ui.mjs';
import { readFile } from 'node:fs/promises';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const fixture = () => {
  const rows = ['KVK Business Register', 'KVK Business Register', 'Overheid.io Public Data', 'Overheid.io Public Data', 'Sirenic', 'Sirenic', 'OpenSanctions', 'CompliancePulse', 'TradePulse'].map((name, index) => ({
    source_id: 'source-' + index, name, source_slug: name, origin: 'apiosk', availability: 'supported',
    subject_id: 'mollie', subject_label: 'Mollie B.V.', endpoint_id: 'endpoint-' + index, capability: 'company.profile',
    price: index === 4 ? '0.001 USD' : '0.076087 USD', description: `Retrieve the official registration record ${index + 1} for a company from a national business register. Additional details.`,
    endpoint: { endpoint_id: 'endpoint-' + index, capability: 'company.profile', input_values: { 'company.name': 'Mollie B.V.' },
      inputs: [{ field: 'company.name', required: true, schema: { type: 'string' } }], price: { currency: 'USD', buyer_atomic: index === 4 ? '1000' : '76087' }, source: { name } },
  }));
  return { view: 'source_search', question: 'KYB check for Mollie B.V.', search_id: 'search1',
    _mcp2: { request_id: 'request1' }, source_rows: rows,
    parsed_request: { subjects: [{ id: 'mollie', label: 'Mollie B.V.' }], capabilities: [{ slug: 'company.profile', subject_id: 'mollie' }] },
    matches: [{ slug: 'company.profile', subject_id: 'mollie', apiosk: rows, coinbase: [] }],
    source_options: rows.map(source => ({ subject_id: 'mollie', source, endpoint: source.endpoint })),
    context_view: { money_display: { base_currency: 'USD', currency: 'EUR', rate: '0.92' } },
    company_context: [{ company: 'Mollie B.V.', search_url: 'https://en.wikipedia.org/w/index.php?search=Mollie', search_status: 'completed', homepage_status: 'unavailable',
      pages: Array.from({ length: 7 }, (_, index) => ({ kind: 'search_result', title: index ? 'Search result ' + index : 'Mollie', publisher: 'Mollie',
        url: `https://en.wikipedia.org/wiki/Mollie${index || ''}`, description: index ? 'Additional background page.' : 'Mollie is a financial technology group providing financial services across Europe.', search_provider: 'wikipedia' })) }],
    notice: 'Technical host instructions must stay outside the buyer card.',
  };
};

async function mount(view = fixture(), onCall) {
  const calls = [], errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(createCardHtml('https://api.apiosk.com'), { url: 'https://mcp.apiosk.com/card', runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole,
    beforeParse(window) {
      window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      window.ResizeObserver = class { observe() {} disconnect() {} };
      window.openai = { theme: 'dark', toolOutput: view, setWidgetState() {},
        callTool: async (name, args) => {
          calls.push({ name, args: JSON.parse(JSON.stringify(args)) });
          if (onCall) return { _meta: { apiosk_card_data: await onCall(name, args) } };
          return { _meta: { apiosk_card_data: { _mcp2: { request_id: 'request1' }, status: 'needs_input', state: { state_ref: 'task1', revision: 1 }, next_actions: [], errors: [] } } };
        },
      };
    },
  });
  await wait(220);
  const shadow = dom.window.document.querySelector('.ask-page-mount')?.shadowRoot;
  assert.ok(shadow, errors.map(error => error.stack).join('\n'));
  assert.equal(errors.length, 0, errors.map(error => error.stack).join('\n'));
  return { dom, shadow, calls, errors };
}

test('the literal Ask page shows background, collapsed web searches, three provider groups and exact source prices', async () => {
  const { dom, shadow, calls } = await mount();
  try {
    assert.equal(shadow.querySelector('h3').textContent, 'About Mollie B.V.');
    assert.ok(shadow.textContent.includes('Background only; identity and requested checks are still unverified.'));
    const web = shadow.querySelector('aside[aria-label="Web searches"] details');
    assert.equal(web.open, false); assert.match(web.querySelector('summary').textContent, /Web searches\s*7/);
    assert.equal(shadow.querySelectorAll('a').length, 10);
    assert.ok(shadow.querySelector('.ask-app.dark'));
    assert.equal(shadow.querySelectorAll('table[aria-label] > tbody[aria-label]').length, 3);
    assert.equal(shadow.querySelectorAll('input[type=checkbox]').length, 6);
    assert.ok(shadow.textContent.includes('9 matches · 9 available'));
    assert.ok(shadow.textContent.includes('€0.07')); assert.ok(shadow.textContent.includes('< €0.01'));
    assert.ok(!shadow.textContent.includes('Technical host instructions'));
    assert.ok(!shadow.textContent.includes('Prepare one plan'));
    assert.ok(!shadow.textContent.includes('Selected sources'));
    const showAll = [...shadow.querySelectorAll('button')].find(button => button.textContent.includes('Show all 9 results'));
    showAll.click(); await wait(20);
    assert.equal(shadow.querySelectorAll('input[type=checkbox]').length, 9);
    [...shadow.querySelectorAll('button')].find(button => button.textContent.includes('Hide sources')).click(); await wait(20);
    assert.ok(shadow.querySelector('div[hidden]'));
    assert.deepEqual(calls, [], 'display, show all and collapse never call a paid source');
  } finally { dom.window.close(); }
});

test('a restored quote keeps the Ask page and authorizes only its exact combined approval on a click', async () => {
  const search = fixture();
  search.selected_sources = [{ endpoint_id: 'endpoint-0', capability: 'company.profile', subject_id: 'mollie', input: { 'company.name': 'Mollie B.V.' } }];
  const approval = { approval_id: 'approval1', currency: 'USD', max_total_atomic: '76087' };
  const view = { status: 'ready', state: { state_ref: 'task1', revision: 1 }, _mcp2: { request_id: 'request1', approval }, errors: [],
    proposal: { quote_ref: 'quote1', currency: 'USD', max_total_atomic: '76087', expires_at: '2099-01-01', approval_url: 'https://app.apiosk.com/approve', steps: ['company.profile'], step_details: [{ title: 'Company profile', source: { name: 'KVK Business Register' }, max_total_atomic: '76087' }] },
    billing: { authorization_active: false, currency: 'USD', total_charged: '0' },
    next_actions: [{ kind: 'execute_quoted_step', action_id: 'run1' }],
    context_view: { execution_mode: 'server', approval_mode: 'chatbot', money_display: search.context_view.money_display,
      source_selection: { original_intake: search }, coverage_notices: ['Sanctions screening is not included in this purchase.'] },
  };
  const { dom, shadow, calls } = await mount(view, (name, args) => name === 'apiosk_card_approve'
    ? { ...view, status: 'running', next_actions: [], billing: { ...view.billing, authorization_active: true, quote_ref: 'quote1' } }
    : view);
  try {
    assert.equal(shadow.querySelector('h3').textContent, 'About Mollie B.V.');
    assert.ok(shadow.querySelector('form[data-purchase-inputs] input'));
    assert.ok(shadow.textContent.includes('Total €0.07'));
    assert.ok(shadow.textContent.includes('Sanctions screening is not included'));
    assert.ok(!shadow.textContent.includes('Data request'));
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
    const approve = [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Approve €0.07');
    assert.ok(approve); assert.equal(approve.disabled, false);
    approve.click(); await wait(40);
    const submitted = calls.find(call => call.name === 'apiosk_card_approve');
    assert.ok(submitted);
    assert.deepEqual(submitted.args.approval, approval);
    assert.equal(submitted.args.request_id, 'request1');
    assert.equal(submitted.args.operation, 'apiosk_approve');
    assert.equal(submitted.args.args.quote_ref, 'quote1');
  } finally { dom.window.close(); }
});

test('a compact Ask row opens the actual App inputs and automatically prepares only the saved request', async () => {
  const { dom, shadow, calls } = await mount();
  try {
    const row = shadow.querySelector('input[type=checkbox]').closest('tr');
    row.click(); await wait(30);
    const input = shadow.querySelector('form[data-purchase-inputs] input');
    assert.ok(input); assert.equal(input.value, 'Mollie B.V.');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'Mollie B.V. edited');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await wait(20);
    assert.equal(shadow.querySelector('form[data-purchase-inputs] input'), input, 'editing preserves the mounted input and focus');
    assert.ok([...shadow.querySelectorAll('button')].find(button => button.textContent === 'Approve').disabled);
    await wait(700);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'apiosk_card');
    assert.equal(calls[0].args.request_id, 'request1');
    assert.equal(calls[0].args.operation, 'apiosk_ask');
    assert.equal(calls[0].args.args.input.apiosk_source_selection_v1.selections[0].input['company.name'], 'Mollie B.V. edited');
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

test('a supported external source uses the same Ask input form and one combined free quote', async () => {
  const search = fixture(), api_id = 'bazaar:external-fixture';
  const source = { origin: 'coinbase', availability: 'supported', api_id, name: 'External Company Source', source_slug: 'external-company',
    url: 'https://data.example.com/company', method: 'GET', subject_id: 'mollie', price: '0.03 USD', description: 'Read a company profile from the published API.' };
  search.source_rows = [source]; search.source_options = [];
  search.matches = [{ subject_id: 'mollie', slug: 'company.profile', apiosk: [], coinbase: [source] }];
  const { dom, shadow, calls } = await mount(search, (_name, args) => args.operation === 'apiosk_external'
    ? { view: 'external_source', api_id, _mcp2: search._mcp2, source: { name: source.name, total_atomic: '30000', inputs: [{ field: 'company', required: true, schema: { type: 'string', title: 'Company name' } }] } }
    : { status: 'needs_input', state: { state_ref: 'task1', revision: 1 }, _mcp2: search._mcp2, next_actions: [], errors: [] });
  try {
    shadow.querySelector('input[type=checkbox]').closest('tr').click(); await wait(60);
    assert.equal(calls.length, 1); assert.equal(calls[0].args.operation, 'apiosk_external');
    const input = shadow.querySelector('form[data-purchase-inputs] input');
    assert.ok(input, 'the external descriptor uses the same App InputFieldset');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, 'Mollie B.V.');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await wait(700);
    const quote = calls.find(call => call.args.operation === 'prepare_basket');
    assert.ok(quote); assert.deepEqual(quote.args.args.external[0].input, { company: 'Mollie B.V.' });
    assert.equal(quote.args.args.external[0].api_id, api_id);
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

test('the shipped embedded card renders recorded saved evidence with the actual Ask result components', async () => {
  const recorded = JSON.parse(await readFile(new URL('./fixtures/cbs-annual-ui.json', import.meta.url)));
  const view = { ...recorded, status: 'succeeded', state: { state_ref: 'saved-cbs', revision: 1 }, _mcp2: { request_id: 'request1' }, next_actions: [], errors: [] };
  const { dom, shadow, calls, errors } = await mount(view, () => view);
  try {
    assert.equal(errors.length, 0);
    assert.ok(shadow.querySelector('table'), 'saved data has an actual table');
    assert.ok(shadow.querySelectorAll('td').length > 0, 'the compiled reader populates saved values');
    assert.ok(!shadow.textContent.includes('No available sources found'));
    assert.ok(calls.every(call => call.args.operation === 'apiosk_status'), 'opening saved evidence only reads saved status');
    const repeat = [...shadow.querySelectorAll('button')].filter(button => button.textContent === 'New purchase');
    assert.equal(repeat.length, 1, 'one request-level repeat action, never one per result');
    repeat[0].click(); await wait(30);
    const newPurchase = calls.find(call => call.args.operation === 'new_purchase');
    assert.deepEqual(newPurchase.args.args, { mode: 'repeat' });
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

test('same-request status refresh preserves expanded sources and the mounted React tree', async () => {
  const search = fixture(), { dom, shadow } = await mount(search);
  try {
    [...shadow.querySelectorAll('button')].find(button => button.textContent.includes('Show all 9 results')).click(); await wait(20);
    assert.equal(shadow.querySelectorAll('input[type=checkbox]').length, 9);
    const next = structuredClone(search);
    dom.window.openai.toolOutput = next;
    dom.window.dispatchEvent(new dom.window.CustomEvent('openai:set_globals', { detail: { globals: { toolOutput: next } } }));
    await wait(30);
    assert.equal(dom.window.document.querySelector('.ask-page-mount').shadowRoot, shadow);
    assert.equal(shadow.querySelectorAll('input[type=checkbox]').length, 9);
  } finally { dom.window.close(); }
});

test('a matched unverified native source loads its scoped descriptor without requiring source_options', async () => {
  const search = fixture(), source = { ...search.source_rows[0], availability: 'unverified' }, descriptor = source.endpoint;
  delete source.endpoint;
  search.source_rows = [source]; search.source_options = [];
  search.matches = [{ slug: source.capability, subject_id: source.subject_id, apiosk: [source], coinbase: [] }];
  const { dom, shadow, calls } = await mount(search, (_name, args) => args.operation === 'inspect_source'
    ? { view: 'source_metadata', descriptor, suggested_input: { 'company.name': 'Mollie B.V.' } }
    : { status: 'needs_input', state: { state_ref: 'task1', revision: 1 }, _mcp2: search._mcp2, next_actions: [], errors: [] });
  try {
    shadow.querySelector('input[type=checkbox]').closest('tr').click(); await wait(50);
    assert.equal(calls[0].args.operation, 'inspect_source');
    assert.deepEqual(calls[0].args.args, { source_id: source.source_id });
    assert.equal(shadow.querySelector('form[data-purchase-inputs] input').value, 'Mollie B.V.');
    await wait(700);
    assert.ok(calls.some(call => call.args.operation === 'apiosk_ask'));
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

for (const kind of ['select_entity', 'supply_input']) test(`the embedded ${kind} decision remains actionable beside saved lookup evidence`, async () => {
  const action = { action_id: 'decision1', kind, label: 'Reporting year', requires_authorization: false,
    input_schema: { type: 'object', properties: { value: { type: 'integer', minimum: 2000 } }, required: ['value'] } };
  const view = { status: kind === 'select_entity' ? 'needs_selection' : 'needs_input', state: { state_ref: 'task1', revision: 2 }, _mcp2: { request_id: 'request1' },
    result: { data: { available: true } }, errors: [], next_actions: [action], context_view: { candidates: [{ entity_ref: 'exact-entity', label: 'Mollie B.V.' }] } };
  const { dom, shadow, calls } = await mount(view, () => view);
  try {
    if (kind === 'select_entity') shadow.querySelector('button[aria-label="Select Mollie B.V."]').click();
    else {
      const input = shadow.querySelector('form input');
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(input, '2025');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); await wait(10);
      shadow.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    }
    await wait(30);
    const submitted = calls.find(call => call.args.operation === 'apiosk_execute');
    assert.ok(submitted); assert.equal(submitted.args.args.action_id, 'decision1');
    assert.deepEqual(submitted.args.args.input, kind === 'select_entity' ? { entity_ref: 'exact-entity' } : { value: 2025 });
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

for (const status of ['failed', 'cancelled', 'partial', 'succeeded']) test(`the embedded ${status} state keeps recovery and the saved purchase boundary`, async () => {
  const view = { status, state: { state_ref: 'task1', revision: 2 }, _mcp2: { request_id: 'request1' }, errors: [], next_actions: [], context_view: {} };
  const { dom, shadow, calls } = await mount(view, () => view);
  try {
    assert.ok(!shadow.textContent.includes('We couldn’t find any results'));
    assert.equal([...shadow.querySelectorAll('button')].filter(button => button.textContent === 'New purchase').length, 1);
    if (status !== 'cancelled') {
      const statusButton = [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Check saved status');
      assert.ok(statusButton); statusButton.click(); await wait(20);
    } else assert.ok(shadow.textContent.includes('stopped'));
    assert.ok(calls.every(call => call.args.operation === 'apiosk_status'));
  } finally { dom.window.close(); }
});

for (const phase of ['ready', 'expired', 'uncertain']) test(`automatic plans render the actual standalone Ask quote in ${phase} state`, async () => {
  const view = { status: 'ready', state: { state_ref: 'plan1', revision: 1 }, _mcp2: { request_id: 'request1', approval: { approval_id: 'approved-total', currency: 'USD', max_total_atomic: '76087' } },
    proposal: { quote_ref: 'plan-quote', currency: 'USD', max_total_atomic: '76087', approval_url: 'https://app.apiosk.com/approve', expires_at: phase === 'expired' ? '2000-01-01' : '2099-01-01',
      steps: ['company.profile'], step_details: [{ number: 1, kind: 'endpoint', title: 'Company profile', subject: 'Mollie B.V.', source: { name: 'KVK Business Register' }, max_total_atomic: '76087' }] },
    next_actions: [{ action_id: 'run1', kind: 'execute_quoted_step' }], errors: [], billing: { authorization_active: false },
    context_view: { execution_mode: 'server', approval_mode: 'chatbot', approval_outcome_unconfirmed: phase === 'uncertain', money_display: fixture().context_view.money_display } };
  const { dom, shadow, calls } = await mount(view, () => view);
  try {
    assert.ok(shadow.textContent.includes('KVK Business Register')); assert.ok(shadow.textContent.includes('€0.07'));
    const approve = [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Approve up to €0.07');
    if (phase === 'expired') {
      assert.equal(approve, undefined);
      [...shadow.querySelectorAll('button')].find(button => button.textContent.includes('Refresh price')).click(); await wait(20);
      assert.ok(calls.some(call => call.args.operation === 'apiosk_requote'));
    } else { assert.ok(approve); assert.equal(approve.disabled, phase === 'uncertain'); }
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

test('mixed preparation shows required task decisions and retries only incomplete prices', async () => {
  const search = fixture(); search.selected_sources = [{ endpoint_id: 'endpoint-0', capability: 'company.profile', subject_id: 'mollie', input: { 'company.name': 'Mollie B.V.' } }];
  const action = { action_id: 'supply-year', kind: 'supply_input', label: 'Reporting year', requires_authorization: false, input_schema: { properties: { value: { type: 'integer' } } } };
  const view = { view: 'source_basket', _mcp2: { request_id: 'request1' }, search, entries: [
    { kind: 'local', response: { status: 'needs_input', state: { state_ref: 'task1', revision: 1 }, next_actions: [action], context_view: {}, errors: [] } },
    { kind: 'external', label: 'External company source', error: 'The source price could not be confirmed.' },
  ] };
  const { dom, shadow, calls } = await mount(view, () => view);
  try {
    assert.ok([...shadow.querySelectorAll('button')].some(button => button.textContent === 'Continue'));
    [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Try again').click(); await wait(30);
    assert.ok(calls.some(call => call.args.operation === 'retry_preparation'));
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

test('a rejected combined price keeps valid inputs, shows the source failure and retries the saved preparation', async () => {
  const search = fixture();
  search.selected_sources = [0, 6].map(index => ({ endpoint_id: `endpoint-${index}`, capability: 'company.profile', subject_id: 'mollie', input: { 'company.name': 'Mollie B.V.' } }));
  const error = 'OpenSanctions cannot preserve the requested filters and output scope. Choose another source or revise the inputs.';
  const view = { view: 'source_basket', _mcp2: { request_id: 'request1' }, search,
    entries: [{ kind: 'local', label: 'Remaining source prices', request_id: 'saved-prepare', error }] };
  const { dom, shadow, calls } = await mount(view, () => view);
  try {
    assert.equal(shadow.querySelectorAll('form[data-purchase-inputs] input').length, 2);
    assert.ok(shadow.textContent.includes(error));
    assert.ok(shadow.textContent.includes('Check the details above and try again.'));
    assert.ok(!shadow.textContent.includes('Fill in the required details.'));
    assert.equal(calls.length, 0, 'restoring a rejected preparation must not automatically retry');
    const retry = [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Try again');
    assert.ok(retry); assert.equal(retry.disabled, false);
    retry.click(); await wait(30);
    assert.ok(calls.some(call => call.args.operation === 'retry_preparation' && call.args.request_id === 'request1'));
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});

test('running work keeps its exact cancel action and cannot offer a new purchase yet', async () => {
  const view = { status: 'running', state: { state_ref: 'running1', revision: 1 }, _mcp2: { request_id: 'request1' },
    billing: { authorization_active: true }, next_actions: [{ action_id: 'cancel-exact', kind: 'cancel', requires_authorization: false }], errors: [], context_view: { worker_active: true, execution_mode: 'server' } };
  const { dom, shadow, calls } = await mount(view, (_name, args) => args.operation === 'apiosk_execute'
    ? { ...view, status: 'cancelled', context_view: { worker_active: false }, next_actions: [] } : view);
  try {
    assert.ok(![...shadow.querySelectorAll('button')].some(button => button.textContent === 'New purchase'));
    [...shadow.querySelectorAll('button')].find(button => button.textContent === 'Stop request').click(); await wait(30);
    const stopped = calls.find(call => call.args.operation === 'apiosk_execute');
    assert.ok(stopped); assert.equal(stopped.args.args.action_id, 'cancel-exact'); assert.equal(stopped.args.args.input, null);
    assert.ok(!calls.some(call => call.name === 'apiosk_card_approve'));
  } finally { dom.window.close(); }
});
