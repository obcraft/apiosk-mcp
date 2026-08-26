// apiosk_execute — the one tool in this surface that settles a call.
//
// It runs one offer the user chose, under a price ceiling the user saw, and
// returns the normalised result. It does not choose, it does not price, and it
// does not settle: the gateway does all three. What lives here is the contract
// with the agent — what it must have decided before calling, and what each
// non-success outcome means for the next turn.
//
// Three ways in, and the first is the one to use:
//
//   offer_id  a stable id from apiosk_compare, priced and pinned. The gateway
//             executes exactly that offer at exactly that price.
//   slug      an Apiosk catalogue listing, priced at call time. The path that
//             existed before offers had identity; kept for callers that already
//             know which listing they want.
//   url       an x402 endpoint outside the catalogue, from the rows
//             apiosk_compare marks `settlement: "apiosk"`. There is no offer_id
//             to pin — nobody reviewed the endpoint and no price was signed —
//             so the caller states the provider price it was shown and the
//             gateway refuses rather than pays if the live 402 asks for more.
//             The gateway fronts the provider's own 402 from the platform
//             wallet and debits the buyer list + 10%, the same fee every other
//             purchase here carries (`POST /v1/x402/fetch`).

import { randomUUID } from "node:crypto";

import { ApioskPaymentRequiredError, GatewayError } from "../gateway-client.mjs";
import { connectUrl } from "./connect.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";

export const EXECUTE_TOOL = {
  name: "apiosk_execute",
  title: "Run the chosen API call",
  description:
    "Run the offer the user chose and return the result. Apiosk settles the call from the connected balance, at the price that was shown: pass the `offer_id` from apiosk_compare, plus `max_price_usdc` set to that price — the call is refused rather than settled if the real price is above it. For a row that came from an x402 index rather than the catalogue there is no offer_id: pass that row's `url` and its `confirmed_price_usdc` (the provider's own price, `list_price_usdc`) with `max_price_usdc` set to the total you showed, and Apiosk pays the provider and bills you that total. Before calling: state the exact price to the user and have them choose; never pick for them and never call this to explore. If the buyer's rules require a human to approve, this returns `status: approval_required` with an approval_id — poll apiosk_approval_status, then call this again with the same offer_id once approved. If it returns `status: payment_required`, the wallet is empty or over its limit: call apiosk_connect to see which, and do not retry.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: {
    "openai/outputTemplate": "ui://apiosk/result-canvas.html",
    "openai/toolInvocation/invoking": "Running the chosen call…",
    "openai/toolInvocation/invoked": "Result received",
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
      url: {
        type: "string",
        description:
          "An external x402 endpoint to run and settle through Apiosk — the `url` of a row apiosk_compare or apiosk_discover marked `settlement: \"apiosk\"`. Requires confirmed_price_usdc.",
      },
      method: {
        type: "string",
        description:
          "External endpoints only: the HTTP method the row publishes (`method`). Defaults to GET.",
      },
      confirmed_price_usdc: {
        type: "number",
        description:
          "External endpoints only: the PROVIDER's own price you showed the user (`list_price_usdc`), not the total. The gateway refuses rather than pays if the live 402 asks for more than this.",
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
  const url = trimString(args.url);

  if (!offerId && !slug && !url) {
    return errorContent({
      error_code: "execute.no_subject",
      message:
        "Nothing to execute. Pass the `offer_id` the user chose from apiosk_compare, an Apiosk catalogue `slug`, or the `url` of an external row Apiosk can settle.",
    });
  }

  // An external endpoint has no signed price, so the one the user was shown has
  // to travel with the call. Without it the gateway would have to accept
  // whatever the live 402 asks, which is how a $0.005 row becomes a $5 charge.
  if (!offerId && !slug && !Number.isFinite(Number(args.confirmed_price_usdc))) {
    return errorContent({
      error_code: "execute.no_confirmed_price",
      message:
        "An external endpoint needs `confirmed_price_usdc` — the provider's own price from the row you showed the user (`list_price_usdc`). Without it there is no ceiling to refuse against.",
    });
  }

  try {
    const result = offerId
      ? await executeOffer(offerId, args, gateway)
      : slug
        ? await executeSlug(slug, args, gateway)
        : await executeExternal(url, args, gateway);
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

/**
 * Run and settle an x402 endpoint outside the Apiosk catalogue.
 *
 * `POST /v1/x402/fetch` is the gateway-as-payer route: it preflights the
 * endpoint's own 402, refuses unless the price is at or under what the user was
 * shown, pays the provider from the platform wallet, and debits the buyer that
 * price plus Apiosk's 10%. The provider is paid their full asking price; the
 * markup is Apiosk's, exactly as on a catalogue call.
 *
 * The idempotency key is generated here and is the reason a retry after a
 * timeout cannot pay twice: the gateway records the key before it pays and
 * replays the outcome instead of the payment.
 */
async function executeExternal(url, args, gateway) {
  const body = {
    url,
    confirmed_price_usdc: Number(args.confirmed_price_usdc),
    method: trimString(args.method) || undefined,
  };
  // The ceiling the user actually saw is the TOTAL, fee included, so it bounds
  // the total rather than the provider's leg.
  if (Number.isFinite(Number(args.max_price_usdc))) body.max_total_usdc = Number(args.max_price_usdc);
  if (args.input !== undefined) body.body = args.input;
  if (args.query !== undefined) body.query = args.query;

  const result = await gateway.requestJson("/v1/x402/fetch", {
    method: "POST",
    body,
    extraHeaders: { "idempotency-key": randomUUID() },
  });
  return { status: "ok", url, settlement: "apiosk", ...asObject(result) };
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
