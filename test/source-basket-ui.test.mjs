import test from 'node:test';
import assert from 'node:assert/strict';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';
import { cardHarness, flatten, flush, plain } from './helpers/card-harness.mjs';

const api_id = 'bazaar:external-fixture';
const native = { origin: 'apiosk', name: 'Registry', capability: 'company.profile', endpoint_id: 'registry', availability: 'supported',
  endpoint: { endpoint_id: 'registry', capability: 'company.profile', inputs: [{ field: 'company.id', required: true, schema: { type: 'string' } }],
    input_values: { 'company.id': '00123456' }, price: { currency: 'USD', buyer_atomic: '40000' } } };
const source = { resource: 'https://fixture.example/data', name: 'Public records', method: 'GET', total_atomic: 60000, provider_atomic: 52173,
  inputs: [{ field: 'query.city', required: true, schema: { type: 'string' } }] };
const search = () => ({ protocol_version: '2', view: 'source_search', question: 'Registry and public records for ACME in Amsterdam', search_id: 'signed-search', catalog_version: 'fixture',
  parsed_request: { meta: { text_sha256: 'question' }, subjects: [{ id: 's1', label: 'ACME', type: 'company', identifiers: {} }], capabilities: [{ slug: 'company.profile', subject_id: 's1', name: 'Company data' }] },
  source_options: [{ source: structuredClone(native), subject_id: 's1' }],
  matches: [{ slug: 'company.profile', subject_id: 's1', apiosk: [structuredClone(native)], coinbase_status: 'complete',
    coinbase: [{ origin: 'coinbase', name: 'Public records', availability: 'supported', api_id }] }] });
const localQuote = () => ({ protocol_version: '2', state: { state_ref: 'native-task', revision: 1 }, status: 'ready', errors: [],
  proposal: { quote_ref: 'native-quote', currency: 'USD', max_total_atomic: '40000', expires_at: '2099-01-01', steps: ['company.profile'], step_details: [], approval_url: 'https://app.apiosk.com/connect' },
  billing: { authorization_active: false, quote_ref: 'native-quote', currency: 'USD', total_charged: '0' },
  context_view: { execution_enabled: true, execution_mode: 'server', approval_mode: 'chatbot', manual_approval_required: true },
  next_actions: [{ action_id: 'run-native', kind: 'execute_quoted_step' }] });
const externalQuote = id => ({ protocol_version: '2', view: 'external_purchase', purchase_id: id, status: 'requires_approval', source,
  quote: { quote_ref: 'external-quote', max_total_atomic: '60000', currency: 'USD', expires_at: '2099-01-01' }, result: null, result_present: false, result_truncated: false, billing: null, error: null });
const buttons = h => h.nodes.get('sections').querySelectorAll('button');
const button = (h, label) => buttons(h).find(item => item.textContent === label);
const approval = h => buttons(h).find(item => item.textContent.startsWith('Approve '));

async function host(kind, data = search(), widgetState = undefined) {
  const direct = [], saved = [], acknowledged = new Set();
  const h = cardHarness(APIO_V2_CARD_HTML, kind === 'skybridge' ? {
    toolOutput: data, widgetState,
    callTool(name, args) { return new Promise((resolve, reject) => direct.push({ name, args: plain(args), resolve, reject })); },
    setWidgetState(value) { saved.push(plain(value)); },
  } : null);
  if (kind === 'mcp-apps') {
    await h.initialize('Claude');
    await h.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data } });
  }
  const client = {
    h, saved,
    calls() { return kind === 'skybridge' ? direct : h.sent.filter(message => message.method === 'tools/call').map(message => ({ name: message.params.name, args: plain(message.params.arguments), id: message.id })); },
    async contexts() {
      for (let round = 0; round < 6; round++) {
        await flush();
        for (const message of h.sent.filter(message => message.method === 'ui/update-model-context' && !acknowledged.has(message.id))) {
          acknowledged.add(message.id); saved.push({ privateContent: { apioskResult: plain(message.params.structuredContent) } });
          await h.message({ jsonrpc: '2.0', id: message.id, result: {} });
        }
      }
    },
    async respond(index, data) {
      if (kind === 'skybridge') direct[index].resolve({ structuredContent: data });
      else await h.message({ jsonrpc: '2.0', id: this.calls()[index].id, result: { structuredContent: data } });
      await flush();
    },
    snapshot() { return saved.at(-1)?.privateContent.apioskResult; },
  };
  return client;
}

