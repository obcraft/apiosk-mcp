import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url));
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

// Retain the canonical MCP environment contract: APIOSK_GATEWAY_URL belongs
// to the OAuth agent gateway; only V2_URL selects the data/execution Gateway.
export function resolveGatewayV2Url(env = process.env) {
  return String(env.APIOSK_GATEWAY_V2_URL || '').trim() || 'https://gateway.apiosk.com';
}

/** Configuration contains credentials; never log or return this object. */
export function readConfig(env = process.env, args = process.argv.slice(2)) {
  const config = {
    transport: env.APIOSK_MCP_TRANSPORT || 'stdio',
    host: env.APIOSK_MCP_HOST || env.APIOSK_MCP_BIND_HOST || '127.0.0.1',
    port: Number(env.APIOSK_MCP_PORT || env.PORT || 3000),
    gatewayUrl: resolveGatewayV2Url(env),
    token: env.APIOSK_TOKEN || env.APIOSK_CONNECT_TOKEN || '',
    workspace: env.APIOSK_WORKSPACE_ID || null,
    stateDir: resolve(env.APIOSK_MCP_STATE_DIR || resolve(PACKAGE_ROOT, '.local/state')),
    allowedOrigins: commaList(env.APIOSK_MCP_ALLOWED_ORIGINS),
    allowedHosts: commaList(env.APIOSK_MCP_ALLOWED_HOSTS),
    maxBodyBytes: 1024 * 1024,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--stdio') config.transport = 'stdio';
    else if (argument === '--http') config.transport = 'http';
    else if (argument === '--help' || argument === '-h') config.help = true;
    else if (argument === '--port' || argument === '--host' || argument === '--state-dir') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}.`);
      if (argument === '--port') config.port = Number(value);
      if (argument === '--host') config.host = value;
      if (argument === '--state-dir') config.stateDir = resolve(value);
    } else throw new Error('Unknown command-line option. Use --help for supported options.');
  }
  if (!['stdio', 'http'].includes(config.transport)) throw new Error('Transport must be stdio or http.');
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  let gateway;
  try { gateway = new URL(config.gatewayUrl); } catch { throw new Error('APIOSK_GATEWAY_V2_URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password || gateway.search || gateway.hash) {
    throw new Error('APIOSK_GATEWAY_V2_URL must use HTTP(S) without credentials, query parameters or fragments.');
  }
  if (gateway.protocol !== 'https:' && !LOOPBACK.has(gateway.hostname)) throw new Error('Non-local Gateway URLs must use HTTPS.');
  config.gatewayUrl = gateway.href.replace(/\/$/, '');
  if (/[\r\n]/.test(config.token) || config.token.length > 16384) throw new Error('Invalid Apiosk token.');
  if (config.workspace && !/^[A-Za-z0-9_-]{1,128}$/.test(config.workspace)) throw new Error('Invalid workspace identifier.');
  for (const value of config.allowedOrigins) {
    let origin;
    try { origin = new URL(value); } catch { throw new Error('Allowed origins must be exact HTTP(S) origins.'); }
    if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value) throw new Error('Allowed origins must be exact HTTP(S) origins without a path.');
  }
  if (config.transport === 'http' && !LOOPBACK.has(config.host) && !config.allowedHosts.length) {
    throw new Error('A non-loopback HTTP listener requires APIOSK_MCP_ALLOWED_HOSTS. Use a TLS reverse proxy for remote access.');
  }
  return config;
}

function commaList(value) {
  return typeof value === 'string' ? [...new Set(value.split(',').map(part => part.trim()).filter(Boolean))] : [];
}

export const CLI_HELP = `Apiosk MCP 2 — Ask tools for MCP hosts

Usage: node index.mjs
       node server.mjs
       node bin/mcp-2.mjs [--stdio | --http] [--port 3000] [--host 127.0.0.1]
       node bin/mcp-2.mjs --help

--stdio       Local MCP process transport (default). Uses APIOSK_TOKEN.
--http        Streamable HTTP on /mcp; every request supplies its own Bearer token.
--state-dir   Directory for owner-scoped saved conversations and approval receipts.

Environment: APIOSK_GATEWAY_V2_URL, APIOSK_TOKEN (or APIOSK_CONNECT_TOKEN),
APIOSK_WORKSPACE_ID, APIOSK_MCP_STATE_DIR, APIOSK_MCP_ALLOWED_ORIGINS,
APIOSK_MCP_ALLOWED_HOSTS. HTTP ignores the global token; it never lends the
server owner's credentials to clients. /health reports process health only.
`;
