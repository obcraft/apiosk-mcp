// The runtime: Gateway v2, for every transport.
//
// Since 2.0 there is one runtime. The hosted server and the stdio package both
// speak the Gateway v2 agent contract (src/gateway-v2.mjs): browse sources,
// plan and price one task, approve it once, follow it to its result. The 1.x
// tools that called the agent gateway's /v1/ask, /v1/select, /v1/run,
// /v1/plans and /v1/jobs are gone; the agent gateway answers those routes with
// 410 and names their v2 replacements.
//
// What is left here is the one decision that belongs to the runtime rather than
// to the tools: which gateway. `APIOSK_GATEWAY_V2_URL` overrides it (a local or
// staging gateway); unset, it is the production gateway.

import { createV2Runtime } from "./gateway-v2.mjs";

export const DEFAULT_GATEWAY_V2_URL = "https://gateway.apiosk.com";

/** The Gateway v2 origin this process talks to. */
export function resolveGatewayV2Url(env = process.env) {
  return String(env?.APIOSK_GATEWAY_V2_URL || "").trim() || DEFAULT_GATEWAY_V2_URL;
}

/**
 * Build the MCP runtime.
 *
 * @param {object} options
 * @param {object} [options.env]              environment, for the gateway URL and a stdio token
 * @param {boolean} [options.hostedAuthEnabled] hosted: never fall back to a machine-wide token
 * @param {Function} [options.fetchImpl]      fetch, for tests
 */
export function createApioskMcpRuntime(options = {}) {
  const env = options.env || process.env;
  // A copy, never a mutation: the caller's env (often process.env) is not ours.
  return createV2Runtime({ ...options, env: { ...env, APIOSK_GATEWAY_V2_URL: resolveGatewayV2Url(env) } });
}
