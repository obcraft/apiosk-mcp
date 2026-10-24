import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';

const root = fileURLToPath(new URL('../', import.meta.url));
const base = path.join(root, 'src/ask-page');
let temporary, module;
before(async () => {
  await mkdir(path.join(root, '.local'), { recursive: true });
  temporary = await mkdtemp(path.join(root, '.local/results-test-'));
  const entry = path.join(temporary, 'entry.ts');
  await writeFile(entry, `export { AskSavedResults } from '@/AskSavedResults';\nexport { AskTaskDecisions } from '@/AskTaskDecisions';\nexport { AskAutomaticQuote } from '@/AskAutomaticQuote';\nexport { AskV2Result } from '@/components/ask-v2/ask-v2-result';\nexport { GatewayV2Outputs } from '@/components/ask/gateway-v2-outputs';\nexport { MoneyContext } from '@/environment';\nexport { PortalRootContext } from '@/lib/ui/portal-root';\n`);
  await build({ configFile: false, root, logLevel: 'silent', resolve: { alias: { '@': base } },
    build: { ssr: entry, outDir: path.join(temporary, 'build'), emptyOutDir: true,
      rolldownOptions: { output: { entryFileNames: 'results.mjs' } } } });
  module = await import(pathToFileURL(path.join(temporary, 'build/results.mjs')));
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

const fixture = async name => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const rendered = (component, props) => renderToStaticMarkup(React.createElement(component, props));

async function mount(t, props, { shadow = false, decisions = false, automaticQuote = false } = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://mcp.apiosk.com/', pretendToBeVisual: true });
  const previous = new Map();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window), requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  dom.window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const fetches = [];
  t.mock.method(globalThis, 'fetch', async (...args) => { fetches.push(args); throw new Error('No network is available to saved-result rendering'); });
  const host = document.getElementById('root');
  const surface = shadow ? host.attachShadow({ mode: 'open' }) : host;
  const portalRoot = document.createElement('div'), reactRoot = document.createElement('div');
  surface.append(portalRoot); portalRoot.append(reactRoot);
  const target = createRoot(reactRoot);
  await act(async () => target.render(React.createElement(module.PortalRootContext, { value: portalRoot },
    React.createElement(module.MoneyContext, { value: { currency: 'EUR', rate: 0.92, ready: true } },
      React.createElement(automaticQuote ? module.AskAutomaticQuote : decisions ? module.AskTaskDecisions : module.AskSavedResults, props)))));
  const click = async element => { assert.ok(element, 'Expected control is present'); await act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))); };
  t.after(async () => {
    await act(async () => target.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  return { document: dom.window.document, surface, portalRoot, window: dom.window, click, fetches };
}

test('the saved-result readers and pure helpers remain byte-identical to the frozen App', async () => {
  const hashes = JSON.parse(await readFile(path.join(base, 'results-upstream-checksums.json')));
  assert.ok(Object.keys(hashes).length >= 60);
  for (const [name, digest] of Object.entries(hashes)) {
    const value = await readFile(path.join(base, name));
    assert.equal(createHash('sha256').update(value).digest('hex'), digest, name);
  }
});

test('recorded CBS data uses the exact App purchased-result reader and keeps source values', async () => {
  const output = await fixture('cbs-annual-ui'), original = structuredClone(output);
  const result = output.context_view.results.at(-1), source = { ...result.source, source_slug: result.source.provider };
  const expected = rendered(module.AskV2Result, { source, value: result.data, raw: result, partial: false });
  assert.equal(rendered(module.AskSavedResults, { output, source }), expected);
  assert.deepEqual(output, original, 'Rendering never rewrites the saved source response');
});

test('recorded supplier analysis uses the exact App answer, including limitations and evidence', async () => {
  const output = await fixture('uk-supplier-ui'), context = output.context_view;
  const question = context.conversation.at(-1).question, result = context.results.at(-1);
  const expected = rendered(module.GatewayV2Outputs, { question, result, results: context.results, analysis: context.analysis,
    report: context.report, showSources: true, onOpenDetails() {} });
  assert.equal(rendered(module.AskSavedResults, { output }), expected);
  assert.match(expected, /VAT remains unverified/);
  assert.match(expected, /identity review/);
});

test('an intermediate lookup keeps the selected source identity and is not relabelled as the requested financial result', () => {
  const source = { name: 'Annual accounts', origin: 'apiosk', endpoint_id: 'financial-record', source_slug: 'filings' };
  const result = { source: { name: 'Company search', endpoint_id: 'company-lookup', provider: 'register' },
    data: Array.from({ length: 20 }, (_, index) => ({ name: `Candidate ${index}`, registry: `00${index}` })) };
  const expected = rendered(module.AskV2Result, { source, value: result.data, raw: result, partial: false });
  const actual = rendered(module.AskSavedResults, { output: { result }, source });
  assert.equal(actual, expected);
  assert.match(actual, /Source result/);
});

test('result details retain signed PDF and evidence links without any provider request', async t => {
  const output = await fixture('uk-supplier-ui');
  output.context_view.report = { format: 'pdf', download_path: '/v2/tasks/abc-123/reports/def-456/report.pdf?token=fixture',
    evidence_download_path: '/v2/tasks/abc-123/reports/def-456/evidence.zip?token=fixture' };
  const ui = await mount(t, { output, gatewayUrl: 'https://gateway.example.test' });
  await ui.click(ui.document.querySelector('[aria-label="Open sources and details"]'));
  const links = [...ui.document.querySelectorAll('a')].map(link => link.href);
  assert.ok(links.includes('https://gateway.example.test' + output.context_view.report.download_path));
  assert.ok(links.includes('https://gateway.example.test' + output.context_view.report.evidence_download_path));
  assert.ok(ui.document.querySelector('[aria-label="Sources and details"]'));
  assert.deepEqual(ui.fetches, []);
});

test('full-result dialogs and keyboard focus stay inside the host shadow surface', async t => {
  const output = await fixture('uk-supplier-ui');
  const ui = await mount(t, { output }, { shadow: true });
  await ui.click(ui.surface.querySelector('[aria-label="Open sources and details"]'));
  const dialog = ui.surface.querySelector('[role="dialog"]');
  assert.ok(dialog);
  assert.ok(ui.portalRoot.contains(dialog));
  assert.equal(ui.document.querySelector('[role="dialog"]'), null);
  const controls = [...dialog.querySelectorAll('a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])')];
  assert.ok(controls.length > 1);
  for (const control of controls) Object.defineProperty(control, 'offsetParent', { configurable: true, value: dialog });
  controls.at(-1).focus();
  await act(async () => controls.at(-1).dispatchEvent(new ui.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })));
  assert.equal(ui.surface.activeElement, controls[0]);
  assert.deepEqual(ui.fetches, []);
});

