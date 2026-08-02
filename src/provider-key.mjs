// Provider API keys minted for an OAuth session.
//
// Publishing tools authenticate with a provider SDK key (`sk_live_…`), which
// until now could only be minted by hand in the provider portal. That left the
// hosted MCP flow with a dead end: a user connects a wallet through OAuth, asks
// their agent to publish, and gets told to open a browser and mint a key.
//
// This module closes that. When the user explicitly grants publishing on the
// consent screen, the authorization flow mints a provider key for the account
// that just signed in and carries it on the issued token, so the same session
// that discovers and pays for APIs can also publish them.
//
// SECURITY: the key is written with the user's OWN dashboard session token, so
// the `provider_api_keys_insert_own` RLS policy (auth.uid() = owner_id) is what
// authorizes the row — this module cannot mint a key for anyone but the signed
// in user, even if `userId` were wrong. Only the SHA-256 hash and a display
// prefix are stored; the plaintext lives on the signed OAuth token and nowhere
// else, exactly like a key minted in the portal is shown once and never
// persisted.

import crypto from "node:crypto";

import { resolveSupabaseConfig, supabaseRest } from "./hosted-payment.mjs";

const PROVIDER_KEY_PREFIX = "sk_live_";
const LABEL_NAMESPACE = "MCP";
const MAX_CLIENT_NAME_LENGTH = 40;

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A provider SDK key in the shape the portal mints: `sk_live_` + 64 hex chars.
 * The stored hash is of the FULL presented string, matching how
 * `verify_provider_api_key(p_secret)` hashes what a caller presents.
 */
export function generateProviderKey() {
  const key = `${PROVIDER_KEY_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  return {
    key,
    secretHash: crypto.createHash("sha256").update(key).digest("hex"),
    secretPrefix: key.slice(0, 16),
  };
}

/**
 * Label the key by the OAuth client that asked for it, so the portal's key list
 * reads as a list of connected apps ("MCP - Cursor") and a user can revoke one
 * app without touching the others.
 *
 * The label doubles as a PostgREST `eq.` filter value when replacing a previous
 * key, so characters that carry meaning in filter syntax are stripped rather
 * than escaped.
 */
export function buildProviderKeyLabel(clientName) {
  const name = trimString(clientName).slice(0, MAX_CLIENT_NAME_LENGTH);
  const safe = name.replace(/[(),.:"'\\]/g, "").trim();
  return safe ? `${LABEL_NAMESPACE} - ${safe}` : `${LABEL_NAMESPACE} connection`;
}

/**
 * Mint a provider key for the signed-in user, replacing any previous key this
 * same client holds.
 *
 * Best-effort by design, mirroring `mintHostedConnectToken`: a failure here must
 * not break sign-in. The session still connects, publishing tools simply stay
 * unavailable and report the portal fallback.
 *
 * @returns {Promise<{providerKey: string, keyId?: string, label: string}|null>}
 */
export async function mintHostedProviderKey({
  env = process.env,
  sessionToken,
  userId,
  clientName,
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

    const label = buildProviderKeyLabel(clientName);

    // Re-authorizing replaces this client's key rather than piling up a new one
    // per connection. Revoking first means a half-failed mint leaves the user
    // with no working key instead of a stale one they think was replaced.
    await supabaseRest(
      config,
      `provider_api_keys?owner_id=eq.${encodeURIComponent(uid)}` +
        `&label=eq.${encodeURIComponent(label)}&revoked_at=is.null`,
      {
        method: "PATCH",
        sessionToken: token,
        body: { revoked_at: new Date().toISOString() },
      }
    );

    const { key, secretHash, secretPrefix } = generateProviderKey();
    const rows = await supabaseRest(config, "provider_api_keys?select=id,label", {
      method: "POST",
      sessionToken: token,
      prefer: "return=representation",
      body: {
        owner_id: uid,
        label,
        secret_hash: secretHash,
        secret_prefix: secretPrefix,
      },
    });

    const row = Array.isArray(rows) ? rows[0] : rows;
    return {
      providerKey: key,
      keyId: trimString(row?.id) || undefined,
      label,
    };
  } catch {
    return null;
  }
}
