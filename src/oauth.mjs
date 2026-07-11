import crypto from "node:crypto";

import express from "express";

import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";

import { isProviderApiKey, verifyProviderKey } from "./publisher.mjs";
import { mintHostedConnectToken } from "./hosted-payment.mjs";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CLIENT_ID_TTL_SECONDS = 20 * 365 * 24 * 60 * 60;
const DEFAULT_SCOPE = "mcp:tools";
const OFFLINE_ACCESS_SCOPE = "offline_access";
const SUPPORTED_SCOPES = [DEFAULT_SCOPE, OFFLINE_ACCESS_SCOPE];
const DEFAULT_SUPABASE_URL = "https://jgjoiyqdyypouskftzeq.supabase.co";
const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
// Every transport surface an MCP client may connect to and treat as the
// OAuth "resource". Streamable HTTP clients target /mcp; the legacy HTTP+SSE
// transport (ChatGPT's connector) opens /sse and posts to /messages. We
// publish protected-resource metadata for each, plus the origin root, so a
// client's discovery probe succeeds no matter which surface it connected to.
const TRANSPORT_RESOURCE_PATHS = ["/mcp", "/sse", "/messages"];
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

function jsStringLiteral(value) {
  return JSON.stringify(String(value)).replaceAll("<", "\\u003c");
}

// Inline brand marks so the wallet options always show a recognizable logo,
// even before an injected wallet announces its own EIP-6963 icon (and for the
// "install" state where no provider exists yet). Encoded as base64 data URIs so
// they can be handed to the client as plain <img src> strings without any
// template-literal escaping concerns.
function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg.trim()).toString("base64")}`;
}

// Official MetaMask fox mark.
const METAMASK_ICON = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 212 189" width="212" height="189">
<g fill="none" fill-rule="evenodd">
<polygon fill="#CDBDB2" points="60.75 173.25 88.313 180.563 88.313 171 90.563 168.75 106.313 168.75 106.313 187.875 89.438 187.875 68.625 178.875"/>
<polygon fill="#CDBDB2" points="151.25 173.25 123.75 180.563 123.75 171 121.5 168.75 105.75 168.75 105.75 187.875 122.688 187.875 143.438 178.875"/>
<polygon fill="#393939" points="90.563 152.438 88.313 171 91.125 168.75 120.938 168.75 123.75 171 121.5 152.438 117 149.625 94.5 150.188"/>
<polygon fill="#F89C35" points="75.375 27 88.875 58.5 95.063 150.188 117 150.188 123.75 58.5 136.125 27"/>
<polygon fill="#F89D35" points="16.313 96.188 .563 141.75 39.938 139.5 65.25 139.5 65.25 119.813 64.125 79.313 58.5 83.813"/>
<polygon fill="#D87C30" points="46.125 101.25 92.25 102.375 87.188 126 65.25 120.375"/>
<polygon fill="#EA8D3A" points="46.125 101.813 65.25 119.813 65.25 137.813"/>
<polygon fill="#F89D35" points="65.25 120.375 87.75 126 95.063 150.188 90 153 65.25 138.375"/>
<polygon fill="#EB8F35" points="65.25 138.375 60.75 173.25 90.563 152.438"/>
<polygon fill="#EA8E3A" points="92.25 102.375 95.063 150.188 86.625 125.719"/>
<polygon fill="#D87C30" points="39.375 138.938 65.25 138.375 60.75 173.25"/>
<polygon fill="#EB8F35" points="12.938 188.438 60.75 173.25 39.375 138.938 .563 141.75"/>
<polygon fill="#E8821E" points="88.875 58.5 64.688 78.75 46.125 101.25 92.25 102.938"/>
<polygon fill="#DFCEC3" points="60.75 173.25 90.563 152.438 88.313 170.438 88.313 180.563 68.063 176.625"/>
<polygon fill="#E88F35" points="12.375 .563 88.875 58.5 75.938 27"/>
<path fill="#8E5A30" d="M12.375.563L2.25 31.5l5.625 33.75-3.938 2.25 5.625 5.063-4.5 3.938 6.188 5.625-3.938 3.375 8.813 11.25 41.063-12.75c20.063-16.125 29.925-24.375 29.588-24.75-.337-.375-29.925-22.688-88.762-66.938z"/>
<polygon fill="#F89D35" points="195.188 96.188 210.938 141.75 171.563 139.5 146.25 139.5 146.25 119.813 147.375 79.313 153 83.813"/>
<polygon fill="#D87C30" points="165.375 101.25 119.25 102.375 124.313 126 146.25 120.375"/>
<polygon fill="#EA8D3A" points="165.375 101.813 146.25 119.813 146.25 137.813"/>
<polygon fill="#F89D35" points="146.25 120.375 123.75 126 116.438 150.188 121.5 153 146.25 138.375"/>
<polygon fill="#EB8F35" points="146.25 138.375 150.75 173.25 121.5 152.438"/>
<polygon fill="#D87C30" points="172.125 138.938 146.25 138.375 150.75 173.25"/>
<polygon fill="#EB8F35" points="198.563 188.438 150.75 173.25 172.125 138.938 210.938 141.75"/>
<polygon fill="#E8821E" points="122.625 58.5 146.813 78.75 165.375 101.25 119.25 102.938"/>
<polygon fill="#E88F35" points="199.125 .563 122.625 58.5 135.563 27"/>
<path fill="#8E5A30" d="M199.125.563L209.25 31.5l-5.625 33.75 3.938 2.25-5.625 5.063 4.5 3.938-6.188 5.625 3.938 3.375-8.813 11.25-41.063-12.75c-20.063-16.125-29.925-24.375-29.588-24.75.337-.375 29.925-22.688 88.762-66.938z"/>
</g></svg>`);

// WalletConnect blue tile + signal wave.
const WALLETCONNECT_ICON = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
<rect width="40" height="40" rx="11" fill="#3396FF"/>
<path fill="#fff" d="M12.4 15.6c4.2-4.1 11-4.1 15.2 0l.5.5c.21.2.21.55 0 .75l-1.73 1.7c-.1.1-.27.1-.38 0l-.7-.68c-2.93-2.87-7.68-2.87-10.6 0l-.75.73c-.1.1-.28.1-.38 0l-1.73-1.7c-.2-.2-.2-.55 0-.75l.75-.55zm18.77 3.5 1.54 1.5c.2.2.2.55 0 .76l-6.94 6.8c-.2.2-.54.2-.75 0l-4.93-4.83a.135.135 0 0 0-.19 0l-4.92 4.83c-.2.2-.55.2-.76 0l-6.94-6.8c-.2-.2-.2-.55 0-.76l1.54-1.5c.2-.2.55-.2.75 0l4.93 4.83c.05.05.14.05.19 0l4.92-4.83c.2-.2.55-.2.76 0l4.93 4.83c.05.05.13.05.19 0l4.92-4.83c.21-.2.55-.2.76 0z"/>
</svg>`);

// Coinbase Wallet blue mark.
const COINBASE_ICON = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
<rect width="40" height="40" rx="11" fill="#0052FF"/>
<path fill="#fff" d="M20 8a12 12 0 1 0 0 24 12 12 0 0 0 0-24zm-3.4 8.1c0-.83.67-1.5 1.5-1.5h3.8c.83 0 1.5.67 1.5 1.5v7.8c0 .83-.67 1.5-1.5 1.5h-3.8c-.83 0-1.5-.67-1.5-1.5v-7.8z"/>
</svg>`);