async function selectAndPrepare(client, nativeDraft = '00998877') {
  const { h } = client;
  await h.change(h.nodes.get('sections').querySelector('.source-choice'), true);
  await h.change(h.nodes.get('sections').querySelector('.source-input'), nativeDraft);
  const inspecting = button(h, 'Review source').onclick(); await flush();
  assert.equal(client.calls()[0].name, 'apiosk_external');
  assert.equal(client.calls()[0].args.action, 'source');
  await client.respond(0, { protocol_version: '2', view: 'external_source', api_id, source }); await inspecting; await client.contexts();
  const form = h.nodes.get('sections').querySelector('form');
  await h.change(form.querySelector('input'), 'Amsterdam');
  await form.onsubmit({ preventDefault() {} }); await client.contexts();
  assert.equal(client.calls().length, 1, 'adding a source is local and free');
  const restored = h.nodes.get('sections').querySelector('.source-input');
  assert.equal(restored.value, nativeDraft, 'native edits survive visiting the external inspector');
  if (!nativeDraft) await h.change(restored, '00998877');
  const review = h.nodes.get('sections').querySelector('.review-sources');
  assert.equal(review.textContent, 'Review 2 selected sources');
  const pending = review.onclick(); await client.contexts();
  assert.deepEqual(client.calls().slice(1).map(call => call.name), ['apiosk_ask', 'apiosk_external']);
  assert.equal(client.calls()[2].args.action, 'prepare');
  assert.equal(client.calls()[1].args.input.apiosk_source_selection_v1.selections[0].input['company.id'], nativeDraft || '00998877');
  assert.deepEqual(client.calls()[2].args.input, { 'query.city': 'Amsterdam' });
  assert.equal(approval(h), undefined, 'no consent before all quotes return');
  const external = externalQuote(client.calls()[2].args.request_id);
  await client.respond(1, localQuote()); await client.respond(2, external); await client.contexts(); await pending;
  assert.equal(buttons(h).filter(item => item.textContent.startsWith('Approve ')).length, 1);
  assert.equal(approval(h).disabled, false);
  assert.match(approval(h).textContent, /0\.10/);
  return external;
}

for (const kind of ['skybridge', 'mcp-apps']) test(`${kind}: mixed local and Bazaar choices have one total and approval, with independent saved recovery`, async () => {
  const client = await host(kind), { h } = client;
  const external = await selectAndPrepare(client);
  assert.equal(client.calls().length, 3, 'only inspect and prepare; nothing has run');
  const approve = approval(h), pending = approve.onclick(); await client.contexts(); await approve.onclick();
  assert.deepEqual(client.calls().slice(3).map(call => call.name), ['apiosk_approve', 'apiosk_external_approve']);
  assert.equal(client.calls()[3].args.max_total_atomic, '40000');
  assert.equal(client.calls()[4].args.max_total_atomic, '60000');
  assert.equal(client.calls()[4].args.purchase_id, external.purchase_id);
  assert.ok(client.saved.some(saved => saved.privateContent.apioskResult.entries?.every(entry => entry.approval_submitted)), 'references are saved before either approval');
  const localRunning = { ...localQuote(), status: 'running', billing: { ...localQuote().billing, authorization_active: true }, state: { state_ref: 'native-task', revision: 2 } };
  await client.respond(3, localRunning); await client.respond(4, { ...external, status: 'running' }); await client.contexts(); await pending;
  assert.equal(approval(h), undefined);
  const recovery = button(h, 'Check all statuses').onclick(); await flush();
  assert.deepEqual(client.calls().slice(5).map(call => [call.name, call.args]), [
    ['apiosk_status', { task_ref: 'native-task' }], ['apiosk_external', { action: 'status', purchase_id: external.purchase_id }],
  ]);
  const localDone = { ...localRunning, status: 'succeeded', result: { name: 'ACME' }, next_actions: [], billing: { ...localRunning.billing, total_charged: '40000' } };
  await client.respond(5, localDone); await client.respond(6, { ...external, status: 'succeeded', result_present: true, result: { city: 'Amsterdam' }, billing: { charged_micro_usd: 60000 } });
  await client.contexts(); await recovery;
  assert.equal(buttons(h).filter(item => item.textContent === 'Open saved result').length, 2);
  await buttons(h).find(item => item.textContent === 'Open saved result').onclick(); await client.contexts();
  assert.ok(button(h, 'Back to all selected sources'));
  assert.equal(approval(h), undefined);
  await button(h, 'Back to all selected sources').onclick(); await client.contexts();
  assert.equal(client.calls().length, 7, 'opening saved results never re-executes');
  assert.doesNotThrow(() => JSON.stringify(client.snapshot()), 'parent basket snapshots have no cycles');
});

