// Hosted-payment bridge: turn a wallet sign-in (dashboard session) into a
// payable connect token.
//
// A hosted MCP buyer (ChatGPT, Claude, ...) signs in on the /authorize page by
// signing a message with their browser wallet. That proves identity and yields
// an Apiosk dashboard (Supabase) session, but the gateway cannot settle a paid
// call from a browser wallet: it never holds that key. The only autonomous
// buyer rail the gateway can settle is a managed (custodial) agent wallet
// authorized by an `aw_live_…` connect token (see gateway proxy/wallet.rs).
//
// So after sign-in we resolve the user's first payable managed wallet and mint
// a connect token for it. That token is carried on the OAuth access token
// (extra.apiosk_connect_token) and the runtime threads it to the gateway as
// X-Apiosk-Connect-Token, which settles the call from the managed wallet.
//
// The insert path mirrors the buyer portal's createConnection exactly
// (buyer/src/lib/data/connections.ts + agent-wallet.ts) so the token format is
// byte-identical and RLS applies as the signed-in user (we call PostgREST with
// the user's own JWT, never the service role, as the Authorization bearer).

import crypto from "node:crypto";

const DEFAULT_SUPABASE_URL = "https://jgjoiyqdyypouskftzeq.supabase.co";
// Matches the buyer portal's DEFAULT_EXPIRY_DAYS for created connections.
const CONNECT_TOKEN_TTL_DAYS = 90;
const CONNECT_TOKEN_LABEL = "Apiosk MCP connection";

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeBaseUrl(value, fallback) {
  return (trimString(value) || fallback).replace(/\/+$/, "");
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isoAfterDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

// Same key precedence as resolveMcpWalletAuthConfig in oauth.mjs, so the mint
// reuses whatever Supabase credentials already power wallet sign-in.
export function resolveSupabaseConfig(env = process.env) {
  const supabaseUrl = normalizeBaseUrl(
    env.APIOSK_SUPABASE_URL || env.SUPABASE_URL,
    DEFAULT_SUPABASE_URL
  );
  const apiKey =
    trimString(env.APIOSK_SUPABASE_SERVICE_ROLE_KEY) ||
    trimString(env.SUPABASE_SERVICE_ROLE_KEY) ||
    trimString(env.SUPABASE_SERVICE_KEY) ||
    trimString(env.APIOSK_SUPABASE_PUBLISHABLE_KEY) ||
    trimString(env.APIOSK_SUPABASE_ANON_KEY) ||
    trimString(env.SUPABASE_PUBLISHABLE_KEY) ||
    trimString(env.SUPABASE_ANON_KEY);

  return {
    supabaseUrl,
    apiKey,
    configured: Boolean(supabaseUrl && apiKey),
  };
}

// Byte-identical to buyer/src/lib/agent-wallet.ts generateConnectToken():
//   token       = `aw_live_${12-hex}_${32-char-base64url}`
//   tokenHash   = sha256(token) as lowercase hex
//   tokenPrefix = token.slice(0, 22)
// The gateway stores sha256(token) and matches on token_prefix, so the format
// must not drift.
export function generateConnectToken() {
  const publicId = crypto.randomBytes(6).toString("hex");
  const secret = crypto.randomBytes(24).toString("base64url");
  const token = `aw_live_${publicId}_${secret}`;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const tokenPrefix = token.slice(0, 22);
  return { token, tokenHash, tokenPrefix };
}

export async function supabaseRest(
  config,
  path,
  { method = "GET", sessionToken, body, prefer } = {}
) {
  const headers = {
    apikey: config.apiKey,
    authorization: `Bearer ${sessionToken}`,
    accept: "application/json",
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  if (prefer) {
    headers.prefer = prefer;
  }

  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    cache: "no-store",
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text || null;
  }

  if (!response.ok) {
    const detail =
      (payload && typeof payload === "object"
        ? payload.message || payload.error || payload.hint
        : payload) || `HTTP ${response.status}`;
    const error = new Error(
      `Supabase REST ${method} ${path} failed: ${
        typeof detail === "string" ? detail : JSON.stringify(detail)
      }`
    );
    error.status = response.status;
    throw error;
  }

  return payload;
}

export async function listHostedPayableWallets({
  env = process.env,
  sessionToken,
} = {}) {
  const token = trimString(sessionToken);
  const config = resolveSupabaseConfig(env);
  if (!token || !config.configured) return [];

  const rows = await supabaseRest(
    config,
    "agent_wallets?select=id,label,wallet_address,status,daily_limit_usdc,per_tx_limit_usdc,encrypted_private_key,created_at&status=eq.active&order=created_at.asc",
    { sessionToken: token }
  );
  if (!Array.isArray(rows)) return [];

  return rows
    .filter(
      (wallet) =>
        wallet &&
        trimString(wallet.id) &&
        trimString(wallet.wallet_address) &&
        trimString(wallet.encrypted_private_key)
    )
    .map((wallet) => ({
      id: wallet.id,
      label: trimString(wallet.label) || "Managed wallet",
      address: String(wallet.wallet_address).toLowerCase(),
      dailyLimitUsdc: asNumber(wallet.daily_limit_usdc),
      perTxLimitUsdc: asNumber(wallet.per_tx_limit_usdc),
    }));
}

/**
 * Resolve the signed-in user's first payable managed wallet (active + has a
 * custodied private key) and mint an `aw_live_…` connect token authorizing it.
 *
 * Best-effort: returns `null` (never throws) when Supabase is not configured,
 * the user has no payable managed wallet, or any REST call fails. Callers embed
 * the returned `connectToken` on the OAuth token so the gateway can settle paid
 * calls from that managed wallet.
 */
export async function mintHostedConnectToken({
  env = process.env,
  sessionToken,
  userId,
  walletId,
  dailyLimitUsdc,
  perTxLimitUsdc,
  strict = false,
} = {}) {
  try {
    const token = trimString(sessionToken);
    const uid = trimString(userId);
    if (!token || !uid) {
      return null;
    }

    const config = resolveSupabaseConfig(env);
    if (!config.configured) {
      return null;
    }

    const payableWallets = await listHostedPayableWallets({ env, sessionToken: token });
    const requestedWalletId = trimString(walletId);
    const payable = requestedWalletId
      ? payableWallets.find((wallet) => wallet.id === requestedWalletId)
      : payableWallets[0];
    if (!payable) {
      if (strict) {
        throw statusError(
          "No active payable Apiosk wallet was found. Create or activate a managed wallet before connecting this app.",
          400
        );
      }
      return null;
    }

    const requestedDaily = dailyLimitUsdc === undefined ? payable.dailyLimitUsdc : Number(dailyLimitUsdc);
    const requestedPerTx = perTxLimitUsdc === undefined ? payable.perTxLimitUsdc : Number(perTxLimitUsdc);
    if (!Number.isFinite(requestedDaily) || requestedDaily <= 0) {
      throw statusError("Daily spending limit must be greater than 0 USDC.", 400);
    }
    if (!Number.isFinite(requestedPerTx) || requestedPerTx <= 0) {
      throw statusError("Per-request spending limit must be greater than 0 USDC.", 400);
    }
    if (requestedPerTx > requestedDaily) {
      throw statusError("Per-request spending limit cannot exceed the daily limit.", 400);
    }
    // Keep accidental approvals bounded. These are authorization guardrails,
    // not account balances; higher limits can still be configured in the portal.
    if (requestedDaily > 1000 || requestedPerTx > 100) {
      throw statusError("MCP limits may not exceed 1,000 USDC/day or 100 USDC/request.", 400);
    }

    const address = payable.address;
    const dailyLimit = requestedDaily;
    const perTxLimit = requestedPerTx;
    const { token: connectToken, tokenHash, tokenPrefix } = generateConnectToken();
    const expiresAt = isoAfterDays(CONNECT_TOKEN_TTL_DAYS);
    const permissions = {
      scope: ["x402.verify", "x402.settle"],
      wallet_ids: [payable.id],
      wallets: [
        {
          id: payable.id,
          address,
          daily_limit_usdc: dailyLimit,
          per_tx_limit_usdc: perTxLimit,
        },
      ],
      include_sepa: false,
      label: CONNECT_TOKEN_LABEL,
    };

    const inserted = await supabaseRest(config, "agent_wallet_connect_tokens", {
      method: "POST",
      sessionToken: token,
      prefer: "return=representation",
      body: {
        wallet_id: payable.id,
        user_id: uid,
        token_prefix: tokenPrefix,
        token_hash: tokenHash,
        token_name: CONNECT_TOKEN_LABEL,
        permissions,
        include_sepa: false,
        sepa_per_tx_limit_eur: null,
        sepa_daily_limit_eur: null,
        expires_at: expiresAt,
      },
    });

    const row = Array.isArray(inserted) ? inserted[0] : inserted;
    const tokenId = row && trimString(row.id);
    if (!tokenId) {
      return null;
    }

    try {
      await supabaseRest(config, "agent_wallet_connect_token_wallets", {
        method: "POST",
        sessionToken: token,
        body: [{
          token_id: tokenId,
          wallet_id: payable.id,
          user_id: uid,
          daily_limit_usdc: dailyLimit,
          per_tx_limit_usdc: perTxLimit,
        }],
      });
    } catch (joinError) {
      // Roll back the dangling token so a failed link never leaves an
      // unusable connect token behind (mirrors the buyer portal cleanup).
      try {
        await supabaseRest(
          config,
          `agent_wallet_connect_tokens?id=eq.${encodeURIComponent(tokenId)}`,
          {
            method: "PATCH",
            sessionToken: token,
            body: { revoked_at: new Date().toISOString() },
          }
        );
      } catch {
        // Best-effort; the orphan token authorizes no wallet, so it is inert.
      }
      throw joinError;
    }

    return {
      connectToken,
      walletAddress: address,
      walletId: payable.id,
      tokenId,
      expiresAt,
    };
  } catch (error) {
    console.warn(
      `Hosted connect-token mint failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    if (strict) throw error;
    return null;
  }
}
