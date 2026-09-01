// The approvals client: GET /v1/approvals/:id on the gateway.
//
// When the buyer's policy says a human must say yes, the gateway holds the
// purchase instead of paying it and hands back an approval id. This module is
// the only thing in the MCP that reads that hold's state; the decision, the
// hold and its expiry all live gateway-side (gateway/02). Nothing here decides
// anything — it reports.

import { GatewayError } from "./gateway-client.mjs";
import { trimString } from "./tool-result.mjs";

export const APPROVAL_STATES = ["pending", "approved", "denied", "expired"];

const BUYER_PORTAL_URL = "https://buy.apiosk.com";

/**
 * Read one held purchase.
 *
 * Returns a normalised state the agent can branch on rather than the gateway's
 * raw row, so a field rename gateway-side does not change what the model sees.
 */
export async function getApprovalStatus(approvalId, { gateway } = {}) {
  const id = trimString(approvalId);
  if (!id) {
    return { status: "error", error_code: "approval.missing_id", message: "Missing required field: approval_id." };
  }

  let payload;
  try {
    payload = await gateway.requestJson(`/v1/approvals/${encodeURIComponent(id)}`);
  } catch (error) {
    if (error instanceof GatewayError && error.status === 404) {
      return {
        status: "unknown",
        approval_id: id,
        error_code: "approval.not_found",
        message: `No held purchase with id ${id}. It may belong to a different connection, or it may have been cleaned up after expiry.`,
      };
    }
    throw error;
  }

  const state = trimString(payload?.state || payload?.status).toLowerCase();
  const normalised = APPROVAL_STATES.includes(state) ? state : "pending";

  return {
    status: normalised,
    approval_id: id,
    offer_token: payload?.offer_token ?? null,
    max_price_usdc: payload?.max_price_usdc ?? null,
    offer_id: payload?.offer_id ?? null,
    amount_usdc: payload?.amount_usdc ?? null,
    reason: payload?.reason ?? null,
    requested_at: payload?.requested_at ?? null,
    expires_at: payload?.expires_at ?? null,
    decided_at: payload?.decided_at ?? null,
    approve_url: payload?.approve_url ?? `${BUYER_PORTAL_URL}/`,
    next_step: nextStep(normalised, payload),
  };
}

function nextStep(state, payload) {
  switch (state) {
    case "approved":
      return "Approved. Call apiosk_execute again with the same offer_token, max_price_usdc and approval_id to complete the purchase.";
    case "denied":
      return "The buyer declined this purchase. Do not retry it. Ask what they would rather do.";
    case "expired":
      return "The hold expired before anyone answered. Call apiosk_compare again for a fresh price, then apiosk_execute.";
    default:
      return `Still waiting on the buyer${
        payload?.expires_at ? `, until ${payload.expires_at}` : ""
      }. Approve it on the Apiosk Home page at ${BUYER_PORTAL_URL}. Do not poll faster than once every few seconds, and do not retry the purchase in the meantime.`;
  }
}
