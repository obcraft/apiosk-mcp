import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpServer, startHttp } from '../src/server.mjs';
import { readConfig } from '../src/config.mjs';

function fixtureService(principal = 'local') {
  return {
    tools: [{
      name: 'ask_fixture', title: 'Read fixture', description: 'Returns saved fixture data without paid calls.',
      inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1 } }, required: ['question'], additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: 'ui://apiosk/fixture' } },
      handler: async ({ question }) => ({ content: [{ type: 'text', text: question }], structuredContent: { question, principal, charges: [] } }),
    }, {
      name: 'ask_broken', description: 'Throws an unexpected exception.', inputSchema: { type: 'object', properties: {} },
      handler: async () => { throw new Error('credential=should-never-appear'); },
    }],
    resources: [{ uri: 'apiosk://guide', name: 'Ask guide', mimeType: 'text/plain', read: async () => 'Review the total before approval.' }],
    prompts: [{ name: 'ask', description: 'Ask for source-backed information.', arguments: [{ name: 'question', required: true }], get: async ({ question }) => ({ messages: [{ role: 'user', content: { type: 'text', text: question } }] }) }],
  };
}

async function inMemory(t, service = fixtureService()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer({ service });
  const client = new Client({ name: 'mcp-2-test', version: '1.0.0' });
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

test('SDK initialize, tools/list and tools/call retain structured results and UI metadata', async t => {
  const client = await inMemory(t);
  assert.equal(client.getServerVersion().name, 'apiosk-mcp-2');
  assert.ok(client.getServerCapabilities().resources);
  assert.match(client.getInstructions(), /explicit approval/);
  const { tools } = await client.listTools();
  assert.equal(tools[0].name, 'ask_fixture');
  assert.equal(tools[0]._meta.ui.resourceUri, 'ui://apiosk/fixture');
  assert.equal(tools[0].handler, undefined);
  const result = await client.callTool({ name: 'ask_fixture', arguments: { question: 'Mollie' } });
  assert.deepEqual(result.structuredContent, { question: 'Mollie', principal: 'local', charges: [] });
});

test('tool JSON Schema rejects invalid and additional inputs before a handler runs', async t => {
  let calls = 0;
  const service = fixtureService();
  service.tools[0].handler = () => { calls++; return {}; };
  const client = await inMemory(t, service);
  for (const args of [{}, { question: 42 }, { question: '' }, { question: 'Mollie', approve: true }]) {
    const response = await client.callTool({ name: 'ask_fixture', arguments: args });
    assert.equal(response.isError, true);
    assert.equal(response.structuredContent.error.code, 'invalid_arguments');
  }
  assert.equal(calls, 0);
  await assert.rejects(client.callTool({ name: 'missing_tool', arguments: {} }), /Unknown Ask tool/);
});

test('unexpected failures do not disclose upstream credentials or raw response bodies', async t => {
  const client = await inMemory(t);
  const result = await client.callTool({ name: 'ask_broken', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'internal_error');
  assert.doesNotMatch(JSON.stringify(result), /should-never-appear|credential=/);
});

test('SDK resources and prompts are fully discoverable and readable', async t => {
  const client = await inMemory(t);
  assert.equal((await client.listResources()).resources[0].uri, 'apiosk://guide');
  assert.equal((await client.readResource({ uri: 'apiosk://guide' })).contents[0].text, 'Review the total before approval.');
  assert.deepEqual((await client.listResourceTemplates()).resourceTemplates, []);
  assert.equal((await client.listPrompts()).prompts[0].name, 'ask');
  assert.equal((await client.getPrompt({ name: 'ask', arguments: { question: 'Mollie' } })).messages[0].content.text, 'Mollie');
  await assert.rejects(client.getPrompt({ name: 'ask', arguments: {} }), /Missing prompt argument/);
  await assert.rejects(client.readResource({ uri: 'apiosk://missing' }), /Unknown Ask resource/);
});

test('dynamic saved resources remain available after the MCP server is initialized', async t => {
  const service = fixtureService();
  let saved = [];
  service.listResources = async () => saved.map(id => ({ uri: `apiosk://saved/${id}`, name: id, mimeType: 'application/json' }));
  service.readResource = async uri => ({ contents: [{ uri, mimeType: 'application/json', text: '{"saved":true}' }] });
  const client = await inMemory(t, service);
  assert.equal((await client.listResources()).resources.length, 0);
  saved = ['result-1'];
  assert.equal((await client.listResources()).resources.length, 1);
  assert.equal(JSON.parse((await client.readResource({ uri: 'apiosk://saved/result-1' })).contents[0].text).saved, true);
});

test('real SDK stdio client can initialize, discover and call the standalone server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'apiosk-mcp-2-stdio-'));
  const entry = join(directory, 'fixture.mjs');
  const serverUrl = new URL('../src/server.mjs', import.meta.url).href;
  await writeFile(entry, `import { startStdio } from ${JSON.stringify(serverUrl)};\nconst fixtureService = ${fixtureService.toString()};\nawait startStdio({service:fixtureService()});\n`);
  const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: 'pipe' });
  const client = new Client({ name: 'stdio-acceptance', version: '1.0.0' });
  let stderr = '';
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect(transport);
  transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  assert.equal((await client.listTools()).tools.length, 2);
  assert.equal((await client.callTool({ name: 'ask_fixture', arguments: { question: 'saved result' } })).structuredContent.question, 'saved result');
  assert.equal(stderr, '');
});

