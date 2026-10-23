import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedApp } from '../src/hosted.mjs';
import { readConfig } from '../src/config.mjs';

const SECRET = 'fixture-only-oauth-secret-with-32-bytes';
const RESOURCE = 'http://127.0.0.1:3000/mcp';
const now = () => Math.floor(Date.now() / 1000);
const signed = payload => {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `apiosk.${encoded}.${createHmac('sha256', SECRET).update(encoded).digest('base64url')}`;
};
const grant = (overrides = {}) => ({ typ: 'access', clientId: 'shared-public-client', exp: now() + 3600, iat: now(),
  scopes: ['mcp:tools', 'offline_access'], resource: RESOURCE, apioskConnectToken: 'apk_access_fixture_buyer_one',
  apioskRefreshToken: 'fixture-upstream-refresh-one', apioskConnectTokenExpiresAt: now() + 86400, ...overrides });
const baseEnv = overrides => ({ NODE_ENV: 'production', APIOSK_MCP_OAUTH_SECRET: SECRET,
  APIOSK_MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3000', APIOSK_MCP_BIND_HOST: '127.0.0.1', ...overrides });

async function fixture(t, options = {}) {
  const callers = [];
  const hosted = createHostedApp({ env: baseEnv(options.env), oauthOptions: options.oauthOptions,
    createService: async caller => {
      callers.push(caller);
      return { instructions: 'Ask fixture', tools: [{ name: 'fixture_read', inputSchema: { type: 'object' },
        handler: async () => ({ content: [{ type: 'text', text: 'Saved fixture result' }] }) }] };
    } });
  const server = hosted.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await hosted.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { ...hosted, callers, url };
}

test('canonical config keeps OAuth agent URL distinct from the V2 data origin', () => {
  const config = readConfig({ PORT: '3000', APIOSK_MCP_BIND_HOST: '127.0.0.1',
    APIOSK_GATEWAY_URL: 'https://oauth.example/functions/v1/agent-gateway', APIOSK_GATEWAY_V2_URL: 'https://data.example' }, []);
  assert.equal(config.gatewayUrl, 'https://data.example'); assert.equal(config.port, 3000);
  assert.equal(readConfig({ APIOSK_GATEWAY_URL: 'https://oauth.example/functions/v1/agent-gateway' }, []).gatewayUrl, 'https://gateway.apiosk.com');
  assert.throws(() => createHostedApp({ env: { NODE_ENV: 'production' } }), /OAuth requires/);
});

test('existing signed OAuth bearer is verified and unwrapped for each MCP request without process-token fallback', async t => {
  const f = await fixture(t, { env: { APIOSK_TOKEN: 'must-not-be-borrowed' } });
  const client = new Client({ name: 'fixture-installed-host', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.url), {
    requestInit: { headers: { authorization: `Bearer ${signed(grant())}`, 'x-apiosk-workspace-id': 'workspace-one' } },
  }));
  const tools = await client.listTools(); assert.deepEqual(tools.tools.map(tool => tool.name), ['fixture_read']);
  await client.callTool({ name: 'fixture_read', arguments: {} });
  assert.ok(f.callers.length >= 3);
  assert.ok(f.callers.every(caller => caller.token === 'apk_access_fixture_buyer_one' && caller.workspace === 'workspace-one'));
  assert.ok(f.callers.every(caller => /^[a-f0-9]{64}$/.test(caller.stateScope)));
  const anonymous = await fetch(`${f.url}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata=/);
});

test('expired, wrong-audience and insufficient-scope grants cannot reach the Ask service', async t => {
  const f = await fixture(t);
  for (const [payload, expected] of [[grant({ exp: now() - 1 }), 401], [grant({ resource: 'https://other.example/mcp' }), 401], [grant({ scopes: [] }), 403]]) {
    const response = await fetch(`${f.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${signed(payload)}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(response.status, expected);
  }
  assert.equal(f.callers.length, 0);
});

test('legacy OAuth state scope survives upstream refresh rotation and is isolated between buyers sharing a client', async t => {
  const f = await fixture(t, { oauthOptions: { refreshPortalToken: async () => ({ connectToken: 'apk_access_rotated_fixture', refreshToken: 'rotated-upstream-refresh', expiresInSeconds: 86400 }) } });
  const legacy = grant({ apioskConnectTokenExpiresAt: now() - 1 });
  const before = await f.oauth.provider.verifyAccessToken(signed(legacy));
  const other = await f.oauth.provider.verifyAccessToken(signed(grant({ apioskConnectToken: 'apk_access_other_buyer', apioskRefreshToken: 'other-buyer-refresh' })));
  assert.notEqual(before.extra.apiosk_state_scope, other.extra.apiosk_state_scope);
  const renewed = await f.oauth.provider.exchangeRefreshToken({ client_id: legacy.clientId }, signed({ ...legacy, typ: 'refresh' }), undefined, new URL(RESOURCE));
  const after = await f.oauth.provider.verifyAccessToken(renewed.access_token);
  assert.equal(after.extra.apiosk_connect_token, 'apk_access_rotated_fixture');
  assert.equal(after.extra.apiosk_state_scope, before.extra.apiosk_state_scope);
  const renewedAgain = await f.oauth.provider.exchangeRefreshToken({ client_id: legacy.clientId }, renewed.refresh_token, undefined, new URL(RESOURCE));
  assert.equal((await f.oauth.provider.verifyAccessToken(renewedAgain.access_token)).extra.apiosk_state_scope, before.extra.apiosk_state_scope);
});

test('OAuth discovery, dynamic registration and refresh routes retain the installed-host contract', async t => {
  const f = await fixture(t);
  const metadata = await (await fetch(`${f.url}/.well-known/oauth-authorization-server`)).json();
  assert.equal(metadata.issuer, 'http://127.0.0.1:3000/');
  assert.equal(metadata.token_endpoint, 'http://127.0.0.1:3000/token');
  const prm = await (await fetch(`${f.url}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(prm.resource, RESOURCE);
  const registration = await fetch(`${f.url}/register`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Fixture host', redirect_uris: ['http://127.0.0.1:3456/callback'], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  const response = await fetch(`${f.url}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: signed(grant({ clientId: client.client_id, typ: 'refresh' })), resource: RESOURCE }) });
  assert.equal(response.status, 200);
  const renewed = await response.json();
  assert.equal((await f.oauth.provider.verifyAccessToken(renewed.access_token)).extra.apiosk_connect_token, 'apk_access_fixture_buyer_one');
  const callback = await fetch(`${f.url}/authorize/callback?error=access_denied`);
  assert.notEqual(callback.status, 404);
});