test('large saved JSON loads through the supplied read callback with Unicode-safe offsets only', async t => {
  const complete = { result_ref: 'saved-result', data: { name: 'Mollie 🌍', registry: '30204462', city: 'Amsterdam' }, source: { name: 'KVK', provider: 'kvk' } };
  const characters = Array.from(JSON.stringify(complete));
  const offset = characters.indexOf('🌍') + 1;
  const first = { result_ref: complete.result_ref, encoding: 'json_text', text: characters.slice(0, offset).join(''), next_offset: offset };
  const reads = [];
  const ui = await mount(t, { output: { status: 'succeeded', result: first }, readResultPage: async (ref, at, signal) => {
    reads.push({ ref, at, signal });
    return { result_ref: ref, encoding: 'json_text', text: characters.slice(at).join(''), next_offset: null };
  } });
  assert.equal(reads.length, 0);
  await ui.click([...ui.document.querySelectorAll('button')].find(button => button.textContent === 'Load full saved result'));
  assert.equal(reads.length, 1);
  assert.equal(reads[0].ref, 'saved-result'); assert.equal(reads[0].at, offset);
  assert.ok(reads[0].signal instanceof AbortSignal);
  assert.match(ui.document.body.textContent, /30204462/);
  assert.match(ui.document.body.textContent, /Mollie 🌍/);
  assert.equal([...ui.document.querySelectorAll('button')].some(button => button.textContent === 'Load full saved result'), false);
  assert.deepEqual(ui.fetches, []);
});

test('record selection prepares an editable follow-up with exact identifiers without submitting it', async t => {
  const followups = [];
  const data = [{ company_name: 'Mollie B.V.', kvk_number: '30204462' }, { company_name: 'Other Company', kvk_number: '01234567' }];
  const ui = await mount(t, { output: { status: 'succeeded', result: { source: { name: 'KVK' }, data } }, onPrepareQuestion: value => followups.push(value) });
  await ui.click(ui.document.querySelector('[aria-label="Select row 1"]'));
  await ui.click([...ui.document.querySelectorAll('button')].find(button => button.textContent === 'Use in follow-up'));
  assert.equal(followups.length, 1);
  assert.match(followups[0], /Selected record from KVK/);
  assert.match(followups[0], /30204462/);
  assert.match(followups[0], /My follow-up: $/);
  assert.deepEqual(ui.fetches, []);
});