test('Streamable HTTP isolates credentials per request and works with the SDK client', async t => {
  const credentials = [];
  const server = await startHttp({ port: 0, createService: ({ token, workspace }) => {
    credentials.push({ token, workspace });
    return fixtureService(token === 'client-A' ? `A:${workspace}` : `B:${workspace}`);
  } });
  const clients = [];
  t.after(async () => { await Promise.all(clients.map(client => client.close())); await server.close(); });
  for (const [token, workspace] of [['client-A', 'workspace-a'], ['client-B', 'workspace-b']]) {
    const client = new Client({ name: 'http-acceptance', version: '1.0.0' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: { authorization: `Bearer ${token}`, 'x-apiosk-workspace-id': workspace } } }));
    const result = await client.callTool({ name: 'ask_fixture', arguments: { question: 'saved' } });
    assert.equal(result.structuredContent.principal, `${token === 'client-A' ? 'A' : 'B'}:${workspace}`);
  }
  assert.ok(credentials.some(item => item.token === 'client-A'));
  assert.ok(credentials.some(item => item.token === 'client-B'));
  assert.ok(credentials.every(item => item.token === 'client-A' || item.token === 'client-B'));
});

test('HTTP rejects missing credentials, unsafe Host/Origin, and oversized body before service creation', async t => {
  let creates = 0;
  const server = await startHttp({ port: 0, maxBodyBytes: 128, createService: () => { creates++; return fixtureService(); } });
  t.after(() => server.close());
  const headers = { 'Content-Type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer client-A' };
  assert.equal((await fetch(server.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(server.url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: '{}' })).status, 403);
  const rejectedHost = await new Promise((resolve, reject) => {
    const request = httpRequest(server.url, { method: 'POST', headers: { ...headers, host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch(server.url, { method: 'POST', headers, body: JSON.stringify({ text: 'x'.repeat(256) }) })).status, 413);
  assert.equal((await fetch(server.url, { method: 'POST', headers, body: 'not JSON' })).status, 400);
  assert.equal((await fetch(server.url, { method: 'GET', headers })).status, 405);
  assert.equal(creates, 0);
  const health = await (await fetch(server.url.replace('/mcp', '/health'))).json();
  assert.deepEqual(health, { ok: true, service: 'apiosk-mcp-2', gateway_verified: false });
});

test('config defaults to stdio and refuses insecure remote URLs or unbounded listener hosts', () => {
  const config = readConfig({}, []);
  assert.equal(config.transport, 'stdio');
  assert.equal(config.gatewayUrl, 'https://gateway.apiosk.com');
  assert.equal(config.port, 3000);
  assert.equal(readConfig({ APIOSK_CONNECT_TOKEN: 'example' }, ['--http', '--port', '3013']).port, 3013);
  assert.equal(readConfig({}, ['--help']).help, true);
  for (const gatewayUrl of ['file:///etc/passwd', 'http://example.com', 'https://user:password@example.com', 'https://example.com/?token=secret']) {
    assert.throws(() => readConfig({ APIOSK_GATEWAY_V2_URL: gatewayUrl }, []));
  }
  assert.throws(() => readConfig({}, ['--http', '--host', '0.0.0.0']), /ALLOWED_HOSTS/);
  assert.throws(() => readConfig({}, ['--port', '-1']), /Port/);
  assert.throws(() => readConfig({}, ['--port']), /Missing value/);
  assert.throws(() => readConfig({ APIOSK_MCP_ALLOWED_ORIGINS: 'https://example.com/path' }, []), /exact HTTP/);
  assert.throws(() => readConfig({ APIOSK_TOKEN: 'secret\nheader' }, []), /Invalid Apiosk token/);
});
