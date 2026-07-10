// Hosted managed-wallet tools over the signed-in user's own Supabase session.
//
// The DASHBOARD_WALLET_TOOLS were built against the legacy Next.js dashboard's
// /api/agent-wallets backend. That deployment is gone — dashboard.apiosk.com
// now serves the provider-portal SPA, whose catch-all rewrite answers every
// /api/* request with index.html. Proxying there returns HTML "200s" that MCP
// clients dutifully show the user as garbage.
//
// So on the hosted server every wallet tool talks straight to Supabase REST
// (PostgREST) with the caller's request-scoped session JWT as the bearer, the
// exact pattern the buyer portal uses client-side (buyer/src/lib/data/
// wallets.ts, connections.ts, wallet-calls.ts) and hosted-payment.mjs already
// uses for the sign-in connect-token mint. RLS applies as the signed-in user;
// the service role is never the acting identity.
//
// Custodial wallet CREATION stays unavailable here: deriving + encrypting the
// private key requires the legacy dashboard's AGENT_WALLET_SECRET_PEPPER and
// the per-user key-seed RPC, plus the on-chain settlement approval. Until that
// service is restored those tools explain the situation instead of failing
// with opaque HTML.

import { generateConnectToken, resolveSupabaseConfig, supabaseRest } from "./hosted-payment.mjs";

const DEFAULT_TOKEN_TTL_DAYS = 90;
const WALLET_SELECT =
  "id,label,wallet_address,status,daily_limit_usdc,per_tx_limit_usdc,last_used_at,created_at,encrypted_private_key,icon,color";
