import schemas from "./gateway-v2-contracts.json" with { type: "json" };
import { sourcesOutputSchema } from "./source-groups.mjs";

export const errorFields = {
  error_code: { type: "string" }, message: { type: "string" },
  request_id: { type: "string", format: "uuid" }, idempotency_key: { type: "string", format: "uuid" },
  recover_task_ref: { type: "string", format: "uuid" },
};
export const sourcesOutput = sourcesOutputSchema(errorFields);
const actionOutput = {
  type: "object", additionalProperties: false, required: ["action_id", "kind", "label", "requires_authorization", "input_schema"],
  properties: { action_id: { type: "string", format: "uuid" }, kind: { type: "string" }, label: { type: "string" }, requires_authorization: { type: "boolean" }, input_schema: { type: "object" } },
};
const proposalOutput = {
  type: "object", additionalProperties: false, required: ["label", "quote_ref", "price_status", "currency", "max_total_atomic", "expires_at", "approval_url", "steps", "step_details"],
  properties: {
    label: { type: "string" }, quote_ref: { type: "string", format: "uuid" }, price_status: { type: "string" }, currency: { type: "string" },
    max_total_atomic: { type: "string", pattern: "^[0-9]+$" }, expires_at: { type: "string", format: "date-time" }, approval_url: { type: "string", format: "uri" },
    steps: { type: "array", items: { type: "string" } }, step_details: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};
export const taskOutput = {
  type: "object", additionalProperties: false,
  properties: {
    protocol_version: { type: "string", const: "2" }, request_id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["ready", "needs_input", "needs_selection", "requires_approval", "running", "cancelled", "succeeded", "partial", "unsupported", "state_conflict", "failed"] },
    intent_ref: { type: ["string", "null"], format: "uuid" }, context_view: { type: "object", additionalProperties: true },
    proposal: { anyOf: [proposalOutput, { type: "null" }] }, result: {}, billing: {},
    next_actions: { type: "array", items: actionOutput }, state: { anyOf: [schemas.state, { type: "null" }] },
    errors: { type: "array", items: { type: "object", additionalProperties: true } }, retry_after_ms: { type: "integer", minimum: 0 }, ...errorFields,
  },
  anyOf: [{ required: ["protocol_version", "request_id", "status", "context_view", "proposal", "result", "next_actions", "state", "errors"] }, { required: ["error_code", "message"] }],
};

