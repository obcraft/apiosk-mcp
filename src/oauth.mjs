import crypto from "node:crypto";

import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthMetadataRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";

import { isProviderApiKey, verifyProviderKey } from "./publisher.mjs";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLIENT_ID_TTL_SECONDS = 20 * 365 * 24 * 60 * 60;
const DEFAULT_SCOPE = "mcp:tools";
const OFFLINE_ACCESS_SCOPE = "offline_access";
const SUPPORTED_SCOPES = [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE];
const UUID_LIKE_CLIENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

function createAuthorizePage({
  actionPath,
  appName,
  clientName,
  email = "",
  errorMessage = "",
  infoMessage = "",
  oauthParams,
}) {
  const scope = Array.isArray(oauthParams.scopes) ? oauthParams.scopes.join(" ") : "";
  const resource = oauthParams.resource ? oauthParams.resource.href : "";

  const hiddenInputs = [
    ["client_id", clientName.client_id],
    ["redirect_uri", oauthParams.redirectUri],
    ["response_type", "code"],
    ["code_challenge", oauthParams.codeChallenge],
    ["code_challenge_method", "S256"],
    ["scope", scope],
    ["state", oauthParams.state || ""],
    ["resource", resource],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}" />`
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Connect ${escapeHtml(appName)}</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #07111c;
        --panel: rgba(11, 24, 38, 0.94);
        --border: rgba(119, 159, 214, 0.22);
        --text: #edf4ff;
        --muted: #94a8c7;
        --accent: #68b4ff;
        --accent-strong: #4d98ff;
        --danger: #ff9d9d;
        --success: #9ef0ba;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(72, 136, 255, 0.22), transparent 32%),
          radial-gradient(circle at bottom right, rgba(55, 217, 169, 0.18), transparent 28%),
          linear-gradient(180deg, #02070d 0%, var(--bg) 100%);
        color: var(--text);
      }

      main {
        width: min(100%, 460px);
        border: 1px solid var(--border);
        background: var(--panel);
        border-radius: 20px;
        padding: 28px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
      }

      h1 {
        margin: 0 0 8px;
        font-size: 1.8rem;
        line-height: 1.1;
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.55;
      }

      .stack {
        display: grid;
        gap: 16px;
      }

      .message {
        border-radius: 14px;
        padding: 12px 14px;
        font-size: 0.96rem;
      }

      .message.error {
        border: 1px solid rgba(255, 157, 157, 0.28);
        background: rgba(106, 26, 26, 0.24);
        color: var(--danger);
      }

      .message.info {
        border: 1px solid rgba(158, 240, 186, 0.22);
        background: rgba(21, 71, 42, 0.24);
        color: var(--success);
      }

      label {
        display: grid;
        gap: 6px;
        font-size: 0.92rem;
        color: var(--muted);
      }

      input {
        width: 100%;
        border: 1px solid rgba(119, 159, 214, 0.18);
        border-radius: 12px;
        background: rgba(2, 10, 18, 0.82);
        color: var(--text);
        padding: 12px 14px;
        font-size: 1rem;
      }

      button {
        appearance: none;
        border: 0;
        border-radius: 12px;
        padding: 12px 14px;
        font-size: 0.98rem;
        font-weight: 600;
        cursor: pointer;
      }

      button.primary {
        background: linear-gradient(135deg, var(--accent) 0%, var(--accent-strong) 100%);
        color: #04101d;
      }

      button.secondary {
        background: rgba(255, 255, 255, 0.06);
        color: var(--text);
      }

      .actions {
        display: grid;
        gap: 10px;
      }

      .meta {
        font-size: 0.84rem;
        color: var(--muted);
      }

      code {
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, monospace;
        color: #cbe1ff;
      }
    </style>
  </head>
  <body>
    <main class="stack">
      <header class="stack">
        <div>
          <p>${escapeHtml(clientName.client_name || "Remote MCP client")}</p>
          <h1>Connect ${escapeHtml(appName)}</h1>
        </div>
        <p>Sign in with your Apiosk dashboard account to unlock paid gateway calls, managed wallets, and credit-backed execution from this MCP app.</p>
      </header>
      ${errorMessage ? `<div class="message error">${escapeHtml(errorMessage)}</div>` : ""}
      ${infoMessage ? `<div class="message info">${escapeHtml(infoMessage)}</div>` : ""}
      <form method="post" action="${escapeHtml(actionPath)}" class="stack">
        ${hiddenInputs}
        <label>
          Email
          <input type="email" name="email" autocomplete="username" value="${escapeHtml(email)}" required />
        </label>
        <label>
          Password
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <div class="actions">
          <button class="primary" type="submit" name="action" value="sign_in">Sign in and continue</button>
          <button class="secondary" type="submit" name="action" value="sign_up">Create account</button>
          <button class="secondary" type="submit" name="action" value="cancel">Cancel</button>
        </div>
      </form>
      <div class="meta">
        Requested scope: <code>${escapeHtml(scope || DEFAULT_SCOPE)}</code><br />
        Resource: <code>${escapeHtml(resource || "default")}</code>
      </div>
    </main>
  </body>
</html>`;
}

async function fetchDashboardJson(baseUrl, pathname, payload) {
  const response = await fetch(new URL(pathname, baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

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
  constructor({ env, secret, controlPlaneBaseUrl, issuerUrl, mcpServerUrl, appName, resourceName }) {
    this.env = env;
    this.secret = secret;
    this.controlPlaneBaseUrl = controlPlaneBaseUrl;
    this.issuerUrl = issuerUrl;
    this.mcpServerUrl = mcpServerUrl;
    this.appName = appName;
    this.resourceName = resourceName;
    this.clientsStore = new ApioskOAuthClientsStore(secret);
  }

  async authorize(client, params, res) {
    const req = res.req;
    const submittedAction = trimString(req?.body?.action);
    const email = trimString(req?.body?.email).toLowerCase();
    const password = trimString(req?.body?.password);

    if (!req || req.method !== "POST" || !submittedAction) {
      res
        .status(200)
        .setHeader("content-type", "text/html; charset=utf-8")
        .send(
          createAuthorizePage({
            actionPath: new URL("/authorize", this.issuerUrl).pathname,
            appName: this.appName,
            clientName: client,
            oauthParams: params,
          })
        );
      return;
    }

    if (submittedAction === "cancel") {
      res.redirect(
        302,
        buildRedirectUri(params.redirectUri, {
          error: "access_denied",
          error_description: "The user cancelled authorization.",
          state: params.state,
        })
      );
      return;
    }

    if (!email || !password) {
      res
        .status(400)
        .setHeader("content-type", "text/html; charset=utf-8")
        .send(
          createAuthorizePage({
            actionPath: new URL("/authorize", this.issuerUrl).pathname,
            appName: this.appName,
            clientName: client,
            oauthParams: params,
            email,
            errorMessage: "Email and password are required.",
          })
        );
      return;
    }

    const route = submittedAction === "sign_up" ? "/api/auth/mcp-sign-up" : "/api/auth/mcp-sign-in";
    const authResponse = await fetchDashboardJson(this.controlPlaneBaseUrl, route, {
      email,
      password,
    });

    const body = authResponse.body && typeof authResponse.body === "object" ? authResponse.body : {};
    const sessionToken = trimString(body.session_token);
    const sessionExpiry = Number(body.expires_at);
    const normalizedSessionExpiry =
      Number.isFinite(sessionExpiry) && sessionExpiry > getIssuedAtSeconds() ? sessionExpiry : null;

    if (submittedAction === "sign_up" && !sessionToken && body.email_confirmation_required) {
      res
        .status(200)
        .setHeader("content-type", "text/html; charset=utf-8")
        .send(
          createAuthorizePage({
            actionPath: new URL("/authorize", this.issuerUrl).pathname,
            appName: this.appName,
            clientName: client,
            oauthParams: params,
            email,
            infoMessage:
              "Account created. Confirm your email from the Apiosk message we sent, then come back and sign in to finish connecting the app.",
          })
        );
      return;
    }

    if (!authResponse.ok || !sessionToken) {
      const message =
        trimString(body.message) ||
        trimString(body.error) ||
        "Could not sign in to Apiosk. Check your credentials and try again.";

      res
        .status(authResponse.ok ? 400 : authResponse.status)
        .setHeader("content-type", "text/html; charset=utf-8")
        .send(
          createAuthorizePage({
            actionPath: new URL("/authorize", this.issuerUrl).pathname,
            appName: this.appName,
            clientName: client,
            oauthParams: params,
            email,
            errorMessage: message,
          })
        );
      return;
    }

    const authorizationCode = buildIssuedToken(
      this.secret,
      "code",
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes: params.scopes?.length ? params.scopes : [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
        resource: params.resource ? params.resource.href : this.mcpServerUrl.href,
        dashboardSessionToken: sessionToken,
        dashboardSessionExpiresAt: normalizedSessionExpiry || undefined,
        userId: trimString(body.user_id),
        email: trimString(body.email) || email,
      },
      AUTHORIZATION_CODE_TTL_SECONDS,
      normalizedSessionExpiry
    ).token;

    res.redirect(
      302,
      buildRedirectUri(params.redirectUri, {
        code: authorizationCode,
        state: params.state,
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
    const maxExpiry = Number.isFinite(payload.dashboardSessionExpiresAt) ? payload.dashboardSessionExpiresAt : null;
    const tokenPayload = {
      clientId: client.client_id,
      scopes:
        Array.isArray(payload.scopes) && payload.scopes.length ?
          payload.scopes :
          [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
      resource: requestedResource,
      dashboardSessionToken: payload.dashboardSessionToken,
      dashboardSessionExpiresAt: payload.dashboardSessionExpiresAt,
      userId: payload.userId,
      email: payload.email,
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
    const maxExpiry = Number.isFinite(payload.dashboardSessionExpiresAt) ? payload.dashboardSessionExpiresAt : null;
    const accessToken = buildIssuedToken(
      this.secret,
      "access",
      {
        clientId: client.client_id,
        scopes: grantedScopes,
        resource: requestedResource,
        dashboardSessionToken: payload.dashboardSessionToken,
        dashboardSessionExpiresAt: payload.dashboardSessionExpiresAt,
        userId: payload.userId,
        email: payload.email,
      },
      ACCESS_TOKEN_TTL_SECONDS,
      maxExpiry
    );

    return {
      access_token: accessToken.token,
      refresh_token: refreshToken,
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

    // Accept Apiosk provider API keys (sk_live_…) as bearer-equivalent. This
    // is the publisher path: a coding agent configures
    // `Authorization: Bearer sk_live_…` in its MCP client and can publish
    // x402 routes without an interactive OAuth handshake. Verified against
    // the provider_api_keys table (verify_provider_api_key RPC).
    if (isProviderApiKey(trimmed)) {
      return this.verifyProviderKeyAccess(trimmed);
    }

    const payload = parseSignedToken(this.secret, token);
    if (payload.typ !== "access") {
      throw new Error("Invalid access token");
    }

    if (payload.resource && payload.resource !== this.mcpServerUrl.href) {
      throw new Error("Token was issued for a different resource");
    }

    return {
      token,
      clientId: payload.clientId,
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE],
      expiresAt: payload.exp,
      resource: payload.resource ? new URL(payload.resource) : new URL(this.mcpServerUrl.href),
      extra: {
        dashboardSessionToken: payload.dashboardSessionToken,
        dashboard_session_token: payload.dashboardSessionToken,
        dashboardSessionExpiresAt: payload.dashboardSessionExpiresAt,
        userId: payload.userId,
        email: payload.email,
      },
    };
  }

  async verifyProviderKeyAccess(providerKey) {
    // verifyProviderKey caches successful lookups for 60s, so bursts of tool
    // calls don't hammer the verify RPC while revocations in the provider
    // portal still take effect within a minute.
    let context;
    try {
      context = await verifyProviderKey(providerKey, { env: this.env });
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : "Invalid Apiosk provider token"
      );
    }

    return {
      token: providerKey,
      clientId: `provider:${context.ownerId}`,
      scopes: [DEFAULT_SCOPE],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
      resource: new URL(this.mcpServerUrl.href),
      extra: {
        apiosk_provider_key: providerKey,
        apiosk_provider_owner_id: context.ownerId,
        apiosk_provider_key_label: context.label,
      },
    };
  }

  async verifyConnectTokenAccess(connectToken) {
    const cached = this.connectTokenCache?.get(connectToken);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.auth;
    }

    const gatewayBase =
      trimString(this.env?.APIOSK_GATEWAY_URL) ||
      trimString(this.env?.APIOSK_GATEWAY_BASE_URL) ||
      "https://gateway.apiosk.com";
    const url = new URL("/v1/me", gatewayBase.replace(/\/+$/, "/")).href;

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

export function createHostedOAuthSupport({
  env = process.env,
  controlPlaneBaseUrl,
  issuerUrl,
  mcpServerUrl,
  appName = "Apiosk",
  resourceName = "Apiosk MCP",
} = {}) {
  const secret = resolveOAuthSecret(env);
  const provider = new ApioskHostedOAuthProvider({
    env,
    secret,
    controlPlaneBaseUrl,
    issuerUrl,
    mcpServerUrl,
    appName,
    resourceName,
  });

  const oauthMetadata = createOAuthMetadata({
    provider,
    issuerUrl,
    scopesSupported: SUPPORTED_SCOPES,
    resourceServerUrl: mcpServerUrl,
    resourceName,
    serviceDocumentationUrl: new URL("https://apiosk.com"),
  });
  oauthMetadata.client_id_metadata_document_supported = true;

  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpServerUrl);

  return {
    provider,
    oauthMetadata,
    resourceMetadataUrl,
    metadataRouter: mcpAuthMetadataRouter({
      oauthMetadata,
      resourceServerUrl: mcpServerUrl,
      scopesSupported: SUPPORTED_SCOPES,
      resourceName,
      serviceDocumentationUrl: new URL("https://apiosk.com"),
    }),
    authorizationRouter: authorizationHandler({ provider }),
    tokenRouter: tokenHandler({ provider }),
    registrationRouter: clientRegistrationHandler({ clientsStore: provider.clientsStore }),
    createMcpAuthMiddleware(runtime) {
      return async (req, res, next) => {
        const bearerToken = extractBearerToken(req);

        if (bearerToken) {
          try {
            req.auth = await provider.verifyAccessToken(bearerToken);
          } catch (error) {
            writeAuthChallenge(res, {
              status: 401,
              code: "invalid_token",
              message: error instanceof Error ? error.message : "Invalid access token",
              resourceMetadataUrl,
            });
            return;
          }
        }

        const requestBody = req.body;
        const method = trimString(requestBody?.method);
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
            resourceMetadataUrl,
          });
          return;
        }

        if (!Array.isArray(req.auth.scopes) || !req.auth.scopes.includes(DEFAULT_SCOPE)) {
          writeAuthChallenge(res, {
            status: 403,
            code: "insufficient_scope",
            message: `This tool requires the ${DEFAULT_SCOPE} scope.`,
            resourceMetadataUrl,
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