test('saved billing uses account EUR display while retaining exact ledger and source document currencies', async t => {
  const output = { status: 'succeeded', result: { source: { name: 'Register' }, data: { company: 'Mollie B.V.', currency: 'USD' } },
    billing: { status: 'captured', currency: 'USD', total_charged: '1000000', provider_cost: '900000', apiosk_fee: '100000',
      reserved: '0', balance_available: '2000000', executions: [{ execution_id: 'saved-execution', receipt_ref: 'saved-receipt', status: 'captured', total_charged: '1000000' }] } };
  const original = structuredClone(output), newPurchases = [];
  const ui = await mount(t, { output, grouped: true, onNewPurchase: () => newPurchases.push('opened') });
  const group = ui.document.querySelector('[aria-label="Apiosk balance payment"]');
  assert.ok(group);
  assert.match(group.textContent, /€0\.92/);
  assert.match(group.textContent, /saved-receipt/);
  assert.equal(group.querySelector('details').open, false);
  assert.deepEqual(output, original);
  assert.match(ui.document.querySelector('[aria-label="Purchased result"]').textContent, /USD/);
  await ui.click([...group.querySelectorAll('button')].find(button => button.textContent === 'New purchase'));
  assert.deepEqual(newPurchases, ['opened']);
  assert.deepEqual(ui.fetches, []);
});

test('JSON and CSV exports are generated from the saved result without refetching or losing identifiers', async t => {
  const data = Array.from({ length: 20 }, (_, index) => ({ company: `Company ${index}`, registry: `00${index}`, amount: index + 0.25 }));
  const result = { source: { name: 'Saved Registry' }, data };
  const ui = await mount(t, { output: { status: 'succeeded', result } });
  const blobs = [], names = [];
  t.mock.method(URL, 'createObjectURL', blob => { blobs.push(blob); return 'blob:fixture'; });
  const create = ui.document.createElement.bind(ui.document);
  t.mock.method(ui.document, 'createElement', (...args) => {
    const element = create(...args);
    if (args[0] === 'a') element.click = () => names.push(element.download);
    return element;
  });
  await ui.click(ui.document.querySelector('[aria-label="Download Saved Registry result as JSON"]'));
  await ui.click(ui.document.querySelector('[aria-label="Download Saved Registry result as CSV"]'));
  assert.deepEqual(names, ['saved-registry-result.json', 'saved-registry-result.csv']);
  assert.deepEqual(JSON.parse(await blobs[0].text()), result);
  const csv = await blobs[1].text();
  assert.match(csv, /"company","registry","amount"/);
  assert.match(csv, /"Company 19","0019","19\.25"/);
  assert.deepEqual(ui.fetches, []);
});

test('saved entity decisions retain the actual Ask labels and continue only the exact offered entity', async t => {
  const action = { action_id: 'select-exact', kind: 'select_entity', label: 'Choose company', requires_authorization: false, input_schema: {} };
  const calls = [], output = { state: { state_ref: 'saved-task' }, status: 'needs_selection', next_actions: [action],
    result: { data: { available: true } }, context_view: { candidates: [{ entity_ref: 'entity-exact', label: 'Mollie B.V.',
      facts: [{ type: 'KVK number', value: '30204462' }] }], candidates_note: 'One matching registered company.' } };
  const ui = await mount(t, { output, onAction: (action, input) => calls.push({ action, input }) }, { decisions: true });
  assert.match(ui.document.body.textContent, /Which one do you mean\?/);
  assert.match(ui.document.body.textContent, /30204462/);
  assert.equal(calls.length, 0);
  await ui.click(ui.document.querySelector('button[aria-label^="Select Mollie"]'));
  assert.deepEqual(calls, [{ action, input: { entity_ref: 'entity-exact' } }]);
  assert.deepEqual(ui.fetches, []);
});

