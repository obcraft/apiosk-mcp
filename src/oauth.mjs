import crypto from "node:crypto";

import express from "express";

import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLIENT_ID_TTL_SECONDS = 20 * 365 * 24 * 60 * 60;
const DEFAULT_SCOPE = "mcp:tools";
const OFFLINE_ACCESS_SCOPE = "offline_access";
const SUPPORTED_SCOPES = [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE];
// Every transport surface an MCP client may connect to and treat as the
// OAuth "resource". Streamable HTTP clients target /mcp; the legacy HTTP+SSE
// transport (ChatGPT's connector) opens /sse and posts to /messages. We
// publish protected-resource metadata for each, plus the origin root, so a
// client's discovery probe succeeds no matter which surface it connected to.
const TRANSPORT_RESOURCE_PATHS = ["/mcp", "/sse", "/messages"];
const UUID_LIKE_CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The client_id this server authorizes as. One client for Claude, ChatGPT and
// Cursor alike — they arrive with an optional app_name shown beside it, which
// the agent gateway passes to the approval screen as `name`.
//
// It matches `^[a-z][a-z0-9-]{0,63}$`, which is what `startAuthorization` in
// the agent gateway's oauth.ts requires of a client_id.
const PORTAL_CLIENT_ID = "apiosk-mcp";
/**
 * The agent gateway. ONE approval screen, and this is how this server reaches
 * it.
 *
 * It used to send the browser to `https://buy.apiosk.com/connect` and redeem
 * the resulting code at `https://gateway.apiosk.com/v1/connect/oauth/token`.
 * That was a second approval screen, in a second frontend, backed by a second
 * token system — beside the one the pasted-invitation flow already used, which
 * approves at `app.apiosk.com/connect`.
 *
 * Now this server starts an ordinary authorization request at the agent
 * gateway, which validates it and redirects to that same screen. The person
 * approving a connection from Claude sees the page they see approving one from
 * a pasted prompt, and sets the limits in the same place.
 */
const DEFAULT_GATEWAY_URL = "https://api.apiosk.com/functions/v1/agent-gateway";
// Same window as the authorization code it feeds into — the round trip to the
// portal and back happens in one browser session, not across a coffee break.
const PORTAL_HANDOFF_TTL_SECONDS = AUTHORIZATION_CODE_TTL_SECONDS;
/**
 * How close to expiry an upstream access token is renewed rather than passed
 * on. Comfortably longer than this server's own access token life, so a token
 * minted here never carries an upstream credential that dies before it does.
 */
const UPSTREAM_RENEWAL_MARGIN_SECONDS = 2 * ACCESS_TOKEN_TTL_SECONDS;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value, fallback) {
  const input = trimString(value) || fallback;
  return input.replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toBase64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function fromBase64Url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getIssuedAtSeconds() {
  return Math.floor(Date.now() / 1000);
}

function buildTokenPayload(secret, payload) {
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `apiosk.${encodedPayload}.${signature}`;
}

function parseSignedToken(secret, token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== "apiosk") {
    throw new Error("Invalid token format");
  }

  const encodedPayload = parts[1];
  const providedSignature = parts[2];
  const expectedSignature = crypto.createHmac("sha256", secret).update(encodedPayload).digest("base64url");

  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    throw new Error("Invalid token signature");
  }

  const payload = JSON.parse(fromBase64Url(encodedPayload));
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid token payload");
  }

  if (typeof payload.exp !== "number" || payload.exp < getIssuedAtSeconds()) {
    throw new Error("Token has expired");
  }

  return payload;
}

function resolveEffectiveExpiry(requestedExpiry, upperBound = null) {
  if (!Number.isFinite(requestedExpiry)) {
    return upperBound ?? null;
  }

  if (Number.isFinite(upperBound)) {
    return Math.min(requestedExpiry, upperBound);
  }

  return requestedExpiry;
}

function buildIssuedToken(secret, type, payload, ttlSeconds, maxExpiry = null) {
  const issuedAt = getIssuedAtSeconds();
  const exp = resolveEffectiveExpiry(issuedAt + ttlSeconds, maxExpiry);
  if (!Number.isFinite(exp) || exp <= issuedAt) {
    throw new Error("Session has expired. Re-authorize the Apiosk app and retry.");
  }

  return {
    expiresAt: exp,
    token: buildTokenPayload(secret, {
      ...payload,
      typ: type,
      iat: issuedAt,
      exp,
    }),
  };
}

function buildRedirectUri(baseRedirectUri, params) {
  const redirectUrl = new URL(baseRedirectUri);

  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    redirectUrl.searchParams.set(key, String(value));
  }

  return redirectUrl.toString();
}

