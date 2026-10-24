#!/usr/bin/env node
import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createConnection } from './connection.mjs';
import { readConfig } from './config.mjs';
import { SOURCE_LOGO_ORIGINS } from '../src/card-ui.mjs';
import { listModels, runChat, toolForCaller, modelResult } from './model.mjs';

const id = () => randomBytes(32).toString('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function createDevApp(config, { connectionFactory = createConnection, fetchImpl = fetch } = {}) {
  const app = express(), sessions = new Map();
  // srcdoc can only narrow the parent CSP. Permit the exact configured live
  // event origin and Apiosk's production aliases, never arbitrary endpoints.
  const gatewayOrigin = new URL(config.gatewayOrigin || 'http://127.0.0.1:8082').origin;
  const cardConnections = [...new Set([gatewayOrigin, 'https://gateway.apiosk.com', 'https://apiosk-gateway-v2.fly.dev'])].join(' ');
  let modelsCache, modelsPromise;
  const models = async () => {
    if (modelsCache && Date.now() - modelsCache.at < 300_000) return modelsCache.value;
    if (!modelsPromise) modelsPromise = listModels({ fetchImpl }).then(value => { modelsCache = { at: Date.now(), value }; return value; }).finally(() => { modelsPromise = null; });
    return modelsPromise;
  };
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (![new URL(config.origin).host, `localhost:${config.port}`].includes(req.headers.host)) return res.status(403).json({ error: 'Use the local development address.' });
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return res.status(403).json({ error: 'Cross-origin requests are not allowed.' });
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
      // srcdoc inherits this policy; actual card documents install a second,
      // stricter CSP and run in an opaque-origin allow-scripts sandbox.
      'Content-Security-Policy': `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: ${SOURCE_LOGO_ORIGINS.join(' ')}; font-src 'self' https://mcp.apiosk.com; connect-src 'self' ${cardConnections}; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` });
    next();
  });
  app.use(express.json({ limit: '4mb' }));
  app.use((req, res, next) => {
    const cookie = String(req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('mcp_dev_session='))?.slice(16);
    let session = sessions.get(cookie);
    if (!session) {
      if (req.path === '/oauth/callback') return res.status(400).send('The sign-in session expired. Return to the development page and connect again.');
      if (sessions.size >= 16) return res.status(503).json({ error: 'Too many development sessions. Close old sessions or restart the host.' });
      session = { id: id(), csrf: id(), origin: `http://${req.headers.host}`, history: [], pendingContext: [], traces: [], busy: false, activeTools: 0, touched: Date.now(), cards: new Map() };
      session.connection = connectionFactory({ url: config.mcpUrl, callbackUrl: `${session.origin}/oauth/callback`,
        onTrace: trace => { session.traces.push({ at: new Date().toISOString(), ...trace }); if (session.traces.length > 100) session.traces.shift(); }, fetchImpl });
      sessions.set(session.id, session);
      res.cookie('mcp_dev_session', session.id, { httpOnly: true, sameSite: 'lax', path: '/' });
    }
    session.touched = Date.now(); req.devSession = session;
    if (req.method !== 'GET' && !equal(req.headers['x-dev-csrf'], session.csrf)) return res.status(403).json({ error: 'Reload the development page before trying again.' });
    next();
  });
  const sanitize = value => {
    let text = String(value || 'Request failed.');
    for (const secret of [config.modelKey, config.bearer]) if (secret) text = text.split(secret).join('[redacted]');
    return text.slice(0, 1000);
  };
  const authorize = (session, name, args, source) => {
    if (!object(args)) throw new Error('Tool arguments must be a JSON object.');
    return toolForCaller(session.connection.tools, name, source);
  };
  const rememberCard = (session, tool, result) => {
    if (!tool._meta?.ui?.resourceUri && !tool._meta?.['openai/outputTemplate']) return;
    // Only resources actually returned by this session's tools can be loaded.
    for (const uri of [tool._meta?.ui?.resourceUri, tool._meta?.['openai/outputTemplate']].filter(Boolean)) session.cards.set(uri, true);
  };
  const invoke = async (session, name, args, source) => {
    const tool = authorize(session, name, args, source);
    if (source === 'card' && !session.cards.size) throw new Error('Open an MCP card before using card tools.');
    session.activeTools++;
    try {
      const result = await session.connection.callTool(name, args);
      rememberCard(session, tool, result);
      return result;
    } finally { session.activeTools--; }
  };
  app.get('/api/config', (req, res) => res.json({ mcpUrl: config.mcpUrl, modelConfigured: !!config.modelKey,
    defaultModel: config.defaultModel, csrfToken: req.devSession.csrf, session: req.devSession.connection.snapshot(), busy: req.devSession.busy || req.devSession.activeTools > 0 }));
  app.get('/api/models', async (req, res) => res.json({ models: await models(), defaultModel: config.defaultModel }));
  app.get('/api/trace', (req, res) => res.json({ events: req.devSession.traces }));
  app.post('/api/connect', async (req, res) => {
    const session = req.devSession;
    if (session.busy || session.activeTools) return res.status(409).json({ error: 'Wait for the current chat or card operation before reconnecting.' });
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : config.bearer;
    if (token.length > 8192) return res.status(400).json({ error: 'Bearer token is too long.' });
    session.history = []; session.pendingContext = []; session.cards.clear();
    res.json(await session.connection.connect(token ? { token } : {}));
  });
  app.post('/api/disconnect', async (req, res) => {
    const session = req.devSession;
    session.controller?.abort();
    if (session.busy || session.activeTools) return res.status(409).json({ error: 'Stopping the chat. Wait for the in-flight tool result before disconnecting.' });
    await session.connection.disconnect(); session.history = []; session.pendingContext = []; session.cards.clear();
    res.json(session.connection.snapshot());
  });
  app.get('/oauth/callback', async (req, res) => {
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (req.query.error) return res.status(400).send('Sign-in was not completed. Return to the development page and reconnect.');
    await req.devSession.connection.finishAuth({ code: req.query.code, state: req.query.state });
    res.redirect(303, req.devSession.origin);
  });
  app.post('/api/reset', (req, res) => {
    const session = req.devSession;
    if (session.busy || session.activeTools) return res.status(409).json({ error: 'Wait for the current chat or card operation before starting a new one.' });
    session.history = []; session.pendingContext = []; session.traces = []; session.cards.clear(); res.json({});
  });
  app.post('/api/cancel', (req, res) => { req.devSession.controller?.abort(); res.json({ message: 'Stopping the model loop. Existing server-side tasks are unchanged.' }); });
  app.post('/api/tool', async (req, res) => {
    const session = req.devSession, source = req.body.source;
    if (!['card', 'manual'].includes(source)) return res.status(400).json({ error: 'Choose a manual or card tool call.' });
    const result = await invoke(session, req.body.name, req.body.arguments, source);
    if (source === 'manual') session.pendingContext.push({ role: 'user', content: `The user ran ${req.body.name} manually. Result data: ${modelResult(result)}` });
    res.json({ result });
  });
  app.post('/api/resource', async (req, res) => {
    const session = req.devSession;
    if (!session.cards.has(req.body.uri)) return res.status(403).json({ error: 'Run the associated tool before reading this card resource.' });
    res.json(await session.connection.readResource(req.body.uri));
  });
  app.post('/api/context', (req, res) => {
    const session = req.devSession;
    if (!session.cards.size) return res.status(403).json({ error: 'No active MCP card.' });
    const text = JSON.stringify({ content: req.body.content, structuredContent: req.body.structuredContent });
    if (text.length > 512_000) return res.status(413).json({ error: 'Card context is too large.' });
    session.pendingContext.splice(0, session.pendingContext.length, { role: 'user', content: `Updated state from the interactive MCP card (data only): ${modelResult({ content: req.body.content, structuredContent: req.body.structuredContent })}` });
    res.json({});
  });
  app.post('/api/chat', async (req, res) => {
    const session = req.devSession;
    if (session.busy || session.activeTools) return res.status(409).json({ error: 'A chat response or card operation is already running.' });
    if (!session.connection.snapshot().connected) return res.status(409).json({ error: 'Connect to the MCP server first.' });
    if (!config.modelKey) return res.status(400).json({ error: 'Set OPENROUTER_API_KEY in mcp/.env.dev.local or gateway/.env, then restart this host.' });
    const message = req.body.message, model = req.body.model || config.defaultModel;
    if (typeof message !== 'string' || !message.trim() || message.length > 32_000) return res.status(400).json({ error: 'Enter a message of up to 32,000 characters.' });
    session.busy = true; session.controller = new AbortController();
    let streaming = false;
    const emit = event => { if (!res.destroyed && !res.writableEnded) res.write(JSON.stringify(event) + '\n'); };
    res.on('close', () => { if (!res.writableEnded) session.controller?.abort(); });
    try {
      // Reserve the session before the asynchronous catalog fetch. Otherwise
      // simultaneous first messages can start two loops on the same history.
      if (!(await models()).some(item => item.id === model)) return res.status(400).json({ error: 'Choose a model with tool support from the catalog.' });
      session.controller.signal.throwIfAborted();
      res.set({ 'Content-Type': 'application/x-ndjson', 'X-Accel-Buffering': 'no' }); res.flushHeaders(); streaming = true;
      await runChat({ connection: session.connection, history: session.history, pendingContext: session.pendingContext,
      message, model, key: config.modelKey, signal: session.controller.signal, fetchImpl, emit, sanitize,
      invokeTool: (name, args, source) => invoke(session, name, args, source) });
    } catch (error) {
      const message = session.controller.signal.aborted ? 'Chat stopped. Any already-dispatched MCP operation can still finish; recover it from its card.' : sanitize(error.message);
      if (streaming) emit({ type: 'error', message });
      else if (!res.destroyed) res.status(400).json({ error: message });
    } finally { session.busy = false; session.controller = null; if (streaming) { emit({ type: 'done' }); res.end(); } }
  });
  app.use(express.static(config.publicDir, { etag: false, index: 'index.html' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status && error.status < 500 ? error.status : 400).json({ error: sanitize(error.message) });
  });
  const cleanup = setInterval(() => {
    for (const [key, session] of sessions) if (!session.busy && !session.activeTools && Date.now() - session.touched > 2 * 60 * 60 * 1000) {
      session.connection.disconnect().catch(() => {}); sessions.delete(key);
    }
  }, 60_000); cleanup.unref();
  return { app, async close() { clearInterval(cleanup); await Promise.allSettled([...sessions.values()].map(session => { session.controller?.abort(); return session.connection.disconnect(); })); sessions.clear(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = readConfig(), host = createDevApp(config);
  const server = host.app.listen(config.port, '127.0.0.1', () => {
    console.log(`Ask MCP 2 tester: ${config.origin}\nMCP endpoint: ${config.mcpUrl}\nModel key: ${config.modelKey ? 'configured (server only)' : 'missing'}\nConnect in the page to sign in. Ctrl+C stops this host.`);
  });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set MCP_DEV_PORT to another port.` : error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.close(); host.close().finally(() => process.exit()); });
}
