// Apiosk external x402 payment (apiosk_fetch_paid).
//
// The last step of the agentic flow for endpoints the Apiosk gateway does NOT
// host: pay an arbitrary external x402 URL from the connected buyer's managed
// wallet. The MCP holds no signing keys, so this delegates to the gateway's
// gateway-as-payer proxy (POST /v1/x402/fetch): the gateway enforces the connect
// token's spend caps, pays the provider from a platform payer wallet, debits the
// buyer's managed wallet, and returns the provider response.
//
// For Apiosk CATALOG listings use apiosk_execute instead — that path is cheaper
// and fully settled. This tool is only for external (federated / discovered)
// endpoints. `confirmed_price_usdc` is required and is the in-chat price
// checkpoint: the gateway refuses if the live price exceeds what the user
// confirmed via apiosk_inspect_x402.

import { randomUUID } from "node:crypto";

const DEFAULT_GATEWAY_BASE_URL = "https://gateway.apiosk.com";

function content(value) {
  const result = {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
  if (value && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value;
  }
  return result;
}

function trimString(value) {
  return String(value ?? "").trim();
}

/**
 * Execute a paid fetch of an external x402 endpoint via the gateway payer proxy.
 *
 * @param {object} args - { url, method?, query?, body?, headers?, confirmed_price_usdc, max_price_usdc?, idempotency_key? }
 * @param {object} ctx  - { connectToken, gatewayBaseUrl, fetchImpl? }
 */
export async function runFetchPaid(args = {}, ctx = {}) {
  const url = trimString(args.url);
  if (!url) {
    return content({ status: "error", error: "Missing required field: url" });
  }
  const confirmedPrice = args.confirmed_price_usdc;
  if (!Number.isFinite(confirmedPrice) || confirmedPrice < 0) {
    return content({
      status: "error",
      error:
        "Missing required field: confirmed_price_usdc. Call apiosk_inspect_x402 on the URL first, tell the user the price, then pass the confirmed amount here.",
    });
  }

  const connectToken = trimString(ctx.connectToken);
  if (!connectToken) {
    return content({
      status: "error",
      error:
        "No connected wallet. apiosk_fetch_paid needs an Apiosk connect token (authorize the Apiosk app / OAuth on the hosted server). For Apiosk catalog listings, use apiosk_execute instead.",
    });
  }

  const gatewayBaseUrl = trimString(ctx.gatewayBaseUrl) || DEFAULT_GATEWAY_BASE_URL;
  const fetchImpl = ctx.fetchImpl || fetch;
  const idempotencyKey = trimString(args.idempotency_key) || randomUUID();
  const method = trimString(args.method).toUpperCase() || "GET";

  const requestBody = {
    url,
    method,
    query: args.query && typeof args.query === "object" ? args.query : undefined,
    body: args.body !== undefined ? args.body : undefined,
    headers: args.headers && typeof args.headers === "object" ? args.headers : undefined,
    confirmed_price_usdc: confirmedPrice,
    max_price_usdc: Number.isFinite(args.max_price_usdc) ? args.max_price_usdc : undefined,
  };

  let response;
  try {
    response = await fetchImpl(`${gatewayBaseUrl.replace(/\/+$/, "")}/v1/x402/fetch`, {
      method: "POST",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "X-Apiosk-Connect-Token": connectToken,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (error) {
    return content({
      status: "error",
      error: `Could not reach the Apiosk gateway payer: ${trimString(error?.message || error)}`,
      idempotency_key: idempotencyKey,
    });
  }

  const text = await response.text().catch(() => "");
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text || null;
  }

  // The gateway emits refusal codes under `error` (json_error_response) or
  // `code`; normalize so callers below can read either.
  const gatewayCode = payload?.code || payload?.error || null;

  // Feature not enabled yet: degrade gracefully so the model falls back to a
  // catalog listing instead of surfacing a raw 403.
  if (response.status === 403 && gatewayCode === "feature_disabled") {
    return content({
      status: "unavailable",
      code: "feature_disabled",
      message:
        "External direct-pay (apiosk_fetch_paid) is not enabled on this gateway yet. Use an Apiosk catalog listing via apiosk_execute instead.",
      idempotency_key: idempotencyKey,
    });
  }

  // Any non-2xx with a structured code is a business outcome (price too high,
  // host not allowed, wallet over cap) — return it as data, not an MCP error, so
  // the model can adapt (lower the amount, pick another endpoint, tell the user).
  if (!response.ok) {
    return content({
      status: payload?.status || (response.status === 402 ? "payment_required" : "refused"),
      code: gatewayCode || `http_${response.status}`,
      message: payload?.message || payload?.error || `Gateway returned HTTP ${response.status}.`,
      http_status: response.status,
      idempotency_key: idempotencyKey,
    });
  }

  // Success: surface the provider data + a receipt the model can quote back.
  return content({
    status: "success",
    data: payload?.data ?? payload,
    receipt: payload?.receipt || null,
    idempotency_key: idempotencyKey,
  });
}

export const FETCH_PAID_TOOL = {
  name: "apiosk_fetch_paid",
  description:
    "Pay an EXTERNAL x402 endpoint (one Apiosk does not host) from the connected wallet and return its data. Use this only for external results from apiosk_discover (executable_via='apiosk_fetch_paid'); for Apiosk catalog listings use apiosk_execute. REQUIRED: call apiosk_inspect_x402 on the url first, tell the user the exact price, and pass that amount as confirmed_price_usdc — the gateway refuses if the live price is higher. The gateway enforces the wallet's per-tx/daily spend limits. Base + USDC only.",
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  _meta: {
    "openai/outputTemplate": "ui://apiosk/result-canvas.html",
    "openai/toolInvocation/invoking": "Paying the provider and fetching data…",
    "openai/toolInvocation/invoked": "Paid data received",
    ui: { resourceUri: "ui://apiosk/result-canvas.html" },
  },
  inputSchema: {
    type: "object",
    required: ["url", "confirmed_price_usdc"],
    properties: {
      url: {
        type: "string",
        description: "The external x402 resource URL to pay and fetch (from a discovery result's `url`).",
      },
      confirmed_price_usdc: {
        type: "number",
        description: "The price you read via apiosk_inspect_x402 and confirmed with the user. The gateway refuses if the live price exceeds this.",
      },
      method: {
        type: "string",
        enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
        description: "HTTP method for the provider request. Defaults to GET.",
      },
      query: {
        type: "object",
        additionalProperties: true,
        description: "Optional query parameters to send to the provider.",
      },
      body: {
        type: "object",
        additionalProperties: true,
        description: "Optional JSON request body for POST/PUT/PATCH.",
      },
      headers: {
        type: "object",
        additionalProperties: true,
        description: "Optional extra request headers (allowlisted server-side; secrets are never accepted here).",
      },
      max_price_usdc: {
        type: "number",
        description: "Optional additional per-call ceiling. The gateway also enforces the wallet's per-tx and daily limits.",
      },
      idempotency_key: {
        type: "string",
        description: "Optional. Reuse the same key to safely retry without paying twice; a fresh one is generated if omitted.",
      },
    },
  },
};