const TOKEN_SELECT = "id,token_name,token_prefix,wallet_id,expires_at,created_at,revoked_at";

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoAfterDays(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

function statusError(message, status = 500) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function requireConfig(env) {
  const config = resolveSupabaseConfig(env);
  if (!config.configured) {
    throw statusError("Managed wallet tools are not configured on this MCP server.", 503);
  }
  return config;
}

function requireSession(sessionToken) {
  const token = trimString(sessionToken);
  if (!token) {
    throw statusError(
      "This tool needs your Apiosk session. Re-authorize the Apiosk app and retry.",
      401
    );
  }
  return token;
}

// Never leak encrypted_private_key; surface only whether the wallet is
// custodial (payable by the gateway) or watch-only.
function toWalletSummary(row) {
  return {
    id: row.id,
    label: trimString(row.label) || "Managed wallet",
    address: trimString(row.wallet_address).toLowerCase(),
    status: row.status,
    daily_limit_usdc: asNumber(row.daily_limit_usdc),
    per_tx_limit_usdc: asNumber(row.per_tx_limit_usdc),
    custodial: Boolean(trimString(row.encrypted_private_key)),
    last_used_at: row.last_used_at || null,
    created_at: row.created_at || null,
    icon: row.icon ?? null,
    color: row.color ?? null,
  };
}

function fundingInstructions(wallet) {
  if (!wallet) return null;
  return {
    address: wallet.address,
    network: "Base mainnet (chain 8453)",
    asset: "USDC",
    note: "Send USDC on Base mainnet to this address to fund paid API calls. Only Base mainnet USDC is accepted.",
  };
}

async function fetchWalletRows(config, sessionToken) {
  const rows = await supabaseRest(
    config,
    `agent_wallets?select=${WALLET_SELECT}&order=created_at.desc&limit=8`,
    { sessionToken }
  );
  return Array.isArray(rows) ? rows.map(toWalletSummary) : [];
}

async function fetchWalletById(config, sessionToken, walletId) {
  const rows = await supabaseRest(
    config,
    `agent_wallets?select=${WALLET_SELECT}&id=eq.${encodeURIComponent(walletId)}&limit=1`,
    { sessionToken }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) {
    throw statusError("Wallet not found on your Apiosk account.", 404);
  }
  return toWalletSummary(row);
}

async function resolveUserId(config, sessionToken, providedUserId) {
  const uid = trimString(providedUserId);
  if (uid) return uid;

  const response = await fetch(`${config.supabaseUrl}/auth/v1/user`, {
    headers: {
      apikey: config.apiKey,
      authorization: `Bearer ${sessionToken}`,
      accept: "application/json",
    },
    cache: "no-store",
  });
  const body = await response.json().catch(() => ({}));
  const id = trimString(body?.id);
  if (!response.ok || !id) {
    throw statusError("Could not resolve your Apiosk user from the session.", 401);
  }
  return id;
}

export async function hostedListWallets({ env = process.env, sessionToken } = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const wallets = await fetchWalletRows(config, token);
  const payable = wallets.find((wallet) => wallet.custodial && wallet.status === "active") || null;

  return {
    wallets,
    payable_wallet: payable,
    funding: fundingInstructions(payable),
    note: payable
      ? "Paid API calls settle automatically from your payable managed wallet (per-call USDC on Base)."
      : "No payable managed wallet found on this account. A custodial wallet with spend limits is required before paid calls can settle automatically.",
  };
}

export async function hostedUpdateWallet({
  env = process.env,
  sessionToken,
  walletId,
  label,
  status,
  dailyLimitUsdc,
  perTxLimitUsdc,
  color,
  icon,
} = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);

  const patch = {};
  if (label !== undefined) {
    const trimmed = trimString(label).slice(0, 64);
    if (!trimmed) throw statusError("Wallet label must be 1 to 64 characters.", 400);
    patch.label = trimmed;
  }
  if (status !== undefined) {
    if (!["active", "paused", "revoked"].includes(status)) {
      throw statusError("status must be active, paused, or revoked.", 400);
    }
    patch.status = status;
  }
  if (dailyLimitUsdc !== undefined || perTxLimitUsdc !== undefined) {
    const daily = Number(dailyLimitUsdc);
    const perTx = Number(perTxLimitUsdc);
    if (!Number.isFinite(daily) || daily <= 0 || !Number.isFinite(perTx) || perTx <= 0) {
      throw statusError("Provide both daily_limit_usdc and per_tx_limit_usdc as positive numbers.", 400);
    }
    if (perTx > daily) {
      throw statusError("Per-request cap cannot exceed the daily budget.", 400);
    }
    patch.daily_limit_usdc = daily;
    patch.per_tx_limit_usdc = perTx;
  }
  if (color !== undefined) patch.color = color || null;
  if (icon !== undefined) patch.icon = icon || null;
  if (Object.keys(patch).length === 0) throw statusError("Nothing to update.", 400);

  const rows = await supabaseRest(
    config,
    `agent_wallets?id=eq.${encodeURIComponent(id)}&select=${WALLET_SELECT}`,
    { method: "PATCH", sessionToken: token, body: patch, prefer: "return=representation" }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw statusError("Wallet not found on your Apiosk account.", 404);
  return { wallet: toWalletSummary(row) };
}

export async function hostedDeleteWallet({ env = process.env, sessionToken, walletId } = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);

  try {
    const rows = await supabaseRest(
      config,
      `agent_wallets?id=eq.${encodeURIComponent(id)}&select=id`,
      { method: "DELETE", sessionToken: token, prefer: "return=representation" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw statusError("Wallet not found on your Apiosk account.", 404);
    return { deleted: true, wallet_id: id };
  } catch (error) {
    // FK violation → connect tokens still reference the wallet.
    if (error?.status === 409) {
      throw statusError(
        "Revoke the connect tokens that use this wallet first (apiosk_list_wallet_api_keys / apiosk_update_wallet_api_key with revoke=true), then delete it.",
        409
      );
    }
    throw error;
  }
}

export async function hostedWalletActivity({
  env = process.env,
  sessionToken,
  walletId,
  limit = 25,
} = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);

  const wallet = await fetchWalletById(config, token, id);
  const cappedLimit = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const rows = await supabaseRest(
    config,
    `gateway_usage?select=id,paid,amount,occurred_at,api_id,endpoint_id,wallet_address,request_id&wallet_address=eq.${encodeURIComponent(
      wallet.address
    )}&order=occurred_at.desc&limit=${cappedLimit}`,
    { sessionToken: token }
  );

  const calls = Array.isArray(rows)
    ? rows.map((row) => ({
        id: row.id,
        paid: Boolean(row.paid),
        amount_usdc: asNumber(row.amount),
        occurred_at: row.occurred_at,
        api_id: row.api_id || null,
        endpoint_id: row.endpoint_id || null,
        request_id: row.request_id || null,
      }))
    : [];

  return {
    wallet,
    calls,
    total_returned: calls.length,
  };
}

export async function hostedListWalletTokens({ env = process.env, sessionToken, walletId } = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);

  const rows = await supabaseRest(
    config,
    `agent_wallet_connect_tokens?select=${TOKEN_SELECT}&wallet_id=eq.${encodeURIComponent(
      id
    )}&order=created_at.desc&limit=50`,
    { sessionToken: token }
  );

  return {
    wallet_id: id,
    keys: (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      name: trimString(row.token_name) || "Connect token",
      token_prefix: row.token_prefix,
      expires_at: row.expires_at,
      created_at: row.created_at,
      revoked: Boolean(row.revoked_at),
    })),
  };
}