function responseMessage(body, fallback) {
  if (body && typeof body === "object") {
    return trimString(body.message) || trimString(body.error) || fallback;
  }
  return trimString(body) || fallback;
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function deriveClientSecret(secret, clientId) {
  return crypto.createHmac("sha256", secret).update(`client-secret:${clientId}`).digest("hex");
}

function shouldReplaceClientId(clientId) {
  const value = trimString(clientId);
  return !value || UUID_LIKE_CLIENT_ID_PATTERN.test(value);
}

function sanitizeClientMetadata(client = {}) {
  const entries = Object.entries(client).filter(([key, value]) => {
    if (value === undefined) return false;
    return ![
      "client_id",
      "client_secret",
      "client_id_issued_at",
      "client_secret_expires_at",
    ].includes(key);
  });
  return Object.fromEntries(entries);
}

function restoreSignedClient(secret, clientId) {
  try {
    const payload = parseSignedToken(secret, clientId);
    if (payload.typ !== "client" || !payload.client || typeof payload.client !== "object") {
      return undefined;
    }

    const restoredClient = {
      ...payload.client,
      client_id: clientId,
      client_id_issued_at: payload.iat,
    };

    if (
      trimString(restoredClient.token_endpoint_auth_method).toLowerCase() !== "none"
    ) {
      restoredClient.client_secret = deriveClientSecret(secret, clientId);
      if (Number.isFinite(payload.client_secret_expires_at)) {
        restoredClient.client_secret_expires_at = payload.client_secret_expires_at;
      }
    }

    return restoredClient;
  } catch {
    return undefined;
  }
}

// The interstitial shown after the round trip to buy.apiosk.com finishes,
// right before bouncing back to the MCP client. The client only completes the
// connection once its own callback runs, so this still carries the
// authorization code (auto-continue + manual link) rather than replacing it.
function createConnectionCompletePage({ appName, clientName, redirectTarget }) {
  const clientLabel = clientName.client_name || "the app";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light dark" />
  <meta http-equiv="refresh" content="2;url=${escapeHtml(redirectTarget)}" />
  <title>Connected · ${escapeHtml(appName)}</title>
  <style>
    @font-face{font-family:Inter;src:url("/brand/inter-latin-500-normal.woff2") format("woff2");font-weight:500;font-display:swap}@font-face{font-family:Inter;src:url("/brand/inter-latin-600-normal.woff2") format("woff2");font-weight:600;font-display:swap}
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--background:#f8f8fb;--foreground:#1f2028;--card:#fff;--border:#e7e3ef;--muted:#676371;--primary:#6349db;--primary-fg:#fff;--glow:rgb(99 73 219/.07);--success:#057857;--shadow:0 22px 54px -30px rgba(48,28,100,.3);color:var(--foreground);background:var(--background);font-weight:500;letter-spacing:-.011em}
    @media (prefers-color-scheme:dark){:root{--background:#0d0f13;--foreground:#ecebf2;--card:#15171d;--border:#262a34;--muted:#a5a2b0;--primary:#c3a0ff;--primary-fg:#25153c;--glow:rgb(195 160 255/.12);--success:#6ee7b7;--shadow:0 24px 52px -26px rgba(0,0,0,.72)}}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(820px 440px at 88% -10%,var(--glow),transparent 62%),var(--background);-webkit-font-smoothing:antialiased}
    .page{min-height:100vh;display:grid;place-items:center;padding:28px 18px}
    main{width:min(430px,100%);background:color-mix(in srgb,var(--card) 97%,transparent);border:1px solid var(--border);border-radius:20px;padding:28px;box-shadow:var(--shadow);text-align:center}
    .brand{display:block;width:92px;height:30px;margin:0 auto 20px}.brand img{display:block;width:92px;height:30px;object-fit:contain}
    .check{width:38px;height:38px;margin:0 auto 15px;border-radius:50%;background:color-mix(in srgb,var(--success) 13%,transparent);display:grid;place-items:center}
    .check svg{width:19px;height:19px;stroke:var(--success)}
    h1{margin:0 0 8px;font-size:24px;font-weight:600;letter-spacing:-.03em}p{color:var(--muted);font-size:14px;line-height:1.55;margin:0 0 20px}
    .steps{display:flex;gap:6px;margin:0 0 20px}.step{height:4px;flex:1;border-radius:99px;background:var(--success)}
    a.continue{display:block;border-radius:11px;padding:12px 15px;font-weight:600;letter-spacing:-.016em;background:var(--primary);color:var(--primary-fg);text-decoration:none;box-shadow:0 10px 22px -16px var(--primary)}
    .note{font-size:12px;color:var(--muted);margin:14px 0 0}
  </style></head><body><div class="page"><main><picture class="brand"><source media="(prefers-color-scheme:dark)" srcset="/brand/wordmark-white-320.png"><img src="/brand/wordmark-black-320.png" alt="Apiosk" width="320" height="103"></picture>
    <div class="check"><svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg></div>
    <h1>You're connected</h1>
    <p>Your Apiosk account is connected. Finishing securely in ${escapeHtml(clientLabel)}.</p>
    <div class="steps" aria-label="Authorization complete"><span class="step"></span><span class="step"></span><span class="step"></span></div>
    <a class="continue" id="continue" href="${escapeHtml(redirectTarget)}">Continue to ${escapeHtml(clientLabel)}</a>
    <p class="note">Returning you to ${escapeHtml(clientLabel)} automatically…</p>
  </main></div><script>setTimeout(()=>{window.location.replace(${JSON.stringify(redirectTarget).replaceAll("<", "\\u003c")})},1200);</script></body></html>`;
}

async function fetchJsonWithBody(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text || null;
  }

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function resolveGatewayBaseUrl(env = process.env) {
  return normalizeBaseUrl(
    env?.APIOSK_GATEWAY_URL || env?.APIOSK_GATEWAY_BASE_URL,
    DEFAULT_GATEWAY_URL
  );
}

/**
 * Where the browser is sent to approve: the agent gateway's own authorize
 * endpoint, which validates the request and redirects on to
 * `app.apiosk.com/connect`.
 *
 * IT IS THE GATEWAY BASE AND NOTHING ELSE. `APIOSK_BUYER_PORTAL_URL` used to
 * name a frontend here and is deliberately no longer read: a deploy that still
 * sets it to `buy.apiosk.com` would otherwise be sent to
 * `buy.apiosk.com/v1/oauth/authorize`, which is not a page, and a wrong host
 * that answers 404 is worse than one that was never consulted. A deploy that
 * needs to move this moves `APIOSK_GATEWAY_URL`, which moves the token
 * endpoint with it - and those two must agree or the code will not redeem.
 */
function resolveAuthorizeBaseUrl(env = process.env) {
  return resolveGatewayBaseUrl(env);
}

/**
 * One request to the agent gateway's token endpoint, and the reading of its
 * answer.
 *
 * The endpoint takes a form or JSON (`readForm` in the gateway's oauth.ts
 * accepts both), and answers the same shape for both grants this server uses.
 * No wallet key, no on-chain transaction and no x402 payload is ever
 * constructed here — settlement belongs to the gateway.
 *
 * THE REFRESH TOKEN IS THE PART THAT IS NEW AND THE PART THAT MATTERS. The
 * agent gateway's access tokens live 24 hours; this server's own live one.
 * Kept only the access token, a connection would work for a day and then ask
 * the person to approve something they had already approved. The refresh token
 * rotates on every use, so what is held is at most a day old.
 */
async function requestUpstreamToken(env, grant, failureMessage) {
  const url = `${resolveGatewayBaseUrl(env)}/v1/oauth/token`;
  const response = await fetchJsonWithBody(url, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({ ...grant, client_id: PORTAL_CLIENT_ID }),
  });

  if (!response.ok) {
    throw statusError(
      responseMessage(response.body, failureMessage),
      response.status >= 400 ? response.status : 502
    );
  }

  const body = response.body && typeof response.body === "object" ? response.body : {};
  const connectToken = trimString(body.access_token);
  if (!connectToken) {
    throw statusError("The gateway did not return an access token.", 502);
  }

  return {
    connectToken,
    refreshToken: trimString(body.refresh_token) || null,
    expiresInSeconds: Number.isFinite(Number(body.expires_in)) ? Number(body.expires_in) : null,
  };
}

/**
 * Redeem the one-time code the approval screen produced, server side.
 *
 * Injectable so tests can bypass the network call.
 */
async function defaultExchangePortalCode(env, { code, codeVerifier, redirectUri }) {
  return await requestUpstreamToken(
    env,
    {
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
    "Could not exchange the approval code for an access token."
  );
}

/** Trade a rotating upstream refresh token for a fresh pair. */
async function defaultRefreshPortalToken(env, { refreshToken }) {
  return await requestUpstreamToken(
    env,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    "Could not refresh the Apiosk connection."
  );
}

class ApioskOAuthClientsStore {
  constructor(secret) {
    this.secret = secret;
    this.registeredClients = new Map();
    this.metadataClients = new Map();
  }

  async getClient(clientId) {
    if (this.registeredClients.has(clientId)) {
      return this.registeredClients.get(clientId);
    }

    if (this.metadataClients.has(clientId)) {
      return this.metadataClients.get(clientId);
    }

    const restoredClient = restoreSignedClient(this.secret, clientId);
    if (restoredClient) {
      this.registeredClients.set(clientId, restoredClient);
      return restoredClient;
    }

    if (!URL.canParse(clientId)) {
      return undefined;
    }

    try {
      const response = await fetch(clientId, {
        headers: {
          accept: "application/json",
        },
        cache: "no-store",
      });

      if (!response.ok) {
        return undefined;
      }

      const payload = await response.json();
      const parsed = OAuthClientMetadataSchema.safeParse(payload);
      if (!parsed.success) {
        return undefined;
      }

      const normalizedClient = {
        ...parsed.data,
        client_id: clientId,
        token_endpoint_auth_method: parsed.data.token_endpoint_auth_method || "none",
      };
      this.metadataClients.set(clientId, normalizedClient);
      return normalizedClient;
    } catch {
      return undefined;
    }
  }

  async registerClient(client) {
    const normalizedClient = {
      token_endpoint_auth_method: "none",
      ...client,
    };

    if (shouldReplaceClientId(normalizedClient.client_id)) {
      const signedClientId = buildIssuedToken(
        this.secret,
        "client",
        {
          client: sanitizeClientMetadata(normalizedClient),
          client_secret_expires_at:
            Number.isFinite(normalizedClient.client_secret_expires_at) ?
              normalizedClient.client_secret_expires_at :
              undefined,
        },
        CLIENT_ID_TTL_SECONDS
      ).token;

      normalizedClient.client_id = signedClientId;
      normalizedClient.client_id_issued_at = getIssuedAtSeconds();
      if (
        trimString(normalizedClient.token_endpoint_auth_method).toLowerCase() !== "none"
      ) {
        normalizedClient.client_secret = deriveClientSecret(this.secret, signedClientId);
      } else {
        delete normalizedClient.client_secret;
        delete normalizedClient.client_secret_expires_at;
      }
    }

    this.registeredClients.set(normalizedClient.client_id, normalizedClient);
    return normalizedClient;
  }
}

class ApioskHostedOAuthProvider {
  constructor({
    env,
    secret,
    issuerUrl,
    mcpServerUrl,
    appName,
    resourceName,
    exchangePortalCode,
    refreshPortalToken,
  }) {
    this.env = env;
    this.secret = secret;
    this.issuerUrl = issuerUrl;
    this.mcpServerUrl = mcpServerUrl;
    this.appName = appName;
    this.resourceName = resourceName;
    // Injectable so tests can bypass the network call to the gateway.
    this.exchangePortalCode = exchangePortalCode || defaultExchangePortalCode;
    this.refreshPortalToken = refreshPortalToken || defaultRefreshPortalToken;
    this.clientsStore = new ApioskOAuthClientsStore(secret);
    this.callbackUrl = new URL("/authorize/callback", this.issuerUrl).href;
    // Audiences we honour on an access token. A client that connected via
    // /sse (ChatGPT) requests resource=<origin>/sse; one via /mcp requests
    // <origin>/mcp. The origin root is accepted for clients that omit the
    // path. All map to the same underlying Apiosk MCP server.
    this.allowedResources = new Set(
      [
        ...TRANSPORT_RESOURCE_PATHS.map((path) => new URL(path, this.mcpServerUrl).href),
        new URL("/", this.mcpServerUrl).href,
        this.mcpServerUrl.href,
      ].map((href) => href.replace(/\/+$/, "") || href)
    );
  }

  isAllowedResource(resourceHref) {
    const normalized = String(resourceHref || "").replace(/\/+$/, "");
    return this.allowedResources.has(normalized) || this.allowedResources.has(resourceHref);
  }

  /**
   * Start the handoff to the agent gateway, which approves at
   * `app.apiosk.com/connect`.
   *
   * Identity, funding and spending limits all live there — this server never
   * renders a sign-in page and never sees a wallet key. It starts an OAuth 2.0
   * authorization code request with PKCE of its own and stashes the ORIGINAL
   * request (from Claude, ChatGPT, ...) in a signed `state` so
   * `completePortalCallback` can pick the flow back up when the browser comes
   * back.
   *
   * `name` rather than `app_name`: that is what `startAuthorization` reads and
   * carries to the approval screen as the suggested connection name, which the
   * person can edit there.
   */
  async authorize(client, params, res) {
    const verifier = crypto.randomBytes(48).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    // Display the runtime that owns the validated callback, rather than the
    // shared Apiosk transport client. Client-supplied names are not identity.
    const callback = new URL(params.redirectUri);
    const provider = callback.protocol === "https:" ? ({
      "claude.ai": "anthropic",
      "chatgpt.com": "openai",
      "chat.openai.com": "openai",
    })[callback.hostname] : undefined;

    const handoffState = buildIssuedToken(
      this.secret,
      "portal_handoff",
      {
        verifier,
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state || null,
        scopes: params.scopes?.length ? params.scopes : [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
        resource: params.resource ? params.resource.href : this.mcpServerUrl.href,
      },
      PORTAL_HANDOFF_TTL_SECONDS
    ).token;

    // Appended, not resolved as a root-relative path: the agent gateway lives
    // UNDER a path (`/functions/v1/agent-gateway`), and `new URL("/v1/...",
    // base)` would throw that path away and address the project root.
    const portalUrl = buildRedirectUri(
      `${resolveAuthorizeBaseUrl(this.env)}/v1/oauth/authorize`,
      {
        client_id: PORTAL_CLIENT_ID,
        redirect_uri: this.callbackUrl,
        response_type: "code",
        code_challenge: challenge,
        // Required, and refused rather than assumed: `startAuthorization`
        // answers `plain` with an error instead of downgrading.
        code_challenge_method: "S256",
        state: handoffState,
        name: trimString(client.client_name) || undefined,
        provider,
      }
    );

    res.redirect(302, portalUrl);
  }

  /**
   * GET /authorize/callback — buy.apiosk.com sends the browser back here once
   * the buyer signs in, funds a wallet, sets limits and consents. Exchanges
   * the one-time code for a connect token server side (RFC 6749 §4.1.3), so
   * the token never enters this browser's address bar or its history.
   */
  async completePortalCallback(req, res) {
    const query = req.query || {};
    const stateToken = trimString(query.state);

    let handoff;
    try {
      handoff = parseSignedToken(this.secret, stateToken);
      if (handoff.typ !== "portal_handoff") {
        throw new Error("Invalid state");
      }
    } catch {
      res
        .status(400)
        .type("text/plain")
        .send("This sign-in link is invalid or has expired. Start again from your MCP client.");
      return;
    }

    const client = await this.clientsStore.getClient(handoff.clientId);
    if (!client) {
      res.status(400).type("text/plain").send("Unknown client. Start again from your MCP client.");
      return;
    }

    const params = {
      redirectUri: handoff.redirectUri,
      codeChallenge: handoff.codeChallenge,
      state: handoff.state,
      scopes: handoff.scopes,
      resource: handoff.resource ? new URL(handoff.resource) : new URL(this.mcpServerUrl.href),
    };

    const errorCode = trimString(query.error);
    if (errorCode) {
      res.redirect(
        302,
        buildRedirectUri(params.redirectUri, {
          error: errorCode,
          error_description:
            trimString(query.error_description) || "The buyer did not complete the connection.",
          state: params.state,
        })
      );
      return;
    }

    const code = trimString(query.code);
    if (!code) {
      res.status(400).type("text/plain").send("The portal did not return a code.");
      return;
    }

    let exchange;
    try {
      exchange = await this.exchangePortalCode(this.env, {
        code,
        codeVerifier: handoff.verifier,
        redirectUri: this.callbackUrl,
      });
    } catch (error) {
      res
        .status(error?.status && error.status >= 400 ? error.status : 502)
        .type("text/plain")
        .send(error instanceof Error ? error.message : "Could not finish connecting to Apiosk.");
      return;
    }

    await this.finishAuthorization(res, client, params, exchange);
  }

  async finishAuthorization(res, client, params, exchange) {
    const connectToken = trimString(exchange.connectToken);
    const upstreamRefresh = trimString(exchange.refreshToken);
    const upstreamExpiresAt = Number.isFinite(exchange.expiresInSeconds)
      ? getIssuedAtSeconds() + exchange.expiresInSeconds
      : null;

    /**
     * The cap, and when there is not one.
     *
     * This server's tokens may never outlive what they carry, so an upstream
     * access token with no way to renew it caps everything issued from it.
     * HOLDING A REFRESH TOKEN REMOVES THE CAP: the upstream access token
     * expiring is then a thing this server fixes on the next refresh rather
     * than a thing the person fixes by approving again. Without this the whole
     * connection died every 24 hours, which is the agent gateway's access TTL.
     */
    const maxExpiry = upstreamRefresh ? null : upstreamExpiresAt;

    const authorizationCode = buildIssuedToken(
      this.secret,
      "code",
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes?.length ? params.scopes : [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
        resource: params.resource ? params.resource.href : this.mcpServerUrl.href,
        apioskConnectToken: connectToken || undefined,
        apioskConnectTokenExpiresAt: upstreamExpiresAt || undefined,
        apioskRefreshToken: upstreamRefresh || undefined,
      },
      AUTHORIZATION_CODE_TTL_SECONDS,
      maxExpiry
    ).token;

    const redirectTarget = buildRedirectUri(params.redirectUri, {
      code: authorizationCode,
      state: params.state,
    });

    res
      .status(200)
      .setHeader("content-type", "text/html; charset=utf-8")
      .send(
        createConnectionCompletePage({
          appName: this.appName,
          clientName: client,
          redirectTarget,
        })
      );
  }

  async challengeForAuthorizationCode(client, authorizationCode) {
    const payload = parseSignedToken(this.secret, authorizationCode);
    if (payload.typ !== "code") {
      throw new Error("Invalid authorization code");
    }
    if (payload.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    return payload.codeChallenge;
  }

  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const payload = parseSignedToken(this.secret, authorizationCode);
    if (payload.typ !== "code") {
      throw new Error("Invalid authorization code");
    }
    if (payload.clientId !== client.client_id) {
      throw new Error("Authorization code was not issued to this client");
    }
    if (redirectUri && payload.redirectUri !== redirectUri) {
      throw new Error("redirect_uri does not match the authorization code");
    }

    const requestedResource = resource ? resource.href : payload.resource || this.mcpServerUrl.href;
    // Uncapped when a refresh token came with it. See `finishAuthorization`.
    const maxExpiry =
      !payload.apioskRefreshToken && Number.isFinite(payload.apioskConnectTokenExpiresAt)
        ? payload.apioskConnectTokenExpiresAt
        : null;
    const tokenPayload = {
      clientId: client.client_id,
      scopes:
        Array.isArray(payload.scopes) && payload.scopes.length ?
          payload.scopes :
          [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
      resource: requestedResource,
      apioskConnectToken: payload.apioskConnectToken,
      apioskConnectTokenExpiresAt: payload.apioskConnectTokenExpiresAt,
      apioskRefreshToken: payload.apioskRefreshToken,
    };

    const accessToken = buildIssuedToken(
      this.secret,
      "access",
      tokenPayload,
      ACCESS_TOKEN_TTL_SECONDS,
      maxExpiry
    );
    const refreshToken = buildIssuedToken(
      this.secret,
      "refresh",
      tokenPayload,
      REFRESH_TOKEN_TTL_SECONDS,
      maxExpiry
    );

    return {
      access_token: accessToken.token,
      refresh_token: refreshToken.token,
      token_type: "bearer",
      expires_in: Math.max(1, accessToken.expiresAt - getIssuedAtSeconds()),
      scope: tokenPayload.scopes.join(" "),
    };
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const payload = parseSignedToken(this.secret, refreshToken);
    if (payload.typ !== "refresh") {
      throw new Error("Invalid refresh token");
    }
    if (payload.clientId !== client.client_id) {
      throw new Error("Refresh token was not issued to this client");
    }

    const grantedScopes =
      Array.isArray(scopes) && scopes.length ?
        scopes.filter((scope) => Array.isArray(payload.scopes) && payload.scopes.includes(scope)) :
        payload.scopes;
    const requestedResource = resource ? resource.href : payload.resource || this.mcpServerUrl.href;

    /**
     * Renew the upstream token when it is spent, before minting one that
     * carries it.
     *
     * THIS IS WHERE A CONNECTION SURVIVES ITS SECOND DAY. The agent gateway's
     * access tokens live 24 hours and this server's live one, so a client that
     * refreshes hourly reaches a point where every token it is handed carries
     * an upstream credential that is already dead — and every tool call fails
     * with a 401 the person can do nothing about except approve again.
     *
     * Renewed a little BEFORE expiry, not at it: a token that dies between
     * being minted here and being used by the next tool call is the same
     * failure arriving less often, which is worse to diagnose than one that
     * arrives reliably.
     *
     * A refusal upstream is not fatal here. The old token may still have life
     * in it, and if it does not, the tool call is where that is reported - with
     * the gateway's own words, to a caller that is asking for something rather
     * than to one that is only renewing.
     */
    let upstreamToken = payload.apioskConnectToken;
    let upstreamRefresh = payload.apioskRefreshToken;
    let upstreamExpiresAt = payload.apioskConnectTokenExpiresAt;
    const spent =
      Number.isFinite(upstreamExpiresAt) &&
      upstreamExpiresAt - getIssuedAtSeconds() < UPSTREAM_RENEWAL_MARGIN_SECONDS;

    if (upstreamRefresh && spent) {
      try {
        const renewed = await this.refreshPortalToken(this.env, { refreshToken: upstreamRefresh });
        upstreamToken = trimString(renewed.connectToken) || upstreamToken;
        // Rotating: the one just spent is dead, so keeping it would guarantee
        // the next renewal fails.
        upstreamRefresh = trimString(renewed.refreshToken) || null;
        upstreamExpiresAt = Number.isFinite(renewed.expiresInSeconds)
          ? getIssuedAtSeconds() + renewed.expiresInSeconds
          : null;
      } catch {
        // Left as it was. See above.
      }
    }

    const tokenPayload = {
      clientId: client.client_id,
      scopes: grantedScopes,
      resource: requestedResource,
      apioskConnectToken: upstreamToken,
      apioskConnectTokenExpiresAt: upstreamExpiresAt,
      apioskRefreshToken: upstreamRefresh,
    };
    // Uncapped when a refresh token remains. See `finishAuthorization`.
    const maxExpiry =
      !upstreamRefresh && Number.isFinite(upstreamExpiresAt) ? upstreamExpiresAt : null;
    const accessToken = buildIssuedToken(
      this.secret,
      "access",
      tokenPayload,
      ACCESS_TOKEN_TTL_SECONDS,
      maxExpiry
    );

    return {
      access_token: accessToken.token,
      // Reissued rather than returned, because the upstream token it carries
      // may have just changed. Handing back the one that came in would hand
      // back a rotated-away upstream refresh token with it.
      refresh_token: buildIssuedToken(
        this.secret,
        "refresh",
        tokenPayload,
        REFRESH_TOKEN_TTL_SECONDS,
        maxExpiry
      ).token,
      token_type: "bearer",
      expires_in: Math.max(1, accessToken.expiresAt - getIssuedAtSeconds()),
      scope: Array.isArray(grantedScopes) ? grantedScopes.join(" ") : DEFAULT_SCOPE,
    };
  }

  async verifyAccessToken(token) {
    // Accept Apiosk connect tokens (aw_live_… / aw_test_…) as bearer-
    // equivalent. This is the headless-agent path: cron / CI / a fresh box
    // can mint a connect token in the buyer portal and call the hosted MCP
    // straight away, no interactive OAuth handshake. The gateway is the
    // authoritative store for connect tokens, so we validate by calling
    // its /v1/me endpoint, one source of truth, no shared secret.
    const trimmed = typeof token === "string" ? token.trim() : "";
    if (/^aw_(live|test)_/i.test(trimmed)) {
      return this.verifyConnectTokenAccess(trimmed);
    }

    const payload = parseSignedToken(this.secret, token);
    if (payload.typ !== "access") {
      throw new Error("Invalid access token");
    }

    if (payload.resource && !this.isAllowedResource(payload.resource)) {
      throw new Error("Token was issued for a different resource");
    }

    return {
      token,
      clientId: payload.clientId,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
      expiresAt: payload.exp,
      resource: payload.resource ? new URL(payload.resource) : new URL(this.mcpServerUrl.href),
      extra: {
        // Connect token minted by the buyer portal's OAuth handoff. The
        // runtime threads this to the gateway as X-Apiosk-Connect-Token so
        // paid calls settle from the buyer's own wallet (runtime getClient
        // reads extra.apiosk_connect_token).
        apiosk_connect_token: payload.apioskConnectToken,
      },
    };
  }

  async verifyConnectTokenAccess(connectToken) {
    const cached = this.connectTokenCache?.get(connectToken);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.auth;
    }

    const url = new URL("/v1/me", `${resolveGatewayBaseUrl(this.env)}/`).href;

    let response;
    try {
      response = await fetch(url, {
        headers: { "X-Apiosk-Connect-Token": connectToken, accept: "application/json" },
      });
    } catch (err) {
      throw new Error(`Gateway unreachable while validating connect token: ${err?.message || err}`);
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Gateway rejected connect token (HTTP ${response.status}): ${body.slice(0, 200)}`);
    }
    const data = await response.json().catch(() => ({}));
    const tokenId = trimString(data?.token_id);
    if (!tokenId) {
      throw new Error("Gateway /v1/me returned no token_id");
    }

    const auth = {
      token: connectToken,
      clientId: tokenId,
      scopes: [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
      // Connect tokens have their own expiry stored gateway-side; we treat
      // each MCP call as needing a fresh check (via cache TTL) rather than
      // mirroring the absolute expiry here.
      expiresAt: Math.floor(now / 1000) + 60,
      resource: new URL(this.mcpServerUrl.href),
      extra: {
        userId: trimString(data?.user_id) || undefined,
        apiosk_connect_token: connectToken,
        apiosk_rails: Array.isArray(data?.rails) ? data.rails : undefined,
      },
    };

    if (!this.connectTokenCache) {
      this.connectTokenCache = new Map();
    }
    // Cache for 60s. Long enough to absorb a burst of tool calls, short
    // enough that a revocation in the buyer portal takes effect within a
    // minute, same TTL the dashboard uses for similar permission caches.
    this.connectTokenCache.set(connectToken, {
      auth,
      expiresAt: now + 60_000,
    });
    return auth;
  }
}

function resolveOAuthSecret(env = process.env) {
  const rawSecret =
    trimString(env.APIOSK_MCP_OAUTH_SECRET) ||
    trimString(env.APIOSK_MCP_AUTH_SECRET) ||
    trimString(env.MCP_OAUTH_SECRET);

  if (rawSecret) {
    return rawSecret;
  }

  if (trimString(env.NODE_ENV).toLowerCase() !== "production") {
    return "apiosk-mcp-dev-secret";
  }

  throw new Error(
    "Hosted MCP OAuth requires APIOSK_MCP_OAUTH_SECRET (or APIOSK_MCP_AUTH_SECRET) in production."
  );
}

function extractBearerToken(req) {
  // Apiosk's own header alias for headless agents that prefer to keep
  // Authorization free for upstream APIs. Checked first so a request that
  // carries BOTH a Bearer JWT and X-Apiosk-Connect-Token is treated as a
  // connect-token caller (the explicit Apiosk header wins).
  const apioskHeader = trimString(req.headers["x-apiosk-connect-token"]);
  if (apioskHeader) {
    return apioskHeader;
  }

  const header = trimString(req.headers.authorization);
  if (!header) return null;

  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function writeAuthChallenge(res, { status, code, message, resourceMetadataUrl }) {
  // HTTP header values must be ASCII: strip quotes and replace any
  // non-printable/non-ASCII characters so an upstream error message (which
  // may contain arrows, em-dashes, etc.) can never crash setHeader.
  const headerSafeMessage = String(message)
    .replaceAll('"', "'")
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = [
    `Bearer error="${code}"`,
    `error_description="${headerSafeMessage}"`,
    `scope="${DEFAULT_SCOPE}"`,
  ];

  if (resourceMetadataUrl) {
    parts.push(`resource_metadata="${resourceMetadataUrl}"`);
  }

  res.setHeader("WWW-Authenticate", parts.join(", "));
  res.status(status).json({
    error: code,
    error_description: message,
  });
}

function protectedResourceMetadataPath(resourceUrl) {
  const rsPath = new URL(resourceUrl.href).pathname;
  return `/.well-known/oauth-protected-resource${rsPath === "/" ? "" : rsPath}`;
}

// One router that serves protected-resource metadata (RFC 9728) for the
// origin root AND every transport surface (/mcp, /sse, /messages), so an MCP
// client's discovery probe resolves regardless of which URL it connected to.
// Longer paths are registered first because express `use()` matches by prefix
// and the root path would otherwise shadow the transport-specific documents.
function buildResourceMetadataRouter({
  oauthMetadata,
  resourceUrls,
  scopesSupported,
  resourceName,
  serviceDocumentationUrl,
}) {
  checkResourceRouterIssuer(oauthMetadata.issuer);
  const router = express.Router();

  const sorted = [...resourceUrls].sort(
    (a, b) => new URL(b.href).pathname.length - new URL(a.href).pathname.length
  );

  for (const resourceUrl of sorted) {
    const document = {
      resource: resourceUrl.href,
      authorization_servers: [oauthMetadata.issuer],
      scopes_supported: scopesSupported,
      resource_name: resourceName,
      resource_documentation: serviceDocumentationUrl?.href,
    };
    router.use(protectedResourceMetadataPath(resourceUrl), metadataHandler(document));
  }

  // RFC 8414 authorization-server metadata, so clients that only speak the
  // AS-metadata discovery path still find the issuer.
  router.use("/.well-known/oauth-authorization-server", metadataHandler(oauthMetadata));

  return router;
}

function checkResourceRouterIssuer(issuer) {
  const issuerUrl = new URL(issuer);
  const allowInsecure =
    process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "true" ||
    process.env.MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL === "1";
  if (
    issuerUrl.protocol !== "https:" &&
    issuerUrl.hostname !== "localhost" &&
    issuerUrl.hostname !== "127.0.0.1" &&
    !allowInsecure
  ) {
    throw new Error("Issuer URL must be HTTPS");
  }
}

export function createHostedOAuthSupport({
  env = process.env,
  issuerUrl,
  mcpServerUrl,
  appName = "Apiosk",
  resourceName = "Apiosk MCP",
  exchangePortalCode,
  refreshPortalToken,
} = {}) {
  const secret = resolveOAuthSecret(env);
  const provider = new ApioskHostedOAuthProvider({
    env,
    secret,
    issuerUrl,
    mcpServerUrl,
    appName,
    resourceName,
    exchangePortalCode,
    refreshPortalToken,
  });

  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl,
    scopesSupported: SUPPORTED_SCOPES,
    resourceServerUrl: mcpServerUrl,
    resourceName,
    serviceDocumentationUrl: new URL("https://apiosk.com"),
  });
  // Claude prefers CIMD when advertised. Its metadata origin currently
  // challenges Fly egress with HTTP 403, which makes a healthy MCP endpoint
  // fail sign-in as invalid_client. DCR is local, durable through signed client
  // IDs, and supported by both hosts. Only advertise CIMD after deployment-
  // side reachability has been verified.
  oauthMetadata.client_id_metadata_document_supported = env.APIOSK_MCP_CIMD_ENABLED === "1";

  const serviceDocumentationUrl = new URL("https://apiosk.com");

  // Every transport surface published as its own OAuth resource, plus the
  // Streamable HTTP /mcp URL and the origin root.
  const resourceUrls = [
    ...TRANSPORT_RESOURCE_PATHS.map((path) => new URL(path, mcpServerUrl)),
    mcpServerUrl,
    new URL("/", mcpServerUrl),
  ];

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpServerUrl);
  // PRM URL for the legacy HTTP+SSE transport, so a client that connected via
  // /sse (and posts to /messages) is handed metadata whose `resource` matches
  // the surface it is actually talking to.
  const sseResourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(
    new URL("/sse", mcpServerUrl)
  );

  // The tool-call challenge rides in on the transport the client chose. Point
  // it at that transport's protected-resource metadata so the `resource` the
  // client discovers matches the URL it connected to (RFC 9728 / RFC 8707).
  function resolveResourceMetadataUrl(req) {
    const pathname = String(req?.path || req?.originalUrl || "")
      .split("?")[0]
      .replace(/\/+$/, "");
    if (pathname === "/messages" || pathname === "/sse") {
      return sseResourceMetadataUrl;
    }
    return resourceMetadataUrl;
  }

  return {
    provider,
    oauthMetadata,
    resourceMetadataUrl,
    sseResourceMetadataUrl,
    resourceUrls,
    metadataRouter: buildResourceMetadataRouter({
      oauthMetadata,
      resourceUrls,
      scopesSupported: SUPPORTED_SCOPES,
      resourceName,
      serviceDocumentationUrl,
    }),
    authorizationRouter: authorizationHandler({ provider }),
    tokenRouter: tokenHandler({ provider }),
    registrationRouter: clientRegistrationHandler({ clientsStore: provider.clientsStore }),
    // GET /authorize/callback — buy.apiosk.com's return leg. Not part of the
    // SDK's authorizationHandler (that only ever starts a flow); this ends
    // one that started on this server and continued at the portal.
    async handlePortalCallback(req, res) {
      await provider.completePortalCallback(req, res);
    },
    createMcpAuthMiddleware(runtime) {
      return async (req, res, next) => {
        const challengeResourceMetadataUrl = resolveResourceMetadataUrl(req);
        const bearerToken = extractBearerToken(req);

        if (bearerToken) {
          try {
            req.auth = await provider.verifyAccessToken(bearerToken);
          } catch (error) {
            writeAuthChallenge(res, {
              status: 401,
              code: "invalid_token",
              message: error instanceof Error ? error.message : "Invalid access token",
              resourceMetadataUrl: challengeResourceMetadataUrl,
            });
            return;
          }
        }

        const requestBody = req.body;
        const method = trimString(requestBody?.method);
        // Every v2 tool uses the connected account. Challenge during the
        // initial handshake too, so hosts do not install it as an anonymous
        // connector and discover the sign-in requirement only on first use.
        if (env.APIOSK_GATEWAY_V2_URL && method && !req.auth) {
          writeAuthChallenge(res, {
            status: 401,
            code: "invalid_token",
            message: "Connect your Apiosk account once to use this connector.",
            resourceMetadataUrl: challengeResourceMetadataUrl,
          });
          return;
        }

        if (method !== "tools/call") {
          next();
          return;
        }

        const toolName = trimString(requestBody?.params?.name);
        const requiresAuth = toolName ? await runtime.isToolProtected(toolName, req.auth) : false;

        if (!requiresAuth) {
          next();
          return;
        }

        if (!req.auth) {
          writeAuthChallenge(res, {
            status: 401,
            code: "invalid_token",
            message: "This Apiosk tool requires sign-in before it can run.",
            resourceMetadataUrl: challengeResourceMetadataUrl,
          });
          return;
        }

        if (!Array.isArray(req.auth.scopes) || !req.auth.scopes.includes(DEFAULT_SCOPE)) {
          writeAuthChallenge(res, {
            status: 403,
            code: "insufficient_scope",
            message: `This tool requires the ${DEFAULT_SCOPE} scope.`,
            resourceMetadataUrl: challengeResourceMetadataUrl,
          });
          return;
        }

        next();
      };
    },
  };
}

export function resolveHostedMcpUrls({ env = process.env, port = 3000 } = {}) {
  const publicBaseUrl = normalizeBaseUrl(
    env.APIOSK_MCP_PUBLIC_BASE_URL ||
      env.APIOSK_MCP_BASE_URL ||
      env.APIOSK_MCP_ORIGIN ||
      env.APIOSK_PUBLIC_MCP_URL,
    `http://localhost:${port}`
  );

  const issuerUrl = new URL(
    normalizeBaseUrl(env.APIOSK_MCP_ISSUER_URL, publicBaseUrl)
  );
  const configuredServerUrl = trimString(env.APIOSK_MCP_SERVER_URL);
  const mcpServerUrl = configuredServerUrl ?
    new URL(configuredServerUrl) :
    new URL("/mcp", `${publicBaseUrl}/`);

  return {
    issuerUrl,
    mcpServerUrl,
  };
}
