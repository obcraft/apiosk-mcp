// apiosk_connect — the one answer to "what now".
//
// It replaces four tools that each answered a slice of the same question
// (apiosk_get_started, apiosk_configure, apiosk_help, apiosk_health). An agent
// asking whether it can spend should not have to pick between four candidates
// and get a different half of the answer from each.
//
// Nothing here signs anybody in. Identity, wallets, funding and limits belong to
// the buyer portal; this tool reports what the current connection can do and,
// when there is nothing to report, hands back the link.

import { GatewayError } from "../gateway-client.mjs";
import { content, trimString } from "../tool-result.mjs";

export const BUYER_PORTAL_URL = "https://buy.apiosk.com";
const CONNECT_PATH = "/connect";

export const CONNECT_TOOL = {
  name: "apiosk_connect",
  title: "Check the Apiosk connection",
  description:
    "Report whether this session can buy: connected or not, payable or not, which wallet, which spending policy, and the exact per-transaction and daily limits. Call it first in any conversation that might end in a paid API call, and again whenever a purchase is refused, so you can tell the user what to fix. When there is no connection it returns the buy.apiosk.com link to set one up — signing in, funding a wallet and setting limits all happen there, never here. Reads only; spends nothing.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};

/** The portal link an unconnected agent should show the user. */
export function connectUrl(env = process.env) {
  const base = (trimString(env.APIOSK_BUYER_PORTAL_URL) || BUYER_PORTAL_URL).replace(/\/+$/, "");
  return `${base}${CONNECT_PATH}`;
}

export async function runConnect(_args = {}, { env = process.env, authInfo = null, gateway } = {}) {
  if (!gateway.hasConnectToken) {
    return content({
      status: "not_connected",
      payable: false,
      connect_url: connectUrl(env),
      message:
        "This session is not connected to an Apiosk account, so nothing can be paid for yet. Discovery and comparison still work.",
      next_steps: [
        `Open ${connectUrl(env)} to sign in, fund a wallet in USDC and set the spending limits.`,
        "Come back and call apiosk_connect again to confirm the connection is payable.",
      ],
    });
  }

  let me;
  try {
    me = await gateway.requestJson("/v1/me");
  } catch (error) {
    if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
      return content({
        status: "expired",
        payable: false,
        connect_url: connectUrl(env),
        error_code: error.code,
        message:
          "The connection is no longer valid — it expired, or it was revoked in the buyer portal. Do not retry the call that failed.",
        next_steps: [`Reconnect at ${connectUrl(env)}, then call apiosk_connect again.`],
      });
    }
    throw error;
  }

  const extra = authInfo?.extra || {};
  const limits = me?.limits || extra.apiosk_limits || null;
  const payable = me?.payable !== false && Boolean(me?.wallet_id || extra.apiosk_connect_wallet_address);

  return content({
    status: "connected",
    payable,
    wallet: {
      id: me?.wallet_id ?? null,
      address: me?.wallet_address ?? extra.apiosk_connect_wallet_address ?? null,
      balance_usdc: me?.balance_usdc ?? null,
    },
    policy: { id: me?.policy_id ?? null, name: me?.policy_name ?? null },
    limits: limits
      ? {
          per_tx_limit_usdc: limits.per_tx_limit_usdc ?? null,
          daily_limit_usdc: limits.daily_limit_usdc ?? null,
          spent_today_usdc: limits.spent_today_usdc ?? null,
          allowed_domains: limits.allowed_domains ?? null,
        }
      : null,
    portal_url: BUYER_PORTAL_URL,
    message: payable
      ? "Connected and able to pay. State the price before every purchase, and stay inside the limits above."
      : "Connected, but not able to pay yet: the wallet holds no USDC or no wallet is attached.",
    next_steps: payable
      ? ["Call apiosk_discover with the job in plain words."]
      : [`Fund the wallet with USDC on Base at ${BUYER_PORTAL_URL}, then call apiosk_connect again.`],
  });
}