export async function hostedCreateWalletToken({
  env = process.env,
  sessionToken,
  userId,
  walletId,
  name,
  expirationDays,
  revokeExisting = false,
} = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);

  const wallet = await fetchWalletById(config, token, id);
  if (!wallet.custodial) {
    throw statusError(
      "This wallet is watch-only (no custodied key), so a connect token minted for it cannot authorize payments.",
      400
    );
  }
  if (wallet.status !== "active") {
    throw statusError(`Wallet is not active (status: ${wallet.status}).`, 400);
  }

  const uid = await resolveUserId(config, token, userId);
  const ttlDays = Number.isFinite(Number(expirationDays)) && Number(expirationDays) > 0
    ? Math.min(Number(expirationDays), 365)
    : DEFAULT_TOKEN_TTL_DAYS;
  const label = trimString(name).slice(0, 64) || "MCP connect token";

  if (revokeExisting) {
    await supabaseRest(
      config,
      `agent_wallet_connect_tokens?wallet_id=eq.${encodeURIComponent(id)}&revoked_at=is.null`,
      {
        method: "PATCH",
        sessionToken: token,
        body: { revoked_at: new Date().toISOString() },
      }
    );
  }

  const { token: connectToken, tokenHash, tokenPrefix } = generateConnectToken();
  const expiresAt = isoAfterDays(ttlDays);
  const permissions = {
    scope: ["x402.verify", "x402.settle"],
    wallet_ids: [wallet.id],
    wallets: [
      {
        id: wallet.id,
        address: wallet.address,
        daily_limit_usdc: wallet.daily_limit_usdc,
        per_tx_limit_usdc: wallet.per_tx_limit_usdc,
      },
    ],
    include_sepa: false,
    label,
  };

  const inserted = await supabaseRest(config, "agent_wallet_connect_tokens", {
    method: "POST",
    sessionToken: token,
    prefer: "return=representation",
    body: {
      wallet_id: wallet.id,
      user_id: uid,
      token_prefix: tokenPrefix,
      token_hash: tokenHash,
      token_name: label,
      permissions,
      include_sepa: false,
      sepa_per_tx_limit_eur: null,
      sepa_daily_limit_eur: null,
      expires_at: expiresAt,
    },
  });
  const row = Array.isArray(inserted) ? inserted[0] : inserted;
  const tokenId = row && trimString(row.id);
  if (!tokenId) throw statusError("Could not create the connect token.", 502);

  try {
    await supabaseRest(config, "agent_wallet_connect_token_wallets", {
      method: "POST",
      sessionToken: token,
      body: [{ token_id: tokenId, wallet_id: wallet.id, user_id: uid }],
    });
  } catch (joinError) {
    // Roll back the dangling token so a failed link never leaves an unusable
    // connect token behind (mirrors hosted-payment.mjs / the buyer portal).
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
    key_id: tokenId,
    name: label,
    wallet: { id: wallet.id, address: wallet.address },
    connect_token: connectToken,
    token_prefix: tokenPrefix,
    expires_at: expiresAt,
    warning:
      "This is the only time the full connect token is shown. Store it securely; anyone holding it can spend from this wallet within its limits.",
  };
}

