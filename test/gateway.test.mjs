import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayClient, GatewayError } from '../src/gateway.mjs';

const token = 'apk_access_test_credential';
const workspaceId = '12345678-1234-1234-1234-123456789012';
const client = (options = {}) => new GatewayClient({ baseUrl: 'http://127.0.0.1:8082', token, workspaceId: null, ...options });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('uses exact Gateway auth/workspace headers and preserves signed request payload', async () => {
  let request;
  const gateway = client({ workspaceId, fetchImpl: async (url, options) => { request = { url, ...options }; return json({ status: 'ready' }); } });
  const body = { request_id: 'stable-id', state: { state_token: 'opaque' }, input: { kvk: '30204462' } };
  assert.deepEqual(await gateway.request('/v2/ask/prepare', { method: 'POST', body, headers: { 'Idempotency-Key': 'stable-id' } }), { status: 'ready' });
  assert.equal(request.url.href, 'http://127.0.0.1:8082/v2/ask/prepare');
  assert.equal(request.headers.get('authorization'), `Bearer ${token}`);
  assert.equal(request.headers.get('x-apiosk-workspace'), workspaceId);
  assert.equal(request.headers.get('idempotency-key'), 'stable-id');
  assert.equal(request.redirect, 'error');
  assert.deepEqual(JSON.parse(request.body), body);
  assert.equal(gateway.credentialKind, 'connection');
  assert.equal(JSON.stringify(gateway).includes(token), false);
});

test('legacy connect credentials retain connection routing and App JWTs retain session routing', () => {
  for (const token of ['apk_access_fixture', 'apk_live_fixture', 'apk_org_live_fixture', 'aw_live_fixture', 'aw_test_fixture', 'AW_LIVE_fixture']) {
    assert.equal(client({ token }).credentialKind, 'connection');
  }
  assert.equal(client({ token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.signature' }).credentialKind, 'session');
  assert.equal(client({ token: null }).credentialKind, 'none');
});

test('direct Gateway construction follows the canonical V2 URL and ignores the OAuth Gateway URL', () => {
  const previous = { v2: process.env.APIOSK_GATEWAY_V2_URL, oauth: process.env.APIOSK_GATEWAY_URL };
  try {
    process.env.APIOSK_GATEWAY_URL = 'https://oauth.example/agent-gateway';
    process.env.APIOSK_GATEWAY_V2_URL = 'https://data.example';
    assert.equal(new GatewayClient({ token, workspaceId: null }).baseUrl, 'https://data.example');
    delete process.env.APIOSK_GATEWAY_V2_URL;
    assert.equal(new GatewayClient({ token, workspaceId: null }).baseUrl, 'https://gateway.apiosk.com');
  } finally {
    if (previous.v2 === undefined) delete process.env.APIOSK_GATEWAY_V2_URL;
    else process.env.APIOSK_GATEWAY_V2_URL = previous.v2;
    if (previous.oauth === undefined) delete process.env.APIOSK_GATEWAY_URL;
    else process.env.APIOSK_GATEWAY_URL = previous.oauth;
  }
});

test('display context preserves caller auth and workspace, expires after 30 seconds and resists caller mutation', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const requests = [];
  const gateway = client({ workspaceId, fetchImpl: async (url, options) => {
    requests.push({ url, ...options });
    return json({ money_display: { base_currency: 'USD', currency: 'EUR', rate: requests.length === 1 ? '0.92' : '0.93' } });
  } });
  const first = await gateway.displayContext();
  assert.equal(requests[0].url.pathname, '/v2/display-context');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].body, undefined);
  assert.equal(requests[0].headers.get('authorization'), `Bearer ${token}`);
  assert.equal(requests[0].headers.get('x-apiosk-workspace'), workspaceId);
  first.money_display.currency = 'GBP';
  now += 29_999;
  const cached = await gateway.displayContext();
  assert.equal(cached.money_display.currency, 'EUR');
  cached.money_display.rate = '9';
  assert.equal((await gateway.displayContext()).money_display.rate, '0.92');
  assert.equal(requests.length, 1);
  now += 1;
  assert.equal((await gateway.displayContext()).money_display.rate, '0.93');
  assert.equal(requests.length, 2);
});

