// MCP observability side-car — the MCP server historically logged NOTHING about
// its own activity (tool calls, SSE sessions, OAuth/installs). This module writes
// append-only rows to the mcp_tool_calls / mcp_sessions / mcp_oauth_events tables
// (gateway migration 057) so the admin portal can see MCP traffic.
//
// Design: fire-and-forget, NEVER throws into the hot path (every write is wrapped
// in try/catch and returns a swallowed promise). Uses the service-role key exactly
// like publisher.mjs (rest/v1/<table>). PRIVACY: raw connect tokens are sha256-hashed
// (never stored raw), and only argument KEY NAMES are stored — never values, headers,
// or bodies.

import { createHash } from "node:crypto";

const DEFAULT_SUPABASE_URL = "https://jgjoiyqdyypouskftzeq.supabase.co";

function resolveConfig(env = {}) {
  const raw =
    env.APIOSK_SUPABASE_URL || env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
  const url = String(raw).replace(/\/+$/, "");
  const key =
    env.APIOSK_SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "";
  return { url, key };
}

function sha256(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return createHash("sha256").update(value).digest("hex");
  } catch {
    return null;
  }
}

function trimStr(v, max = 400) {
  if (v == null) return null;
  const s = String(v);
  return s.length > max ? s.slice(0, max) : s;
}

// Low-level fire-and-forget REST write. Resolves regardless of outcome; a failure
// is logged to stderr but never propagates — observability must not break a tool call.
async function restWrite(env, path, body, { method = "POST", extraHeaders = {} } = {}) {
  const { url, key } = resolveConfig(env);
  if (!key) return; // not configured on this deployment — skip silently
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") return;
  try {
    await fetchImpl(`${url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=minimal",
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    try {
      console.warn(
        "[observability] write failed:",
        error && error.message ? error.message : String(error),
      );
    } catch {
      /* ignore */
    }
  }
}

/** Extract caller identity from the MCP authInfo (never returns a raw token). */
export function callerFrom(authInfo) {
  const x = (authInfo && (authInfo.extra || authInfo)) || {};
  const rawToken = x.apiosk_connect_token || x.connectToken || null;
  const hasToken = Boolean(rawToken || x.apiosk_connect_token_id);
  return {
    auth_method: hasToken ? "connect_token" : x.userId ? "oauth" : "anonymous",
    user_id: x.userId || x.user_id || null,
    connect_token_id: x.apiosk_connect_token_id || x.connect_token_id || null,
    connect_token_hash: sha256(rawToken),
    wallet_address:
      x.walletAddress || x.apiosk_connect_wallet_address || x.wallet_address || null,
    provider_id: x.providerId || x.provider_id || null,
    client_name: (authInfo && (authInfo.clientName || authInfo.client_name)) || null,
    client_kind: (authInfo && (authInfo.clientKind || authInfo.client_kind)) || null,
  };
}

/** Log one tools/call dispatch. Fire-and-forget. */
export function logToolCall(
  env,
  {
    toolName,
    outcome = "ok",
    errorCode = null,
    latencyMs = null,
    authInfo = null,
    argKeys = [],
    sessionId = null,
    gatewayRequestId = null,
    ip = null,
    userAgent = null,
  } = {},
) {
  const caller = callerFrom(authInfo);
  return restWrite(env, "mcp_tool_calls", {
    tool_name: String(toolName || "unknown"),
    outcome,
    error_code: errorCode ? trimStr(errorCode, 120) : null,
    latency_ms: typeof latencyMs === "number" ? Math.round(latencyMs) : null,
    ...caller,
    session_id: sessionId,
    gateway_request_id: gatewayRequestId,
    arg_keys: Array.isArray(argKeys) ? argKeys.slice(0, 64).map(String) : [],
    ip_address: ip,
    user_agent: trimStr(userAgent),
  });
}

/** Record an SSE session on connect (upsert on session_id). Fire-and-forget. */
export function openSession(
  env,
  { sessionId, transport = "sse", ip = null, userAgent = null, clientName = null, clientKind = null, protocolVersion = null } = {},
) {
  if (!sessionId) return;
  return restWrite(
    env,
    "mcp_sessions",
    {
      session_id: String(sessionId),
      transport,
      ip_address: ip,
      user_agent: trimStr(userAgent),
      client_name: clientName,
      client_kind: clientKind,
      protocol_version: protocolVersion,
      status: "online",
    },
    // Upsert: a reconnect with the same id refreshes it instead of 409-ing.
    { extraHeaders: { prefer: "resolution=merge-duplicates,return=minimal" } },
  );
}

/** Mark an SSE session closed on disconnect. Fire-and-forget. */
export function closeSession(env, sessionId) {
  if (!sessionId) return;
  const now = new Date().toISOString();
  return restWrite(
    env,
    `mcp_sessions?session_id=eq.${encodeURIComponent(String(sessionId))}`,
    { status: "closed", disconnected_at: now, last_activity_at: now },
    { method: "PATCH" },
  );
}

/** Log an OAuth / install event (authorize, consent, token_issued, wallet_created…). */
export function logOAuthEvent(
  env,
  {
    eventType,
    userId = null,
    clientId = null,
    clientName = null,
    redirectUri = null,
    scopes = [],
    connectTokenId = null,
    connectTokenHash = null,
    connectTokenRaw = null,
    walletAddress = null,
    walletCreated = false,
    outcome = "ok",
    errorCode = null,
    ip = null,
    userAgent = null,
  } = {},
) {
  if (!eventType) return;
  return restWrite(env, "mcp_oauth_events", {
    event_type: eventType,
    user_id: userId,
    client_id: clientId ? trimStr(clientId, 200) : null,
    client_name: clientName,
    redirect_uri: redirectUri ? trimStr(redirectUri, 500) : null,
    scopes: Array.isArray(scopes) ? scopes.map(String) : [],
    connect_token_id: connectTokenId,
    connect_token_hash: connectTokenHash || sha256(connectTokenRaw),
    wallet_address: walletAddress,
    wallet_created: Boolean(walletCreated),
    outcome,
    error_code: errorCode ? trimStr(errorCode, 120) : null,
    ip_address: ip,
    user_agent: trimStr(userAgent),
  });
}
