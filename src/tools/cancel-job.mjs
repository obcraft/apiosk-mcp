// apiosk_cancel_job — stop a running plan from dispatching anything further.
//
// WHAT CANCEL IS AND IS NOT. It stops future dispatches. It does not unsend a
// request that has already left, and it is not a refund: a call already made is
// settled by the worker, which is the honest answer rather than a comforting
// one. Saying "cancelled, nothing charged" about a request in flight would be a
// claim this server cannot make and the reconciliation would contradict.
//
// A conversation ending is not this. Cancelling is a thing a person decides,
// and a closed chat window has never been that decision.

import { GatewayError } from "../gateway-client.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";

export const CANCEL_JOB_TOOL = {
  name: "apiosk_cancel_job",
  title: "Apiosk cancel job",
  description:
    "Stop a running plan. Call it only when the user asks to stop — never because a conversation is ending, and never to tidy up a job you are done watching, since a job keeps running perfectly well without this session. It stops further calls from being dispatched; calls already sent are still settled, so tell the user that rather than promising nothing was charged. A cancelled job stays visible and readable in the Apiosk app and through apiosk_job_status. Spends nothing itself, and cannot spend less than what has already been called.",
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    required: ["job_id"],
    additionalProperties: false,
    properties: {
      job_id: { type: "string", description: "The job the user asked to stop." },
    },
  },
};

export async function runCancelJob(args = {}, { gateway } = {}) {
  const jobId = trimString(args.job_id);
  if (!jobId) {
    return errorContent({
      error_code: "job.no_job_id",
      message: "Missing required field: job_id. Only cancel a job the user has asked you to stop.",
    });
  }

  let payload;
  try {
    payload = await gateway.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", body: {} });
  } catch (error) {
    return cancelFailure(error);
  }

  return content({
    status: "cancelled",
    job_id: jobId,
    cancelled: payload?.cancelled !== false,
    message:
      payload?.note ||
      "No further calls will be dispatched. Calls already sent are settled, so this is a stop rather than a refund.",
    next_steps: [
      "Tell the user it is stopped, and that anything already called is still settled.",
      `Call apiosk_job_status with job_id ${jobId} once if they want to see what it had reached.`,
    ],
  });
}

function cancelFailure(error) {
  if (!(error instanceof GatewayError)) throw error;

  if (error.status === 404 || error.code === "job_not_found") {
    return content({
      status: "not_found",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "This session cannot see a job with that id — it may already have finished, or belong to someone else.",
        "Check the id with apiosk_job_status, and do not retry with a guessed one.",
      ],
    });
  }
  return errorContent(error.toJSON());
}