test('display context cache is never shared between credential instances', async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const authorization = options.headers.get('authorization'); calls.push(authorization);
    return json({ money_display: { base_currency: 'USD', currency: authorization.endsWith('buyer-a') ? 'EUR' : 'GBP', rate: '0.9' } });
  };
  const a = client({ token: 'apk_access_buyer-a', fetchImpl }), b = client({ token: 'apk_access_buyer-b', fetchImpl });
  assert.equal((await a.displayContext()).money_display.currency, 'EUR');
  assert.equal((await b.displayContext()).money_display.currency, 'GBP');
  assert.equal((await a.displayContext()).money_display.currency, 'EUR');
  assert.deepEqual(calls, ['Bearer apk_access_buyer-a', 'Bearer apk_access_buyer-b']);
});

test('optional display-context failures are not cached and cancellation cannot return cached data', async () => {
  let calls = 0;
  const gateway = client({ fetchImpl: async () => {
    calls++;
    if (calls === 1) return json({ errors: [{ code: 'display_unavailable', message: 'Display context unavailable' }] }, 503);
    if (calls === 2) return json({ unexpected: true });
    return json({ money_display: { base_currency: 'USD', currency: 'EUR', rate: '0.92' } });
  } });
  await assert.rejects(gateway.displayContext(), error => error.code === 'display_unavailable');
  await assert.rejects(gateway.displayContext(), error => error.code === 'invalid_display_context');
  assert.equal((await gateway.displayContext()).money_display.currency, 'EUR');
  assert.equal(calls, 3);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(gateway.displayContext(controller.signal), error => error.code === 'gateway_aborted');
  assert.equal(calls, 3);
});