test('saved input decisions preserve action typing and never offer a paid execute action', async t => {
  const action = { action_id: 'supply-year', kind: 'supply_input', label: 'Reporting year', requires_authorization: false,
    input_schema: { properties: { value: { type: 'integer', description: 'The year on the saved record.' } } } };
  const calls = [], output = { state: { state_ref: 'saved-task' }, next_actions: [action,
    { action_id: 'paid', kind: 'execute_quoted_step', requires_authorization: true, input_schema: {} }] };
  const ui = await mount(t, { output, onAction: (action, input) => calls.push({ action, input }) }, { decisions: true });
  const input = ui.document.querySelector('input');
  const props = input[Object.keys(input).find(key => key.startsWith('__reactProps$'))];
  await act(async () => props.onChange({ target: { value: '2024' } }));
  await act(async () => ui.document.querySelector('form').dispatchEvent(new ui.window.Event('submit', { bubbles: true, cancelable: true })));
  assert.deepEqual(calls, [{ action, input: { value: 2024 } }]);
  assert.equal(ui.document.querySelectorAll('button').length, 1);
  assert.deepEqual(ui.fetches, []);
});

test('decisions remain disabled while payment is being reconciled', async t => {
  const calls = [], action = { action_id: 'select', kind: 'select_entity', requires_authorization: false, input_schema: {} };
  const ui = await mount(t, { output: { state: { state_ref: 'saved-task' }, billing: { status: 'pending_reconciliation' }, next_actions: [action],
    context_view: { candidates: [{ entity_ref: 'company', label: 'Mollie B.V.' }] } }, onAction: (...args) => calls.push(args) }, { decisions: true });
  const button = ui.document.querySelector('button');
  assert.equal(button.disabled, true);
  await ui.click(button);
  assert.deepEqual(calls, []);
});

const automaticProposal = { label: 'Mollie check', max_total_atomic: '100000', currency: 'USD', quote_ref: 'exact-quote',
  step_details: [
    { number: 1, kind: 'source', title: 'Company profile', source: { name: 'KVK', slug: 'kvk' }, max_total_atomic: '70000' },
    { number: 2, kind: 'source', title: 'Sanctions screening', source: { name: 'OpenSanctions', slug: 'opensanctions' }, max_total_atomic: '30000' },
  ] };

test('automatic planning shows the App offer with sources, scope and one explicit approval control', async t => {
  const calls = [], proposal = structuredClone(automaticProposal);
  const ui = await mount(t, { proposal, coverageNotices: ['VAT is outside this request.'], expired: false, canApprove: true,
    executionEnabled: true, disabled: false, onApprove: () => calls.push('approve'), onRefreshPrice: () => calls.push('refresh') }, { automaticQuote: true });
  assert.match(ui.document.body.textContent, /KVK/);
  assert.match(ui.document.body.textContent, /OpenSanctions/);
  assert.match(ui.document.body.textContent, /VAT is outside this request/);
  assert.equal(calls.length, 0);
  const approve = [...ui.document.querySelectorAll('button')].filter(button => button.textContent.startsWith('Approve up to'));
  assert.equal(approve.length, 1);
  assert.match(approve[0].textContent, /€0\.10/);
  await ui.click(approve[0]);
  assert.deepEqual(calls, ['approve']);
  assert.deepEqual(proposal, automaticProposal);
  assert.deepEqual(ui.fetches, []);
});

test('an expired automatic quote can only refresh its price, never approve the old offer', async t => {
  const calls = [];
  const ui = await mount(t, { proposal: automaticProposal, expired: true, canApprove: true, disabled: false,
    onApprove: () => calls.push('approve'), onRefreshPrice: () => calls.push('refresh') }, { automaticQuote: true });
  assert.equal([...ui.document.querySelectorAll('button')].some(button => button.textContent.startsWith('Approve')), false);
  await ui.click([...ui.document.querySelectorAll('button')].find(button => button.textContent === 'Refresh price'));
  assert.deepEqual(calls, ['refresh']);
  assert.deepEqual(ui.fetches, []);
});

test('automatic quote approval remains disabled when execution is disabled', async t => {
  const calls = [];
  const ui = await mount(t, { proposal: automaticProposal, expired: false, canApprove: true, executionEnabled: false, disabled: false,
    onApprove: () => calls.push('approve'), onRefreshPrice() {} }, { automaticQuote: true });
  const approve = [...ui.document.querySelectorAll('button')].find(button => button.textContent.startsWith('Approve'));
  assert.equal(approve.disabled, true);
  await ui.click(approve);
  assert.deepEqual(calls, []);
});
