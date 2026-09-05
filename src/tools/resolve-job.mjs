// apiosk_resolve_job — answer the one question a job may stop to ask.
//
// It costs nothing, and that is a fact about the flow rather than a promise:
// the lookup that produced the candidates has already run and already been
// charged. This records one of them and lets the branch continue.
//
// THE ANSWER IS A CANDIDATE, NOT A DESCRIPTION. `chosen` must equal the
// `identity` of one of the candidates the job offered, exactly as offered. The
// gateway refuses anything else with `not_a_candidate`, which is what stops a
// confident model from resuming a paid job against a company nobody picked.

import { GatewayError } from "../gateway-client.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";

export const RESOLVE_JOB_TOOL = {
  name: "apiosk_resolve_job",
  title: "Apiosk answer job",
  description:
    "Answer the question a running plan stopped to ask. A job pauses when a lookup matched more than one subject — several companies of the same name, say — and it cannot continue until a person says which one was meant. Read the candidates from `pending_question` in apiosk_job_status, show them to the user with the details that tell them apart, and ask BY NAME, never by number. Then pass `node_key` from that question and `chosen` set to the chosen candidate's `identity`, copied exactly: an answer that is not one of the offered candidates is refused rather than guessed at. Do not choose on the user's behalf, and do not answer from the question text alone. This records the answer on the external job and resumes it; answering spends nothing because the lookup that produced these candidates was already paid for.",
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  inputSchema: {
    type: "object",
    required: ["job_id", "node_key", "chosen"],
    additionalProperties: false,
    properties: {
      job_id: { type: "string", description: "The job that is asking." },
      node_key: {
        type: "string",
        description: "`pending_question.node_key` from apiosk_job_status. It says which step the answer belongs to.",
      },
      chosen: {
        description:
          "The `identity` of the candidate the user chose, copied exactly from `pending_question.candidates`. Any JSON type, whatever the candidate carried.",
      },
    },
  },
};

export async function runResolveJob(args = {}, { gateway } = {}) {
  const jobId = trimString(args.job_id);
  const nodeKey = trimString(args.node_key);
  if (!jobId || !nodeKey || args.chosen === undefined || args.chosen === null) {
    return errorContent({
      error_code: "job.resolve_incomplete",
      message:
        "An answer needs all three of job_id, node_key and chosen. Read node_key and the candidates from `pending_question` in apiosk_job_status, and pass the chosen candidate's `identity` unchanged.",
    });
  }

  let payload;
  try {
    payload = await gateway.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/resolve`, {
      method: "POST",
      body: { node_key: nodeKey, chosen: args.chosen },
    });
  } catch (error) {
    return resolveFailure(error);
  }

  return content({
    status: "resolved",
    job_id: jobId,
    node_key: nodeKey,
    chosen: args.chosen,
    resolved: payload?.resolved !== false,
    message: "The job has the answer and continues from where it paused. Nothing was spent on answering.",
    next_steps: [
      `Call apiosk_job_status with job_id ${jobId} in a few seconds to follow it.`,
      "Do not send the same answer again; it is recorded.",
    ],
  });
}

function resolveFailure(error) {
  if (!(error instanceof GatewayError)) throw error;

  if (error.code === "not_a_candidate") {
    return content({
      status: "not_a_candidate",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "That answer was not one of the candidates the job offered. Do not adjust it and retry.",
        "Read `pending_question.candidates` again with apiosk_job_status and pass one `identity` exactly as it appears.",
      ],
    });
  }
  if (["job_not_asking", "wrong_question"].includes(error.code)) {
    return content({
      status: "not_asking",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "This job is not waiting for this answer — it may have been answered already, or moved on.",
        "Read apiosk_job_status before answering again.",
      ],
    });
  }
  if (error.status === 404 || error.code === "job_not_found") {
    return content({
      status: "not_found",
      error_code: error.code,
      message: error.message,
      next_steps: ["This session cannot see a job with that id. Check the id, and do not retry with a guessed one."],
    });
  }
  return errorContent(error.toJSON());
}
