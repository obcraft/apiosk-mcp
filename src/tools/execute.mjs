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

import { createHash } from "node:crypto";

import { ApioskPaymentRequiredError, GatewayError } from "../gateway-client.mjs";
import { connectUrl } from "./connect.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";

export const EXECUTE_TOOL = {
  name: "apiosk_execute",
  title: "Apiosk run",
  description:
    "Run the offer the user chose and return the result. Apiosk settles the call from the connected balance, at the price that was shown. Pass `offer_token` exactly as apiosk_discover returned it for the row the user picked, `prompt` set to the job you searched for, and `max_price_usdc` set to the price you showed — the call is refused rather than settled if the real price is above it. The token pins the endpoint and the price together, so there is nothing else to state and no price for you to restate. Before calling: say the exact price to the user and have them choose; never pick for them and never call this to explore. A token is good for an hour — if the user takes longer, run apiosk_discover again and use the fresh one. If the buyer's rules require a human to approve, this returns `status: approval_required` with an approval_id: poll apiosk_approval_status, then call this again with the same offer_token once approved. If it returns `status: payment_required`, the balance is empty or over its limit: call apiosk_connect to see which, and do not retry.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  _meta: {
    "openai/outputTemplate": "ui://apiosk/result-canvas.html",
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Running the chosen call…",
    "openai/toolInvocation/invoked": "Result received",
    ui: { resourceUri: "ui://apiosk/result-canvas.html", visibility: ["model", "app"] },
  },
  inputSchema: {
    type: "object",
    required: ["offer_token", "prompt", "max_price_usdc"],
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
      approval_id: {
        type: "string",
        description: "Optional approval id returned by apiosk_execute after an approval_required hold.",
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
      input_parts: {
        type: "object",
        additionalProperties: false,
        description: "Optional exact split of provider inputs by path, query and body. The Apiosk approval card supplies this automatically.",
        properties: {
          path: { type: "object", additionalProperties: true },
          query: { type: "object", additionalProperties: true },
          body: { type: "object", additionalProperties: true },
        },
      },
    },
  },
};

export async function runExecute(args = {}, { env = process.env, gateway } = {}) {
  const offerToken = trimString(args.offer_token);
  const approvalId = trimString(args.approval_id);

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
    const value = await executeSignedOffer(offerToken, approvalId, args, gateway);
    const result = content(value);
    if (typeof value.answer === "string" && value.answer.trim()) {
      result.content = [{ type: "text", text: value.answer }];
    }
    return result;
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
      if (isApprovalError(error)) {
        return content(approvalPayload(error, offerToken, args));
      }
      if (error.status === 402) {
        return content(paymentRequiredPayload(error, env));
      }
      if (error.status === 403 && error.code === "limit_exceeded") {
        return content({
          status: "limit_exceeded",
          error_code: error.code,
          message: error.message,
          next_steps: [
            "Do not retry this purchase.",
            `The buyer can review this connection's limits at ${connectUrl(env)}.`,
          ],
        });
      }
      if (error.status === 401 || ["unauthorized", "invalid_token", "expired"].includes(error.code)) {
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

function isApprovalError(error) {
  const body = error.body || {};
  return (
    error.code === "policy.approval_required" ||
    error.code === "approval_required" ||
    body.status === "approval_required" ||
    body.error === "approval_required" ||
    body.error_code === "approval_required"
  );
}

function paymentRequiredPayload(error, env) {
  return {
    status: "payment_required",
    error_code: error.code,
    message: error.message,
    balance_micro_usd: error.body?.balance_micro_usd ?? null,
    required_micro_usd: error.body?.required_micro_usd ?? null,
    next_steps: [
      "Call apiosk_connect to distinguish an empty balance from a connection limit.",
      `Only the buyer can fund the balance or change limits at ${connectUrl(env)}.`,
      "Do not retry until that state changes.",
    ],
  };
}

function approvalPayload(error, offerToken, args) {
  const body = error.body || {};
  const shownPrice = Number(args.max_price_usdc);
  return {
    status: "approval_required",
    approval_id: body.approval_id ?? null,
    offer_token: offerToken ?? null,
    max_price_usdc: body.max_price_usdc ?? (Number.isFinite(shownPrice) ? shownPrice : null),
    error_code: error.code,
    amount_usdc: body.amount_usdc ?? body.price_usdc ?? null,
    reason: body.reason ?? error.message,
    expires_at: body.expires_at ?? null,
    approve_url: body.approve_url ?? null,
    next_steps: [
      "Tell the user the purchase is waiting on their approval, and where.",
      "Poll apiosk_approval_status with the approval_id, at most once every few seconds.",
      "When it reports approved, call apiosk_execute again with the same offer_token, max_price_usdc and approval_id.",
    ],
    message:
      "The buyer's rules hold this purchase until a person approves it. Nothing has been paid and nothing has been called.",
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
async function executeSignedOffer(offerToken, approvalId, args, gateway) {
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
    idempotency_key: executionKey(offerToken, args),
  };
  // The ceiling the user actually saw is the TOTAL, fee included, so it bounds
  // what leaves the balance rather than the provider's leg of it.
  if (Number.isFinite(Number(args.max_price_usdc))) body.max_price_usdc = Number(args.max_price_usdc);
  const suppliedParts = asInputParts(args.input_parts);
  const derivedParts = {
    path: asRecord(args.path_params),
    query: asRecord(args.query),
    body: asRecord(args.input),
  };
  const inputParts = suppliedParts ?? derivedParts;
  if (Object.values(inputParts).some((part) => Object.keys(part).length > 0)) {
    body.input_parts = inputParts;
  }
  if (trimString(args.operation)) body.operation = trimString(args.operation);
  if (approvalId) body.approval_id = approvalId;

  const result = await gateway.requestJson("/v1/run", { method: "POST", body, timeout: 90_000 });
  return { status: "ok", selection_id: selectionId, ...asObject(result) };
}

// A retry of the same signed offer and exact inputs is the same purchase,
// including across MCP restarts. The ledger accepts UUID-v4-shaped keys.
export function executionKey(offerToken, args) {
  function canonical(value) {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
    return value;
  }
  const parts = asInputParts(args.input_parts) ?? { path: asRecord(args.path_params), query: asRecord(args.query), body: asRecord(args.input) };
  const hash = createHash("sha256").update(JSON.stringify(canonical({ offerToken, parts, operation: trimString(args.operation) }))).digest();
  hash[6] = (hash[6] & 15) | 64;
  hash[8] = (hash[8] & 63) | 128;
  const id = hash.subarray(0, 16).toString("hex");
  return `${id.slice(0,8)}-${id.slice(8,12)}-${id.slice(12,16)}-${id.slice(16,20)}-${id.slice(20)}`;
}


function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : { result: value };
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function asInputParts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    path: asRecord(value.path),
    query: asRecord(value.query),
    body: asRecord(value.body),
  };
}
