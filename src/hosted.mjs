import express from 'express';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createHostedOAuthSupport, resolveHostedMcpUrls } from './auth/oauth.mjs';
import { readConfig } from './config.mjs';
import { GatewayClient } from './gateway.mjs';
import { StateStore, scopeKey } from './store.mjs';
import { createAskService } from './service.mjs';
import { withEmbeddedCards } from './card-adapter.mjs';
import { createMcpServer } from './server.mjs';
import { resolveServerInfo } from './server-identity.mjs';
import { withLegacyCompatibility } from './legacy-compat.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const list = value => String(value || '').split(',').map(item => item.trim()).filter(Boolean);
const workspacePattern = /^[A-Za-z0-9_-]{1,128}$/;
const publicAssets = [
  'apiosk-a-20260921.png', 'mark-20260918.svg', 'mark-light-20260918.png', 'mark-dark-20260918.png',
  'wordmark-black-320.png', 'wordmark-white-320.png', 'inter-latin-400-normal.woff2', 'inter-latin-500-normal.woff2',
  'inter-latin-600-normal.woff2', 'favicon.ico', 'favicon-dark.ico', 'apple-touch-icon.png',
];

/** A verified OAuth grant supplies stateScope; raw bearer callers remain token-scoped. */
export function hostedServiceFactory(config) {
  return ({ token, workspace, stateScope, legacyUiMime = false }) => {
    const gateway = new GatewayClient({ baseUrl: config.gatewayUrl, token, workspace });
    const store = new StateStore({ directory: config.stateDir, scope: scopeKey({
      gatewayUrl: config.gatewayUrl, token: stateScope ? `verified-oauth-grant:${stateScope}` : token, workspace,
    }) });
    return withLegacyCompatibility(withEmbeddedCards(createAskService({ gateway, store }), { gateway, store, legacyUiMime }), { gateway, store });
  };
}

/** Public descriptions never open a buyer's store or make Gateway requests. */
export function describeAskService(config) {
  const gateway = new GatewayClient({ baseUrl: config.gatewayUrl, token: null, workspace: null });
  const store = { list: async () => [] };
  return withLegacyCompatibility(withEmbeddedCards(createAskService({ gateway, store }), { gateway, store }), { gateway, store });
}

/** Reconnect metadata is needed even when the outer OAuth grant is still valid. */
export function withHostedToolMetadata(service, resourceMetadataUrl) {
  const schemes = [{ type: 'oauth2', scopes: ['mcp:tools'] }];
  const decorate = tool => ({ ...tool, securitySchemes: schemes,
    _meta: { ...tool._meta, securitySchemes: schemes },
    async handler(...args) {
      const result = await tool.handler(...args);
      const error = result?.structuredContent?.error || result?.structuredContent;
      const code = error?.code || error?.error_code;
      if (!result?.isError || !(error?.status === 401 || ['unauthorized', 'invalid_token', 'authentication_required', 'token_expired'].includes(code))) return result;
      return { ...result, _meta: { ...result._meta,
        'mcp/www_authenticate': [`Bearer resource_metadata="${resourceMetadataUrl}", error="invalid_token", error_description="Reconnect your Apiosk account and recover the saved request", scope="mcp:tools"`] } };
    },
  });
  return { ...service, tools: service.tools.map(decorate),
    ...(service.compatibilityTools ? { compatibilityTools: service.compatibilityTools.map(decorate) } : {}) };
}

