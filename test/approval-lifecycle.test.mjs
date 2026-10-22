import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2Runtime } from '../src/gateway-v2.mjs';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';
import { cardHarness, flatten, flush, plain } from './helpers/card-harness.mjs';

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const taskRef = uuid(1), quoteRef = uuid(2), actionId = uuid(3);
const state = { schema_version: '2', state_ref: taskRef, revision: 1, expires_at: '2099-01-01T00:00:00Z', focus: { entity_refs: [], goal_refs: [] }, state_token: 'signed-fixture-state' };
const ready = {
  protocol_version: '2', request_id: uuid(4), status: 'requires_approval', intent_ref: taskRef,
  state, result: null, errors: [],
  context_view: { approval_mode: 'chatbot', execution_mode: 'server', execution_enabled: true, worker_active: false },
  proposal: { label: 'Selected sources', quote_ref: quoteRef, price_status: 'quoted', currency: 'USD', max_total_atomic: '600000', expires_at: '2099-01-01T00:00:00Z', approval_url: `https://app.apiosk.com/gateway-v2?task=${taskRef}`, steps: ['company.profile', 'company.officers'], step_details: [] },
  billing: { authorization_active: false, quote_ref: quoteRef, quote_cap: '600000', total_charged: '0', currency: 'USD', executions: [] },
  next_actions: [{ action_id: actionId, kind: 'execute_quoted_step', label: 'Run selected sources', requires_authorization: true, input_schema: {} }],
};
const approved = { ...ready, status: 'running', state: { ...state, revision: 2 }, context_view: { ...ready.context_view, worker_active: true }, billing: { ...ready.billing, authorization_active: true }, next_actions: [] };
const saved = { ...approved, status: 'succeeded', state: { ...state, revision: 3 }, context_view: { ...approved.context_view, worker_active: false }, result: { source: { name: 'Fixture registry' }, data: { name: 'Financial Crime Compliance Associates' } }, billing: { ...approved.billing, total_charged: '500000' } };

async function lifecycle(host, initial, gateway) {
  const requests = [];
  const runtime = createV2Runtime({
    hostedAuthEnabled: true,
    env: { APIOSK_GATEWAY_V2_URL: 'https://gateway.example.test', APIOSK_CONNECT_TOKEN: 'must-not-be-used' },
    fetchImpl: async (url, options) => {
      const request = { path: url.pathname, method: options.method, body: options.body ? JSON.parse(options.body) : undefined, authorization: options.headers.authorization };
      requests.push(request);
      return gateway(request, requests);
    },
  });
  const callTool = (name, args) => runtime.callTool(name, plain(args), { extra: { apiosk_connect_token: 'connected-user-token' } });
  const h = cardHarness(APIO_V2_CARD_HTML, host === 'chatgpt' ? { toolOutput: initial, callTool, setWidgetState(value) { this.widgetState = value; } } : null);
  if (host === 'claude') {
    await h.initialize('claude');
    await h.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: initial } });
  }
  let processed = h.sent.length;
  async function settle(action) {
    let done = !action, failure;
    Promise.resolve(action).then(() => { done = true; }, error => { failure = error; done = true; });
    for (let i = 0; i < 30; i++) {
      await flush();
      while (processed < h.sent.length) {
        const message = h.sent[processed++];
        if (message.id == null) continue;
        const result = message.method === 'tools/call' ? await callTool(message.params.name, message.params.arguments) : {};
        await h.message({ jsonrpc: '2.0', id: message.id, result });
      }
      if (done) { await flush(); if (processed === h.sent.length) break; }
    }
    if (failure) throw failure;
    assert.ok(done, 'card action settled through the host bridge');
  }
  const button = label => h.nodes.get('sections').querySelectorAll('button').find(node => typeof label === 'string' ? node.textContent === label : label.test(node.textContent));
  return { h, runtime, requests, settle, button };
}

for (const host of ['chatgpt', 'claude']) test(`${host}: one approval crosses the authenticated runtime and free status recovers the result`, async () => {
  const x = await lifecycle(host, ready, request => Response.json(request.path === '/v2/approve' ? approved : saved));
  assert.equal(x.requests.length, 0, 'mounting a priced plan does not buy');
  const approve = x.button(/^Approve up to /);
  const firstClick = approve.onclick();
  assert.equal(approve.disabled, true);
  const duplicateClick = approve.onclick();
  await x.settle(Promise.all([firstClick, duplicateClick]));
  assert.equal(x.requests.length, 1);
  assert.deepEqual({ ...x.requests[0], body: { ...x.requests[0].body, request_id: 'generated' } }, {
    path: '/v2/approve', method: 'POST', authorization: 'Bearer connected-user-token',
    body: { state, quote_ref: quoteRef, max_total_atomic: '600000', request_id: 'generated' },
  });
  assert.equal(x.h.window.apiosk.data.billing.authorization_active, true);
  assert.equal(x.button(/^Approve up to /), undefined, 'server execution needs no second approval');
  await x.settle(x.button('Check status').onclick());
  assert.deepEqual(x.requests.map(({ path, method }) => ({ path, method })), [{ path: '/v2/approve', method: 'POST' }, { path: `/v2/tasks/${taskRef}`, method: 'GET' }]);
  assert.equal(x.requests[1].body, undefined);
  assert.equal(x.h.window.apiosk.data.status, 'succeeded');
  assert.ok(flatten(x.h.nodes.get('sections')).some(value => String(value).includes('Financial Crime Compliance Associates')));
});

