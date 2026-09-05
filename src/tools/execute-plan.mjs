// apiosk_execute_plan — redeem one approved plan version. This one spends.
//
// ONE WAY IN: a `plan_token`, exactly as apiosk_plan returned it. There is no
// second argument that could change what runs, because a token IS the
// authorisation — owner, plan version, plan hash, price ceiling and request
// budget, signed by the gateway that compiled them. This tool cannot build a
// plan and cannot edit one; it holds no compiler and no catalogue, and the only
// thing it does with the token is hand it back.
//
// IT ASKS NOTHING. The confirmation happened once, in apiosk_plan, with the
// price on the button. A second question in front of the token would be a
// second chance to answer a decision that was already made.
//
// ONE JOB PER APPROVED PLAN. The idempotency key is DERIVED FROM THE TOKEN
// rather than generated fresh, which is the opposite of what apiosk_execute
// does and the difference is deliberate. A single call is one purchase and a
// retry of it is a new one; a plan is a reservation against a ceiling, and a
// retried start with a fresh key would reserve the same money twice. The
// gateway deduplicates on (owner, idempotency_key), so two starts of the same
// approved version give one job.

import { createHash } from "node:crypto";

import { GatewayError } from "../gateway-client.mjs";
import { amountLabel, normalizeJob, planApprovalUrl } from "../plans.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";
import { connectUrl } from "./connect.mjs";

/**
 * The key that makes a repeated start one job.
 *
 * Domain-prefixed before hashing so the value cannot be replayed as anything
 * else derived from the same token, and truncated because the gateway caps the
 * key at 200 characters and 32 hex characters is already far past collision.
 */
export function jobKeyFor(planToken) {
  return `mcp-plan-${createHash("sha256").update(`apiosk-mcp-job:${planToken}`).digest("hex").slice(0, 32)}`;
}

export const EXECUTE_PLAN_TOOL = {
  name: "apiosk_execute_plan",
  title: "Apiosk run plan",
  description:
    "Start the plan the user approved, and return the job that runs it. Pass `plan_token` exactly as apiosk_plan returned it; it is the whole authorisation — the plan version, its hash and its one price ceiling, signed — so there is nothing else to pass and nothing here that could change what runs. Apiosk settles the calls from the connected balance, never above the ceiling that was approved. Call this only after a person approved that exact plan, and never to explore. It returns immediately with a job id: the work outlives this call, so watch it with apiosk_job_status, answer it with apiosk_resolve_job when it asks which subject was meant, and stop it with apiosk_cancel_job. If the plan changed or its quote expired since approval this refuses rather than starting — run apiosk_plan again and have the user approve the new one. Starting the same approved plan twice gives one job, not two.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  _meta: {
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": "Starting the approved plan…",
    "openai/toolInvocation/invoked": "Job started",
  },
  inputSchema: {
    type: "object",
    required: ["plan_token"],
    additionalProperties: false,
    properties: {
      plan_token: {
        type: "string",
        description:
          "The approved plan version, as `plan.plan_token` from apiosk_plan. Opaque: pass it back exactly as given. It carries the price ceiling, so there is no price for you to restate.",
      },
      idempotency_key: {
        type: "string",
        description:
          "Optional. Two starts with the same key give one job. Leave it out and one is derived from the plan token, which already means one job per approved plan.",
      },
    },
  },
};

export async function runExecutePlan(args = {}, { env = process.env, gateway } = {}) {
  const planToken = trimString(args.plan_token);
  if (!planToken) {
    return errorContent({
      error_code: "execute_plan.no_plan_token",
      message:
        "Nothing to start. Pass the `plan_token` from the plan the user approved, exactly as apiosk_plan returned it. This tool never builds a plan — if you no longer have the token, run apiosk_plan again and have the user approve the new one.",
    });
  }

  const body = {
    plan_token: planToken,
    idempotency_key: trimString(args.idempotency_key) || jobKeyFor(planToken),
  };

  let payload;
  try {
    payload = await gateway.requestJson("/v1/jobs", { method: "POST", body });
  } catch (error) {
    return startFailure(error, env);
  }

  const job = normalizeJob(payload);
  return content({
    status: "started",
    ...job,
    ceiling_label: amountLabel(job.ceiling_usdc),
    message: `The job is running. It will never spend more than ${amountLabel(job.ceiling_usdc)}, which is what was approved.`,
    next_steps: [
      "Tell the user the job started and that it keeps running whether or not this conversation stays open.",
      `Call apiosk_job_status with job_id ${job.job_id} to follow it; do not poll more often than every few seconds.`,
      "If it comes back with a pending_question, ask the user which candidate is meant and answer with apiosk_resolve_job.",
    ],
  });
}

/**
 * The refusals that are business states rather than failures.
 *
 * A stale plan is the important one: the quote expired, the plan moved, or the
 * fee schedule changed since the approval. None of those may be worked around
 * here — the answer is a new plan and a new approval, because the thing the
 * person said yes to is no longer the thing that would run.
 */
function startFailure(error, env) {
  if (!(error instanceof GatewayError)) throw error;

  if (["approval_expired", "plan_changed", "fees_changed"].includes(error.code)) {
    return content({
      status: "plan_stale",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "The approved plan is no longer the plan that would run. Do not retry this token.",
        "Call apiosk_plan again and have the user approve the new plan and its price.",
      ],
    });
  }
  if (["plan_token_invalid", "approval_not_yours"].includes(error.code) || error.status === 403) {
    return content({
      status: "not_authorised",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "This authorisation is not this session's to redeem. Do not retry it.",
        `Call apiosk_connect, and reconnect at ${connectUrl(env)} if it reports expired.`,
      ],
    });
  }
  if (error.status === 402) {
    return content({
      status: "payment_required",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "Call apiosk_connect to see whether the balance is empty or the plan is over a limit.",
        `Only the buyer can fund the balance or change limits at ${connectUrl(env)}.`,
        "Do not retry until that changes.",
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
  if (error.code === "plan_not_found") {
    return content({
      status: "plan_stale",
      error_code: error.code,
      message: error.message,
      next_steps: [
        `Run apiosk_plan again, or have the user open ${planApprovalUrl(env)} to see their plans.`,
      ],
    });
  }
  return errorContent(error.toJSON());
}
