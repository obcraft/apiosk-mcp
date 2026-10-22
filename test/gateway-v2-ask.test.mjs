import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import schemas from '../src/gateway-v2-contracts.json' with { type: 'json' };
import { NO_RESULTS } from '../src/gateway-v2-ask.mjs';

const env = { APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082', APIOSK_CONNECT_TOKEN: 'fixture' };
const question = 'What time is it in Amsterdam? Check via Apiosk.';
// What Apiosk's own parser reads from that question.
const parsed = { language: 'en', subjects: [{ id: 's1', label: 'Amsterdam', type: 'city', identifiers: {} }],
  capabilities: [{ slug: 'location.time.current', name: 'Current local time', description: 'The current local time in a city.', domain: 'location', inputs: ['city'], outputs: ['local_time'], subject_id: 's1', source_hint: null, confidence: 0.9 }],
  deliverable: { format: 'chat', operations: [] } };
const endpoint = { endpoint_id: '7b0f4c0e-7a55-4a55-9d6e-0f3e7f0a1b2c', capability: 'location.time.current', name: 'World time', description: 'Local time',
  source: { slug: 'worldtime', name: 'World Time', logo_url: null, url: 'https://example.test' }, inputs: [{ field: 'location.city', required: true, schema: { type: 'string' } }],
  input_values: { 'location.city': 'Amsterdam' }, missing_inputs: [],
  lookup: null, price: { currency: 'USDC', provider_atomic: '1000', buyer_atomic: '1100' } };
// The public Ask answer: the App's parse and both origin searches, no task.
const answer = (apiosk, extra = {}) => ({ status: 'choices', question, parsed_request: parsed, model: 'fixture', attempts: 1, timing: { parse_ms: 4 }, apis: [],
  searches: { apiosk: { apiosk_sources_searched: 112, catalog_version: 'v1', timing: { search_ms: 3 }, ...apiosk } }, errors: [], execution: { method: 'POST', path: '/v2/execute' }, ...extra });

test('apiosk_ask takes the question, never a chatbot-filled capability object', async () => {
  const tools = await createApioskMcpRuntime({ env }).listTools();
  const ask = tools.find(t => t.name === 'apiosk_ask');
  assert.deepEqual(ask.inputSchema, schemas.ask);
  assert.deepEqual(ask.inputSchema.required, ['question']);
  assert.equal(ask.inputSchema.properties.parsed_request, undefined);
  assert.equal(ask.title, 'Ask one source');
  assert.equal(tools.some(t => ['apiosk_search', 'apiosk_prepare'].includes(t.name)), false);
});

test('asking sends only the question to the public Ask route and returns each endpoint input contract', async () => {
  let request;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) };
    return Response.json(answer({ matches: [{ slug: 'location.time.current', query: 'q', operations: ['location.time.current'],
      apiosk: [{ origin: 'apiosk', name: 'World time', description: 'Local time', source_slug: 'worldtime', capability: 'location.time.current', endpoint_id: endpoint.endpoint_id, url: null, method: 'GET', price: '0.001100 USD', network: null, calls_30d: null, availability: 'supported', endpoint }],
      coinbase: [], coinbase_status: 'pending' }] }));
  } });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(request.path, '/v2/ask');
  assert.equal(request.method, 'POST');
  // The public route denies unknown fields: the question and nothing else.
  assert.deepEqual(request.body, { question });
  const view = result.structuredContent;
  assert.equal(view.view, 'source_search');
  assert.deepEqual(view.parsed_request, parsed);
  assert.deepEqual(view.matches[0].apiosk[0].endpoint.inputs, endpoint.inputs);
  assert.deepEqual(view.matches[0].apiosk[0].endpoint.input_values, { 'location.city': 'Amsterdam' });
  assert.equal(view.apiosk_sources_searched, 112);
  assert.equal(view.timing, undefined);
  assert.match(view.notice, /call apiosk_ask again with the same question/);
});

test('asking with a chosen candidate prepares only that endpoint and returns the discover task shape', async () => {
  let request;
  const task = { protocol_version: '2', request_id: '1b2c3d4e-0000-4000-8000-000000000001', status: 'requires_approval', intent_ref: null, context_view: {}, proposal: null, result: null, billing: null, next_actions: [], state: null, errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, body: JSON.parse(options.body) };
    return Response.json(task);
  } });
  const result = await runtime.callTool('apiosk_ask', { question, endpoint_id: endpoint.endpoint_id, capability: 'location.time.current', input: { 'location.city': 'Amsterdam' } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(request.path, '/v2/ask-v2/prepare');
  assert.deepEqual(Object.keys(request.body).sort(), ['capability', 'endpoint_id', 'input', 'question', 'request_id']);
  assert.deepEqual(request.body.input, { 'location.city': 'Amsterdam' });
  assert.equal(request.body.question, question);
  assert.equal(result.structuredContent.status, 'requires_approval');
});

test('an unusable Ask reply is reported, never shown as an empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ unexpected: true }) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, true);
  assert.notEqual(result.structuredContent.message, NO_RESULTS);
});

test('a public Ask refusal keeps its code and message', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ error: { code: 'rate_limit_exceeded', message: 'Too many requests are running right now.' } }, { status: 429 }) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'rate_limit_exceeded');
  assert.equal(result.structuredContent.message, 'Too many requests are running right now.');
  assert.equal(result.structuredContent.error, undefined);
});

test('a completed empty source search has the exact no-results message', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [] }, { status: 'needs_input' })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.message, NO_RESULTS);
  assert.equal(result.structuredContent.matches[0].slug, parsed.capabilities[0].slug);
});