test('a returned server continuation runs once with the gateway action as its payment retry identity', async () => {
  const continuation = { ...approved, context_view: { ...approved.context_view, worker_active: false }, next_actions: ready.next_actions };
  const x = await lifecycle('claude', ready, request => Response.json(request.path === '/v2/approve' ? continuation : saved));
  await x.settle(x.button(/^Approve up to /).onclick());
  await x.h.tick(0); await x.settle();
  await x.h.tick(0); await x.settle();
  assert.deepEqual(x.requests.map(request => request.path), ['/v2/approve', '/v2/execute']);
  assert.equal(x.requests[1].body.action_id, actionId);
  assert.equal(x.requests[1].body.idempotency_key, actionId);
  assert.equal(x.requests[1].body.quote_ref, quoteRef);
  assert.deepEqual(x.requests[1].body.state, continuation.state);
  assert.equal(x.h.window.apiosk.data.status, 'succeeded');
});

for (const host of ['chatgpt', 'claude']) test(`${host}: expired price refresh preserves the saved selection and never discovers, approves or executes`, async () => {
  const expired = { ...ready, proposal: { ...ready.proposal, expires_at: '2020-01-01T00:00:00Z' } };
  const refreshed = { ...ready, state: { ...state, revision: 2 }, proposal: { ...ready.proposal, quote_ref: uuid(5), max_total_atomic: '700000' } };
  const x = await lifecycle(host, expired, request => Response.json(request.method === 'GET' ? expired : refreshed));
  await x.settle(x.button('Get new price').onclick());
  assert.deepEqual(x.requests.map(({ path, method }) => ({ path, method })), [{ path: `/v2/tasks/${taskRef}`, method: 'GET' }, { path: '/v2/ask/requote', method: 'POST' }]);
  const { request_id, ...body } = x.requests[1].body;
  assert.ok(request_id);
  assert.deepEqual(body, { state, quote_ref: quoteRef });
  assert.equal(x.h.window.apiosk.data.proposal.quote_ref, uuid(5));
  assert.equal(x.h.window.apiosk.data.billing.authorization_active, false);
  assert.ok(x.button(/^Approve up to /));
});

test('a lost approval response recovers saved authorization without a second approval or purchase', async () => {
  const x = await lifecycle('claude', ready, request => {
    if (request.path === '/v2/approve') throw new Error('response lost after approval was saved');
    return Response.json(approved);
  });
  await x.settle(x.button(/^Approve up to /).onclick());
  assert.deepEqual(x.requests.map(({ path, method }) => ({ path, method })), [{ path: '/v2/approve', method: 'POST' }, { path: `/v2/tasks/${taskRef}`, method: 'GET' }]);
  assert.equal(x.h.window.apiosk.data.billing.authorization_active, true);
  assert.equal(x.button(/^Approve up to /), undefined);
});

test('uncertain approval blocks another click until a valid read recovers the saved task', async () => {
  let reads = 0;
  const x = await lifecycle('chatgpt', ready, request => {
    if (request.path === '/v2/approve') throw new Error('approval response unavailable');
    if (++reads === 1) throw new Error('status temporarily unavailable');
    return Response.json(approved);
  });
  const originalApprove = x.button(/^Approve up to /);
  await x.settle(originalApprove.onclick());
  assert.equal(x.button('Check status before approving again').disabled, true);
  await x.settle(originalApprove.onclick());
  assert.equal(x.requests.filter(request => request.path === '/v2/approve').length, 1);
  await x.settle(x.button('Check status').onclick());
  assert.equal(x.h.window.apiosk.data.billing.authorization_active, true);
  assert.equal(x.button(/^Approve up to /), undefined);
  assert.deepEqual(x.requests.map(request => request.method), ['POST', 'GET', 'GET']);
});

