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
        `Open ${connectUrl(env)} to sign in, top up your balance and set the spending limits.`,
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

  // /v1/me reports wallets as an ARRAY, each with its own on-chain USDC
  // balance and caps (gateway src/v1_routes/me.rs). There is no top-level
  // wallet_id / balance / limits / payable field — reading those returned
  // undefined and made every connection look unpayable.
  const wallets = Array.isArray(me?.wallets) ? me.wallets : [];

  // A wallet is spendable when it is attached and still has daily budget left.
  // Crucially, on-chain USDC balance is NOT a gate here: it is reported for the
  // agent to reason about, but the gateway is the authority on whether funds
  // suffice and refuses at settlement with the exact reason (apiosk_execute ->
  // payment_required). A managed wallet funded through the buyer portal can read
  // 0 on-chain here — the portal's "available to spend" is its own ledger, not
  // this on-chain figure — so blocking on balance would wrongly refuse a funded
  // buyer, which is exactly what it did.
  const walletHasBudget = (w) => {
    if (!w) return false;
    const dailyCap = Number.isFinite(w.cap_per_day_usdc) ? w.cap_per_day_usdc : null;
    const spentToday = Number(w.spent_today_usdc) || 0;
    return dailyCap === null || dailyCap - spentToday > 0;
  };

  const payableWallet = wallets.find(walletHasBudget) || null;
  const wallet = payableWallet || wallets[0] || null;
  const payable = Boolean(payableWallet);
  const policy = me?.policy || null;

  // Only genuinely terminal cases here: no wallet at all, or a wallet whose
  // daily cap is already spent. An empty on-chain balance is left to the
  // gateway to report at settlement, not pre-judged as unpayable.
  let notPayableReason = "no wallet is attached to this connection";
  if (wallet) {
    const spentToday = Number(wallet.spent_today_usdc) || 0;
    const dailyCap = Number.isFinite(wallet.cap_per_day_usdc) ? wallet.cap_per_day_usdc : null;
    if (dailyCap !== null && dailyCap - spentToday <= 0) {
      notPayableReason = "today's spending limit is used up";
    }
  }

  return content({
    status: "connected",
    payable,
    wallet: wallet
      ? {
          address: wallet.address ?? null,
          status: wallet.status ?? null,
          balance_usdc: wallet.balance_usdc ?? null,
        }
      : null,
    policy: policy ? { id: policy.id ?? null, name: policy.name ?? null } : null,
    limits: wallet
      ? {
          per_tx_limit_usdc: wallet.cap_per_tx_usdc ?? null,
          daily_limit_usdc: wallet.cap_per_day_usdc ?? null,
          spent_today_usdc: wallet.spent_today_usdc ?? null,
          allowed_domains: me?.allowed_domains ?? null,
        }
      : null,
    rails: Array.isArray(me?.rails) ? me.rails : [],
    portal_url: BUYER_PORTAL_URL,
    message: payable
      ? "Connected and able to pay. State the price before every purchase, and stay inside the limits above."
      : `Connected, but not able to pay yet: ${notPayableReason}.`,
    next_steps: payable
      ? ["Call apiosk_discover with the job in plain words."]
      : [`Top up your balance at ${BUYER_PORTAL_URL}, then call apiosk_connect again.`],
  });
}
