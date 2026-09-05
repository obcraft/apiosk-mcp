// apiosk_job_status — what a running plan is doing. Reads only; spends nothing.
//
// One tool for the two reads that answer the same question. `GET /v1/jobs/:id`
// says where the job is now; `GET /v1/jobs/:id/events?after=` says what has
// happened since a cursor. They are one tool because an agent asking "how is it
// going" wants both, and because the events read is what makes this survivable:
// a conversation that was interrupted asks for everything after the cursor it
// last saw rather than having had to stay connected.
//
// A job started in the App reads back here, and one started here reads back in
// the App, because both read the same row through the same route. Nothing in
// this file knows which surface started it.

import { GatewayError } from "../gateway-client.mjs";
import { amountLabel, isJobRunning, normalizeJob } from "../plans.mjs";
import { content, errorContent, trimString } from "../tool-result.mjs";
import { connectUrl } from "./connect.mjs";

const MAX_EVENTS = 100;

export const JOB_STATUS_TOOL = {
  name: "apiosk_job_status",
  title: "Apiosk job status",
  description:
    "Read where a running plan has got to: its status, how many of the approved requests it has used, the ceiling it was approved against, and — when the job stopped to ask which subject was meant — the question with its candidates. Pass `after` with the cursor from the previous read to get only what happened since, which is how a conversation that was interrupted catches up without having stayed connected. The same job reads back identically in the Apiosk app, whichever surface started it. Poll at most once every few seconds, and stop polling once the status is succeeded, partial, failed, cancelled or expired. Reads only; spends nothing.",
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    required: ["job_id"],
    additionalProperties: false,
    properties: {
      job_id: {
        type: "string",
        description: "The job id apiosk_execute_plan returned, or the one shown against a job in the Apiosk app.",
      },
      after: {
        type: "number",
        description:
          "Optional event cursor. Pass the `cursor` from the previous read to receive only what happened since; leave it out on the first read.",
      },
      include_events: {
        type: "boolean",
        description: "Set false to read the status only and skip the event log. Defaults to true.",
      },
    },
  },
};

export async function runJobStatus(args = {}, { env = process.env, gateway } = {}) {
  const jobId = trimString(args.job_id);
  if (!jobId) {
    return errorContent({
      error_code: "job.no_job_id",
      message: "Missing required field: job_id. It is the id apiosk_execute_plan returned when the plan was started.",
    });
  }

  let payload;
  try {
    payload = await gateway.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}`);
  } catch (error) {
    return jobFailure(error, env);
  }

  const job = normalizeJob(payload);
  let events = [];
  let cursor = Number.isFinite(Number(args.after)) ? Number(args.after) : 0;
  if (args.include_events !== false) {
    try {
      const read = await gateway.requestJson(`/v1/jobs/${encodeURIComponent(jobId)}/events`, {
        query: { after: String(Math.max(0, cursor)), limit: String(MAX_EVENTS) },
      });
      events = Array.isArray(read?.events) ? read.events : [];
      cursor = Number.isFinite(Number(read?.cursor)) ? Number(read.cursor) : cursor;
    } catch {
      // The status is the answer to the question that was asked. An event log
      // that could not be read must never turn a healthy status read into a
      // failure the agent then reports as a broken job.
      events = [];
    }
  }

  const running = isJobRunning(job.job_status);
  const asking = Boolean(job.pending_question);
  return content({
    status: asking ? "asking" : running ? "running" : "finished",
    ...job,
    ceiling_label: amountLabel(job.ceiling_usdc),
    events,
    cursor,
    next_steps: asking
      ? [
          "The job paused because more than one subject matched. Show the candidates in `pending_question` and ask the user which one is meant, BY NAME.",
          "Answer with apiosk_resolve_job, passing the chosen candidate's `identity` exactly as it appears.",
          "Answering costs nothing: the lookup that produced these candidates has already been paid for.",
        ]
      : running
        ? [
            "Tell the user it is still running. Call this again with `after` set to `cursor` in a few seconds.",
            "The job keeps running whether or not this conversation stays open.",
          ]
        : [
            "The job is finished. Stop polling and answer the user's original question from the result.",
            "Nothing further will be spent on it.",
          ],
  });
}

function jobFailure(error, env) {
  if (!(error instanceof GatewayError)) throw error;

  if (error.status === 404 || error.code === "job_not_found") {
    return content({
      status: "not_found",
      error_code: error.code,
      message: error.message,
      next_steps: [
        "This session cannot see a job with that id. Check the id, and do not retry with a guessed one.",
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
