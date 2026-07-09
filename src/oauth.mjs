import crypto from "node:crypto";

import express from "express";

import { OAuthClientMetadataSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { authorizationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import { tokenHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/token.js";
import { clientRegistrationHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/register.js";
import { metadataHandler } from "@modelcontextprotocol/sdk/server/auth/handlers/metadata.js";

import { isProviderApiKey, verifyProviderKey } from "./publisher.mjs";

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
        --shadow: 0 12px 28px rgba(26, 35, 53, 0.12), 0 4px 8px rgba(26, 35, 53, 0.05);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: var(--background);
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
        padding: 24px;
      }

      main {
        width: min(100%, 440px);
        border: 1px solid var(--border);
        background: var(--card);
        border-radius: 8px;
        padding: 22px;
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
        background: var(--card);
        border: 1px solid var(--border);
        color: var(--foreground);
        text-align: left;
      }

      .wallet-option:hover:not(:disabled) {
        border-color: color-mix(in srgb, var(--primary) 40%, var(--border));
        background: var(--primary-soft);
      }

      .wallet-name {
        min-width: 0;
        display: inline-flex;
        align-items: center;
        gap: 8px;
      }

      .wallet-icon {
        width: 18px;
        height: 18px;
        border-radius: 4px;
        flex: 0 0 auto;
        object-fit: contain;
      }

      .wallet-name-text {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .wallet-action {
        flex: 0 0 auto;
        color: var(--muted);
        font-size: 0.78rem;
      }

      .actions {
        display: grid;
        gap: 8px;
      }

      .meta {
        font-size: 0.84rem;
        color: var(--muted);
        padding-top: 2px;
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
        <main class="stack">
          <header class="stack header">
            <div>
              <p class="eyebrow">${escapeHtml(clientName.client_name || "Remote MCP client")}</p>
              <h1>Connect ${escapeHtml(appName)}</h1>
            </div>
            <p>Sign in with your Apiosk account to unlock paid gateway calls, managed wallets, and credit-backed execution from this MCP app.</p>
          </header>
          ${errorMessage ? `<div class="message error">${escapeHtml(errorMessage)}</div>` : ""}
          ${infoMessage ? `<div class="message info">${escapeHtml(infoMessage)}</div>` : ""}
          <section class="panel" aria-label="Wallet sign in">
            <div id="wallet-list" class="wallet-list">
              <button id="wallet-fallback" class="wallet-option" type="button" ${walletEnabled ? "" : "disabled"}>
                <span class="wallet-name">Connect browser wallet</span>
                <span class="wallet-action">${walletEnabled ? "Sign" : "Unavailable"}</span>
              </button>
              ${
                walletEnabled && walletConnectProjectId
                  ? `<button id="walletconnect-button" class="wallet-option" type="button">
                <span class="wallet-name">WalletConnect (mobile / QR)</span>
                <span class="wallet-action">Sign</span>
              </button>`
                  : ""
              }
            </div>
            <p id="wallet-status" class="meta">${walletEnabled ? "Use MetaMask, Coinbase Wallet, Rabby, or another injected wallet." : "Wallet sign-in is not configured on this MCP server."}</p>
          </section>
          <form method="post" action="${escapeHtml(actionPath)}" class="actions">
            ${hiddenInputs}
            <button class="secondary" type="submit" name="action" value="cancel" formnovalidate>Cancel</button>
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
          <div class="meta">
            Requested scope: <code>${escapeHtml(scope || DEFAULT_SCOPE)}</code><br />
            Resource: <code>${escapeHtml(resource || "default")}</code>
          </div>
        </main>
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
        const noncePath = ${jsStringLiteral(walletNoncePath)};
        const walletConnectProjectId = ${jsStringLiteral(walletConnectProjectId)};
        const walletForm = document.getElementById("wallet-form");
        const walletList = document.getElementById("wallet-list");
        const walletStatus = document.getElementById("wallet-status");
        const walletConnectButton = document.getElementById("walletconnect-button");
        const providers = new Map();
        let busy = false;

        function setStatus(message, tone = "muted") {
          walletStatus.textContent = message;
          walletStatus.style.color = tone === "error" ? "var(--danger)" : tone === "success" ? "var(--success)" : "var(--muted)";
        }

        function hexEncode(value) {
          return "0x" + Array.from(new TextEncoder().encode(value))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
        }

        // Base64url so the exact signed bytes survive the form POST. A plain
        // text field would have its "\n" line breaks rewritten to "\r\n" on
        // submit, changing the digest and breaking signature recovery.
        function base64UrlEncode(value) {
          const bytes = new TextEncoder().encode(value);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
          }
          return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
        }

        function providerLabel(detail) {
          return detail?.info?.name || "Browser wallet";
        }

        function rememberProvider(detail) {
          if (!detail?.provider) return;
          const key = detail?.info?.rdns || detail?.info?.uuid || providerLabel(detail);
          providers.set(key, detail);
          renderProviders();
        }

        function renderProviders() {
          if (!walletEnabled) return;
          walletList.innerHTML = "";
          const entries = [...providers.entries()];
          if (!entries.length) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "wallet-option";
            button.innerHTML = '<span class="wallet-name">Connect browser wallet</span><span class="wallet-action">Sign</span>';
            button.addEventListener("click", () => {
              const provider = window.ethereum;
              if (!provider) {
                setStatus("No browser wallet found. Install MetaMask, Coinbase Wallet, or Rabby and refresh.", "error");
                return;
              }
              signWithProvider({ provider, info: { name: "Browser wallet" } });
            });
            walletList.appendChild(button);
            return;
          }

          for (const [, detail] of entries) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "wallet-option";
            button.disabled = busy;
            const icon = detail?.info?.icon;
            button.innerHTML =
              '<span class="wallet-name">' +
              (icon ? '<img class="wallet-icon" alt="" />' : "") +
              '<span class="wallet-name-text"></span></span><span class="wallet-action">Sign</span>';
            if (icon) {
              button.querySelector(".wallet-icon").src = icon;
            }
            button.querySelector(".wallet-name-text").textContent = providerLabel(detail);
            button.addEventListener("click", () => signWithProvider(detail));
            walletList.appendChild(button);
          }
        }

        async function requestAccounts(provider) {
          try {
            await provider.request({
              method: "wallet_requestPermissions",
              params: [{ eth_accounts: {} }],
            });
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
          const mod = await import("https://esm.sh/@walletconnect/ethereum-provider@2?bundle");
          const EthereumProvider = mod.EthereumProvider || mod.default?.EthereumProvider || mod.default;
          const provider = await EthereumProvider.init({
            projectId: walletConnectProjectId,
            chains: [8453],
            optionalChains: [8453],
            showQrModal: true,
            metadata: {
              name: "Apiosk",
              description: "Apiosk MCP sign-in",
              url: window.location.origin,
              icons: [],
            },
          });
          await provider.enable();
          return { provider, info: { name: "WalletConnect" } };
        }

        async function signWithProvider(detail) {
          if (!walletEnabled || busy) return;
          busy = true;
          if (walletConnectButton) walletConnectButton.disabled = true;
          renderProviders();
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
            setStatus("Wallet verified. Continuing...", "success");
            walletForm.submit();
          } catch (error) {
            setStatus(error instanceof Error ? error.message : "Wallet sign-in failed.", "error");
            busy = false;
            if (walletConnectButton) walletConnectButton.disabled = false;
            renderProviders();
          }
        }

        if (!walletEnabled) return;
        window.addEventListener("eip6963:announceProvider", (event) => rememberProvider(event.detail));
        window.dispatchEvent(new Event("eip6963:requestProvider"));
        window.setTimeout(() => {
          if (!providers.size && window.ethereum) {
            rememberProvider({ provider: window.ethereum, info: { name: "Browser wallet", rdns: "legacy.injected" } });
          }
          renderProviders();
        }, 250);
        renderProviders();

        if (walletConnectButton) {
          walletConnectButton.addEventListener("click", async () => {
            if (busy) return;
            busy = true;
            walletConnectButton.disabled = true;
            renderProviders();
            setStatus("Opening WalletConnect...");
            try {
              const detail = await connectWalletConnect();
              busy = false;
              await signWithProvider(detail);
            } catch (error) {
              setStatus(error instanceof Error ? error.message : "WalletConnect sign-in failed.", "error");
              busy = false;
              walletConnectButton.disabled = false;
              renderProviders();
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
  constructor({ env, secret, issuerUrl, mcpServerUrl, appName, resourceName }) {
    this.env = env;
    this.secret = secret;
    this.issuerUrl = issuerUrl;
    this.mcpServerUrl = mcpServerUrl;
    this.appName = appName;
    this.resourceName = resourceName;
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
        this.finishAuthorization(res, client, params, session);
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

  finishAuthorization(res, client, params, session) {
    const sessionToken = trimString(session.session_token);
    const normalizedSessionExpiry = normalizeSessionExpiry(session.expires_at);
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
} = {}) {
  const secret = resolveOAuthSecret(env);
  const provider = new ApioskHostedOAuthProvider({
    env,
    secret,
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
