import test from 'node:test';
import assert from 'node:assert/strict';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { externalDefinitions, externalRequest, presentExternal } from '../src/gateway-v2-external.mjs';
import { createApioskMcpRuntime } from '../src/runtime.mjs';

const id = '7b0f4c0e-7a55-4a55-9d6e-0f3e7f0a1b2c';
const quote = '2b0f4c0e-7a55-4a55-9d6e-0f3e7f0a1b2c';
const api_id = 'bazaar:fixture';
const source = { resource: 'https://fixture.example/data', method: 'GET', name: 'Fixture source', inputs: [], provider_atomic: 100, total_atomic: 115 };
const definitions = externalDefinitions({ error_code: { type: 'string' }, message: { type: 'string' } });
const validator = new AjvJsonSchemaValidator();
const valid = (name, args) => validator.getValidator(definitions.find(tool => tool.name === name).inputSchema)(args).valid;

test('public external tool keeps inspection, preparation and recovery separate from approval', () => {
  const inspect = { action: 'source', api_id };
  const prepare = { action: 'prepare', api_id, request_id: id, input: { city: 'Amsterdam' } };
  const status = { action: 'status', purchase_id: id };
  for (const args of [inspect, prepare, status]) assert.equal(valid('apiosk_external', args), true);
  assert.deepEqual(externalRequest('apiosk_external', inspect), { method: 'POST', path: '/v2/ask/external/source', kind: 'source', body: { api_id } });
  assert.deepEqual(externalRequest('apiosk_external', prepare), { method: 'POST', path: '/v2/ask/external/prepare', kind: 'purchase', body: { request_id: id, api_id, input: { city: 'Amsterdam' } } });
  assert.deepEqual(externalRequest('apiosk_external', status), { method: 'GET', path: `/v2/ask/external/${id}`, kind: 'purchase' });
  for (const args of [{ ...prepare, quote_ref: quote }, { ...prepare, max_total_atomic: '115' }, { ...status, input: {} }, { action: 'approve', purchase_id: id }]) {
    assert.equal(valid('apiosk_external', args), false);
  }
});

test('private approval binds the saved quote and cannot replace source or inputs', () => {
  const args = { purchase_id: id, quote_ref: quote, max_total_atomic: '115' };
  assert.equal(valid('apiosk_external_approve', args), true);
  assert.equal(valid('apiosk_external_approve', { ...args, api_id }), false);
  assert.equal(valid('apiosk_external_approve', { ...args, input: {} }), false);
  assert.deepEqual(externalRequest('apiosk_external_approve', args), { method: 'POST', path: `/v2/ask/external/${id}/authorize`, kind: 'purchase', body: { quote_ref: quote, max_total_atomic: '115' } });
});

test('purchase response keeps false, null, truncation and source currency exactly', () => {
  const request = externalRequest('apiosk_external', { action: 'status', purchase_id: id });
  for (const result of [null, false, { currency: 'EUR', amount: 12 }]) {
    const presented = presentExternal({ purchase_id: id, status: 'succeeded', source, quote: { quote_ref: quote, max_total_atomic: '115', currency: 'USDC', expires_at: '2026-10-24T12:00:00Z' },
      result, result_present: true, result_truncated: true, billing: { status: 'charged', charged_micro_usd: 115 }, error: null }, request, { purchase_id: id });
    assert.deepEqual(presented.result, result);
    assert.equal(presented.result_present, true);
    assert.equal(presented.result_truncated, true);
    assert.equal(presented.quote.currency, 'USD');
    assert.equal(validator.getValidator(definitions[0].outputSchema)(presented).valid, true);
  }
});

test('rejects mismatched purchase recovery and preserves canonical offer fields', () => {
  const request = externalRequest('apiosk_external', { action: 'status', purchase_id: id });
  assert.throws(() => presentExternal({ purchase_id: quote, status: 'requires_approval', source, quote: { quote_ref: quote, max_total_atomic: '115' } }, request, { purchase_id: id }), /Unexpected protocol/);
  const inspect = externalRequest('apiosk_external', { action: 'source', api_id });
  const presented = presentExternal(source, inspect, { api_id });
  assert.deepEqual(presented.source, source);
  assert.equal(validator.getValidator(definitions[0].outputSchema)(presented).valid, true);
});

