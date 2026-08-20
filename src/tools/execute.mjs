// apiosk_execute — the only tool in this surface that spends money.
//
// It runs one offer the user chose, under a price ceiling the user saw, and
// returns the normalised result. It does not choose, it does not price, and it
// does not settle: the gateway does all three. What lives here is the contract
// with the agent — what it must have decided before calling, and what each
// non-success outcome means for the next turn.
//
// Two ways in, and the first is the one to use:
//
//   offer_id  a stable id from apiosk_compare, priced and pinned. The gateway
//             executes exactly that offer at exactly that price.
//   slug      an Apiosk catalogue listing, priced at call time. The path that
//             existed before offers had identity; kept for callers that already
//             know which listing they want.

import { ApioskPaymentRequiredError, GatewayError } from "../gateway-client.mjs";
import { connectUrl } from "./connect.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";

export const EXECUTE_TOOL = {
  name: "apiosk_execute",
  title: "Run the chosen API and pay for it",
  description:
    "SPENDS MONEY. Run the offer the user chose and return the result. Pass the `offer_id` from apiosk_compare, plus `max_price_usdc` set to the price you showed the user — the call is refused rather than paid if the real price is above it. Before calling: state the exact price to the user and have them choose; never pick for them and never call this to explore. If the buyer's rules require a human to approve, this returns `status: approval_required` with an approval_id — poll apiosk_approval_status, then call this again with the same offer_id once approved. If it returns `status: payment_required`, the wallet is empty or over its limit: call apiosk_connect to see which, and do not retry.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: {
    "openai/outputTemplate": "ui://apiosk/result-canvas.html",
    "openai/toolInvocation/invoking": "Paying for and fetching the data…",
    "openai/toolInvocation/invoked": "Paid data received",
    ui: { resourceUri: "ui://apiosk/result-canvas.html" },
  },
  inputSchema: {
    type: "object",
    properties: {
      offer_id: {
        type: "string",
        description: "The offer the user chose, as returned by apiosk_compare. Preferred over slug.",
      },
      slug: {
        type: "string",
        description: "An Apiosk catalogue slug, when you already know the listing and have no offer_id.",
      },
      max_price_usdc: {
        type: "number",
        description:
          "The price ceiling — the exact price you showed the user. The call is refused, not paid, if the real price exceeds it.",
      },
      operation: { type: "string", description: "Optional explicit operation id or path." },
      input: {
        type: "object",
        additionalProperties: true,
        description: "The request body, in the provider's own schema.",
      },
      query: { type: "object", additionalProperties: true, description: "Optional query-string parameters." },
      path_params: { type: "object", additionalProperties: true, description: "Optional path parameters." },
    },
  },
};

export async function runExecute(args = {}, { env = process.env, gateway } = {}) {
  const offerId = trimString(args.offer_id);
  const slug = trimString(args.slug);

  if (!offerId && !slug) {
    return errorContent({
      error_code: "execute.no_subject",
      message:
        "Nothing to execute. Pass the `offer_id` the user chose from apiosk_compare, or an Apiosk catalogue `slug`.",
    });
  }

  try {
    const result = offerId ? await executeOffer(offerId, args, gateway) : await executeSlug(slug, args, gateway);
    return content(result);
  } catch (error) {
    if (error instanceof ApioskPaymentRequiredError) {
      // A 402 is a business state, not a protocol failure. Returning isError
      // made clients collapse it into JSON-RPC -32603 and hide the one piece of
      // guidance the user needs.
      return content({
        status: "payment_required",
        error_code: "payment.wallet_unfunded_or_over_limit",
        message: error.message,
        next_steps: [
          "Call apiosk_connect to see whether the wallet is empty or over its limit.",
          `Fund it or raise the limit at ${connectUrl(env)}.`,
          "Do not retry this call until one of those is done.",
        ],
        payment_required: error.paymentRequired,
      });
    }

    if (error instanceof GatewayError) {
      if (error.status === 402 || error.code === "policy.approval_required") {
        return content(approvalPayload(error));
      }
      if (error.status === 401 || error.status === 403) {
        return content({
          status: "not_authorised",
          error_code: error.code,
          message: error.message,
          next_steps: [`Call apiosk_connect, then reconnect at ${connectUrl(env)} if it reports expired.`],
        });
      }
      return errorContent(error.toJSON());
    }

    throw error;
  }
}

function approvalPayload(error) {
  const body = error.body || {};
  return {
    status: "approval_required",
    approval_id: body.approval_id ?? null,
    error_code: error.code,
    amount_usdc: body.amount_usdc ?? null,
    reason: body.reason ?? error.message,
    expires_at: body.expires_at ?? null,
    message:
      "The buyer's rules hold this purchase until a person approves it. Nothing has been paid and nothing has been called.",
    next_steps: [
      "Tell the user the purchase is waiting on their approval, and where.",
      "Poll apiosk_approval_status with the approval_id, at most once every few seconds.",
      "When it reports approved, call apiosk_execute again with the same offer_id.",
    ],
  };
}

async function executeOffer(offerId, args, gateway) {
  const body = { offer_id: offerId };
  if (Number.isFinite(Number(args.max_price_usdc))) body.max_price_usdc = Number(args.max_price_usdc);
  if (args.input !== undefined) body.input = args.input;
  if (args.query !== undefined) body.query = args.query;
  if (args.path_params !== undefined) body.path_params = args.path_params;
  if (trimString(args.operation)) body.operation = trimString(args.operation);

  const result = await gateway.requestJson("/v1/do", { method: "POST", body });
  return { status: "ok", offer_id: offerId, ...asObject(result) };
}

async function executeSlug(slug, args, gateway) {
  const result = await gateway.execute(slug, args.input, {
    operation: args.operation,
    query: args.query,
    pathParams: args.path_params,
  });
  return { status: "ok", slug, result };
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
}
