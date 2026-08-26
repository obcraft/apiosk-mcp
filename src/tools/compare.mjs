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
    "Turn a job into priced offers you can act on: price per call, a 0-100 score, measured p95 latency and measured success rate, side by side. Each offer carries a stable `offer_id` that PINS the endpoint and that exact price for about fifteen minutes — the result comes back with a finished table in `presentation` to print as-is, numbered so the user can answer with a number, and you then pass THAT offer's `offer_id` to apiosk_execute, which is then refused rather than paid if the real price has moved above what you showed. The reviewed Apiosk offers come back beside the live x402 endpoints the gateway swept from the wider ecosystem for the same job — those carry no offer_id and are paid to the provider directly, and the table marks which is which, so the user compares the whole market rather than one shelf. Chain it after apiosk_discover by passing the same plain-words query. Dimensions Apiosk has not measured come back null, never a plausible default. Reads only; spends nothing.",
  // openWorld, because it is: the quote now sweeps the x402 indexes beside the
  // catalogue, so what comes back depends on a world outside this gateway.
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: COMPARE_TOOL_INPUT_SCHEMA,
};

export async function runCompareTool(args = {}, { gateway } = {}) {
  return runCompare(args, { gateway });
}
