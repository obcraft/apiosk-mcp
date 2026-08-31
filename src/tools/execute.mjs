// apiosk_execute — the one tool in this surface that settles a call.
//
// It runs one offer the user chose, under a price ceiling the user saw, and
// returns the normalised result. It does not choose, it does not price, and it
// does not settle: the gateway does all three. What lives here is the contract
// with the agent — what it must have decided before calling, and what each
// non-success outcome means for the next turn.
//
// ONE WAY IN: `offer_token`, exactly as apiosk_discover returned it.
//
// There used to be three — `offer_id`, `slug`, `url` — and all three named a
// thing for the settlement gateway to price at call time. Pricing at call time
// is what the signed offer replaced: the token IS the price the user was shown,
// signed by the gateway that decided it, so the number on the screen and the
// number that leaves the balance cannot drift apart.
//
// It also closed a second payment path. The old routes were `POST /v1/do` and
// `POST /v1/x402/fetch` on the settlement gateway, reached with the buyer's own
// connect token — this server asking that gateway to spend a buyer's wallet
// directly. Now it is `/v1/select` then `/v1/run` on the agent gateway, which
// is the app's own path: the treasury pays and the balance drops, reserved and
// settled in `_shared/execution.ts`. Both of the old branches still happen, one
// layer down, chosen from the selection's own kind.

import { randomUUID } from "node:crypto";

import { ApioskPaymentRequiredError, GatewayError } from "../gateway-client.mjs";
import { connectUrl } from "./connect.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";

export const EXECUTE_TOOL = {
  name: "apiosk_execute",
  title: "Run the chosen API call",
  description:
    "Run the offer the user chose and return the result. Apiosk settles the call from the connected balance, at the price that was shown. Pass `offer_token` exactly as apiosk_discover returned it for the row the user picked, `prompt` set to the job you searched for, and `max_price_usdc` set to the price you showed — the call is refused rather than settled if the real price is above it. The token pins the endpoint and the price together, so there is nothing else to state and no price for you to restate. Before calling: say the exact price to the user and have them choose; never pick for them and never call this to explore. A token is good for an hour — if the user takes longer, run apiosk_discover again and use the fresh one. If the buyer's rules require a human to approve, this returns `status: approval_required` with an approval_id: poll apiosk_approval_status, then call this again with the same offer_token once approved. If it returns `status: payment_required`, the balance is empty or over its limit: call apiosk_connect to see which, and do not retry.",
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
      offer_token: {
        type: "string",
        description:
          "The row the user chose, as `offer_token` from apiosk_discover. Opaque: pass it back exactly as given. It pins the endpoint AND the price the user was shown, and is good for one hour.",
      },
      prompt: {
        type: "string",
        description:
          "The job you searched for, in the user's own words. Recorded with the pick so the purchase reads back as an answer to a question rather than a bare charge.",
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
  const offerToken = trimString(args.offer_token);

  if (!offerToken) {
    /* ONE WAY IN NOW, where there were three. `slug` and `url` named a thing
       for the settlement gateway to price at call time, and pricing at call
       time is what the signed offer replaced: the price the user was shown is
       the price that gets charged, because it is the one that was signed. A
       caller holding either still has the row it came from, and that row
       carries the token. */
    return errorContent({
      error_code: "execute.no_offer_token",
      message:
        "Nothing to execute. Pass the `offer_token` of the row the user chose, exactly as apiosk_discover returned it. If you no longer have it, run apiosk_discover again — a token is only good for an hour.",
    });
  }

  try {
    return content(await executeSignedOffer(offerToken, args, gateway));
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
      "When it reports approved, call apiosk_execute again with the same offer_token.",
    ],
  };
}

/**
 * Buy it, through the one payment path there is.
 *
 * TWO CALLS WHERE THERE USED TO BE ONE, and the second one is the whole change.
 * This used to POST `/v1/do` (catalogue) or `/v1/x402/fetch` (external) on the
 * settlement gateway, holding the buyer's own connect token — which meant this
 * server could ask that gateway to spend a buyer's wallet directly, beside the
 * path the app uses. Apiosk has one payment path: the treasury pays and the
 * BALANCE drops, reserved and settled in `_shared/execution.ts`.
 *
 * `/v1/select` records the pick and `/v1/run` runs it, and `/v1/run` chooses
 * between `/v1/do` and `/v1/x402/fetch` itself, from the selection's own kind.
 * So both of the branches this function used to have still happen — one layer
 * down, where the reservation and the settlement are.
 *
 * THE OFFER IS NOT REBUILT HERE. `offer_token` is what discovery handed back:
 * the offer the gateway priced, signed by it. This server never learns what is
 * inside it and could not alter it if it did.
 *
 * The idempotency key is generated here and is why a retry after a timeout
 * cannot pay twice: the charge is recorded under the key before anything is
 * paid, and a repeat replays the outcome instead of the payment.
 */
async function executeSignedOffer(offerToken, args, gateway) {
  const prompt = trimString(args.prompt) || trimString(args.query_text) || "an agent's request";

  const selection = asObject(
    await gateway.requestJson("/v1/select", {
      method: "POST",
      body: { prompt, offer_token: offerToken },
    })
  );
  const selectionId = trimString(selection.selection_id ?? selection.id);
  if (!selectionId) {
    throw new GatewayError("Apiosk recorded the pick but returned no selection to run.", {
      code: "execute.no_selection",
      status: 502,
      body: selection,
    });
  }

  const body = {
    selection_id: selectionId,
    inputs: args.input ?? {},
    idempotency_key: randomUUID(),
  };
  // The ceiling the user actually saw is the TOTAL, fee included, so it bounds
  // what leaves the balance rather than the provider's leg of it.
  if (Number.isFinite(Number(args.max_price_usdc))) body.max_price_usdc = Number(args.max_price_usdc);
  if (args.query !== undefined) body.query = args.query;
  if (args.path_params !== undefined) body.path_params = args.path_params;
  if (trimString(args.operation)) body.operation = trimString(args.operation);

  const result = await gateway.requestJson("/v1/run", { method: "POST", body });
  return { status: "ok", selection_id: selectionId, ...asObject(result) };
}


function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
}
