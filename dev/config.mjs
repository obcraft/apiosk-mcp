import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const repo = new URL('../', import.meta.url);
const read = path => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
export function readConfig(inherited = process.env) {
  // Only the provider key is reused from Gateway. Its routes, model selection,
  // execution flags and other credentials are not changed or inherited.
  const gateway = read(new URL('../../gateway/.env', import.meta.url));
  const env = { ...read(new URL('.env', repo)), ...read(new URL('.env.v2.local', repo)),
    ...read(new URL('.env.dev.local', repo)), ...inherited };
  const port = Number(env.MCP_DEV_PORT || 3013);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('MCP_DEV_PORT must be between 1024 and 65535.');
  const url = new URL(env.MCP_DEV_URL || 'http://127.0.0.1:3012/mcp');
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) {
    throw new Error('MCP_DEV_URL must be HTTPS or loopback HTTP, without credentials, query or fragment.');
  }
  const displayGateway = new URL(env.MCP_DEV_GATEWAY_URL || env.APIOSK_GATEWAY_V2_URL ||
    (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ? 'http://127.0.0.1:8082' : 'https://gateway.apiosk.com'));
  if (displayGateway.username || displayGateway.password || displayGateway.search || displayGateway.hash || displayGateway.pathname !== '/'
    || !(displayGateway.protocol === 'https:' || displayGateway.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(displayGateway.hostname))) {
    throw new Error('MCP_DEV_GATEWAY_URL must be an HTTPS or loopback HTTP origin without credentials.');
  }
  return { port, origin: `http://127.0.0.1:${port}`, mcpUrl: url.href, gatewayOrigin: displayGateway.origin,
    modelKey: env.OPENROUTER_API_KEY || gateway.OPENROUTER_API_KEY || gateway.INTENT_API_KEY || '',
    defaultModel: env.MCP_DEV_MODEL || 'openai/gpt-oss-120b',
    bearer: env.MCP_DEV_TOKEN || '', publicDir: fileURLToPath(new URL('public/', import.meta.url)) };
}