// Generic browser-wallet glyph for injected wallets with no announced icon.
const GENERIC_WALLET_ICON = svgDataUri(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
<rect width="40" height="40" rx="11" fill="#6b38d4"/>
<path fill="#fff" d="M11 14.5A2.5 2.5 0 0 1 13.5 12h13a2.5 2.5 0 0 1 2.5 2.5V16h-2v-1.5a.5.5 0 0 0-.5-.5h-13a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5V24h2v1.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 11 25.5v-11zM24 18h6v4h-6a2 2 0 0 1 0-4zm2 1.4a.6.6 0 1 0 0 1.2.6.6 0 0 0 0-1.2z"/>
</svg>`);

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

function normalizeSessionExpiry(value) {
  const sessionExpiry = Number(value);
  return Number.isFinite(sessionExpiry) && sessionExpiry > getIssuedAtSeconds()
    ? sessionExpiry
    : null;
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

function createAuthorizePage({
  actionPath,
  appName,
  clientName,
  errorMessage = "",
  infoMessage = "",
  oauthParams,
  walletEnabled = true,
  walletNoncePath = "/api/auth/mcp-wallet-nonce",
  walletConnectProjectId = "",
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
    <meta name="color-scheme" content="light" />
    <meta name="theme-color" content="#f8f9fb" />
    <title>Connect ${escapeHtml(appName)}</title>
    <link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDI0IDEwMjQiPjxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iZyIgeDE9IjE1OCIgeTE9IjEyMCIgeDI9Ijg2NiIgeTI9IjkwNiIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPjxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzhiNWNmNiIvPjxzdG9wIG9mZnNldD0iLjUyIiBzdG9wLWNvbG9yPSIjNmIzOGQ0Ii8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNTUxNmJlIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PGcgZmlsbD0ibm9uZSIgc3Ryb2tlPSJ1cmwoI2cpIiBzdHJva2Utd2lkdGg9IjQzIj48cGF0aCBkPSJNNTExLjUgMTkwLjV2MzIxIi8+PHBhdGggZD0iTTIzMSAzMzVsMjgwLjUgMTc2LjUiLz48cGF0aCBkPSJNNzkyLjUgMzM1TDUxMS41IDUxMS41Ii8+PHBhdGggZD0iTTIzMSA2NzVsMjgwLjUtMTYzLjUiLz48cGF0aCBkPSJNNzkyLjUgNjc1TDUxMS41IDUxMS41Ii8+PHBhdGggZD0iTTUxMS41IDgyNS41di0zMTQiLz48L2c+PGcgZmlsbD0idXJsKCNnKSI+PGNpcmNsZSBjeD0iNTExLjUiIGN5PSIxOTAuNSIgcj0iODAuNSIvPjxjaXJjbGUgY3g9IjIzMSIgY3k9IjMzNSIgcj0iODAiLz48Y2lyY2xlIGN4PSI3OTIuNSIgY3k9IjMzNSIgcj0iODAiLz48Y2lyY2xlIGN4PSI1MTEuNSIgY3k9IjUxMS41IiByPSIxMzUiLz48Y2lyY2xlIGN4PSIyMzEiIGN5PSI2NzUiIHI9IjgwIi8+PGNpcmNsZSBjeD0iNzkyLjUiIGN5PSI2NzUiIHI9IjgwIi8+PGNpcmNsZSBjeD0iNTExLjUiIGN5PSI4MjUuNSIgcj0iODAuNSIvPjwvZz48L3N2Zz4K" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" />
    <style>
      :root {
        color-scheme: light;
        --background: #f8f9fb;
        --foreground: #191c1e;
        --card: #ffffff;
        --border: #e5e3ec;
        --muted: #5d5a68;
        --muted-surface: #f2f4f6;
        --primary: #6b38d4;
        --primary-strong: #5516be;
        --primary-soft: #f3effd;
        --danger: #ba1a1a;
        --danger-soft: #ffdad6;
        --success: #1f8a5b;
        --success-soft: #e6f4ee;
        --shadow: 0 24px 48px -16px rgba(60, 30, 120, 0.22), 0 8px 20px -12px rgba(26, 35, 53, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background:
          radial-gradient(900px 520px at 88% -12%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 60%),
          radial-gradient(760px 520px at -8% 112%, color-mix(in srgb, #8b5cf6 13%, transparent), transparent 55%),
          var(--background);
        background-attachment: fixed;
        color: var(--foreground);
      }

      .shell {
        width: 100%;
        min-height: 100vh;
        display: grid;
        grid-template-rows: auto 1fr auto;
      }

      .topbar,
      footer {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px clamp(20px, 5vw, 42px);
      }

      .brand {
        display: inline-flex;
        align-items: center;
        gap: 10px;
        color: var(--foreground);
        text-decoration: none;
        font-weight: 700;
      }

      .brand-mark {
        width: 36px;
        height: 36px;
        display: inline-grid;
        place-items: center;
      }

      .brand-mark svg {
        width: 100%;
        height: 100%;
      }

      .page {
        width: 100%;
        display: grid;
        place-items: center;
        padding: 24px clamp(20px, 5vw, 42px) 40px;
      }

      .layout {
        width: min(100%, 960px);
        display: grid;
        grid-template-columns: 1fr;
        justify-items: center;
        gap: 36px;
        align-items: center;
      }

      .hero {
        display: none;
      }

      @media (min-width: 900px) {
        .layout {
          grid-template-columns: 1.02fr 0.98fr;
          gap: 56px;
          justify-items: stretch;
        }

        .hero {
          display: grid;
          gap: 22px;
          align-content: center;
        }
      }

      .hero-eyebrow {
        color: var(--primary);
        font-weight: 700;
        font-size: 0.85rem;
        letter-spacing: 0.01em;
      }

      .hero h2 {
        margin: 6px 0 0;
        font-size: clamp(1.9rem, 2.6vw, 2.55rem);
        line-height: 1.08;
        letter-spacing: -0.02em;
      }

      .hero .lead {
        font-size: 1.02rem;
        line-height: 1.55;
        max-width: 42ch;
      }

      .value-list {
        display: grid;
        gap: 16px;
        margin-top: 4px;
      }

      .value {
        display: flex;
        gap: 13px;
        align-items: flex-start;
      }

      .value-icon {
        flex: 0 0 auto;
        width: 40px;
        height: 40px;
        border-radius: 11px;
        display: grid;
        place-items: center;
        background: var(--primary-soft);
        color: var(--primary);
        border: 1px solid color-mix(in srgb, var(--primary) 16%, transparent);
      }

      .value-icon svg {
        width: 20px;
        height: 20px;
      }

      .value-title {
        font-weight: 600;
        font-size: 0.96rem;
      }

      .value-desc {
        color: var(--muted);
        font-size: 0.9rem;
        line-height: 1.45;
      }

      main {
        width: 100%;
        max-width: 440px;
        justify-self: center;
        border: 1px solid var(--border);
        background: var(--card);
        border-radius: 18px;
        padding: 28px;
        box-shadow: var(--shadow);
      }

      h1 {
        margin: 0 0 8px;
        font-size: 1.35rem;
        line-height: 1.2;
        letter-spacing: 0;
      }

      p {
        margin: 0;
        color: var(--muted);
        line-height: 1.55;
      }

      .stack {
        display: grid;
        gap: 14px;
      }

      .header {
        gap: 8px;
      }

      .eyebrow {
        margin-bottom: 6px;
        color: var(--primary);
        font-size: 0.83rem;
        font-weight: 700;
      }

      .message {
        border-radius: 8px;
        padding: 12px 14px;
        font-size: 0.9rem;
      }

      .message.error {
        border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
        background: var(--danger-soft);
        color: var(--danger);
      }

      .message.info {
        border: 1px solid color-mix(in srgb, var(--success) 26%, transparent);
        background: var(--success-soft);
        color: var(--success);
      }

      .panel {
        display: grid;
        gap: 10px;
      }

      button {
        appearance: none;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 12px 14px;
        font-size: 0.98rem;
        font-weight: 600;
        cursor: pointer;
        min-height: 40px;
        transition: background-color 140ms ease, border-color 140ms ease, color 140ms ease, opacity 140ms ease;
      }

      button:disabled {
        cursor: not-allowed;
        opacity: 0.58;
      }

      button.primary {
        background: var(--primary);
        color: #fff;
      }

      button.primary:hover:not(:disabled) {
        background: var(--primary-strong);
      }

      button.secondary {
        background: transparent;
        border-color: var(--border);
        color: var(--foreground);
      }

      button.secondary:hover:not(:disabled) {
        background: var(--muted-surface);
      }

      .wallet-list {
        display: grid;
        gap: 8px;
      }

      .wallet-option {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 13px 16px;
        min-height: 58px;
        border-radius: 12px;
        background: var(--card);
        border: 1px solid var(--border);
        color: var(--foreground);
        text-align: left;
        text-decoration: none;
        font-weight: 600;
        cursor: pointer;
        transition: border-color 140ms ease, background-color 140ms ease, box-shadow 140ms ease, transform 140ms ease;
      }

      .wallet-option:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--primary) 45%, var(--border));
        background: var(--primary-soft);
        box-shadow: 0 6px 16px -10px color-mix(in srgb, var(--primary) 60%, transparent);
        transform: translateY(-1px);
      }

      .wallet-name {
        min-width: 0;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .wallet-icon {
        width: 24px;
        height: 24px;
        border-radius: 6px;
        flex: 0 0 auto;
        object-fit: contain;
        background: var(--card);
      }

      .wallet-name-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.95rem;
        font-weight: 500;
      }

      .wallet-action {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        color: var(--muted);
        font-size: 0.78rem;
      }

      .wallet-option.install {
        border-style: dashed;
      }

      .wallet-option.busy {
        opacity: 0.6;
      }

      .wallet-connect-option .wallet-action {
        color: var(--primary);
        font-weight: 600;
      }

      .spinner {
        width: 15px;
        height: 15px;
        border-radius: 999px;
        border: 2px solid color-mix(in srgb, var(--primary) 30%, transparent);
        border-top-color: var(--primary);
        animation: spin 0.7s linear infinite;
      }

      @keyframes spin {
        to {
          transform: rotate(360deg);
        }
      }

      .divider {
        display: flex;
        align-items: center;
        gap: 12px;
        color: var(--muted);
        font-size: 0.76rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .divider::before,
      .divider::after {
        content: "";
        flex: 1;
        height: 1px;
        background: var(--border);
      }

      .cancel-row {
        display: flex;
        justify-content: center;
        margin: 0;
      }

      .cancel-link {
        appearance: none;
        background: none;
        border: none;
        box-shadow: none;
        min-height: auto;
        padding: 4px 8px;
        color: var(--muted);
        font-size: 0.86rem;
        font-weight: 500;
        cursor: pointer;
      }

      .cancel-link:hover {
        color: var(--foreground);
        text-decoration: underline;
        text-underline-offset: 3px;
      }

      .meta {
        font-size: 0.84rem;
        color: var(--muted);
        padding-top: 2px;
      }

      .grant {
        margin-top: 2px;
        border-top: 1px solid var(--border);
        padding-top: 14px;
        font-size: 0.8rem;
        line-height: 1.7;
        color: var(--muted);
      }

      code {
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, monospace;
        color: var(--foreground);
        word-break: break-word;
      }

      footer {
        justify-content: center;
        gap: 18px;
        color: var(--muted);
        font-size: 0.78rem;
      }

      footer a {
        color: inherit;
        text-decoration: none;
      }

      footer a:hover {
        color: var(--foreground);
      }

      .hidden {
        display: none;
      }

      /* Connect / Create segmented tabs — mirrors the provider portal's
         wallet-connection toggle so the two sign-in surfaces feel like one. */
      .mode-tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        padding: 4px;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--muted-surface);
      }

      .mode-tab {
        appearance: none;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: var(--muted);
        font-size: 0.92rem;
        font-weight: 600;
        padding: 9px 12px;
        min-height: auto;
        cursor: pointer;
      }

      .mode-tab.active {
        background: var(--primary);
        color: #fff;
      }

      .mode-tab:not(.active):hover {
        color: var(--foreground);
      }

      .create-panel {
        display: grid;
        gap: 12px;
      }

      /* .create-panel's display:grid would otherwise win over .hidden (same
         specificity, declared later), leaving the Create pane visible on the
         Connect tab. */
      .create-panel.hidden {
        display: none;
      }

      .create-note {
        font-size: 0.84rem;
        color: var(--muted);
        line-height: 1.55;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 12px;
      }

      .create-address {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
        word-break: break-all;
        color: var(--foreground);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 10px 12px;
        background: var(--muted-surface);
      }

      .phrase-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 6px;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 12px;
        background: var(--muted-surface);
      }

      .phrase-grid.blurred .phrase-word-text {
        filter: blur(5px);
      }

      .phrase-word {
        display: flex;
        gap: 6px;
        align-items: baseline;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.8rem;
        color: var(--foreground);
      }

      .phrase-word .phrase-index {
        color: var(--muted);
        font-size: 0.7rem;
        min-width: 16px;
        text-align: right;
      }

      .create-actions {
        display: grid;
        grid-template-columns: 1fr 1fr 1fr;
        gap: 8px;
      }

      .create-actions button {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--foreground);
        font-size: 0.84rem;
        padding: 8px 10px;
        min-height: auto;
      }

      .create-actions button:hover:not(:disabled) {
        background: var(--muted-surface);
      }

      .checkbox-row {
        display: flex;
        gap: 10px;
        align-items: flex-start;
        font-size: 0.84rem;
        color: var(--muted);
        line-height: 1.5;
        cursor: pointer;
      }

      .checkbox-row input {
        width: auto;
        margin-top: 2px;
        accent-color: var(--primary);
      }

      button.primary-wide {
        background: var(--primary);
        border: 1px solid transparent;
        color: #fff;
        font-weight: 600;
        width: 100%;
      }

      button.primary-wide:hover:not(:disabled) {
        background: var(--primary-strong);
      }

      @media (max-width: 560px) {
        .topbar {
          padding: 16px 20px;
        }

        .page {
          padding: 16px;
          place-items: start center;
        }

        main {
          padding: 20px;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header class="topbar">
        <a class="brand" href="https://apiosk.com" rel="noreferrer">
          <span class="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Apiosk">
              <defs>
                <linearGradient id="apiosk-brand-mark" x1="158" y1="120" x2="866" y2="906" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#8b5cf6" />
                  <stop offset="52%" stop-color="#6b38d4" />
                  <stop offset="100%" stop-color="#5516be" />
                </linearGradient>
              </defs>
              <g fill="none" stroke="url(#apiosk-brand-mark)" stroke-width="43" stroke-linecap="butt">
                <line x1="511.5" y1="190.5" x2="511.5" y2="511.5" />
                <line x1="231" y1="335" x2="511.5" y2="511.5" />
                <line x1="792.5" y1="335" x2="511.5" y2="511.5" />
                <line x1="231" y1="675" x2="511.5" y2="511.5" />
                <line x1="792.5" y1="675" x2="511.5" y2="511.5" />
                <line x1="511.5" y1="825.5" x2="511.5" y2="511.5" />
              </g>
              <g fill="url(#apiosk-brand-mark)">
                <circle cx="511.5" cy="190.5" r="80.5" />
                <circle cx="231" cy="335" r="80" />
                <circle cx="792.5" cy="335" r="80" />
                <circle cx="511.5" cy="511.5" r="135" />
                <circle cx="231" cy="675" r="80" />
                <circle cx="792.5" cy="675" r="80" />
                <circle cx="511.5" cy="825.5" r="80.5" />
              </g>
            </svg>
          </span>
          <span>Apiosk</span>
        </a>
      </header>
      <div class="page">
        <div class="layout">
          <section class="hero" aria-hidden="true">
            <div>
              <p class="hero-eyebrow">Apiosk payment infrastructure</p>
              <h2>Pay for any API, straight from your agent</h2>
            </div>
            <p class="lead">Sign in once to let ${escapeHtml(clientName.client_name || "your AI app")} discover and call APIs through Apiosk. Paid calls use your managed Apiosk wallet or credits when configured.</p>
            <div class="value-list">
              <div class="value">
                <span class="value-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6" /><path d="M18.09 10.37A6 6 0 1 1 10.34 18" /><path d="M7 6h1v4" /><path d="m16.71 13.88.7.71-2.82 2.82" /></svg>
                </span>
                <div>
                  <div class="value-title">Pay per call, automatically</div>
                  <div class="value-desc">USDC over x402 on Base. No invoices, no API-key juggling.</div>
                </div>
              </div>
              <div class="value">
                <span class="value-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" /><path d="M16 12h.01" /></svg>
                </span>
                <div>
                  <div class="value-title">One secure connection</div>
                  <div class="value-desc">Your wallet proves identity; managed wallet or credits authorize automatic payments.</div>
                </div>
              </div>
              <div class="value">
                <span class="value-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="7" x="3" y="3" rx="1" /><rect width="7" height="7" x="14" y="3" rx="1" /><rect width="7" height="7" x="14" y="14" rx="1" /><rect width="7" height="7" x="3" y="14" rx="1" /></svg>
                </span>
                <div>
                  <div class="value-title">One catalog, one contract</div>
                  <div class="value-desc">Discover APIs and datasets and call them without leaving your chat.</div>
                </div>
              </div>
            </div>
          </section>
          <main class="stack">
          <header class="stack header">
            <div>
              <p class="eyebrow">${escapeHtml(clientName.client_name || "Remote MCP client")}</p>
              <h1>Connect ${escapeHtml(appName)}</h1>
            </div>
            <p>Connect a wallet to sign in without a password. Automatic paid calls require a funded managed Apiosk wallet or credits on your account.</p>
          </header>
          ${errorMessage ? `<div class="message error">${escapeHtml(errorMessage)}</div>` : ""}
          ${infoMessage ? `<div class="message info">${escapeHtml(infoMessage)}</div>` : ""}
          <section class="panel" aria-label="Wallet sign in">
            ${
              walletEnabled
                ? `<div class="mode-tabs" role="tablist" aria-label="Wallet sign-in mode">
              <button id="mode-connect" class="mode-tab active" type="button" role="tab" aria-selected="true">Connect</button>
              <button id="mode-create" class="mode-tab" type="button" role="tab" aria-selected="false">Create</button>
            </div>`
                : ""
            }
            <div id="connect-panel">
            <div id="wallet-list" class="wallet-list" role="list">
              ${
                walletEnabled
                  ? `<button class="wallet-option" type="button" disabled>
                <span class="wallet-name">
                  <img class="wallet-icon" src="${METAMASK_ICON}" alt="" />
                  <span class="wallet-name-text">Detecting wallets&hellip;</span>
                </span>
                <span class="wallet-action">Please wait</span>
              </button>`
                  : `<button class="wallet-option" type="button" disabled>
                <span class="wallet-name">
                  <span class="wallet-name-text">Wallet sign-in unavailable</span>
                </span>
                <span class="wallet-action">Unavailable</span>
              </button>`
              }
            </div>
            ${
              walletEnabled && walletConnectProjectId
                ? `<div class="divider">or</div>
            <button id="walletconnect-button" class="wallet-option wallet-connect-option" type="button">
              <span class="wallet-name">
                <img class="wallet-icon" src="${WALLETCONNECT_ICON}" alt="" />
                <span class="wallet-name-text">WalletConnect</span>
              </span>
              <span class="wallet-action">Mobile / QR</span>
            </button>`
                : ""
            }
            </div>
            ${
              walletEnabled
                ? `<div id="create-panel" class="create-panel hidden">
              <p class="create-note">Generate a new self-custody sign-in wallet in your browser. The recovery phrase never leaves this tab and Apiosk only sees the public address. This wallet proves your identity; automatic MCP payments require a managed Apiosk wallet or credits.</p>
              <div id="create-start">
                <button id="create-generate" class="primary-wide" type="button">Generate new wallet</button>
              </div>
              <div id="create-result" class="create-panel hidden">
                <div id="create-address" class="create-address"></div>
                <div id="phrase-grid" class="phrase-grid blurred" aria-label="Recovery phrase"></div>
                <div class="create-actions">
                  <button id="phrase-reveal" type="button">Reveal</button>
                  <button id="phrase-copy" type="button">Copy phrase</button>
                  <button id="phrase-download" type="button">Download backup</button>
                </div>
                <label class="checkbox-row">
                  <input id="phrase-saved" type="checkbox" />
                  <span>I&rsquo;ve securely saved my recovery phrase. I understand it&rsquo;s the only way to recover this wallet and Apiosk cannot restore it for me.</span>
                </label>
                <button id="create-sign-in" class="primary-wide" type="button" disabled>Sign in with this wallet</button>
              </div>
            </div>`
                : ""
            }
            <p id="wallet-status" class="meta">${walletEnabled ? "Connect MetaMask, Coinbase Wallet, or any browser wallet to sign in." : "Wallet sign-in is not configured on this MCP server."}</p>
          </section>
          <form method="post" action="${escapeHtml(actionPath)}" class="cancel-row">
            ${hiddenInputs}
            <button class="cancel-link" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
          </form>
          <form id="wallet-form" method="post" action="${escapeHtml(actionPath)}" class="hidden">
            ${hiddenInputs}
            <input type="hidden" name="action" value="wallet_sign_in" />
            <input type="hidden" name="wallet_address" />
            <input type="hidden" name="wallet_message" />
            <input type="hidden" name="wallet_message_encoding" value="base64url" />
            <input type="hidden" name="wallet_signature" />
            <input type="hidden" name="wallet_method" value="connected_wallet" />
          </form>
          <div class="grant">
            Requested scope: <code>${escapeHtml(scope || DEFAULT_SCOPE)}</code><br />
            Resource: <code>${escapeHtml(resource || "default")}</code>
          </div>
          </main>
        </div>
      </div>
      <footer>
        <span>© Apiosk</span>
        <a href="https://apiosk.com/terms" target="_blank" rel="noreferrer">Terms</a>
        <a href="https://apiosk.com/privacy" target="_blank" rel="noreferrer">Privacy</a>
      </footer>
    </div>
    <script>
      (() => {
        const walletEnabled = ${walletEnabled ? "true" : "false"};
        if (!walletEnabled) return;

        const noncePath = ${jsStringLiteral(walletNoncePath)};
        const walletConnectProjectId = ${jsStringLiteral(walletConnectProjectId)};
        const BRAND_ICONS = {
          metamask: ${jsStringLiteral(METAMASK_ICON)},
          coinbase: ${jsStringLiteral(COINBASE_ICON)},
          generic: ${jsStringLiteral(GENERIC_WALLET_ICON)},
        };

        // First-class injected wallets, always offered so users recognise them
        // even before detection; when none is installed we link to install.
        const KNOWN = [
          { rdns: "io.metamask", name: "MetaMask", flag: "isMetaMask", icon: BRAND_ICONS.metamask, install: "https://metamask.io/download/" },
          { rdns: "com.coinbase.wallet", name: "Coinbase Wallet", flag: "isCoinbaseWallet", icon: BRAND_ICONS.coinbase, install: "https://www.coinbase.com/wallet/downloads" },
        ];

        const walletForm = document.getElementById("wallet-form");
        const walletList = document.getElementById("wallet-list");
        const walletStatus = document.getElementById("wallet-status");
        const walletConnectButton = document.getElementById("walletconnect-button");
        const detected = new Map();
        let busy = false;

        function setStatus(message, tone) {
          walletStatus.textContent = message;
          walletStatus.style.color =
            tone === "error" ? "var(--danger)" : tone === "success" ? "var(--success)" : "var(--muted)";
        }

        function setBusy(next) {
          busy = next;
          if (walletConnectButton) walletConnectButton.disabled = next;
          for (const el of walletList.querySelectorAll("button")) el.disabled = next;
          const createGenerateButton = document.getElementById("create-generate");
          if (createGenerateButton) createGenerateButton.disabled = next;
          const createSignInButton = document.getElementById("create-sign-in");
          if (createSignInButton) {
            const saved = document.getElementById("phrase-saved");
            createSignInButton.disabled = next || !saved || !saved.checked;
          }
        }

        function hexEncode(value) {
          return "0x" + Array.from(new TextEncoder().encode(value))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        }

        // Base64url keeps the exact signed bytes intact across the form POST; a
        // plain text control would rewrite line breaks and change the EIP-191
        // digest, so server-side signature recovery would fail.
        function base64UrlEncode(value) {
          const bytes = new TextEncoder().encode(value);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
        }

        // Resolve a live provider for a known wallet: EIP-6963 announcement
        // first, then a legacy window.ethereum.providers[] entry carrying the
        // wallet flag, then a lone window.ethereum whose flag is set.
        function resolveKnown(wallet) {
          const announced = detected.get(wallet.rdns);
          if (announced) return announced.provider;
          const eth = window.ethereum;
          if (!eth) return null;
          if (Array.isArray(eth.providers)) {
            const match = eth.providers.find((p) => p && p[wallet.flag]);
            if (match) return match;
          }
          return eth[wallet.flag] ? eth : null;
        }

        function connectButton(icon, name, detail) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "wallet-option";
          button.disabled = busy;
          const nameWrap = document.createElement("span");
          nameWrap.className = "wallet-name";
          const iconImg = document.createElement("img");
          iconImg.className = "wallet-icon";
          iconImg.alt = "";
          iconImg.src = icon || BRAND_ICONS.generic;
          const nameText = document.createElement("span");
          nameText.className = "wallet-name-text";
          nameText.textContent = name;
          nameWrap.append(iconImg, nameText);
          const actionEl = document.createElement("span");
          actionEl.className = "wallet-action";
          actionEl.textContent = "Connect";
          button.append(nameWrap, actionEl);
          button.addEventListener("click", () => signWithProvider(detail));
          return button;
        }

        function installLink(wallet) {
          const link = document.createElement("a");
          link.className = "wallet-option install";
          link.href = wallet.install;
          link.target = "_blank";
          link.rel = "noreferrer";
          const nameWrap = document.createElement("span");
          nameWrap.className = "wallet-name";
          const iconImg = document.createElement("img");
          iconImg.className = "wallet-icon";
          iconImg.alt = "";
          iconImg.src = wallet.icon;
          const nameText = document.createElement("span");
          nameText.className = "wallet-name-text";
          nameText.textContent = wallet.name;
          nameWrap.append(iconImg, nameText);
          const actionEl = document.createElement("span");
          actionEl.className = "wallet-action";
          actionEl.textContent = "Install";
          link.append(nameWrap, actionEl);
          return link;
        }

        function render() {
          walletList.innerHTML = "";
          const shown = new Set();
          const hasNonLegacy = [...detected.keys()].some((k) => k !== "legacy.injected");

          for (const wallet of KNOWN) {
            shown.add(wallet.rdns);
            const announced = detected.get(wallet.rdns);
            const provider = announced ? announced.provider : resolveKnown(wallet);
            const icon = (announced && announced.info && announced.info.icon) || wallet.icon;
            if (provider) {
              walletList.appendChild(connectButton(icon, wallet.name, { provider, info: { name: wallet.name } }));
            } else {
              walletList.appendChild(installLink(wallet));
            }
          }

          // Any other injected wallet the browser announced (Rabby, Frame, ...).
          for (const [rdns, detail] of detected) {
            if (shown.has(rdns)) continue;
            if (rdns === "legacy.injected" && hasNonLegacy) continue;
            const icon = (detail.info && detail.info.icon) || BRAND_ICONS.generic;
            const name = (detail.info && detail.info.name) || "Browser wallet";
            walletList.appendChild(connectButton(icon, name, detail));
          }
        }

        async function requestAccounts(provider) {
          try {
            await provider.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
          } catch (error) {
            if (error && error.code === 4001) throw error;
          }
          const accounts = await provider.request({ method: "eth_requestAccounts" });
          if (!Array.isArray(accounts) || !accounts.length) {
            throw new Error("No wallet account was returned.");
          }
          return String(accounts[0]);
        }

        async function fetchNonce() {
          const response = await fetch(noncePath, {
            method: "POST",
            headers: { accept: "application/json" },
            credentials: "same-origin",
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || !body.nonce) {
            throw new Error(body.message || body.error || "Could not start wallet sign-in.");
          }
          return body.nonce;
        }

        async function connectWalletConnect() {
          const mod = await import("https://esm.sh/@walletconnect/ethereum-provider@2.23.9?bundle");
          const EthereumProvider = mod.EthereumProvider || (mod.default && mod.default.EthereumProvider) || mod.default;
          const origin = window.location.origin;
          const provider = await EthereumProvider.init({
            projectId: walletConnectProjectId,
            chains: [8453],
            optionalChains: [8453],
            showQrModal: true,
            metadata: {
              name: "Apiosk",
              description: "Apiosk MCP sign-in",
              url: origin,
              // Absolute, always-hosted mark for the WalletConnect pairing UI
              // (the MCP server serves no static assets). A PNG raster renders
              // more reliably across wallets than the gradient SVG.
              icons: ["https://apiosk.com/web-app-manifest-512x512.png"],
            },
          });
          await provider.enable();
          return { provider, info: { name: "WalletConnect" } };
        }

        async function signWithProvider(detail) {
          if (busy || !detail || !detail.provider) return;
          setBusy(true);
          setStatus("Opening wallet...");
          try {
            const provider = detail.provider;
            const address = await requestAccounts(provider);
            const nonce = await fetchNonce();
            const message = [
              "Apiosk Provider wallet sign-in",
              "wallet: " + address.toLowerCase(),
              "origin: " + window.location.origin,
              "nonce: " + nonce,
              "issued_at: " + new Date().toISOString(),
            ].join("\\n");
            setStatus("Confirm the signature in your wallet...");
            const signature = await provider.request({
              method: "personal_sign",
              params: [hexEncode(message), address],
            });

            walletForm.elements.wallet_address.value = address;
            walletForm.elements.wallet_message.value = base64UrlEncode(message);
            walletForm.elements.wallet_signature.value = signature;
            walletForm.elements.wallet_method.value = "connected_wallet";
            setStatus("Wallet verified. Continuing...", "success");
            walletForm.submit();
          } catch (error) {
            const rejected = error && error.code === 4001;
            setStatus(
              rejected
                ? "Signature request was rejected in the wallet."
                : error instanceof Error ? error.message : "Wallet sign-in failed.",
              "error"
            );
            setBusy(false);
          }
        }

        window.addEventListener("eip6963:announceProvider", (event) => {
          const detail = event.detail;
          if (!detail || !detail.info || !detail.info.rdns || !detail.provider) return;
          detected.set(detail.info.rdns, detail);
          render();
        });
        window.dispatchEvent(new Event("eip6963:requestProvider"));

        // Legacy fallback for a lone window.ethereum with no EIP-6963 support.
        window.setTimeout(() => {
          if (!detected.size && window.ethereum) {
            detected.set("legacy.injected", {
              info: { name: "Browser wallet", rdns: "legacy.injected", icon: "" },
              provider: window.ethereum,
            });
          }
          render();
        }, 300);
        render();

        if (walletConnectButton) {
          walletConnectButton.addEventListener("click", async () => {
            if (busy) return;
            setBusy(true);
            setStatus("Opening WalletConnect...");
            try {
              const detail = await connectWalletConnect();
              setBusy(false);
              await signWithProvider(detail);
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "WalletConnect sign-in failed.", "error");
              setBusy(false);
            }
          });
        }

        // ── Create-wallet mode ─────────────────────────────────────────────
        // Mirrors the provider portal's Connect | Create toggle: a fresh
        // self-custody wallet is generated in this tab with viem (same library
        // and derivation the portal uses); the phrase/key never leave the
        // browser — the server only ever receives the address + signature.
        const modeConnect = document.getElementById("mode-connect");
        const modeCreate = document.getElementById("mode-create");
        const connectPanel = document.getElementById("connect-panel");
        const createPanel = document.getElementById("create-panel");
        const createStart = document.getElementById("create-start");
        const createResult = document.getElementById("create-result");
        const createGenerate = document.getElementById("create-generate");
        const createAddress = document.getElementById("create-address");
        const phraseGrid = document.getElementById("phrase-grid");
        const phraseReveal = document.getElementById("phrase-reveal");
        const phraseCopy = document.getElementById("phrase-copy");
        const phraseDownload = document.getElementById("phrase-download");
        const phraseSaved = document.getElementById("phrase-saved");
        const createSignIn = document.getElementById("create-sign-in");
        let generatedWallet = null;

        function setMode(mode) {
          if (!modeConnect || !modeCreate) return;
          const isCreate = mode === "create";
          modeConnect.classList.toggle("active", !isCreate);
          modeCreate.classList.toggle("active", isCreate);
          modeConnect.setAttribute("aria-selected", String(!isCreate));
          modeCreate.setAttribute("aria-selected", String(isCreate));
          connectPanel.classList.toggle("hidden", isCreate);
          createPanel.classList.toggle("hidden", !isCreate);
          setStatus(
            isCreate
              ? "Create a brand-new wallet and sign in with it — no extension needed."
              : "Connect MetaMask, Coinbase Wallet, or any browser wallet to sign in."
          );
        }

        function refreshCreateSignIn() {
          if (createSignIn) {
            createSignIn.disabled = busy || !generatedWallet || !phraseSaved.checked;
          }
        }

        function renderGeneratedWallet() {
          createAddress.textContent = generatedWallet.address;
          phraseGrid.innerHTML = "";
          generatedWallet.mnemonic.split(" ").forEach((word, index) => {
            const cell = document.createElement("span");
            cell.className = "phrase-word";
            const num = document.createElement("span");
            num.className = "phrase-index";
            num.textContent = String(index + 1) + ".";
            const text = document.createElement("span");
            text.className = "phrase-word-text";
            text.textContent = word;
            cell.append(num, text);
            phraseGrid.appendChild(cell);
          });
          createStart.classList.add("hidden");
          createResult.classList.remove("hidden");
        }

        if (modeConnect && modeCreate) {
          modeConnect.addEventListener("click", () => setMode("connect"));
          modeCreate.addEventListener("click", () => setMode("create"));
        }

        if (createGenerate) {
          createGenerate.addEventListener("click", async () => {
            if (busy) return;
            setBusy(true);
            setStatus("Generating a new wallet in your browser...");
            try {
              // Same-origin bundle (see server.mjs /assets/wallet-accounts.mjs)
              // — embedded browsers can block cross-origin dynamic imports, so
              // the wallet library must never come from a CDN.
              const accounts = await import("/assets/wallet-accounts.mjs");
              const mnemonic = accounts.generateMnemonic(accounts.english);
              const account = accounts.mnemonicToAccount(mnemonic);
              generatedWallet = { account, mnemonic, address: account.address };
              renderGeneratedWallet();
              setStatus("Wallet created. Save the recovery phrase before signing in.", "success");
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "Could not generate a wallet.", "error");
            } finally {
              setBusy(false);
              refreshCreateSignIn();
            }
          });
        }

        if (phraseReveal) {
          phraseReveal.addEventListener("click", () => {
            const blurred = phraseGrid.classList.toggle("blurred");
            phraseReveal.textContent = blurred ? "Reveal" : "Hide";
          });
        }

        if (phraseCopy) {
          phraseCopy.addEventListener("click", async () => {
            if (!generatedWallet) return;
            try {
              await navigator.clipboard.writeText(generatedWallet.mnemonic);
              setStatus("Recovery phrase copied. Store it somewhere safe.", "success");
            } catch {
              setStatus("Could not copy — reveal the phrase and copy it manually.", "error");
            }
          });
        }

        if (phraseDownload) {
          phraseDownload.addEventListener("click", () => {
            if (!generatedWallet) return;
            const backup = [
              "Apiosk wallet backup",
              "",
              "Address: " + generatedWallet.address,
              "Recovery phrase: " + generatedWallet.mnemonic,
              "Derivation path: m/44'/60'/0'/0/0 (standard Ethereum)",
              "",
              "Keep this file offline and private. Anyone with the phrase controls the wallet.",
            ].join("\\n");
            const blob = new Blob([backup], { type: "text/plain" });
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = "apiosk-wallet-" + generatedWallet.address.slice(2, 8) + ".txt";
            document.body.appendChild(link);
            link.click();
            link.remove();
            URL.revokeObjectURL(url);
          });
        }

        if (phraseSaved) {
          phraseSaved.addEventListener("change", refreshCreateSignIn);
        }

        if (createSignIn) {
          createSignIn.addEventListener("click", async () => {
            if (busy || !generatedWallet || !phraseSaved.checked) return;
            setBusy(true);
            setStatus("Signing you in with the new wallet...");
            try {
              const address = generatedWallet.address;
              const nonce = await fetchNonce();
              const message = [
                "Apiosk Provider wallet sign-in",
                "wallet: " + address.toLowerCase(),
                "origin: " + window.location.origin,
                "nonce: " + nonce,
                "issued_at: " + new Date().toISOString(),
              ].join("\\n");
              const signature = await generatedWallet.account.signMessage({ message });

              walletForm.elements.wallet_address.value = address;
              walletForm.elements.wallet_message.value = base64UrlEncode(message);
              walletForm.elements.wallet_signature.value = signature;
              walletForm.elements.wallet_method.value = "created_wallet";
              setStatus("Wallet verified. Continuing...", "success");
              walletForm.submit();
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "Wallet sign-in failed.", "error");
              setBusy(false);
              refreshCreateSignIn();
            }
          });
        }
      })();
    </script>
  </body>
</html>`;
}