test('unsupported legacy price refresh reports the Gateway refusal without replanning or buying', async () => {
  const expired = { ...ready, proposal: { ...ready.proposal, expires_at: '2020-01-01T00:00:00Z' } };
  const message = 'This request cannot be repriced. Search for sources again.';
  const x = await lifecycle('claude', expired, request => request.method === 'GET' ? Response.json(expired) : Response.json({ error_code: 'requote_unavailable', message }, { status: 409 }));
  await x.settle(x.button('Get new price').onclick());
  assert.deepEqual(x.requests.map(request => request.path), [`/v2/tasks/${taskRef}`, '/v2/ask/requote']);
  assert.equal(x.h.nodes.get('feedback-text').textContent, message);
  assert.equal(x.h.window.apiosk.data.proposal.quote_ref, quoteRef);
});

const sourceCandidate = { origin: 'apiosk', source_slug: 'fixture-registry', endpoint_id: uuid(10), capability: 'company.profile', availability: 'supported', name: 'Fixture registry', endpoint: { endpoint_id: uuid(10), capability: 'company.profile', inputs: [], input_values: {} } };
const sourceRequirement = { slug: 'company.profile', name: 'Company profile', subject_id: 'company' };
const search = {
  protocol_version: '2', view: 'source_search', question: 'Company profile for Financial Crime Compliance Associates', search_id: 'signed-source-snapshot', catalog_version: 'fixture-catalog',
  parsed_request: { subjects: [{ id: 'company', label: 'Financial Crime Compliance Associates', type: 'company', identifiers: {} }], capabilities: [sourceRequirement], meta: { text_sha256: 'question-hash', parsed_at: '2026-10-22T14:00:00Z' } },
  matches: [{ slug: 'company.profile', subject_id: 'company', apiosk: [sourceCandidate], coinbase: [] }],
  source_options: [{ source: sourceCandidate, subject_id: 'company', requirement: sourceRequirement, input_values: {}, reason: 'Matches your question' }],
};

for (const host of ['chatgpt', 'claude']) test(`${host}: replaying the original source list cannot erase its prepared quote or approval`, async () => {
  const x = await lifecycle(host, search, request => Response.json(request.path === '/v2/ask/prepare' ? ready : approved));
  const checkbox = x.h.nodes.get('sections').querySelectorAll('input').find(node => node.type === 'checkbox');
  await x.h.change(checkbox, true);
  await x.settle(x.button('Review 1 selected source').onclick());
  assert.equal(x.h.window.apiosk.data.state.state_ref, taskRef);
  const replay = async () => host === 'chatgpt'
    ? x.h.globals({ toolOutput: plain(search) })
    : x.h.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: plain(search) } });
  await replay();
  assert.ok(x.button(/^Approve up to /), 'host source replay preserves the price card');
  assert.equal(x.h.window.apiosk.data.state.state_ref, taskRef);
  await x.settle(x.button('Change sources').onclick());
  assert.ok(x.button('Review 1 selected source'), 'explicit local Change sources still works');
  await x.settle(x.button('Review 1 selected source').onclick());
  await x.settle(x.button(/^Approve up to /).onclick());
  await replay();
  assert.equal(x.h.window.apiosk.data.billing.authorization_active, true);
  assert.equal(x.button(/^Approve up to /), undefined);
  assert.equal(x.requests.filter(request => request.path === '/v2/approve').length, 1);
  assert.equal(x.requests[0].body.request_id, x.requests[1].body.request_id, 'unchanged selection repeats the same preparation identity');
});

test('remount restores the task created from a source list but a genuinely new search remains visible', async () => {
  const x = await lifecycle('chatgpt', search, () => Response.json(ready));
  await x.h.change(x.h.nodes.get('sections').querySelectorAll('input').find(node => node.type === 'checkbox'), true);
  await x.settle(x.button('Review 1 selected source').onclick());
  const widgetState = plain(x.h.window.openai.widgetState);
  assert.ok(widgetState.privateContent.apioskSourceSearchIdentity);
  const calls = [];
  const h = cardHarness(APIO_V2_CARD_HTML, { toolOutput: plain(search), widgetState, callTool: async name => { calls.push(name); return { structuredContent: ready }; } });
  assert.equal(h.window.apiosk.data.state.state_ref, taskRef);
  assert.ok(h.nodes.get('sections').querySelectorAll('button').some(button => /^Approve up to /.test(button.textContent)));
  assert.equal(calls.length, 0, 'restoring the quote never purchases');
  await h.globals({ toolOutput: { ...search, search_id: 'new-signed-source-snapshot' } });
  assert.equal(h.window.apiosk.data.view, 'source_search');
  assert.ok(h.nodes.get('sections').querySelectorAll('button').some(button => button.textContent === 'Review selected sources'));
  await h.globals({ toolOutput: { ...search, question: 'A different company', search_id: 'another-source-snapshot' } });
  assert.equal(h.window.apiosk.data.question, 'A different company');
  assert.equal(calls.length, 0);
});
