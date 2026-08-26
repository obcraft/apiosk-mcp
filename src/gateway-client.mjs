// The only code in this repository that talks to the gateway.
//
// Before this file, three modules each resolved the gateway base URL, each
// decided how to attach a connect token, and each decoded errors their own way
// (runtime.mjs via the SDK, discovery.mjs and flow.mjs via bare fetch). Three
// implementations of one boundary is three places to look when a call fails
// and three answers to "which base URL did that actually hit".
//
// Everything the MCP asks the gateway now goes through here: the base URL, the
// X-Apiosk-Connect-Token header, the timeout, and the error decoding. The tools
// in src/tools/ carry no knowledge of the transport.

import { ApioskClient, ApioskPaymentRequiredError } from "@apiosk/sdk";

export const DEFAULT_GATEWAY_BASE_URL = "https://gateway.apiosk.com";
export const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BODY_BYTES = 512 * 1024;

function trimString(value) {
  return String(value ?? "").trim();
}

/** A gateway failure the agent can act on: a code it can branch on, a message it can read. */
export class GatewayError extends Error {
  constructor(message, { code = "gateway.error", status = null, url = null, body = null } = {}) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.status = status;
    this.url = url;
    this.body = body;
  }

  toJSON() {
    return { error_code: this.code, message: this.message, status: this.status, url: this.url };
  }
}

export function resolveGatewayBaseUrl(env = process.env) {
  const configured =
    trimString(env.APIOSK_GATEWAY_URL) ||
    trimString(env.APIOSK_GATEWAY_BASE_URL) ||
    trimString(env.APIOSK_BASE_URL);
  return (configured || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
}

/**
 * The connect token names the buyer's wallet and policy to the gateway.
 *
 * A request-scoped token (minted for this OAuth session, stashed on
 * `authInfo.extra` by src/oauth.mjs) always beats the per-process env token:
 * one server serves many buyers, and the caller's own connection is the only
 * one allowed to spend.
 */
export function resolveConnectToken(authInfo = null, env = process.env) {
  return (
    trimString(authInfo?.extra?.apiosk_connect_token) ||
    trimString(env.APIOSK_CONNECT_TOKEN) ||
    ""
  );
}

function decodeErrorBody(body) {
  if (!body || typeof body !== "object") return {};
  const code = trimString(body.error_code || body.code || body.error);
  const message = trimString(body.message || body.detail || body.error_description);
  return { code: code || "", message: message || "" };
}

export function createGatewayClient({
  env = process.env,
  authInfo = null,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  clientFactory = null,
  client: fixedClient = null,
} = {}) {
  const baseUrl = resolveGatewayBaseUrl(env);
  const connectToken = resolveConnectToken(authInfo, env);

  function headers(extra = {}) {
    const merged = new Headers({ accept: "application/json", ...extra });
    if (connectToken) {
      merged.set("x-apiosk-connect-token", connectToken);
      merged.set("authorization", `Bearer ${connectToken}`);
    }
    return merged;
  }

  /** GET/POST JSON against the gateway. Throws GatewayError; never returns a half-decoded body. */
  async function requestJson(
    path,
    { method = "GET", query = null, body = null, timeout = timeoutMs, extraHeaders = null } = {}
  ) {
    const url = new URL(path, `${baseUrl}/`);
    if (query) {
      const params = query instanceof URLSearchParams ? query : new URLSearchParams(query);
      for (const [key, value] of params.entries()) url.searchParams.append(key, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let response;
    try {
      response = await fetchImpl(url.href, {
        method,
        headers: headers({
          ...(body ? { "content-type": "application/json" } : {}),
          // Callers that need a per-request header — an Idempotency-Key, say,
          // which is the difference between a retried payment and a double one.
          ...(extraHeaders || {}),
        }),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      const reason =
        error?.name === "AbortError" ? `timed out after ${timeout}ms` : trimString(error?.message) || String(error);
      throw new GatewayError(`Could not reach the Apiosk gateway at ${baseUrl}: ${reason}.`, {
        code: "gateway.unreachable",
        url: url.href,
      });
    } finally {
      clearTimeout(timer);
    }

    const raw = await response.text();
    if (raw.length > MAX_BODY_BYTES) {
      throw new GatewayError(`Gateway response from ${url.href} exceeded ${MAX_BODY_BYTES} bytes.`, {
        code: "gateway.response_too_large",
        status: response.status,
        url: url.href,
      });
    }

    let parsed = null;
    if (raw.trim()) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (response.ok) {
          throw new GatewayError(`Gateway returned a non-JSON body (HTTP ${response.status}) for ${url.href}.`, {
            code: "gateway.malformed_response",
            status: response.status,
            url: url.href,
          });
        }
      }
    }

    if (!response.ok) {
      const decoded = decodeErrorBody(parsed);
      throw new GatewayError(
        decoded.message || `Gateway returned HTTP ${response.status} for ${url.href}.`,
        {
          code: decoded.code || `gateway.http_${response.status}`,
          status: response.status,
          url: url.href,
          body: parsed,
        }
      );
    }

    return parsed;
  }

  // The SDK owns the x402 settlement handshake (402 -> pay -> retry), so paid
  // execution goes through it rather than through requestJson. It is built
  // lazily: a session that only discovers and compares never needs one.
  let sdkClient = null;
  async function getSdkClient() {
    if (fixedClient) return fixedClient;
    if (sdkClient) return sdkClient;
    const options = {
      baseUrl,
      connectToken: connectToken || undefined,
      authorization: connectToken ? `Bearer ${connectToken}` : undefined,
    };
    sdkClient = clientFactory ? await clientFactory(options) : new ApioskClient(options);
    return sdkClient;
  }

  return {
    baseUrl,
    connectToken,
    hasConnectToken: Boolean(connectToken),
    requestJson,
    async listApis(params = {}) {
      const client = await getSdkClient();
      return client.listApis(params);
    },
    async execute(slug, input, options = {}) {
      const client = await getSdkClient();
      return client.execute(slug, input, { headers: { accept: "application/json" }, ...options });
    },
  };
}

export { ApioskPaymentRequiredError };