test('raw bearer verification uses the configured V2 Gateway and keeps callers separate', async t => {
  const verified = [];
  const gateway = createServer((req, res) => {
    verified.push({ path: req.url, authorization: req.headers.authorization });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ protocol_version: '2', sources: [] }));
  }).listen(0, '127.0.0.1'); await once(gateway, 'listening');
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  const f = await fixture(t, { env: { APIOSK_GATEWAY_V2_URL: `http://127.0.0.1:${gateway.address().port}` } });
  for (const token of ['apk_access_first_fixture', 'apk_live_second_fixture']) {
    const response = await fetch(`${f.url}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } } }) });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(f.callers.map(caller => caller.token), ['apk_access_first_fixture', 'apk_live_second_fixture']);
  assert.ok(f.callers.every(caller => caller.stateScope === null && caller.workspace === null));
  assert.ok(verified.every(request => request.path === '/v2/sources?limit=1'));
});

test('legacy SSE streams reject another buyer or workspace', async t => {
  const f = await fixture(t), controller = new AbortController();
  const owner = signed(grant());
  const stream = await fetch(`${f.url}/sse`, { headers: { authorization: `Bearer ${owner}`, 'x-apiosk-workspace-id': 'one' }, signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const text = new TextDecoder().decode((await reader.read()).value);
  const endpoint = text.match(/data: (\/messages\?sessionId=[^\s]+)/)?.[1]; assert.ok(endpoint);
  for (const headers of [
    { authorization: `Bearer ${signed(grant({ apioskConnectToken: 'apk_access_other_fixture', apioskRefreshToken: 'other-refresh' }))}`, 'x-apiosk-workspace-id': 'one' },
    { authorization: `Bearer ${owner}`, 'x-apiosk-workspace-id': 'two' },
  ]) {
    const response = await fetch(f.url + endpoint, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(response.status, 404);
  }
  controller.abort(); await reader.cancel().catch(() => {});
});