const env = { APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082', APIOSK_CONNECT_TOKEN: 'fixture' };
const purchase = () => ({ purchase_id: id, status: 'requires_approval', source,
  quote: { quote_ref: quote, max_total_atomic: '115', currency: 'USDC', expires_at: '2026-10-24T12:00:00Z' },
  result: null, result_present: false, result_truncated: false, billing: null, error: null });

test('runtime exposes public review and card-only approval with exact free and paid routes', async () => {
  const requests = [];
  let answer = source;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, method: options.method, body: options.body && JSON.parse(options.body) });
    return Response.json(answer);
  } });
  const tools = await runtime.listTools();
  assert.equal(tools.find(tool => tool.name === 'apiosk_external')._meta['openai/visibility'], 'public');
  const approve = tools.find(tool => tool.name === 'apiosk_external_approve');
  assert.equal(approve._meta['openai/visibility'], 'private');
  assert.deepEqual(approve._meta.ui.visibility, ['app']);
  const inspected = await runtime.callTool('apiosk_external', { action: 'source', api_id });
  assert.equal(inspected.structuredContent.view, 'external_source');
  answer = purchase();
  const prepared = await runtime.callTool('apiosk_external', { action: 'prepare', api_id, input: {}, request_id: id });
  assert.equal(prepared.structuredContent.status, 'requires_approval');
  assert.equal(prepared.structuredContent.quote.currency, 'USD');
  await runtime.callTool('apiosk_external', { action: 'status', purchase_id: id });
  assert.equal(requests.length, 3, 'none of the public actions implicitly approves');
  await runtime.callTool('apiosk_external_approve', { purchase_id: id, quote_ref: quote, max_total_atomic: '115' });
  assert.deepEqual(requests, [
    { path: '/v2/ask/external/source', method: 'POST', body: { api_id } },
    { path: '/v2/ask/external/prepare', method: 'POST', body: { api_id, input: {}, request_id: id } },
    { path: `/v2/ask/external/${id}`, method: 'GET', body: undefined },
    { path: `/v2/ask/external/${id}/authorize`, method: 'POST', body: { quote_ref: quote, max_total_atomic: '115' } },
  ]);
});

test('runtime preserves the provider result currency, null and truncation independently of billing', async () => {
  const answer = { ...purchase(), status: 'succeeded', result: { currency: 'USDC', amount: 12 }, result_present: true, result_truncated: true,
    billing: { status: 'charged', charged_micro_usd: 115 } };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer) });
  const reply = await runtime.callTool('apiosk_external', { action: 'status', purchase_id: id });
  assert.deepEqual(reply.structuredContent.result, answer.result, 'payment display must not rewrite source data');
  assert.equal(reply.structuredContent.result_truncated, true);
  answer.result = null;
  const nullReply = await runtime.callTool('apiosk_external', { action: 'status', purchase_id: id });
  assert.equal(nullReply.structuredContent.result, null);
  assert.equal(nullReply.structuredContent.result_present, true);
});

test('runtime never retries uncertain preparation or approval and returns the durable purchase reference', async () => {
  const calls = [];
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    calls.push({ path: new URL(url).pathname, method: options.method });
    throw new Error('transport failed');
  } });
  for (const [name, args] of [
    ['apiosk_external', { action: 'prepare', api_id, input: {}, request_id: id }],
    ['apiosk_external', { action: 'status', purchase_id: id }],
    ['apiosk_external_approve', { purchase_id: id, quote_ref: quote, max_total_atomic: '115' }],
  ]) {
    const reply = await runtime.callTool(name, args);
    assert.equal(reply.isError, true);
    assert.equal(reply.structuredContent.recover_purchase_id, id);
  }
  assert.equal(calls.length, 3);
  assert.equal(calls[1].method, 'GET');
});