test('restoring mixed quotes requires current free reads before approval and never buys on mount', async () => {
  const original = await host('skybridge');
  const external = await selectAndPrepare(original);
  const saved = plain(original.snapshot());
  const client = await host('skybridge', saved), { h } = client;
  assert.equal(client.calls().length, 0);
  assert.equal(approval(h).disabled, true);
  await approval(h).onclick(); await flush();
  assert.equal(client.calls().length, 0, 'programmatic stale click is also blocked');
  const check = button(h, 'Check all statuses').onclick(); await flush();
  await client.respond(0, localQuote()); await client.respond(1, external); await client.contexts(); await check;
  assert.equal(approval(h).disabled, false);
  assert.deepEqual(client.calls().map(call => call.name), ['apiosk_status', 'apiosk_external']);
});

test('an uncertain mixed approval recovers each reference and never repeats a confirmed source approval', async () => {
  const client = await host('skybridge'), { h } = client;
  const external = await selectAndPrepare(client);
  const pending = approval(h).onclick(); await client.contexts();
  await client.respond(3, { ...localQuote(), status: 'succeeded', billing: { ...localQuote().billing, authorization_active: true } });
  client.calls()[4].reject(new Error('lost approval response')); await client.contexts(); await pending;
  assert.equal(approval(h), undefined);
  assert.ok(flatten(h.nodes.get('sections')).some(text => text.includes('not confirmed')));
  const check = button(h, 'Check all statuses').onclick(); await flush();
  await client.respond(5, { ...localQuote(), status: 'succeeded', billing: { ...localQuote().billing, authorization_active: true } });
  await client.respond(6, external); await client.contexts(); await check;
  assert.match(approval(h).textContent, /0\.06/);
  const retry = approval(h).onclick(); await client.contexts();
  assert.equal(client.calls().length, 8);
  assert.equal(client.calls()[7].name, 'apiosk_external_approve');
  await client.respond(7, { ...external, status: 'running' }); await client.contexts(); await retry;
  assert.equal(client.calls().filter(call => call.name === 'apiosk_approve').length, 1);
});


test('an incomplete native draft can inspect and add an external source before completing its input', async () => {
  const client = await host('skybridge');
  await selectAndPrepare(client, '');
  assert.equal(client.calls().length, 3);
});

test('failure to persist purchase references blocks every paid approval', async () => {
  const client = await host('skybridge'), { h } = client;
  const external = await selectAndPrepare(client);
  h.window.openai.setWidgetState = () => { throw new Error('storage unavailable'); };
  await approval(h).onclick(); await flush();
  assert.equal(client.calls().length, 3, 'no paid calls after failed persistence');
  assert.equal(approval(h), undefined);
  assert.equal(button(h, 'Check all statuses').disabled, false);
  const check = button(h, 'Check all statuses').onclick(); await flush();
  await client.respond(3, localQuote()); await client.respond(4, external); await check;
  assert.equal(client.calls().length, 5, 'recovery uses only free status reads');
});


test('actual OpenAI remount restores the basket from widgetState against the original search without buying', async () => {
  const original = await host('skybridge');
  await selectAndPrepare(original);
  const widgetState = plain(original.saved.at(-1));
  const restored = await host('skybridge', search(), widgetState);
  assert.equal(restored.h.nodes.get('title').textContent, 'Your selected sources');
  assert.equal(approval(restored.h).disabled, true, 'restored quotes require current reads');
  assert.equal(restored.calls().length, 0);
  await restored.h.globals({ toolOutput: search() });
  assert.equal(restored.h.nodes.get('title').textContent, 'Your selected sources', 'layout replay preserves basket');
  const changed = { ...search(), search_id: 'new-authoritative-search' };
  await restored.h.globals({ toolOutput: changed });
  assert.notEqual(restored.h.nodes.get('title').textContent, 'Your selected sources');
  assert.equal(restored.calls().length, 0, 'a fresh search never approves a previous basket');
});

test('in-card mixed basket survives original tool output replay before any remount', async () => {
  const client = await host('skybridge');
  await selectAndPrepare(client);
  await client.h.globals({ toolOutput: search() });
  assert.equal(client.h.nodes.get('title').textContent, 'Your selected sources');
  assert.equal(approval(client.h).disabled, false);
  assert.equal(client.calls().length, 3);
});

test('standalone external widget restores the exact purchase but a newer tool result wins', async () => {
  const originalSource = { protocol_version: '2', view: 'external_source', api_id, source };
  const original = await host('skybridge', originalSource), { h } = original;
  const form = h.nodes.get('sections').querySelector('form');
  await h.change(form.querySelector('input'), 'Amsterdam');
  const prepare = form.onsubmit({ preventDefault() {} }); await flush();
  const quoted = externalQuote(original.calls()[0].args.request_id);
  await original.respond(0, quoted); await prepare; await original.contexts();
  const widgetState = plain(original.saved.at(-1));
  const restored = await host('skybridge', originalSource, widgetState);
  assert.ok(button(restored.h, 'Check status'));
  assert.equal(restored.h.nodes.get('sections').querySelector('form'), undefined);
  assert.equal(restored.calls().length, 0, 'mount never approves the saved purchase');
  const latest = { ...quoted, status: 'succeeded', result_present: true, result: { city: 'Amsterdam' }, billing: { charged_micro_usd: 60000 } };
  await restored.h.globals({ toolOutput: latest });
  assert.equal(approval(restored.h), undefined);
  assert.ok(flatten(restored.h.nodes.get('sections')).includes('Saved result'));
  const unrelated = await host('skybridge', { ...originalSource, api_id: 'bazaar:different-source' }, widgetState);
  assert.ok(unrelated.h.nodes.get('sections').querySelector('form'));
  assert.equal(unrelated.calls().length, 0);
});

