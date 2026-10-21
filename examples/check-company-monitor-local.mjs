#!/usr/bin/env node
// Fresh production MCP entrypoint over stdio. Read-only; never creates a check,
// buys data, sends mail, or prints the connection token. Local Gateway only.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cwd = fileURLToPath(new URL('../', import.meta.url));
const client = new Client({ name: 'apiosk-local-monitor-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({ command: process.execPath, args: ['index.mjs'], cwd,
  env: { PATH: process.env.PATH, APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082',
    APIOSK_CONNECT_TOKEN: process.env.APIOSK_CONNECT_TOKEN || '' }, stderr: 'pipe' });
transport.stderr?.on('data', () => {});
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.filter(t => t.name.startsWith('apiosk_company_check'));
  assert.equal(tools.length, 5);
  assert.match(client.getInstructions(), /company-monitoring workflow/);
  const resources = [];
  for (const uri of ['apiosk://company-checks/host-contract', 'ui://apiosk/company-check-v1.html', 'ui://apiosk/company-check-v1-chatgpt.html']) {
    const resource = (await client.readResource({ uri })).contents[0];
    assert.ok(resource.text.length > 100); resources.push({ uri, mimeType: resource.mimeType });
  }
  const read = await client.callTool({ name: 'apiosk_company_check_read', arguments: { check_id: '00000000-0000-4000-8000-000000000001' } });
  const result = read.structuredContent || {};
  console.log(JSON.stringify({ transport: 'stdio', entrypoint: 'mcp/index.mjs',
    tools: tools.map(t => t.name), resources, initialized: true,
    local_gateway_read: { confirmed: !read.isError, error_code: result.error_code || result.errors?.[0]?.code || null,
      oauth_challenge: Boolean(read._meta?.['mcp/www_authenticate']) },
    paid_calls: 0, sent_emails: 0, note: 'Only initialization, resources and a read-only unknown-check probe. This is not a completed monitoring run.' }, null, 2));
  // Do not turn a working MCP handshake into a green Gateway acceptance test.
  if (read.isError) process.exitCode = 2;
} finally { await client.close(); }
