// Local development host for the production UI resource; no resource code runs
// in this document. Native MCP Apps uses its standard JSON-RPC wire format.
const CHANNEL = 'apiosk-dev-card';
const MAX_STATE_BYTES = 2 * 1024 * 1024;

function copy(value) {
  if (value === undefined) return null;
  const json = JSON.stringify(value);
  if (json.length > MAX_STATE_BYTES) throw new Error('Card state is too large.');
  return JSON.parse(json);
}

function origins(values, protocols = ['https:', 'http:']) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.filter(value => {
    if (typeof value !== 'string' || /[\s;'"<>]/.test(value)) return false;
    try {
      const url = new URL(value.replace('://*.', '://wildcard.'));
      return protocols.includes(url.protocol) && !url.username && !url.password &&
        !url.search && !url.hash && url.pathname === '/' &&
        /^\w+:\/\/(?:\*\.)?[a-z0-9.[\]:-]+\/?$/i.test(value);
    } catch { return false; }
  }))];
}

function contentPolicy(meta = {}) {
  const policy = meta.ui?.csp ?? meta['openai/widgetCSP'] ?? {};
  const resources = origins(policy.resourceDomains ?? policy.resource_domains);
  const directive = values => values.length ? values.join(' ') : "'none'";
  return [
    "default-src 'none'", "object-src 'none'", "form-action 'none'", "worker-src 'none'",
    `base-uri ${directive(origins(policy.baseUriDomains ?? policy.base_uri_domains))}`,
    `connect-src ${directive(origins(policy.connectDomains ?? policy.connect_domains, ['https:', 'http:', 'wss:', 'ws:']))}`,
    `script-src 'unsafe-inline' ${resources.join(' ')}`,
    `style-src 'unsafe-inline' ${resources.join(' ')}`,
    `img-src data: ${resources.join(' ')}`, `media-src data: ${resources.join(' ')}`,
    `font-src ${directive(resources)}`,
    `frame-src ${directive(origins(policy.frameDomains ?? policy.frame_domains))}`,
  ].join('; ');
}

function resourceContent(resource) {
  const item = resource?.contents?.[0] ?? resource;
  if (!item || !/^ui:\/\//.test(item.uri ?? '') ||
      !/^text\/html(?:\+skybridge)?(?:;|$)/i.test(item.mimeType ?? '')) {
    throw new Error('Expected an HTML ui:// resource.');
  }
  const html = typeof item.text === 'string' ? item.text : typeof item.blob === 'string'
    ? new TextDecoder().decode(Uint8Array.from(atob(item.blob), char => char.charCodeAt(0))) : null;
  if (html === null || html.length > MAX_STATE_BYTES) throw new Error('Invalid card HTML.');
  return { item, html };
}

function resultContent(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  for (const entry of result?.content ?? []) {
    if (entry?.type === 'text') { try { return JSON.parse(entry.text); } catch {} }
  }
  return result;
}

function toolResult(result) {
  return result && typeof result === 'object' && (Array.isArray(result.content) || 'structuredContent' in result)
    ? result : { content: [], structuredContent: result ?? {} };
}

// Stringified into the isolated document. Keep it self-contained.
function installOpenAi(initial) {
  const pending = new Map(); let sequence = 0, closed = false;
  const send = (method, params, id) => window.parent.postMessage({
    channel: 'apiosk-dev-card', nonce: initial.nonce, method, params, ...(id === undefined ? {} : { id }),
  }, '*');
  const rpc = (method, params) => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('Card closed.'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host request timed out.')); }, 180000);
    pending.set(id, { resolve, reject, timer }); send(method, params, id);
  });
  const globals = values => {
    Object.assign(window.openai, values);
    window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: values } }));
  };
  window.openai = {
    toolInput: initial.input, toolOutput: initial.output, toolResponseMetadata: initial.meta,
    theme: initial.theme, widgetState: initial.widgetState, displayMode: 'inline',
    locale: navigator.language || 'en', maxHeight: 10000,
    safeArea: { insets: { top: 0, right: 0, bottom: 0, left: 0 } },
    callTool: (name, args = {}) => rpc('tools/call', { name, arguments: args }),
    sendFollowUpMessage: ({ prompt }) => rpc('ui/message', { role: 'user', content: [{ type: 'text', text: prompt }] }),
    setWidgetState(value) {
      const json = JSON.stringify(value);
      if (json.length > 2 * 1024 * 1024) throw new Error('Card state is too large.');
      window.openai.widgetState = JSON.parse(json);
      send('widget/set-state', { state: window.openai.widgetState });
    },
    openExternal: ({ href }) => { void rpc('ui/open-link', { url: href }).catch(() => {}); },
    notifyIntrinsicHeight: height => send('ui/notifications/size-changed', { height }),
    requestDisplayMode: async ({ mode }) => {
      const result = await rpc('ui/request-display-mode', { mode });
      globals({ displayMode: result.mode }); return result;
    },
    requestClose: () => send('host/close', {}),
  };
  window.addEventListener('message', event => {
    const message = event.data;
    if (event.source !== window.parent || message?.channel !== 'apiosk-dev-card' || message.nonce !== initial.nonce) return;
    if (message.method === 'host/globals') { globals(message.params); return; }
    if (message.method === 'host/teardown') {
      closed = true;
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Card closed.')); }
      pending.clear(); return;
    }
    const request = pending.get(message.id); if (!request) return;
    pending.delete(message.id); clearTimeout(request.timer);
    message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
  });
  send('host/ready', {});
}