export async function hostedUpdateWalletToken({
  env = process.env,
  sessionToken,
  walletId,
  keyId,
  name,
  expirationDays,
  revoke,
} = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  const key = trimString(keyId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);
  if (!key) throw statusError("Missing required field: key_id", 400);

  const patch = {};
  if (name !== undefined) {
    const trimmed = trimString(name).slice(0, 64);
    if (!trimmed) throw statusError("Key name must be 1 to 64 characters.", 400);
    patch.token_name = trimmed;
  }
  if (expirationDays !== undefined) {
    const days = Number(expirationDays);
    if (!Number.isFinite(days) || days <= 0) {
      throw statusError("expiration_days must be a positive number.", 400);
    }
    patch.expires_at = isoAfterDays(Math.min(days, 365));
  }
  if (revoke === true) {
    patch.revoked_at = new Date().toISOString();
  }
  if (Object.keys(patch).length === 0) throw statusError("Nothing to update.", 400);

  const rows = await supabaseRest(
    config,
    `agent_wallet_connect_tokens?id=eq.${encodeURIComponent(key)}&wallet_id=eq.${encodeURIComponent(
      id
    )}&select=${TOKEN_SELECT}`,
    { method: "PATCH", sessionToken: token, body: patch, prefer: "return=representation" }
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw statusError("Connect token not found for this wallet.", 404);

  return {
    key: {
      id: row.id,
      name: trimString(row.token_name) || "Connect token",
      token_prefix: row.token_prefix,
      expires_at: row.expires_at,
      created_at: row.created_at,
      revoked: Boolean(row.revoked_at),
    },
  };
}

export async function hostedDeleteWalletToken({
  env = process.env,
  sessionToken,
  walletId,
  keyId,
} = {}) {
  const config = requireConfig(env);
  const token = requireSession(sessionToken);
  const id = trimString(walletId);
  const key = trimString(keyId);
  if (!id) throw statusError("Missing required field: wallet_id", 400);
  if (!key) throw statusError("Missing required field: key_id", 400);

  // Remove the wallet links first (FK), then the token row itself. If RLS
  // forbids the hard delete, fall back to a revoke so the key is still dead.
  try {
    await supabaseRest(
      config,
      `agent_wallet_connect_token_wallets?token_id=eq.${encodeURIComponent(key)}`,
      { method: "DELETE", sessionToken: token }
    );
    const rows = await supabaseRest(
      config,
      `agent_wallet_connect_tokens?id=eq.${encodeURIComponent(key)}&wallet_id=eq.${encodeURIComponent(id)}&select=id`,
      { method: "DELETE", sessionToken: token, prefer: "return=representation" }
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) throw statusError("Connect token not found for this wallet.", 404);
    return { deleted: true, key_id: key };
  } catch (error) {
    if (error?.status === 404) throw error;
    const revoked = await hostedUpdateWalletToken({
      env,
      sessionToken: token,
      walletId: id,
      keyId: key,
      revoke: true,
    });
    return { deleted: false, revoked: true, key: revoked.key };
  }
}

export function hostedCreateWalletUnavailable() {
  return {
    error: "custodial_wallet_creation_unavailable",
    message:
      "Creating a new managed (custodial) wallet is temporarily unavailable on the hosted MCP server: the legacy dashboard service that derived and encrypted wallet keys has been retired.",
    what_you_can_do: [
      "If your account already has a managed wallet, fund it with USDC on Base mainnet and paid calls will settle automatically (see apiosk_list_wallets).",
      "Sign in to the Apiosk buyer portal to manage wallets and connections.",
      "For fully autonomous local use, run the stdio package (npx -y @apiosk/mcp) and create a local wallet with apiosk_wallet_create.",
    ],
  };
}
