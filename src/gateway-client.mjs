// Where the agent gateway is, and which token speaks for the buyer.
//
// Two small answers the rest of the server shares. The Gateway v2 runtime
// (src/gateway-v2.mjs) sends the token as a Bearer credential; the hosted
// OAuth flow (src/oauth.mjs) and the served route index
// (src/well-known-routes.mjs) read the agent gateway's base URL.

/**
 * The agent gateway: OAuth (/v1/oauth/*), connect and the skill. Data requests
 * go to Gateway v2 (src/runtime.mjs), never here.
 */
export const DEFAULT_GATEWAY_BASE_URL =
  "https://api.apiosk.com/functions/v1/agent-gateway";

function trimString(value) {
  return String(value ?? "").trim();
}

export function resolveGatewayBaseUrl(env = process.env) {
  const configured =
    trimString(env.APIOSK_GATEWAY_URL) ||
    trimString(env.APIOSK_GATEWAY_BASE_URL) ||
    trimString(env.APIOSK_BASE_URL);
  return (configured || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
}

/**
 * The token that names the buyer to the gateway.
 *
 * A request-scoped token (minted for this OAuth session, stashed on
 * `authInfo.extra` by src/oauth.mjs) always beats the per-process env token:
 * one server serves many buyers, and the caller's own connection is the only
 * one allowed to spend. For stdio, `APIOSK_CONNECT_TOKEN` holds an Apiosk agent
 * token (`apk_access_…` or `apk_live_…`).
 */
export function resolveConnectToken(authInfo = null, env = process.env) {
  return (
    trimString(authInfo?.extra?.apiosk_connect_token) ||
    trimString(env.APIOSK_CONNECT_TOKEN) ||
    ""
  );
}
