import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHostedApp, withHostedToolMetadata } from '../src/hosted.mjs';
import { resolveServerInfo, resolveServerVersion } from '../src/server-identity.mjs';

const secret = 'synthetic-compatibility-signing-secret-32bytes';
const resource = 'http://127.0.0.1:3000/mcp';
function bearer() {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({ typ: 'access', clientId: 'fixture-existing-client', iat: now, exp: now + 3600,
    scopes: ['mcp:tools'], resource, apioskConnectToken: 'apk_access_fixture', apioskRefreshToken: 'fixture-refresh', apioskConnectTokenExpiresAt: now + 7200 })).toString('base64url');
  return `apiosk.${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'apiosk-host-compat-'));
  const env = { NODE_ENV: 'production', APIOSK_MCP_OAUTH_SECRET: secret, APIOSK_MCP_PUBLIC_BASE_URL: 'http://127.0.0.1:3000',
    APIOSK_MCP_BIND_HOST: '127.0.0.1', APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:9', APIOSK_MCP_STATE_DIR: directory,
    APIOSK_MCP_VERSION: '3.0.123' };
  const hosted = createHostedApp({ env });
  const server = hosted.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await hosted.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  return { ...hosted, env, url: `http://127.0.0.1:${server.address().port}` };
}

test('installed connector identity, brand icons and deploy-sensitive version are retained', () => {
  const info = resolveServerInfo({});
  assert.equal(info.name, 'apiosk-mcp'); assert.equal(info.title, 'Apiosk'); assert.equal(info.version, '3.0.0');
  assert.equal(info.icons.length, 4);
  assert.equal(info.icons[0].src, 'https://mcp.apiosk.com/brand/apiosk-a-20260921.png');
  assert.equal(resolveServerVersion({ APIOSK_MCP_VERSION: '3.2.7' }), '3.2.7');
  assert.equal(resolveServerVersion({ FLY_MACHINE_VERSION: 'not-a-ulid' }), '3.0.0');
  assert.equal(resolveServerVersion({ FLY_MACHINE_VERSION: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }), '3.0.1469922850');
  assert.notEqual(resolveServerVersion({ FLY_MACHINE_VERSION: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }), resolveServerVersion({ FLY_MACHINE_VERSION: '01ARZ3PEEKTSV4RRFFQ69G5FAV' }));
});

test('initialize and public server card describe the same tools, identity and static resources without Gateway access', async t => {
  const f = await fixture(t), client = new Client({ name: 'existing-mcp1-client', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', f.url), { requestInit: { headers: { authorization: `Bearer ${bearer()}` } } }));
  const card = await (await fetch(`${f.url}/.well-known/mcp/server-card.json`)).json();
  assert.deepEqual(card.serverInfo, client.getServerVersion());
  assert.equal(card.version, '3.0.123'); assert.equal(card.name, 'apiosk-mcp');
  assert.equal(card.authentication.required, true); assert.deepEqual(card.authentication.schemes, ['oauth2']);
  assert.deepEqual(card.capabilities, client.getServerCapabilities());
  // The standard SDK strips the nonstandard top-level securitySchemes field;
  // its backward-compatible _meta copy remains visible to every host.
  assert.deepEqual(card.tools.map(({ securitySchemes, ...tool }) => tool), (await client.listTools()).tools);
  assert.ok(card.tools.every(tool => tool._meta.securitySchemes[0].type === 'oauth2'));
  assert.equal(card.tools.filter(tool => tool._meta?.['openai/visibility'] !== 'private').length, 36);
  assert.ok(card.resources.some(item => item.uri === 'apiosk://v2/host-contract'));
  assert.ok(card.resources.every(item => !item.uri.startsWith('apiosk://requests/')));
  assert.match(card.instructions, /call apiosk_ask/);
  const health = await (await fetch(`${f.url}/health`)).json();
  assert.equal(health.tool_count, card.tools.length); assert.equal(health.gateway_verified, false);
});

test('MCP1 browser welcome and per-transport OAuth challenge discovery remain available', async t => {
  const f = await fixture(t);
  for (const path of ['/', '/mcp']) {
    const page = await fetch(f.url + path, { headers: { accept: 'text/html' } });
    assert.equal(page.status, 200); assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(await page.text(), /Connect Apiosk/);
    const data = await (await fetch(f.url + path, { headers: { accept: 'application/json' } })).json();
    assert.equal(data.endpoint, resource); assert.equal(data.server.name, 'apiosk-mcp');
  }
  const eventStream = await fetch(`${f.url}/mcp`, { headers: { accept: 'text/event-stream' } });
  assert.equal(eventStream.status, 405);
  for (const [path, method, suffix] of [['/mcp', 'POST', '/mcp'], ['/sse', 'GET', '/sse'], ['/messages', 'POST', '/sse']]) {
    const response = await fetch(f.url + path, { method });
    assert.equal(response.status, 401);
    const metadata = response.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)?.[1];
    assert.equal(metadata, `http://127.0.0.1:3000/.well-known/oauth-protected-resource${suffix}`);
    const document = await (await fetch(f.url + new URL(metadata).pathname)).json();
    assert.equal(document.resource, `http://127.0.0.1:3000${suffix}`);
  }
});

test('upstream unauthorized tools preserve saved errors and signal account reconnection', async () => {
  const output = { isError: true, content: [{ type: 'text', text: 'Read saved status after reconnecting.' }],
    structuredContent: { request_id: 'saved-request', error: { code: 'gateway_unauthorized', status: 401 } }, _meta: { retained: true } };
  const denied = { ...output, structuredContent: { error: { code: 'app_only', status: 403 } } };
  const service = withHostedToolMetadata({ tools: [{ name: 'status', handler: async () => output }, { name: 'account_only', handler: async () => denied }],
    compatibilityTools: [{ name: 'old_status', handler: async () => output }] }, 'https://mcp.apiosk.com/.well-known/oauth-protected-resource/mcp');
  for (const tool of [service.tools[0], service.compatibilityTools[0]]) {
    const result = await tool.handler({});
    assert.deepEqual(result.structuredContent, output.structuredContent); assert.equal(result._meta.retained, true);
    assert.match(result._meta['mcp/www_authenticate'][0], /resource_metadata="https:\/\/mcp.apiosk.com/);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['mcp:tools'] }]);
  }
  assert.equal((await service.tools[1].handler({}))._meta['mcp/www_authenticate'], undefined);
  assert.equal(output._meta['mcp/www_authenticate'], undefined);
  const legacy = withHostedToolMetadata({ tools: [{ name: 'legacy_error', handler: async () => ({ isError: true,
    structuredContent: { error_code: 'unauthorized', message: 'Reconnect your account.' }, content: [] }) }] }, 'https://mcp.apiosk.com/.well-known/oauth-protected-resource/mcp');
  assert.match((await legacy.tools[0].handler({}))._meta['mcp/www_authenticate'][0], /invalid_token/);
});
