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

  // /v1/me reports wallets as an ARRAY, each with its own on-chain USDC
  // balance and caps (gateway src/v1_routes/me.rs). There is no top-level
  // wallet_id / balance / limits / payable field — reading those returned
  // undefined and made every connection look unpayable.
  const wallets = Array.isArray(me?.wallets) ? me.wallets : [];

  // Mirror the gateway's own selection: the first authorized wallet that
  // passes its caps and can settle on-chain (me.wallet_selection_strategy). A
  // wallet can pay when it is attached, still has daily budget, and either
  // holds USDC or the gateway could not read its balance this call — a null
  // balance is an RPC blip, not an empty wallet, and the authoritative check
  // runs again at settlement, so it must not read as "unpayable" here.
  const walletCanPay = (w) => {
    if (!w) return false;
    const dailyCap = Number.isFinite(w.cap_per_day_usdc) ? w.cap_per_day_usdc : null;
    const spentToday = Number(w.spent_today_usdc) || 0;
    if (dailyCap !== null && dailyCap - spentToday <= 0) return false;
    if (typeof w.balance_usdc === "number") return w.balance_usdc > 0;
    return true;
  };

  const payableWallet = wallets.find(walletCanPay) || null;
  const wallet = payableWallet || wallets[0] || null;
  const payable = Boolean(payableWallet);
  const policy = me?.policy || null;

  // Say WHY it cannot pay, so the user fixes the right thing rather than
  // re-funding a wallet that is fine and hitting the daily cap again.
  let notPayableReason = "no wallet is attached to this connection";
  if (wallet) {
    const spentToday = Number(wallet.spent_today_usdc) || 0;
    const dailyCap = Number.isFinite(wallet.cap_per_day_usdc) ? wallet.cap_per_day_usdc : null;
    if (typeof wallet.balance_usdc === "number" && wallet.balance_usdc <= 0) {
      notPayableReason = "the wallet holds no USDC on Base";
    } else if (dailyCap !== null && dailyCap - spentToday <= 0) {
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
      : [`Fund the wallet with USDC on Base at ${BUYER_PORTAL_URL}, then call apiosk_connect again.`],
  });
}
