// apiosk_connect — the one answer to "what now".
//
// It replaces four tools that each answered a slice of the same question
// (apiosk_get_started, apiosk_configure, apiosk_help, apiosk_health). An agent
// asking whether it can spend should not have to pick between four candidates
// and get a different half of the answer from each.
//
// Nothing here signs anybody in. Identity, funding and limits belong to Apiosk;
// this tool reports what the current connection can do and, when there is
// nothing to report, hands back the link.

import { randomUUID } from "node:crypto";

import { GatewayError } from "../gateway-client.mjs";
import { content, trimString } from "../tool-result.mjs";
import { elicitConnect } from "../elicit.mjs";

/**
 * Where a person tops up and sets limits — app.apiosk.com, the same screen the
 * approval happens on.
 *
 * It was `buy.apiosk.com`, which was a second frontend with a second connect
 * page. Sending somebody there to fix a limit they had set here would have
 * shown them a different account view of the same money.
 */
export const BUYER_PORTAL_URL = "https://app.apiosk.com";
const CONNECT_PATH = "/connect";

export const CONNECT_TOOL = {
  name: "apiosk_connect",
  title: "Apiosk connect",
  description:
    "Report whether this session can buy: connected or not, payable or not, the balance left, and the exact per-call and daily limits with how much of today's allowance is gone. Call it first in any conversation that might end in a paid API call, and again whenever a purchase is refused, so you can tell the user what to fix. When there is no connection it returns the link to set one up — signing in, topping up and setting limits all happen there, never here. Reads only; spends nothing.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  _meta: {
    "openai/outputTemplate": "ui://apiosk/connect-card.html",
    "openai/toolInvocation/invoking": "Checking the Apiosk connection…",
    "openai/toolInvocation/invoked": "Connection checked",
    ui: { resourceUri: "ui://apiosk/connect-card.html" },
  },
  inputSchema: { type: "object", additionalProperties: false, properties: {} },
};

/** The portal link an unconnected agent should show the user. */
export function connectUrl(env = process.env) {
  const base = (trimString(env.APIOSK_BUYER_PORTAL_URL) || BUYER_PORTAL_URL).replace(/\/+$/, "");
  return `${base}${CONNECT_PATH}`;
}

export async function runConnect(_args = {}, { env = process.env, authInfo = null, gateway, host = null } = {}) {
  if (!gateway.hasConnectToken) {
    /**
     * The hand-off, as something to click rather than something to copy.
     *
     * URL mode is the right shape for this step and not a flourish: signing in,
     * topping up and setting the spending limits all happen in the buyer's own
     * account, and none of it may pass through the chat. The host opens the
     * link; this server never sees a password, a token or a limit. A host that
     * cannot do it gets the same URL in the text below, which is what every
     * host got before.
     */
    const url = connectUrl(env);
    const handoff = await elicitConnect(host, { connectUrl: url, elicitationId: randomUUID() });
    return content({
      status: "not_connected",
      payable: false,
      connect_url: url,
      // Whether the person was handed the link directly, so the model does not
      // repeat a link they are already looking at.
      handoff_shown: Boolean(handoff),
      message:
        "This session is not connected to an Apiosk account, so nothing can be paid for yet. Discovery and comparison still work.",
      next_steps: [
        `Open ${connectUrl(env)} to sign in, top up your balance and set the spending limits.`,
        "Come back and call apiosk_connect again to confirm the connection is payable.",
      ],
    });
  }

  let account;
  try {
    account = await gateway.requestJson("/v1/balance");
  } catch (error) {
    if (error instanceof GatewayError && (error.status === 401 || error.status === 403)) {
      return content({
        status: "expired",
        payable: false,
        connect_url: connectUrl(env),
        error_code: error.code,
        message:
          "The connection is no longer valid — it expired, or it was revoked in Apiosk. Do not retry the call that failed.",
        next_steps: [`Reconnect at ${connectUrl(env)}, then call apiosk_connect again.`],
      });
    }
    throw error;
  }

  /**
   * A BALANCE, NOT A WALLET, and that is the whole of this rewrite.
   *
   * `/v1/me` on the settlement gateway reported an ARRAY of on-chain wallets
   * with their own caps, and this file reasoned about which of them could pay.
   * None of that was ever the buyer's view: what a person tops up in Apiosk and
   * watches go down is one balance, and the wallet behind it is the treasury's,
   * not theirs. Reporting an on-chain figure here also meant reporting 0 for a
   * perfectly funded buyer, because a managed balance is a ledger and not a
   * chain address.
   *
   * So there is one number now, it is the same number the app shows, and the
   * limits beside it are the ones the person set on the approval screen.
   */
  const balance = Number(account?.balance_usdc ?? account?.balance_usd) || 0;
  const limits = account?.limits || {};
  const dailyRemaining = Number.isFinite(Number(limits.daily_remaining_usd))
    ? Number(limits.daily_remaining_usd)
    : null;

  // Spendable when there is money AND today's allowance is not used up. The
  // gateway is still the authority and refuses at settlement with the exact
  // reason (apiosk_execute -> payment_required); this only avoids sending an
  // agent shopping with nothing to spend.
  const payable = balance > 0 && (dailyRemaining === null || dailyRemaining > 0);
  const notPayableReason =
    balance <= 0 ? "the balance is empty" : "today's spending limit is used up";

  return content({
    status: "connected",
    payable,
    balance_usd: balance,
    limits: {
      per_call_usd: limits.per_call_usd ?? null,
      daily_usd: limits.daily_usd ?? null,
      daily_spent_usd: limits.daily_spent_usd ?? null,
      daily_remaining_usd: dailyRemaining,
    },
    connect_url: connectUrl(env),
    message: payable
      ? "Connected and able to pay. State the price before every purchase, and stay inside the limits above."
      : `Connected, but not able to pay yet: ${notPayableReason}.`,
    next_steps: payable
      ? ["Call apiosk_discover with the job in plain words."]
      : [`Top up or raise the limit at ${connectUrl(env)}, then call apiosk_connect again.`],
  });
}