for (const kind of ['skybridge', 'mcp-apps']) test(`${kind}: mixed running sources automatically read saved statuses and stop each completed source`, async () => {
  const client = await host(kind), { h } = client;
  const external = await selectAndPrepare(client);
  const approve = approval(h).onclick(); await client.contexts();
  const runningLocal = { ...localQuote(), status: 'running', state: { state_ref: 'native-task', revision: 2 }, billing: { ...localQuote().billing, authorization_active: true } };
  await client.respond(3, runningLocal); await client.respond(4, { ...external, status: 'running' }); await client.contexts(); await approve;
  assert.equal(await h.tick(2000), true); await flush();
  assert.deepEqual(client.calls().slice(5).map(call => [call.name, call.args]), [
    ['apiosk_status', { task_ref: 'native-task' }], ['apiosk_external', { action: 'status', purchase_id: external.purchase_id }],
  ]);
  await client.respond(5, { ...runningLocal, status: 'succeeded', state: { state_ref: 'native-task', revision: 3 }, result: { name: 'ACME' }, next_actions: [] });
  await client.respond(6, { ...external, status: 'running' }); await client.contexts();
  assert.equal(await h.tick(2000), true); await flush();
  assert.equal(client.calls().length, 8, 'the completed native source is no longer polled');
  assert.deepEqual(client.calls()[7].args, { action: 'status', purchase_id: external.purchase_id });
  await client.respond(7, { ...external, status: 'succeeded', result_present: true, result: { city: 'Amsterdam' }, billing: { charged_micro_usd: 60000 } }); await client.contexts();
  assert.equal(buttons(h).filter(item => item.textContent === 'Open saved result').length, 2);
  assert.equal(await h.tick(2000), false, 'terminal basket stops polling');
  assert.equal(client.calls().filter(call => call.name.endsWith('_approve')).length, 2, 'polling never adds approval');
});

test('standalone running external purchase polls only saved status and stops on completion', async () => {
  const running = { ...externalQuote('purchase-poll'), status: 'running' };
  const client = await host('skybridge', running), { h } = client;
  assert.equal(client.calls().length, 0, 'mount does not execute');
  assert.equal(await h.tick(2000), true); await flush();
  assert.deepEqual(client.calls().map(call => [call.name, call.args]), [['apiosk_external', { action: 'status', purchase_id: 'purchase-poll' }]]);
  await client.respond(0, { ...running, status: 'succeeded', result_present: true, result: { found: true } }); await client.contexts();
  assert.ok(flatten(h.nodes.get('sections')).includes('Saved result'));
  assert.equal(await h.tick(2000), false);
});

test('running purchase polling pauses during manual status and never duplicates its read', async () => {
  const running = { ...externalQuote('purchase-manual'), status: 'running' };
  const client = await host('skybridge', running), { h } = client;
  const manual = button(h, 'Check status').onclick(); await flush();
  assert.equal(await h.tick(2000), true); await flush();
  assert.equal(client.calls().length, 1, 'busy manual read suppresses background read');
  await client.respond(0, { ...running, status: 'failed', error: { message: 'Source unavailable' } }); await client.contexts(); await manual;
  assert.equal(await h.tick(2000), false);
});

for (const leave of ['new view', 'pagehide']) test(`saved purchase polling discards in-flight replies after ${leave}`, async () => {
  const running = { ...externalQuote('purchase-leave'), status: 'running' };
  const client = await host('skybridge', running), { h } = client;
  await h.tick(2000); await flush();
  assert.equal(client.calls().length, 1);
  if (leave === 'new view') await h.globals({ toolOutput: search() });
  else await h.event('pagehide');
  const title = h.nodes.get('title').textContent;
  await client.respond(0, { ...running, status: 'succeeded', result_present: true, result: { found: true } }); await client.contexts();
  assert.equal(h.nodes.get('title').textContent, title);
  assert.equal(await h.tick(2000), false, 'no scheduled read survives leaving the view');
  assert.equal(client.saved.length, 0, 'stale response does not replace current widget state');
});
