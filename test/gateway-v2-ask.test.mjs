import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import schemas from '../src/gateway-v2-contracts.json' with { type: 'json' };

const env = { APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082', APIOSK_CONNECT_TOKEN: 'fixture' };
// What a chatbot fills in for "what time is it in Amsterdam? check via Apiosk".
const parsed = { language: 'en', subjects: [{ id: 's1', label: 'Amsterdam', type: 'city', identifiers: {} }],
  capabilities: [{ slug: 'location.time.current', name: 'Current local time', description: 'The current local time in a city.', domain: 'location', inputs: ['city'], outputs: ['local_time'], subject_id: 's1', source_hint: null, confidence: 0.9 }],
  deliverable: { format: 'chat', operations: [] } };
const endpoint = { endpoint_id: '7b0f4c0e-7a55-4a55-9d6e-0f3e7f0a1b2c', capability: 'location.time.current', name: 'World time', description: 'Local time',
  source: { slug: 'worldtime', name: 'World Time', logo_url: null, url: 'https://example.test' }, inputs: [{ field: 'location.city', required: true, schema: { type: 'string' } }],
  lookup: null, price: { currency: 'USDC', provider_atomic: '1000', buyer_atomic: '1100' } };

test('the chatbot fills in the Ask parser schema exactly', async () => {
  const tools = await createApioskMcpRuntime({ env }).listTools();
  assert.deepEqual(tools.find(t => t.name === 'apiosk_search').inputSchema, schemas.search);
  assert.deepEqual(tools.find(t => t.name === 'apiosk_prepare').inputSchema, schemas.prepare);
  assert.equal(tools.find(t => t.name === 'apiosk_search').annotations.readOnlyHint, true);
});

test('search sends the filled-in object to the Ask search and returns each endpoint input contract', async () => {
  let request;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) };
    return Response.json({ matches: [{ slug: 'location.time.current', query: 'q', operations: ['location.time.current'],
      apiosk: [{ origin: 'apiosk', name: 'World time', description: 'Local time', source_slug: 'worldtime', capability: 'location.time.current', endpoint_id: endpoint.endpoint_id, url: null, method: 'GET', price: '0.001100 USD', network: null, calls_30d: null, availability: 'supported', endpoint }],
      coinbase: [], coinbase_status: 'pending' }], apiosk_sources_searched: 112, catalog_version: 'v1', timing: { search_ms: 3 } });
  } });
  const result = await runtime.callTool('apiosk_search', { parsed_request: parsed });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(request.path, '/v2/ask-v2/search');
  assert.equal(request.method, 'POST');
  assert.deepEqual(Object.keys(request.body).sort(), ['origin', 'parsed_request']);
  assert.equal(request.body.origin, 'apiosk');
  const { meta, ...sent } = request.body.parsed_request;
  assert.deepEqual(sent, parsed);
  assert.equal(meta.model, 'connected-chatbot');
  const view = result.structuredContent;
  assert.equal(view.view, 'source_search');
  assert.deepEqual(view.parsed_request, parsed);
  assert.deepEqual(view.matches[0].apiosk[0].endpoint.inputs, endpoint.inputs);
  assert.equal(view.apiosk_sources_searched, 112);
  assert.equal(view.timing, undefined);
});

test('prepare sends only the chosen endpoint and its inputs, and returns the discover task shape', async () => {
  let request;
  const task = { protocol_version: '2', request_id: '1b2c3d4e-0000-4000-8000-000000000001', status: 'requires_approval', intent_ref: null, context_view: {}, proposal: null, result: null, billing: null, next_actions: [], state: null, errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, body: JSON.parse(options.body) };
    return Response.json(task);
  } });
  const result = await runtime.callTool('apiosk_prepare', { endpoint_id: endpoint.endpoint_id, capability: 'location.time.current', input: { 'location.city': 'Amsterdam' } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(request.path, '/v2/ask-v2/prepare');
  assert.deepEqual(Object.keys(request.body).sort(), ['capability', 'endpoint_id', 'input', 'request_id']);
  assert.deepEqual(request.body.input, { 'location.city': 'Amsterdam' });
  assert.equal(result.structuredContent.status, 'requires_approval');
});

test('an unusable search reply is reported, never shown as an empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ unexpected: true }) });
  const result = await runtime.callTool('apiosk_search', { parsed_request: parsed });
  assert.equal(result.isError, true);
});
