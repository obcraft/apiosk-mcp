import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const catalog = { protocol_version: '2', sources: [{ slug: 'fixture', name: 'Fixture source' }], total: 1, offset: 0, next_offset: null, categories: [], sectors: [], notice: '' };

test('Databricks-style HTTP clients: DCR/PKCE/refresh, bearer credentials, read-only tools and revoked access', { timeout: 30000 }, async t => {
  let allowed = true;
  let invalidUpstream = false;
  let redirectUpstream = false;
  const requests = [];
  const upstream = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/oauth/token' && req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const grant = JSON.parse(body);
      assert.equal(grant.client_id, 'apiosk-mcp');
      res.end(JSON.stringify({ access_token: 'apk_access_fixture', refresh_token: 'fixture-refresh', expires_in: 3600 }));
    } else if (req.url.startsWith('/v2/sources') && req.method === 'GET') {
      if (redirectUpstream) {
        res.writeHead(302, { location: '/must-not-receive-credentials' }); res.end(); return;
      }
      if (invalidUpstream) { res.end('{}'); return; }
      const valid = allowed && /^Bearer apk_(access_|live_|org_live_)fixture$/.test(req.headers.authorization || '');
      res.statusCode = valid ? 200 : 401;
      res.end(JSON.stringify(valid ? catalog : { error: 'unauthorized' }));
    } else {
      res.statusCode = 404; res.end('{}');
    }
  });
  const upstreamPort = await listen(upstream);
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    // Do not inherit live database/observability credentials into this fixture.
    env: { PATH: process.env.PATH, NODE_ENV: 'test', PORT: String(port), APIOSK_MCP_BIND_HOST: '127.0.0.1',
      APIOSK_MCP_PUBLIC_BASE_URL: origin, APIOSK_MCP_OAUTH_SECRET: 'databricks-local-test-only',
      APIOSK_GATEWAY_URL: `http://127.0.0.1:${upstreamPort}`, APIOSK_GATEWAY_V2_URL: `http://127.0.0.1:${upstreamPort}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.resume(); child.stderr.resume();
  t.after(async () => { if (child.exitCode === null) { const done = once(child, 'exit'); child.kill(); await done; } });
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${origin}/health`)).ok) break; } catch {}
    assert.ok(attempt < 100 && child.exitCode === null, 'HTTP server must start');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const metadata = await fetch(`${origin}/.well-known/oauth-authorization-server`).then(r => r.json());
  const resource = await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`).then(r => r.json());
  assert.equal(resource.resource, `${origin}/mcp`);
  assert.ok(metadata.code_challenge_methods_supported.includes('S256'));
  const initialize = token => fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'databricks-test', version: '1' } } }),
  });
  const anonymous = await initialize();
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  await anonymous.body.cancel();

  const callback = 'https://fixture.cloud.databricks.com/login/oauth/http.html';
  const registered = await fetch(metadata.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Databricks', redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }) });
  assert.equal(registered.status, 201);
  const registration = await registered.json();
  const verifier = crypto.randomBytes(32).toString('base64url');
  const authorize = new URL(metadata.authorization_endpoint);
  authorize.search = new URLSearchParams({ client_id: registration.client_id, redirect_uri: callback, response_type: 'code', scope: 'mcp:tools offline_access', state: 'databricks-state', resource: `${origin}/mcp`, code_challenge_method: 'S256', code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }).toString();
  const handoff = await fetch(authorize, { redirect: 'manual' });
  assert.equal(handoff.status, 302);
  const handoffUrl = new URL(handoff.headers.get('location'));
  await handoff.body?.cancel();
  // Simulate the account login/consent service; no real account is authorized.
  const returned = await fetch(`${origin}/authorize/callback?${new URLSearchParams({ code: 'fixture-code', state: handoffUrl.searchParams.get('state') })}`, { redirect: 'manual' });
  assert.equal(returned.status, 302);
  const returnedUrl = new URL(returned.headers.get('location'));
  assert.equal(returnedUrl.origin + returnedUrl.pathname, callback);
  assert.equal(returnedUrl.searchParams.get('state'), 'databricks-state');
  await returned.body?.cancel();
  const exchange = async grant => {
    const response = await fetch(metadata.token_endpoint, { method: 'POST', body: new URLSearchParams({ client_id: registration.client_id, client_secret: registration.client_secret, ...grant }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const issued = await exchange({ grant_type: 'authorization_code', code: returnedUrl.searchParams.get('code'), redirect_uri: callback, code_verifier: verifier, resource: `${origin}/mcp` });
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, resource: `${origin}/mcp` });
  assert.ok(refreshed.access_token);

  for (const token of [issued.access_token, refreshed.access_token, 'apk_access_fixture', 'apk_live_fixture', 'apk_org_live_fixture']) {
    const client = new Client({ name: 'Databricks', version: 'test' }, { capabilities: {} });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const { tools } = await client.listTools();
      assert.equal(tools.filter(tool => tool._meta?.ui?.visibility?.includes('model')).length, 5);
      assert.deepEqual(tools.find(tool => tool.name === 'apiosk_approve')._meta.ui.visibility, ['app']);
      const result = await client.callTool({ name: 'apiosk_sources', arguments: { limit: 1 } });
      assert.ok(!result.isError);
      assert.equal(result.structuredContent.sources[0].name, 'Fixture source');
      assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
      assert.match(client.getInstructions(), /If the host cannot display or use the card, offer `proposal.approval_url`/);
    } finally { await client.close(); }
  }
  invalidUpstream = true;
  const malformed = await initialize('apk_access_fixture');
  assert.equal(malformed.status, 401);
  await malformed.body.cancel();
  invalidUpstream = false;
  redirectUpstream = true;
  const redirected = await initialize('apk_access_fixture');
  assert.equal(redirected.status, 401);
  await redirected.body.cancel();
  assert.ok(requests.every(req => req.url !== '/must-not-receive-credentials'));
  redirectUpstream = false;
  allowed = false;
  for (const token of ['apk_access_fixture', 'apk_live_fixture', 'apk_org_live_fixture', 'not-a-token']) {
    const denied = await initialize(token);
    assert.equal(denied.status, 401);
    await denied.body.cancel();
  }
  assert.ok(requests.some(req => req.authorization === 'Bearer apk_org_live_fixture'));
  assert.ok(requests.every(req => req.method === 'GET' || req.url === '/v1/oauth/token'), 'integration test never plans, approves or buys');
});
