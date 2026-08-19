// apiosk_compare — priced offers, with the arithmetic shown.
//
// Thin over src/flow.mjs. The scoring lives in the gateway; duplicating it here
// would mean two answers to the same question and no way to tell which one a
// decision was made on.

import { COMPARE_TOOL_INPUT_SCHEMA, runCompare } from "../flow.mjs";

export const COMPARE_TOOL = {
  name: "apiosk_compare",
  title: "Compare the candidates on price and measured performance",
  description:
    "Turn the candidates from apiosk_discover into offers you can act on: price per call, measured p95 latency, measured success rate and input compatibility, side by side, each scored 0-100 with the weights and per-dimension contributions that produced the number, so the score can be recomputed rather than trusted. Each offer carries a stable `offer_id` — show the offers to the user, let them choose, and pass the chosen id to apiosk_execute. Chain it after apiosk_discover by passing the same plain-words query. Dimensions Apiosk has not measured are named and dropped from the weighting, never scored zero. Reads only; spends nothing.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: COMPARE_TOOL_INPUT_SCHEMA,
};

export async function runCompareTool(args = {}, { gateway } = {}) {
  return runCompare(args, { gateway });
}
