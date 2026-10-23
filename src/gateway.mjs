/** Transport for the existing Gateway contract; it never retries a request. */
const DEFAULT_URL = 'http://127.0.0.1:8082';
const DEFAULT_TIMEOUT_MS = 80_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_HEADERS = new Set(['accept', 'idempotency-key']);

export class GatewayError extends Error {
  constructor(message, { code = 'gateway_error', status = 0, retryable = false, outcomeUnknown = false } = {}) {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
  }

  toJSON() {
    return { name: this.name, message: this.message, code: this.code, status: this.status,
      retryable: this.retryable, outcomeUnknown: this.outcomeUnknown };
  }
}

function fail(message, code = 'invalid_gateway_configuration') {
  throw new GatewayError(message, { code });
}

function positiveInteger(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail(`Invalid ${name}.`);
  return value;
}

function gatewayURL(value) {
  let url;
  try { url = new URL(value); } catch { fail('Invalid Gateway URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    fail('Gateway URL must be an HTTPS origin or an HTTP loopback origin without credentials.');
  }
  return url;
}

function safeText(value, token) {
  if (typeof value !== 'string') return '';
  let text = value;
  if (token) text = text.split(token).join('[redacted]');
  return text.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/apk_(?:org_live|access|live)_[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 800);
}

function abortFailure(signal, mutation) {
  const timedOut = signal.reason?.name === 'TimeoutError';
  return new GatewayError(timedOut
    ? 'The Gateway timed out. Read the saved task before retrying a purchase.'
    : 'The Gateway request was cancelled. Read the saved task before retrying a purchase.', {
    code: timedOut ? 'gateway_timeout' : 'gateway_aborted', retryable: !mutation, outcomeUnknown: mutation,
  });
}

function withSignal(operation, signal, mutation) {
  if (signal.aborted) return Promise.reject(abortFailure(signal, mutation));
  return new Promise((resolve, reject) => {
    const aborted = () => reject(abortFailure(signal, mutation));
    signal.addEventListener('abort', aborted, { once: true });
    Promise.resolve(operation).then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

/**
 * Credentials are constructor-scoped so HTTP callers cannot inherit another
 * caller's token. Pass token:null explicitly to disable environment fallback.
 * App and connected credentials retain the Gateway's own route restrictions.
 */
export class GatewayClient {
  #base;
  #token;
  #workspace;
  #fetch;
  #timeout;
  #maxBytes;

  constructor({ baseUrl = process.env.APIOSK_GATEWAY_URL || DEFAULT_URL,
    token = process.env.APIOSK_TOKEN || process.env.APIOSK_CONNECT_TOKEN || null,
    workspace, workspaceId = workspace !== undefined ? workspace : process.env.APIOSK_WORKSPACE_ID || null,
    fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS,
    maxResponseBytes = DEFAULT_MAX_BYTES } = {}) {
    this.#base = gatewayURL(baseUrl);
    if (token != null && (typeof token !== 'string' || !token || token.length > 8192 || /\s/.test(token))) fail('Invalid Gateway credential.');
    if (workspaceId != null && (typeof workspaceId !== 'string' || !UUID.test(workspaceId))) fail('Workspace must be a UUID.');
    if (token?.startsWith('apk_org_live_') && workspaceId) fail('Organisation API keys cannot select a workspace.');
    if (typeof fetchImpl !== 'function') fail('A fetch implementation is required.');
    this.#token = token;
    this.#workspace = workspaceId;
    this.#fetch = fetchImpl;
    this.#timeout = positiveInteger(timeoutMs, 'Gateway timeout', 300_000);
    this.#maxBytes = positiveInteger(maxResponseBytes, 'Gateway response limit', 64 * 1024 * 1024);
  }

  get baseUrl() { return this.#base.origin; }
  get credentialKind() {
    if (!this.#token) return 'none';
    if (/^apk_(org_live|access|live)_/.test(this.#token)) return 'connection';
    return 'session';
  }

  /** GET/POST only. onProgress receives NDJSON snapshots or parsed SSE data. */
  async request(path, { method, body, signal, headers: extraHeaders, onProgress,
    responseType = 'json' } = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(path) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(path)) {
      fail('Use a relative Gateway path.', 'invalid_gateway_path');
    }
    let url;
    try { url = new URL(path, this.#base); } catch { fail('Invalid Gateway path.', 'invalid_gateway_path'); }
    if (url.origin !== this.#base.origin || url.hash) fail('Invalid Gateway path.', 'invalid_gateway_path');
    if (!this.#token && url.pathname !== '/health') fail('Configure APIOSK_TOKEN or APIOSK_CONNECT_TOKEN.', 'authentication_required');
    method = method ?? (body === undefined ? 'GET' : 'POST');
    if (!['GET', 'POST'].includes(method) || (method === 'GET' && body !== undefined)) fail('Use GET without a body, or POST.', 'invalid_gateway_method');
    if (!['json', 'bytes', 'sse'].includes(responseType)) fail('Invalid Gateway response type.', 'invalid_gateway_response_type');
    if (onProgress !== undefined && typeof onProgress !== 'function') fail('onProgress must be a function.');
    const mutation = method !== 'GET';
    const headers = new Headers({ accept: responseType === 'sse' ? 'text/event-stream' : onProgress ? 'application/x-ndjson' : 'application/json' });
    if (this.#token) headers.set('authorization', `Bearer ${this.#token}`);
    if (this.#workspace) headers.set('x-apiosk-workspace', this.#workspace);
    if (extraHeaders) {
      let supplied;
      try { supplied = new Headers(extraHeaders); } catch { fail('Invalid Gateway headers.', 'invalid_gateway_headers'); }
      for (const [key, value] of supplied) {
        if (!ALLOWED_HEADERS.has(key)) fail('Only Accept and Idempotency-Key may be supplied.', 'invalid_gateway_headers');
        headers.set(key, value);
      }
    }
    let encoded;
    if (body !== undefined) {
      try { encoded = JSON.stringify(body); } catch { fail('Request body must be JSON serializable.', 'invalid_gateway_body'); }
      if (encoded === undefined) fail('Request body must be JSON serializable.', 'invalid_gateway_body');
      if (Buffer.byteLength(encoded) > 1024 * 1024) fail('Gateway request body exceeds 1 MiB.', 'gateway_request_too_large');
      headers.set('content-type', 'application/json');
    }
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new DOMException('Timed out', 'TimeoutError')), this.#timeout);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    try {
      if (combined.aborted) throw abortFailure(combined, false);
      const response = await withSignal(this.#fetch(url, { method, body: encoded, headers,
        redirect: 'error', signal: combined }), combined, mutation);
      const contentType = response.headers.get('content-type') || '';
      const streaming = response.ok && (contentType.includes('application/x-ndjson') || contentType.includes('text/event-stream'));
      const parsed = await this.#read(response, { signal: combined, mutation, streaming,
        sse: contentType.includes('text/event-stream'), onProgress, bytes: response.ok && responseType === 'bytes' });
      if (!response.ok) {
        const error = parsed?.errors?.[0] ?? parsed?.error ?? parsed;
        const code = typeof error?.code === 'string' && /^[a-z0-9_:-]{1,100}$/i.test(error.code)
          ? safeText(error.code, this.#token) : 'gateway_rejected';
        throw new GatewayError(safeText(error?.message, this.#token) || `Gateway rejected the request (${response.status}).`, {
          code, status: response.status, retryable: !mutation && (response.status === 429 || response.status >= 500),
          outcomeUnknown: mutation && response.status >= 500,
        });
      }
      if (responseType === 'bytes') return parsed;
      if (response.status === 204) return null;
      if (parsed === null || typeof parsed !== 'object') throw new GatewayError('The Gateway returned an unreadable response. Read the saved task before retrying.', {
        code: 'gateway_invalid_response', outcomeUnknown: mutation,
      });
      return parsed;
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      if (combined.aborted) throw abortFailure(combined, mutation);
      throw new GatewayError('The Gateway connection was interrupted. Read the saved task before retrying a purchase.', {
        code: 'gateway_connection_error', retryable: !mutation, outcomeUnknown: mutation,
      });
    } finally { clearTimeout(timer); }
  }

  async #read(response, { signal, mutation, streaming, sse, onProgress, bytes }) {
    const declaredLength = Number(response.headers.get('content-length'));
    const tooLarge = () => new GatewayError('The Gateway response exceeded the configured size limit.', {
      code: 'gateway_response_too_large', outcomeUnknown: mutation,
    });
    if (declaredLength > this.#maxBytes) {
      void response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    if (!response.body) return bytes ? new Uint8Array() : null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks = [];
    let total = 0, text = '', latest, eventData = [];
    const publish = (line) => {
      if (!line.trim() || line.trim() === '[DONE]') return;
      try { latest = JSON.parse(line); } catch {
        throw new GatewayError('The Gateway returned invalid progress data.', { code: 'gateway_invalid_response', outcomeUnknown: mutation });
      }
      if (latest === null || typeof latest !== 'object') throw new GatewayError('The Gateway returned invalid progress data.', { code: 'gateway_invalid_response', outcomeUnknown: mutation });
      onProgress?.(latest);
    };
    const line = (value) => {
      value = value.replace(/\r$/, '');
      if (!sse) return publish(value);
      if (value === '') { publish(eventData.join('\n')); eventData = []; }
      else if (value.startsWith('data:')) eventData.push(value.slice(5).replace(/^ /, ''));
    };
    try {
      while (true) {
        const next = await withSignal(reader.read(), signal, mutation);
        if (next.done) break;
        total += next.value.byteLength;
        if (total > this.#maxBytes) throw tooLarge();
        if (bytes) { chunks.push(next.value); continue; }
        text += decoder.decode(next.value, { stream: true });
        if (streaming) {
          let index;
          while ((index = text.indexOf('\n')) !== -1) { line(text.slice(0, index)); text = text.slice(index + 1); }
        }
      }
      if (bytes) {
        const output = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
        return output;
      }
      text += decoder.decode();
      if (streaming) { if (text) line(text); if (sse && eventData.length) publish(eventData.join('\n')); return latest; }
      try { return JSON.parse(text); } catch { return null; }
    } finally {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
