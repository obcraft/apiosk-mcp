// apiosk_approval_status — the state of a held purchase.
//
// The only tool in the surface that exists because a person might say no.

import { getApprovalStatus } from "../approvals.mjs";
import { content, errorContent } from "../tool-result.mjs";

export const APPROVAL_STATUS_TOOL = {
  name: "apiosk_approval_status",
  title: "Check a purchase waiting for approval",
  description:
    "Read the state of a purchase the buyer's rules put on hold: pending, approved, denied or expired, with the reason and the deadline. Call it only after apiosk_execute returned `status: approval_required` with an approval_id. When it comes back approved, call apiosk_execute again with the same offer_id; when denied, do not retry — tell the user and ask what they want instead. Poll at most once every few seconds. Reads only; spends nothing.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    required: ["approval_id"],
    additionalProperties: false,
    properties: {
      approval_id: {
        type: "string",
        description: "The approval id returned by apiosk_execute when the purchase was held.",
      },
    },
  },
};

export async function runApprovalStatus(args = {}, { gateway } = {}) {
  const result = await getApprovalStatus(args.approval_id, { gateway });
  return result.status === "error" ? errorContent(result) : content(result);
}