function resolveMcpWalletAuthConfig(env = process.env) {
  const supabaseUrl = normalizeBaseUrl(
    env.APIOSK_SUPABASE_URL || env.SUPABASE_URL,
    DEFAULT_SUPABASE_URL
  );
  const key =
    trimString(env.APIOSK_SUPABASE_SERVICE_ROLE_KEY) ||
    trimString(env.SUPABASE_SERVICE_ROLE_KEY) ||
    trimString(env.SUPABASE_SERVICE_KEY) ||
    trimString(env.APIOSK_SUPABASE_PUBLISHABLE_KEY) ||
    trimString(env.APIOSK_SUPABASE_ANON_KEY) ||
    trimString(env.SUPABASE_PUBLISHABLE_KEY) ||
    trimString(env.SUPABASE_ANON_KEY);
  const walletAuthUrl = normalizeBaseUrl(
    env.APIOSK_WALLET_AUTH_URL || env.APIOSK_WALLET_AUTH_BASE_URL,
    `${supabaseUrl}/functions/v1/wallet-auth`
  );

  return {
    configured: Boolean(supabaseUrl && key && walletAuthUrl),
    key,
    supabaseUrl,
    walletAuthUrl,
  };
}

export function isMcpWalletAuthConfigured(env = process.env) {
  return resolveMcpWalletAuthConfig(env).configured;
}

