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
import { createMcpServer, SERVER_INFO } from './server.mjs';

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
  return ({ token, workspace, stateScope }) => {
    const gateway = new GatewayClient({ baseUrl: config.gatewayUrl, token, workspace });
    const store = new StateStore({ directory: config.stateDir, scope: scopeKey({
      gatewayUrl: config.gatewayUrl, token: stateScope ? `verified-oauth-grant:${stateScope}` : token, workspace,
    }) });
    return withEmbeddedCards(createAskService({ gateway, store }), { gateway, store });
  };
}

/** Canonical hosted entry: existing OAuth routes and new Ask tools share one origin. */
export function createHostedApp({ env = process.env, createService, oauthOptions = {} } = {}) {
  const port = Number(env.APIOSK_MCP_PORT || env.PORT || 3000);
  const { issuerUrl, mcpServerUrl } = resolveHostedMcpUrls({ env, port });
  const allowedHosts = list(env.APIOSK_MCP_ALLOWED_HOSTS);
  if (!allowedHosts.length) allowedHosts.push(issuerUrl.hostname, mcpServerUrl.hostname, 'localhost', '127.0.0.1', '[::1]', ...(env.FLY_APP_NAME ? [`${env.FLY_APP_NAME}.fly.dev`] : []));
  const config = readConfig({ ...env, APIOSK_MCP_TRANSPORT: 'http', APIOSK_MCP_HOST: env.APIOSK_MCP_HOST || env.APIOSK_MCP_BIND_HOST || '0.0.0.0', APIOSK_MCP_ALLOWED_HOSTS: [...new Set(allowedHosts)].join(',') }, []);
  const factory = createService || hostedServiceFactory(config);
  const oauth = createHostedOAuthSupport({ env, issuerUrl, mcpServerUrl, appName: 'Apiosk', resourceName: 'Apiosk Ask', ...oauthOptions });
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

  const challenge = (res, status = 401) => res.status(status).set('WWW-Authenticate',
    `Bearer error="${status === 403 ? 'insufficient_scope' : 'invalid_token'}", scope="mcp:tools", resource_metadata="${oauth.resourceMetadataUrl.href}"`)
    .json({ error: status === 403 ? 'insufficient_scope' : 'invalid_token', error_description: 'Connect your Apiosk account to use this MCP server.' });
  const authenticate = async (req, res, next) => {
    const explicit = req.headers['x-apiosk-connect-token'];
    const supplied = typeof explicit === 'string' ? explicit.trim() : /^Bearer ([^\s]{1,16384})$/i.exec(req.headers.authorization || '')?.[1];
    if (!supplied || supplied.length > 16384 || /\s/.test(supplied)) return challenge(res);
    try {
      const auth = await oauth.provider.verifyAccessToken(supplied);
      if (!auth.scopes?.includes('mcp:tools')) return challenge(res, 403);
      const token = auth.extra?.apiosk_connect_token;
      if (!token || typeof token !== 'string') return challenge(res);
      const workspace = req.headers['x-apiosk-workspace-id'] || null;
      if (workspace && (typeof workspace !== 'string' || !workspacePattern.test(workspace))) return res.status(400).json({ error: 'invalid_workspace' });
      req.askCaller = { token, workspace, stateScope: auth.extra?.apiosk_state_scope || null };
      next();
    } catch { return challenge(res); }
  };
  const rpcError = (res, status, message) => res.status(status).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message } });

  app.post('/mcp', authenticate, async (req, res) => {
    let server;
    try {
      server = createMcpServer({ service: await factory(req.askCaller) });
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
  app.get('/mcp', authenticate, (_req, res) => res.status(405).set('Allow', 'POST, DELETE').end());
  app.delete('/mcp', authenticate, (_req, res) => res.status(200).json({ ok: true }));

  // Keep installed legacy SSE endpoints. Bind each stream to its authenticated
  // buyer + workspace; a rotated upstream token must reconnect its stream.
  app.get('/sse', authenticate, async (req, res) => {
    if (sessions.size >= 64) return rpcError(res, 503, 'Too many active MCP streams. Reconnect shortly.');
    const server = createMcpServer({ service: await factory(req.askCaller) });
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

  app.get('/health', (_req, res) => res.json({ status: 'ok', server: SERVER_INFO, gateway_verified: false }));
  app.get('/', (_req, res) => res.json({ name: 'Apiosk Ask', mcp_endpoint: mcpServerUrl.href, oauth_issuer: issuerUrl.href, health: '/health' }));
  app.get('/.well-known/mcp/server-card.json', (_req, res) => res.json({ name: 'Apiosk Ask', description: SERVER_INFO.description, server: SERVER_INFO, transport: 'streamable-http', endpoint: mcpServerUrl.href, authentication: { type: 'oauth2', issuer: issuerUrl.href } }));
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
