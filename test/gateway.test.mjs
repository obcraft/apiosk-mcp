import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayClient, GatewayError } from '../src/gateway.mjs';

const token = 'apk_access_test_credential';
const workspaceId = '12345678-1234-1234-1234-123456789012';
const client = (options = {}) => new GatewayClient({ token, workspaceId: null, ...options });
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
