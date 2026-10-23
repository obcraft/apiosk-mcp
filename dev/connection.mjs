import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

const CONNECT_TIMEOUT = 30_000;
const REQUEST_TIMEOUT = 180_000;
const AUTH_TIMEOUT = 15_000;
const AUTH_LIFETIME = 10 * 60_000;
const MAX_TOOL_PAGES = 100;
const MAX_TOOLS = 5_000;
const clone = value => value == null ? value : structuredClone(value);

function safeUrl(value, label) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${label} must be a valid URL.`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (!(parsed.protocol === 'https:' || parsed.protocol === 'http:' && loopback) || parsed.username || parsed.password || parsed.hash) {
    throw new Error(`${label} requires HTTPS or loopback HTTP without embedded credentials or fragments.`);
  }
  return parsed;
}

function safeError(error, method) {
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === -32001) {
    return `MCP ${method} timed out or was cancelled. Read saved status before retrying a purchase.`;
  }
  if (error instanceof UnauthorizedError || error?.code === 401 || error?.code === 403) {
    return 'MCP authentication is required. Connect again to sign in.';
  }
  // SDK OAuth errors may contain the complete upstream body or request URL.
  // Neither those errors nor credential-bearing transport objects leave here.
  return `MCP ${method} failed. Check the server and try again; recover saved status before retrying a purchase.`;
}

function sameState(actual, expected) {
  if (typeof actual !== 'string' || !expected || actual.length > 1024) return false;
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(actual), digest(expected));
}

/** A per-browser-session MCP client. Credentials stay in this closure only. */
export function createConnection({ url, callbackUrl, onTrace, fetchImpl = globalThis.fetch }) {
  const serverUrl = safeUrl(url, 'MCP server URL');
  const redirectUrl = safeUrl(callbackUrl, 'OAuth callback URL');
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required.');

  let client = null, transport = null, sessionAbort = null;
  let connected = false, serverInfo = null, tools = [], instructions = '', authUrl = null, error = null;
  let clientInfo, tokens, verifier, discovery, pendingState, stateExpiresAt = 0, bearer = null;
  let lifecycle = Promise.resolve();
  const outputValidators = new Map();
  const validator = new AjvJsonSchemaValidator();

  const trace = event => {
    try { onTrace?.({ at: new Date().toISOString(), ...event }); } catch { /* Observability never interrupts MCP. */ }
  };
  const snapshot = () => ({ connected, serverInfo: clone(serverInfo), tools: clone(tools), authUrl, error });
  const serial = work => {
    const result = lifecycle.then(work, work);
    lifecycle = result.catch(() => {});
    return result;
  };
  const clearPending = () => { authUrl = null; pendingState = undefined; stateExpiresAt = 0; verifier = undefined; };
  const clearCredentials = () => { clearPending(); clientInfo = undefined; tokens = undefined; discovery = undefined; bearer = null; };

  const provider = {
    get redirectUrl() { return redirectUrl.href; },
    get clientMetadata() {
      return {
        client_name: 'Apiosk Local Chatbot', redirect_uris: [redirectUrl.href],
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
        token_endpoint_auth_method: 'none', scope: 'mcp:tools',
      };
    },
    state() {
      pendingState = randomBytes(32).toString('base64url');
      stateExpiresAt = Date.now() + AUTH_LIFETIME;
      return pendingState;
    },
    clientInformation: () => clientInfo,
    saveClientInformation: value => { clientInfo = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier() {
      if (!verifier) throw new Error('No pending OAuth verifier.');
      return verifier;
    },
    redirectToAuthorization(value) {
      const target = safeUrl(value, 'Authorization URL');
      if (!sameState(target.searchParams.get('state'), pendingState)) throw new Error('Invalid authorization state.');
      authUrl = target.href;
      trace({ direction: 'in', method: 'oauth/authorize', status: 'authorization_required' });
    },
    saveDiscoveryState: value => { discovery = value; },
    discoveryState: () => discovery,
    invalidateCredentials(scope) {
      if (scope === 'all' || scope === 'client') clientInfo = undefined;
      if (scope === 'all' || scope === 'tokens') tokens = undefined;
      if (scope === 'all' || scope === 'discovery') discovery = undefined;
      if (scope === 'all' || scope === 'verifier') verifier = undefined;
    },
  };

  async function network(input, init = {}) {
    const destination = new URL(input instanceof Request ? input.url : input);
    const isMcp = destination.origin === serverUrl.origin && destination.pathname === serverUrl.pathname;
    const timeout = isMcp && init.method !== 'DELETE' ? REQUEST_TIMEOUT : AUTH_TIMEOUT;
    const signals = [init.signal, sessionAbort?.signal, AbortSignal.timeout(timeout)].filter(Boolean);
    // OAuth token exchanges can carry secrets in a POST body. Never follow an
    // upstream redirect with that body or a supplied Authorization header.
    return fetchImpl(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  }

  function newTransport() {
    return new StreamableHTTPClientTransport(serverUrl, {
      fetch: network,
      ...(bearer ? { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } } : { authProvider: provider }),
      reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1000, maxReconnectionDelay: 5000, reconnectionDelayGrowFactor: 1.5 },
    });
  }

  async function closeCurrent({ terminate = false } = {}) {
    const oldClient = client, oldTransport = transport;
    client = null; transport = null; connected = false;
    if (terminate && oldTransport?.sessionId) {
      try { await oldTransport.terminateSession(); } catch { /* Closing locally still clears credentials. */ }
    }
    sessionAbort?.abort();
    sessionAbort = null;
    try { await oldClient?.close(); } catch { /* Already closed. */ }
    try { await oldTransport?.close(); } catch { /* Already closed. */ }
  }

  async function observed(method, work) {
    const start = Date.now();
    trace({ direction: 'out', method, status: 'pending' });
    try {
      const result = await work();
      trace({ direction: 'in', method, status: 'success', durationMs: Date.now() - start });
      return result;
    } catch (cause) {
      trace({ direction: 'in', method, status: cause instanceof UnauthorizedError && authUrl ? 'authorization_required' : 'error', durationMs: Date.now() - start, error: safeError(cause, method) });
      throw cause;
    }
  }

  async function establish() {
    sessionAbort = new AbortController();
    transport = newTransport();
    const activeClient = new Client({
      name: 'apiosk-local-chatbot', title: 'Apiosk Local Chatbot', version: '1.0.0',
      icons: [{ src: 'https://mcp.apiosk.com/brand/apiosk-a-20260921.png', mimeType: 'image/png', sizes: ['1254x1254'] }],
    }, { capabilities: { experimental: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } });
    client = activeClient;
    activeClient.onerror = cause => trace({ direction: 'in', method: 'transport', status: 'error', error: safeError(cause, 'transport') });
    activeClient.onclose = () => { if (client === activeClient) connected = false; };
    const deadline = setTimeout(() => sessionAbort?.abort(), CONNECT_TIMEOUT);
    try {
      const options = { timeout: CONNECT_TIMEOUT, maxTotalTimeout: CONNECT_TIMEOUT, signal: sessionAbort.signal };
      await observed('initialize', () => activeClient.connect(transport, options));
      serverInfo = clone(activeClient.getServerVersion());
      instructions = activeClient.getInstructions() || '';
      const found = new Map(), cursors = new Set();
      let cursor;
      for (let page = 0; ; page++) {
        if (page >= MAX_TOOL_PAGES) throw new Error('Tool pagination limit exceeded.');
        const result = await observed('tools/list', () => activeClient.listTools(cursor ? { cursor } : {}, options));
        for (const tool of result.tools) {
          if (found.has(tool.name) || found.size >= MAX_TOOLS) throw new Error('Invalid tool catalog pagination.');
          found.set(tool.name, tool);
        }
        if (!result.nextCursor) break;
        if (cursors.has(result.nextCursor)) throw new Error('Repeated tool catalog cursor.');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      tools = [...found.values()];
      outputValidators.clear();
      // SDK 1.27 resets its schema cache on each page. Keep validators for the
      // complete catalog so earlier pages have the same validation guarantee.
      for (const tool of tools) if (tool.outputSchema) outputValidators.set(tool.name, validator.getValidator(tool.outputSchema));
      connected = true; error = null; clearPending();
      return snapshot();
    } catch (cause) {
      connected = false;
      error = cause instanceof UnauthorizedError && authUrl ? null : safeError(cause, 'connection');
      // Keep the closed transport's OAuth discovery/scope for finishAuth.
      // Client.connect closes its transport after an initialization failure.
      sessionAbort?.abort();
      try { await activeClient.close(); } catch { /* Already closed. */ }
      client = null;
      tools = []; instructions = ''; serverInfo = null; outputValidators.clear();
      return snapshot();
    } finally { clearTimeout(deadline); }
  }

  async function connect({ token } = {}) {
    return serial(async () => {
      if (token !== undefined && (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token) || token.length > 16_384)) {
        throw new Error('Supply a nonempty bearer token without line breaks.');
      }
      if (token === undefined && (connected || authUrl && Date.now() < stateExpiresAt)) return snapshot();
      await closeCurrent();
      if (token !== undefined) { clearCredentials(); bearer = token.trim(); }
      else { bearer = null; clearPending(); }
      error = null;
      return establish();
    });
  }

  async function finishAuth({ code, state } = {}) {
    return serial(async () => {
      if (!authUrl || Date.now() >= stateExpiresAt || !sameState(state, pendingState)) {
        throw new Error('The OAuth state is invalid, expired, or already used. Start Connect again.');
      }
      if (typeof code !== 'string' || !code || code.length > 8192 || /[\r\n]/.test(code)) throw new Error('The OAuth callback has no valid authorization code.');
      // Consume state before exchanging the code. Parallel callbacks cannot
      // exchange it twice, and an error never makes the old callback reusable.
      pendingState = undefined; stateExpiresAt = 0; authUrl = null; error = null;
      sessionAbort = new AbortController();
      const authTransport = transport || newTransport();
      const deadline = setTimeout(() => sessionAbort?.abort(), CONNECT_TIMEOUT);
      try {
        await observed('oauth/token', () => authTransport.finishAuth(code));
      } catch (cause) {
        error = safeError(cause, 'authorization'); clearPending();
        await closeCurrent();
        return snapshot();
      } finally { clearTimeout(deadline); }
      await closeCurrent();
      return establish();
    });
  }

  async function disconnect() {
    return serial(async () => {
      await closeCurrent({ terminate: true });
      clearCredentials(); tools = []; instructions = ''; serverInfo = null; error = null; outputValidators.clear();
      trace({ direction: 'in', method: 'disconnect', status: 'success' });
      return snapshot();
    });
  }

  async function request(method, work) {
    await lifecycle;
    const activeClient = client;
    if (!connected || !activeClient) throw new Error('Connect to the MCP server first.');
    try {
      return await observed(method, () => work(activeClient, { timeout: REQUEST_TIMEOUT, maxTotalTimeout: REQUEST_TIMEOUT, signal: sessionAbort.signal }));
    } catch (cause) {
      const message = safeError(cause, method);
      if (activeClient === client) {
        error = message;
        if (cause instanceof UnauthorizedError || cause?.code === 401 || cause?.code === 403) connected = false;
      }
      throw new Error(message);
    }
  }

  return {
    connect, finishAuth, disconnect, snapshot,
    get tools() { return clone(tools); },
    get instructions() { return instructions; },
    async callTool(name, args = {}) {
      await lifecycle;
      const tool = tools.find(tool => tool.name === name);
      if (!tool) throw new Error('That tool is not in the connected MCP catalog.');
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
      if (tool.execution?.taskSupport === 'required') throw new Error('This local host does not support required MCP task execution.');
      return request('tools/call', async (activeClient, options) => {
        const result = await activeClient.callTool({ name, arguments: args }, undefined, options);
        const check = outputValidators.get(name);
        if (!result.isError && check && (!result.structuredContent || !check(result.structuredContent).valid)) throw new Error('Invalid structured tool output.');
        return result;
      });
    },
    async readResource(uri) {
      if (typeof uri !== 'string' || !uri || uri.length > 16_384) throw new Error('Supply a resource URI.');
      return request('resources/read', (activeClient, options) => activeClient.readResource({ uri }, options));
    },
  };
}