/** Canonical hosted entry: existing OAuth routes and new Ask tools share one origin. */
export function createHostedApp({ env = process.env, createService, oauthOptions = {} } = {}) {
  const port = Number(env.APIOSK_MCP_PORT || env.PORT || 3000);
  const { issuerUrl, mcpServerUrl } = resolveHostedMcpUrls({ env, port });
  const allowedHosts = list(env.APIOSK_MCP_ALLOWED_HOSTS);
  if (!allowedHosts.length) allowedHosts.push(issuerUrl.hostname, mcpServerUrl.hostname, 'localhost', '127.0.0.1', '[::1]', ...(env.FLY_APP_NAME ? [`${env.FLY_APP_NAME}.fly.dev`] : []));
  const config = readConfig({ ...env, APIOSK_MCP_TRANSPORT: 'http', APIOSK_MCP_HOST: env.APIOSK_MCP_HOST || env.APIOSK_MCP_BIND_HOST || '0.0.0.0', APIOSK_MCP_ALLOWED_HOSTS: [...new Set(allowedHosts)].join(',') }, []);
  const factory = createService || hostedServiceFactory(config);
  const serverInfo = resolveServerInfo(env);
  const oauth = createHostedOAuthSupport({ env, issuerUrl, mcpServerUrl, appName: 'Apiosk', resourceName: 'Apiosk Ask', ...oauthOptions });
  const metadataService = withHostedToolMetadata(describeAskService(config), String(oauth.resourceMetadataUrl));
  const app = createMcpExpressApp({ host: config.host, allowedHosts: config.allowedHosts });
  const active = new Set(), sessions = new Map();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
    next();
  });
  // Bearer credentials are explicit; no cookies or server-wide token confer
  // authority. Expose OAuth challenges to browser MCP hosts as before.
  app.use(['/mcp', '/sse', '/messages'], (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && config.allowedOrigins.length && !config.allowedOrigins.includes(origin)) return res.status(403).json({ error: 'origin_not_allowed' });
    res.set({ 'Access-Control-Allow-Origin': config.allowedOrigins.length && origin ? origin : '*',
      'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version' });
    if (req.method === 'OPTIONS') {
      res.set({ 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id, x-apiosk-connect-token, x-apiosk-workspace-id', 'Access-Control-Max-Age': '86400' });
      return res.status(204).end();
    }
    next();
  });
  app.use(oauth.metadataRouter);
  app.use(new URL(oauth.oauthMetadata.authorization_endpoint).pathname, oauth.authorizationRouter);
  app.use(new URL(oauth.oauthMetadata.token_endpoint).pathname, oauth.tokenRouter);
  app.use(new URL(oauth.oauthMetadata.registration_endpoint).pathname, oauth.registrationRouter);
  app.get('/authorize/callback', (req, res) => oauth.handlePortalCallback(req, res));

  const metadataUrl = req => String(['/sse', '/messages'].includes(req.path) ? oauth.sseResourceMetadataUrl : oauth.resourceMetadataUrl);
  const challenge = (req, res, status = 401) => res.status(status).set('WWW-Authenticate',
    `Bearer error="${status === 403 ? 'insufficient_scope' : 'invalid_token'}", scope="mcp:tools", resource_metadata="${metadataUrl(req)}"`)
    .json({ error: status === 403 ? 'insufficient_scope' : 'invalid_token', error_description: 'Connect your Apiosk account to use this MCP server.' });
  const authenticate = async (req, res, next) => {
    const explicit = req.headers['x-apiosk-connect-token'];
    const supplied = typeof explicit === 'string' ? explicit.trim() : /^Bearer ([^\s]{1,16384})$/i.exec(req.headers.authorization || '')?.[1];
    if (!supplied || supplied.length > 16384 || /\s/.test(supplied)) return challenge(req, res);
    try {
      const auth = await oauth.provider.verifyAccessToken(supplied);
      if (!auth.scopes?.includes('mcp:tools')) return challenge(req, res, 403);
      const token = auth.extra?.apiosk_connect_token;
      if (!token || typeof token !== 'string') return challenge(req, res);
      const workspace = req.headers['x-apiosk-workspace-id'] || null;
      if (workspace && (typeof workspace !== 'string' || !workspacePattern.test(workspace))) return res.status(400).json({ error: 'invalid_workspace' });
      req.askCaller = { token, workspace, stateScope: auth.extra?.apiosk_state_scope || null, legacyUiMime: /openai|chatgpt/i.test(req.headers['user-agent'] || '') };
      next();
    } catch { return challenge(req, res); }
  };
  const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } });

  app.post('/mcp', authenticate, async (req, res) => {
    let server;
    try {
      server = createMcpServer({ service: withHostedToolMetadata(await factory(req.askCaller), metadataUrl(req)), env });
      active.add(server);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      const close = () => { active.delete(server); void server.close().catch(() => {}); };
      res.once('close', close);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent) rpcError(res, 500, 'MCP request failed. Read saved status before retrying an approval.');
      if (server) { active.delete(server); await server.close().catch(() => {}); }
    }
  });
  const welcome = (req, res) => {
    const data = { name: 'Apiosk Connect', server: serverInfo, description: serverInfo.description,
      transport: 'streamable-http', endpoint: mcpServerUrl.href, mcp_endpoint: mcpServerUrl.href,
      legacy_sse_endpoint: new URL('/sse', mcpServerUrl).href, oauth_issuer: issuerUrl.href,
      connect: { claude_code: `claude mcp add --transport http apiosk ${mcpServerUrl.href}` },
      docs: 'https://github.com/obcraft/apiosk-mcp', health: '/health' };
    if (!String(req.headers.accept || '').includes('text/html')) return res.json(data);
    const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    return res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Apiosk</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:660px;margin:8vh auto;padding:24px;color:#20232c}img{width:48px;height:48px}code{display:block;padding:16px;border:1px solid #ddd;border-radius:8px;overflow-wrap:anywhere}a{color:#4658d6}</style><main><img src="/brand/apiosk-a-20260921.png" alt="Apiosk"><h1>Connect Apiosk</h1><p>Ask a data question, review matching sources and one total, then inspect your saved results.</p><p>Use this MCP endpoint in your AI host and sign in with your Apiosk account:</p><code>${escape(mcpServerUrl.href)}</code><p><a href="https://github.com/obcraft/apiosk-mcp">Connection instructions</a></p><p>Apiosk ${escape(serverInfo.version)}</p></main></html>`);
  };
  app.get('/mcp', (req, res) => String(req.headers.accept || '').includes('text/event-stream')
    ? rpcError(res.set('Allow', 'POST, DELETE'), 405, 'This stateless endpoint has no event stream.') : welcome(req, res));
  app.delete('/mcp', authenticate, (_req, res) => res.status(200).json({ ok: true }));

  // Keep installed legacy SSE endpoints. Bind each stream to its authenticated
  // buyer + workspace; a rotated upstream token must reconnect its stream.
  app.get('/sse', authenticate, async (req, res) => {
    if (sessions.size >= 64) return rpcError(res, 503, 'Too many active MCP streams. Reconnect shortly.');
    const server = createMcpServer({ service: withHostedToolMetadata(await factory(req.askCaller), metadataUrl(req)), env });
    const transport = new SSEServerTransport('/messages', res);
    const binding = digest(JSON.stringify([req.askCaller.token, req.askCaller.workspace]));
    sessions.set(transport.sessionId, { server, transport, binding }); active.add(server);
    const close = () => { sessions.delete(transport.sessionId); active.delete(server); void server.close().catch(() => {}); };
    res.once('close', close);
    try { await server.connect(transport); } catch { close(); if (!res.headersSent) rpcError(res, 500, 'MCP stream could not start.'); }
  });
  app.post('/messages', authenticate, async (req, res) => {
    const session = typeof req.query.sessionId === 'string' && sessions.get(req.query.sessionId);
    const binding = digest(JSON.stringify([req.askCaller.token, req.askCaller.workspace]));
    if (!session || session.binding !== binding) return rpcError(res, 404, 'This MCP stream is unavailable. Reconnect to continue.');
    try { await session.transport.handlePostMessage(req, res, req.body); }
    catch { if (!res.headersSent) rpcError(res, 400, 'MCP stream request failed. Read saved status before retrying an approval.'); }
  });

  app.get('/health', (_req, res) => res.json({ status: 'ok', server: serverInfo, tool_count: metadataService.tools.length, gateway_verified: false }));
  app.get('/', welcome);
  app.get('/.well-known/mcp/server-card.json', async (_req, res) => {
    const resources = await metadataService.listResources();
    res.json({ ...serverInfo, serverInfo, server: serverInfo, instructions: metadataService.instructions,
      transport: 'streamable-http', endpoint: mcpServerUrl.href,
      authentication: { type: 'oauth2', issuer: issuerUrl.href, required: true, schemes: ['oauth2'] },
      capabilities: { tools: {}, resources: {}, prompts: {} },
      tools: metadataService.tools.map(({ handler, ...definition }) => definition),
      prompts: (metadataService.prompts || []).map(({ get, ...definition }) => definition), resources });
  });
  app.get(/^\/\.well-known\/openai-apps-challenge(?:\/\.well-known\/openai-apps-challenge)*\/?$/, (_req, res) => {
    const token = String(env.APIOSK_OPENAI_APPS_CHALLENGE_TOKEN || '').trim();
    res.status(token ? 200 : 404).type('text/plain').send(token || 'OpenAI apps challenge token is not configured.');
  });
  for (const filename of publicAssets) app.get(`/brand/${filename}`, (_req, res) => res.sendFile(fileURLToPath(new URL(`../assets/brand/${filename}`, import.meta.url))));
  for (const [route, filename] of [['/favicon.ico', 'favicon.ico'], ['/favicon-dark.ico', 'favicon-dark.ico'], ['/favicon.svg', 'mark-20260918.svg'], ['/favicon.png', 'apiosk-a-20260921.png'], ['/apple-touch-icon.png', 'apple-touch-icon.png']]) {
    app.get(route, (_req, res) => res.sendFile(fileURLToPath(new URL(`../assets/brand/${filename}`, import.meta.url))));
  }
  app.get('/logo-optimized-light.png', (_req, res) => res.sendFile(fileURLToPath(new URL('../assets/brand/apiosk-a-20260921.png', import.meta.url))));
  app.use((_error, _req, res, _next) => { if (!res.headersSent) res.status(400).json({ error: 'request_failed', message: 'The request could not be completed.' }); });
  return { app, config, oauth, async close() { await Promise.allSettled([...active].map(server => server.close())); active.clear(); sessions.clear(); } };
}

export async function startHosted(options = {}) {
  const hosted = createHostedApp(options);
  const http = await new Promise((resolve, reject) => {
    const listener = hosted.app.listen(hosted.config.port, hosted.config.host, () => resolve(listener));
    listener.once('error', reject);
  });
  return { ...hosted, http, url: `http://${hosted.config.host}:${hosted.config.port}/mcp`,
    async close() { await hosted.close(); await new Promise((resolve, reject) => http.close(error => error ? reject(error) : resolve())); } };
}