test('never retries an ambiguous mutation, including authentication and server errors', async () => {
  for (const status of [401, 429, 500, 503]) {
    let calls = 0;
    const gateway = client({ fetchImpl: async () => { calls++; return json({ errors: [{ code: 'refused', message: 'Read saved status.' }] }, status); } });
    await assert.rejects(gateway.request('/v2/approve', { method: 'POST', body: {} }), error => {
      assert.equal(error.status, status); assert.equal(error.code, 'refused');
      assert.equal(error.outcomeUnknown, status >= 500); assert.equal(error.retryable, false);
      return true;
    });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(client({ fetchImpl: async () => { calls++; throw new Error(`secret ${token}`); } })
    .request('/v2/approve', { body: {} }), error => error.outcomeUnknown && !error.message.includes(token));
  assert.equal(calls, 1);
});

test('does not expose credentials or raw response bodies through errors', async () => {
  const gateway = client({ fetchImpl: async () => json({ errors: [{ code: 'invalid_auth', message: `failed ${token}; Bearer other-secret; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzIn0.sig` }], token }, 401) });
  await assert.rejects(gateway.request('/v2/tasks/id'), error => {
    const rendered = JSON.stringify(error);
    assert.equal(rendered.includes(token), false);
    assert.equal(rendered.includes('other-secret'), false);
    assert.equal(rendered.includes('eyJ'), false);
    assert.equal(Object.hasOwn(error, 'body'), false);
    return error instanceof GatewayError;
  });
});

test('rejects credential exfiltration paths, header overrides and insecure origins', async () => {
  for (const baseUrl of ['http://example.org', 'https://user:password@example.org', 'https://example.org/?secret=1', 'https://example.org/api']) {
    assert.throws(() => client({ baseUrl }), GatewayError);
  }
  let calls = 0;
  const gateway = client({ fetchImpl: async () => { calls++; return json({}); } });
  for (const path of ['https://evil.invalid/v2/ask', '//evil.invalid/v2/ask', '/\\evil.invalid', '/v2/ask\n', '/v2/ask#fragment', '/%5cevil']) {
    await assert.rejects(gateway.request(path), error => error.code === 'invalid_gateway_path');
  }
  for (const headers of [{ authorization: 'Bearer stolen' }, { 'x-apiosk-workspace': workspaceId }, { cookie: 'private' }]) {
    await assert.rejects(gateway.request('/v2/tasks', { headers }), error => error.code === 'invalid_gateway_headers');
  }
  assert.equal(calls, 0);
});

test('explicit no-credential construction cannot silently inherit environment credentials', async () => {
  let calls = 0;
  const gateway = client({ token: null, fetchImpl: async (_url, options) => { calls++; assert.equal(options.headers.has('authorization'), false); return json({ service: 'gateway' }); } });
  await assert.rejects(gateway.request('/v2/tasks'), error => error.code === 'authentication_required');
  assert.deepEqual(await gateway.request('/health'), { service: 'gateway' });
  assert.equal(calls, 1);
  assert.throws(() => client({ token: 'apk_org_live_example', workspaceId }), /cannot select a workspace/);
});

test('separate clients do not mix HTTP caller credentials', async () => {
  const seen = [];
  const fetchImpl = async (_url, options) => { seen.push(options.headers.get('authorization')); return json({}); };
  await Promise.all([client({ token: 'caller-A', fetchImpl }).request('/v2/tasks'), client({ token: 'caller-B', fetchImpl }).request('/v2/tasks')]);
  assert.deepEqual(seen.sort(), ['Bearer caller-A', 'Bearer caller-B']);
});

test('bounded NDJSON streams preserve split UTF-8 and final snapshot', async () => {
  const payload = new TextEncoder().encode('{"context_status":"loading","name":"é"}\n{"context_status":"completed"}\n');
  const snapshots = [];
  const gateway = client({ fetchImpl: async (_url, options) => {
    assert.equal(options.headers.get('accept'), 'application/x-ndjson');
    return new Response(new ReadableStream({ start(controller) { for (const byte of payload) controller.enqueue(new Uint8Array([byte])); controller.close(); } }), { headers: { 'content-type': 'application/x-ndjson' } });
  } });
  assert.deepEqual(await gateway.request('/v2/ask-v2/parse', { body: { question: 'test' }, onProgress: value => snapshots.push(value) }), { context_status: 'completed' });
  assert.deepEqual(snapshots, [{ context_status: 'loading', name: 'é' }, { context_status: 'completed' }]);
});

test('SSE parses data records without interpreting comments or event names', async () => {
  const snapshots = [];
  const gateway = client({ fetchImpl: async () => new Response(': keepalive\r\nevent: task\r\ndata: {"status":"running"}\r\n\r\nevent: task\ndata: {"status":"succeeded"}\n\n', { headers: { 'content-type': 'text/event-stream' } }) });
  const result = await gateway.request('/v2/tasks/id/events?capability=opaque', { responseType: 'sse', onProgress: value => snapshots.push(value) });
  assert.equal(result.status, 'succeeded'); assert.equal(snapshots.length, 2);
});

test('limits declared and streamed bodies, and rejects malformed progress without retry', async () => {
  for (const headers of [{ 'content-length': '200' }, {}]) {
    const gateway = client({ maxResponseBytes: 32, fetchImpl: async () => new Response('x'.repeat(200), { headers }) });
    await assert.rejects(gateway.request('/v2/tasks/id'), error => error.code === 'gateway_response_too_large');
  }
  const gateway = client({ fetchImpl: async () => new Response('{"valid":true}\nnope\n', { headers: { 'content-type': 'application/x-ndjson' } }) });
  const snapshots = [];
  await assert.rejects(gateway.request('/v2/ask-v2/parse', { body: {}, onProgress: value => snapshots.push(value) }), error => error.code === 'gateway_invalid_response' && error.outcomeUnknown);
  assert.deepEqual(snapshots, [{ valid: true }]);
});

test('timeouts and caller cancellation terminate fetch and body reading', async () => {
  const gateway = client({ timeoutMs: 10, fetchImpl: async () => new Promise(() => {}) });
  await assert.rejects(gateway.request('/v2/approve', { body: {} }), error => error.code === 'gateway_timeout' && error.outcomeUnknown);
  const controller = new AbortController();
  const streamed = client({ fetchImpl: async () => new Response(new ReadableStream({ start() {} })) });
  const pending = streamed.request('/v2/tasks/id', { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, error => error.code === 'gateway_aborted' && !error.outcomeUnknown);
});

test('keeps plain-text HTTP rejection status and supports bounded binary reports', async () => {
  await assert.rejects(client({ fetchImpl: async () => new Response('upstream failed', { status: 502 }) }).request('/v2/tasks/id'), error => error.status === 502 && error.retryable);
  const gateway = client({ fetchImpl: async () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { 'content-type': 'application/pdf' } }) });
  assert.deepEqual(await gateway.request('/v2/tasks/id/report.pdf', { responseType: 'bytes' }), new Uint8Array([37, 80, 68, 70]));
});