test('an unavailable Apiosk search is not presented as a confirmed empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ ...answer({}), searches: {}, status: 'partial', errors: [{ origin: 'apiosk', code: 'search_unavailable' }] }) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.message, 'Some sources could not be searched. Try again shortly.');
});

test('an incomplete external search is not presented as a confirmed empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [{ slug: parsed.capabilities[0].slug, apiosk: [], coinbase: [], coinbase_status: 'unavailable' }] })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.structuredContent.message, 'Some sources could not be searched. Try again shortly.');
});

test('completed Coinbase search replaces the placeholder and preserves its executable candidate', async () => {
  const candidate = { origin: 'coinbase', name: 'World time', availability: 'supported', endpoint };
  const gatewayAnswer = answer({ matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's1', apiosk: [], coinbase: [], coinbase_status: 'pending' }] });
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's1', coinbase: [candidate], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.deepEqual(view.matches[0].coinbase, [candidate]);
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.equal(view.message, undefined);
});

test('a completed empty external search does not tell the host to retry a pending search', async () => {
  const gatewayAnswer = answer({ matches: [{ slug: parsed.capabilities[0].slug, apiosk: [], coinbase: [], coinbase_status: 'pending' }] });
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, coinbase: [], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.equal(view.message, NO_RESULTS);
});

test('external results cannot cross subjects or conceal an origin failure', async () => {
  const request = { ...parsed, subjects: [...parsed.subjects, { ...parsed.subjects[0], id: 's2', label: 'Paris' }],
    capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], subject_id: 's2' }] };
  const gatewayAnswer = answer({ matches: request.capabilities.map(cap => ({ slug: cap.slug, subject_id: cap.subject_id, apiosk: [], coinbase: [], coinbase_status: 'pending' })) }, { parsed_request: request });
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's2', coinbase: [{ name: 'Paris time' }], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  let view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.deepEqual(view.matches[0].coinbase, []);
  assert.equal(view.matches[0].coinbase_status, 'unavailable');
  assert.equal(view.matches[1].coinbase[0].name, 'Paris time');
  delete gatewayAnswer.searches.coinbase;
  gatewayAnswer.errors = [{ origin: 'coinbase', code: 'search_unavailable' }];
  view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.ok(view.matches.every(match => match.coinbase_status === 'unavailable'));
  assert.match(view.message, /could not be searched/);
});

test('available external candidates survive an Apiosk origin outage with an honest partial-search message', async () => {
  const gatewayAnswer = answer({}, { status: 'partial', errors: [{ origin: 'apiosk', code: 'search_unavailable' }] });
  delete gatewayAnswer.searches.apiosk;
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's1', coinbase: [{ name: 'World time' }], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.equal(view.matches[0].coinbase[0].name, 'World time');
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.match(view.message, /could not be searched/);
});

test('preparing preserves the gateway clarification and does not imply approval without a plan', async () => {
  const task = { protocol_version: '2', status: 'needs_input', context_view: { conversation: [{ question: 'Time in a city', reply: 'Which city?' }] }, proposal: null, result: null, state: { state_ref: 'saved-task' }, next_actions: [{ kind: 'supply_input', label: 'City' }], errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(task) });
  const result = await runtime.callTool('apiosk_ask', { question, endpoint_id: endpoint.endpoint_id, input: {} });
  assert.deepEqual(result.structuredContent, task);
  assert.match(result.content.map(item => item.text).join('\n'), /actual missing detail/);
  assert.doesNotMatch(result.content.map(item => item.text).join('\n'), /card can approve/);
});

test('unsupported discovery preserves matching sources without clarification guidance', async () => {
  const task = { protocol_version: '2', status: 'unsupported', context_view: { capability_intake: { parsed_request: parsed, matches: [{ slug: parsed.capabilities[0].slug, apiosk: [{ name: 'World Time', availability: 'discovery_only' }], coinbase: [] }] } }, proposal: null, result: null, next_actions: [], state: { state_ref: 'saved-task' }, errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(task) });
  const result = await runtime.callTool('apiosk_discover', { question: 'Time in Amsterdam' });
  assert.deepEqual(result.structuredContent, task);
  const text = result.content.map(item => item.text).join('\n');
  assert.match(text, /show those sources with their actual availability/);
  assert.doesNotMatch(text, /task needs an actual missing detail|card can approve/);
});

test('a missing check remains visible when another part of the professional request has matches', async () => {
  const request = { ...parsed, capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], slug: 'company.credit.score', name: 'Credit score' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [
    { slug: 'location.time.current', apiosk: [{ availability: 'supported', endpoint_id: endpoint.endpoint_id, endpoint }], coinbase: [], coinbase_status: 'complete' },
  ] }, { parsed_request: request })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.matches[1], { slug: 'company.credit.score', query: 'Credit score', subject_id: 's1', apiosk: [], coinbase: [], coinbase_status: 'complete' });
  assert.match(result.structuredContent.notice, /apiosk_discover once with the complete question/);
  assert.match(result.structuredContent.notice, /not necessarily the complete request/);
});

test('a match for one subject does not hide the same missing check for another subject', async () => {
  const request = { ...parsed, subjects: [...parsed.subjects, { ...parsed.subjects[0], id: 's2', label: 'Paris' }],
    capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], subject_id: 's2' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [
    { slug: 'location.time.current', subject_id: 's1', apiosk: [{ availability: 'supported', endpoint_id: endpoint.endpoint_id, endpoint }], coinbase: [], coinbase_status: 'complete' },
  ] }, { parsed_request: request })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.matches.length, 2);
  assert.equal(result.structuredContent.matches[1].subject_id, 's2');
  assert.deepEqual(result.structuredContent.matches[1].apiosk, []);
});