function scriptData(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Mount one resource. Saved state is scoped to this instance and its remounts. */
export function mountCard({ container, resource, tool, input = {}, result = {}, mode = 'mcp', theme = 'light',
  callTool, onMessage, onContext, onTrace } = {}) {
  if (!container?.ownerDocument || !['mcp', 'chatgpt'].includes(mode)) throw new Error('Invalid card host options.');
  const { item, html } = resourceContent(resource);
  const document = container.ownerDocument, host = document.defaultView;
  const policy = contentPolicy(item._meta);
  let frame, removeListener, generation = 0, active = false, widgetState = null, savedContext = null;
  let currentTheme = theme === 'dark' ? 'dark' : 'light';
  const trace = event => { try { onTrace?.({ ...event, mode, resourceUri: item.uri }); } catch {} };
  const context = async (value, kind) => { await onContext?.(value, { mode, kind, resourceUri: item.uri }); };

  function create() {
    const mountGeneration = ++generation, requests = new Map();
    const nonce = host.crypto.randomUUID();
    let initialized = false, ready = false;
    active = true;
    const iframe = document.createElement('iframe'); frame = iframe;
    // App JSON/CSV exports use a user-clicked Blob download. Keep the frame's
    // opaque origin; downloads do not grant parent DOM, forms or popup access.
    iframe.setAttribute('sandbox', 'allow-scripts allow-downloads');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.setAttribute('title', `${typeof tool === 'string' ? tool : tool?.name ?? 'Apiosk'} card`);
    iframe.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-write 'none'");
    Object.assign(iframe.style, { width: '100%', height: '420px', border: '0', display: 'block', colorScheme: currentTheme });
    const isActive = () => active && generation === mountGeneration;
    const send = message => {
      if (!isActive()) return;
      trace({ direction: 'host-to-card', ...message });
      iframe.contentWindow?.postMessage(message, '*'); // Opaque sandbox origins require '*'.
    };
    const notify = (method, params) => send({ jsonrpc: '2.0', method, params });
    const shim = (method, params) => send({ channel: CHANNEL, nonce, method, params });
    const reply = (message, value, error) => send({
      ...(message.channel === CHANNEL ? { channel: CHANNEL, nonce } : { jsonrpc: '2.0' }),
      id: message.id, ...(error ? { error: { code: error.code ?? -32000, message: error.message || 'Host request failed.' } } : { result: value ?? {} }),
    });

    async function dispatch(message) {
      const params = message.params ?? {};
      if (message.method === 'ui/initialize') {
        if (mode !== 'mcp') throw Object.assign(new Error('Use the ChatGPT bridge in this mode.'), { code: -32601 });
        if (initialized) throw new Error('Card already initialized.');
        initialized = true;
        return { protocolVersion: '2026-01-26', hostInfo: { name: 'Apiosk local development host', version: '1.0.0' },
          hostCapabilities: { serverTools: {}, message: { text: {} }, openLinks: {}, updateModelContext: { text: {} } },
          hostContext: { theme: currentTheme, displayMode: 'inline', availableDisplayModes: ['inline'], locale: host.navigator?.language || 'en' } };
      }
      if (message.method === 'host/ready' && mode === 'chatgpt') { ready = true; return {}; }
      if (message.method === 'ui/notifications/initialized' && mode === 'mcp' && initialized && !ready) {
        ready = true;
        notify('ui/notifications/tool-input', { arguments: copy(input) });
        notify('ui/notifications/tool-result', savedContext?.structuredContent !== undefined ? toolResult(savedContext.structuredContent) : toolResult(result));
        return {};
      }
      if (!ready) throw new Error('Card is not initialized.');
      switch (message.method) {
        case 'ping': return {};
        case 'tools/call': {
          if (typeof params.name !== 'string' || !params.name || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) throw new Error('Invalid tool call.');
          if (!callTool) throw new Error('Tool calls are unavailable.');
          return await callTool(params.name, copy(params.arguments), { source: 'card', tool, resourceUri: item.uri, mode });
        }
        case 'ui/message': {
          if (!['user', 'assistant'].includes(params.role) || !Array.isArray(params.content) ||
            params.content.some(part => part?.type !== 'text' || typeof part.text !== 'string')) throw new Error('Only text follow-up messages are supported.');
          if (!onMessage) throw new Error('Follow-up messages are unavailable.');
          await onMessage(params.content.map(part => part.text).join('\n'), { ...copy(params), source: 'card' });
          return {};
        }
        case 'ui/update-model-context': {
          const value = copy(params); await context(value, 'model-context');
          if (isActive()) savedContext = value; return {};
        }
        case 'widget/set-state': {
          if (mode !== 'chatgpt') throw new Error('Widget state requires ChatGPT mode.');
          const next = copy(params.state);
          widgetState = next;
          // Apps SDK privateContent is for this widget's display cache. Only
          // modelContent enters the surrounding model conversation.
          await context({ content: [{ type: 'text', text: JSON.stringify(next?.modelContent ?? {}) }],
            structuredContent: next?.modelContent ?? {} }, 'widget-state');
          return {};
        }
        case 'ui/open-link': {
          const url = new URL(params.url);
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Only HTTPS links are allowed.');
          host.open(url.href, '_blank', 'noopener,noreferrer'); return {};
        }
        case 'ui/notifications/size-changed': {
          if (typeof params.height === 'number' && Number.isFinite(params.height)) iframe.style.height = `${Math.min(10000, Math.max(80, Math.ceil(params.height)))}px`;
          return {};
        }
        case 'ui/request-display-mode': return { mode: 'inline' };
        case 'notifications/message': return {};
        case 'host/close': destroy(); return {};
        default: throw Object.assign(new Error('Unsupported card method.'), { code: -32601 });
      }
    }

    const receive = event => {
      if (!isActive() || event.source !== iframe.contentWindow) return;
      const message = event.data;
      if (!message || typeof message !== 'object' || typeof message.method !== 'string') return;
      const fromShim = message.channel === CHANNEL && message.nonce === nonce;
      if (mode === 'chatgpt' ? !fromShim && !(message.jsonrpc === '2.0' && message.method === 'ui/initialize') : message.jsonrpc !== '2.0') return;
      if (message.id !== undefined && (typeof message.id !== 'number' && typeof message.id !== 'string')) return;
      if (['tools/call', 'ui/message', 'ui/open-link', 'ui/update-model-context'].includes(message.method) && message.id === undefined) return;
      const requestKey = message.id === undefined ? null : JSON.stringify([fromShim, message.id]);
      if (requestKey && requests.has(requestKey)) return; // Never replay a duplicate request's effects.
      if (requestKey) {
        if (requests.size >= 2048) { reply(message, null, new Error('Card request limit reached; remount to continue.')); return; }
        requests.set(requestKey, true);
      }
      trace({ direction: 'card-to-host', method: message.method, id: message.id, params: message.params });
      void dispatch(message).then(value => {
        if (message.id !== undefined) reply(message, value);
      }, error => {
        trace({ direction: 'host-error', method: message.method, message: error.message });
        if (message.id !== undefined) reply(message, null, error);
      });
    };
    host.addEventListener('message', receive);
    removeListener = () => host.removeEventListener('message', receive);
    iframe.__apioskTheme = value => mode === 'chatgpt' ? shim('host/globals', { theme: value }) : ready && notify('ui/notifications/host-context-changed', { theme: value });
    iframe.__apioskTeardown = () => {
      if (mode === 'chatgpt') shim('host/teardown', {});
      else if (ready) send({ jsonrpc: '2.0', id: `host-teardown-${mountGeneration}`, method: 'ui/resource-teardown', params: { reason: 'Host removed or remounted the card.' } });
    };
    const boot = mode === 'chatgpt' ? `<script>(${installOpenAi.toString()})(${scriptData({
      nonce, input: copy(input), output: resultContent(result), meta: result?._meta ?? {}, theme: currentTheme, widgetState,
    })});</script>` : '';
    const escapedPolicy = policy.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    iframe.srcdoc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapedPolicy}">${boot}${html.replace(/^\s*<!doctype[^>]*>/i, '')}`;
    trace({ direction: 'host', method: 'card/mount', csp: policy });
    container.append(iframe);
  }

  function destroy() {
    if (!active) return;
    frame.__apioskTeardown?.(); active = false;
    removeListener?.(); frame.remove();
    trace({ direction: 'host', method: 'card/destroy' });
  }
  const handle = {
    destroy,
    setTheme(value) { currentTheme = value === 'dark' ? 'dark' : 'light'; if (active) { frame.style.colorScheme = currentTheme; frame.__apioskTheme(currentTheme); } },
    remount() { destroy(); create(); return handle; },
  };
  create(); return handle;
}