function resolveWalletConnectProjectId(env = process.env) {
  return (
    trimString(env.APIOSK_MCP_WALLETCONNECT_PROJECT_ID) ||
    trimString(env.WALLETCONNECT_PROJECT_ID)
  );
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

async function fetchWalletAuthJson(env, path, payload = {}) {
  const config = resolveMcpWalletAuthConfig(env);
  if (!config.configured) {
    throw statusError("Wallet sign-in is not configured on this MCP server.", 503);
  }

  const response = await fetchJsonWithBody(`${config.walletAuthUrl}/${path}`, {
    method: "POST",
    headers: {
      accept: "application/json",
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    throw statusError(
      responseMessage(response.body, "Wallet sign-in is temporarily unavailable."),
      response.status
    );
  }

  return response.body && typeof response.body === "object" ? response.body : {};
}

export async function createMcpWalletAuthNonce({ env = process.env } = {}) {
  const body = await fetchWalletAuthJson(env, "nonce");
  const nonce = trimString(body.nonce);
  if (!nonce) {
    throw statusError("Wallet sign-in did not return a nonce.", 502);
  }
  return body;
}

async function verifySupabaseTokenHash(env, tokenHash) {
  const config = resolveMcpWalletAuthConfig(env);
  if (!config.configured) {
    throw statusError("Wallet sign-in is not configured on this MCP server.", 503);
  }

  const response = await fetchJsonWithBody(`${config.supabaseUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      accept: "application/json",
      apikey: config.key,
      authorization: `Bearer ${config.key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      token_hash: tokenHash,
      type: "magiclink",
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    throw statusError(
      responseMessage(response.body, "Could not establish an Apiosk dashboard session."),
      response.status
    );
  }

  const body = response.body && typeof response.body === "object" ? response.body : {};
  const session = body.session && typeof body.session === "object" ? body.session : body;
  const user = body.user && typeof body.user === "object" ? body.user : session.user || {};
  const sessionToken = trimString(session.access_token);
  if (!sessionToken) {
    throw statusError("Wallet sign-in did not return a dashboard session.", 502);
  }

  const expiresAt =
    Number(session.expires_at) ||
    (Number.isFinite(Number(session.expires_in))
      ? getIssuedAtSeconds() + Number(session.expires_in)
      : null);

  return {
    session_token: sessionToken,
    expires_at: expiresAt,
    user_id: trimString(user.id),
    email: trimString(user.email),
  };
}

async function verifyWalletDashboardSession(env, { address, message, signature, method }) {
  const normalizedAddress = trimString(address);
  if (!EVM_ADDRESS_PATTERN.test(normalizedAddress)) {
    throw statusError("Invalid wallet address.", 400);
  }
  if (!trimString(message) || !trimString(signature)) {
    throw statusError("Missing wallet message or signature.", 400);
  }

  const walletAuth = await fetchWalletAuthJson(env, "verify", {
    address: normalizedAddress,
    message,
    signature,
    method: method === "created_wallet" ? "created_wallet" : "connected_wallet",
  });
  const tokenHash = trimString(walletAuth.tokenHash || walletAuth.token_hash);
  if (!tokenHash) {
    throw statusError("Wallet sign-in did not return a session token.", 502);
  }

  const session = await verifySupabaseTokenHash(env, tokenHash);
  return {
    ...session,
    email: session.email || trimString(walletAuth.email),
    wallet_address: normalizedAddress.toLowerCase(),
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
  constructor({
    env,
    secret,
    issuerUrl,
    mcpServerUrl,
    appName,
    resourceName,
    connectTokenMinter,
  }) {
    this.env = env;
    this.secret = secret;
    this.issuerUrl = issuerUrl;
    this.mcpServerUrl = mcpServerUrl;
    this.appName = appName;
    this.resourceName = resourceName;
    // Injectable so tests can bypass the Supabase round-trip; defaults to the
    // real hosted-payment minter.
    this.connectTokenMinter = connectTokenMinter || mintHostedConnectToken;
    this.clientsStore = new ApioskOAuthClientsStore(secret);
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

  async authorize(client, params, res) {
    const req = res.req;
    const submittedAction = trimString(req?.body?.action);
    const renderPage = (status, options = {}) =>
      res
        .status(status)
        .setHeader("content-type", "text/html; charset=utf-8")
        .send(
          createAuthorizePage({
            actionPath: new URL("/authorize", this.issuerUrl).pathname,
            appName: this.appName,
            clientName: client,
            oauthParams: params,
            walletEnabled: isMcpWalletAuthConfigured(this.env),
            walletConnectProjectId: resolveWalletConnectProjectId(this.env),
            ...options,
          })
        );

    if (!req || req.method !== "POST" || !submittedAction) {
      renderPage(200);
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

    if (submittedAction === "wallet_sign_in") {
      try {
        // The wallet signs a multi-line message joined with "\n", but an
        // application/x-www-form-urlencoded POST normalizes every "\n" in a
        // control's value to "\r\n" (HTML form-submission spec). Those extra
        // bytes change the EIP-191 digest, so server-side signature recovery
        // returns a different address and the wallet-auth function rejects it
        // with "Signature does not match the wallet." To keep the signed bytes
        // intact across the POST, the client base64url-encodes the message and
        // we decode it here before verification.
        const message =
          trimString(req.body.wallet_message_encoding).toLowerCase() === "base64url"
            ? fromBase64Url(trimString(req.body.wallet_message))
            : req.body.wallet_message;
        const session = await verifyWalletDashboardSession(this.env, {
          address: req.body.wallet_address,
          message,
          signature: req.body.wallet_signature,
          method: req.body.wallet_method,
        });
        await this.finishAuthorization(res, client, params, session);
      } catch (error) {
        renderPage(error.status && error.status >= 400 ? error.status : 400, {
          errorMessage:
            error instanceof Error
              ? error.message
              : "Could not sign in with this wallet. Try again.",
        });
      }
      return;
    }

    renderPage(400, {
      errorMessage: "Sign in with a wallet to continue.",
    });
  }

  async finishAuthorization(res, client, params, session) {
    const sessionToken = trimString(session.session_token);
    const normalizedSessionExpiry = normalizeSessionExpiry(session.expires_at);

    // Bridge the wallet sign-in into a payable connect token: mint one for the
    // user's managed wallet so the gateway can settle paid calls autonomously
    // (a browser wallet cannot be settled from server-side). Best-effort — if
    // the user has no managed wallet, or minting fails, sign-in still completes
    // and paid calls fall back to the same 402 as before.
    const mintedConnect = sessionToken
      ? await this.connectTokenMinter({
          env: this.env,
          sessionToken,
          userId: trimString(session.user_id),
        })
      : null;
    const apioskConnectToken = trimString(mintedConnect?.connectToken) || undefined;
    const apioskConnectWalletAddress =
      trimString(mintedConnect?.walletAddress) || undefined;

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
        userId: trimString(session.user_id),
        email: trimString(session.email),
        walletAddress: trimString(session.wallet_address) || undefined,
        apioskConnectToken,
        apioskConnectWalletAddress,
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
      walletAddress: payload.walletAddress,
      apioskConnectToken: payload.apioskConnectToken,
      apioskConnectWalletAddress: payload.apioskConnectWalletAddress,
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
        walletAddress: payload.walletAddress,
        apioskConnectToken: payload.apioskConnectToken,
        apioskConnectWalletAddress: payload.apioskConnectWalletAddress,
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
        dashboardSessionToken: payload.dashboardSessionToken,
        dashboard_session_token: payload.dashboardSessionToken,
        dashboardSessionExpiresAt: payload.dashboardSessionExpiresAt,
        userId: payload.userId,
        email: payload.email,
        walletAddress: payload.walletAddress,
        // Managed-wallet connect token minted at sign-in. The runtime threads
        // this to the gateway as X-Apiosk-Connect-Token so paid calls settle
        // autonomously from the buyer's managed wallet (runtime getClient reads
        // extra.apiosk_connect_token).
        apiosk_connect_token: payload.apioskConnectToken,
        apiosk_connect_wallet_address: payload.apioskConnectWalletAddress,
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
  connectTokenMinter,
} = {}) {
  const secret = resolveOAuthSecret(env);
  const provider = new ApioskHostedOAuthProvider({
    env,
    secret,
    issuerUrl,
    mcpServerUrl,
    appName,
    resourceName,
    connectTokenMinter,
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
