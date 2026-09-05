// The plan half of the surface, against the gateway's real response shape.
//
// The fixtures below are `PlanResponse` (gateway/src/v1_routes/plans.rs) and
// `JobResponse` (gateway/src/v1_routes/jobs.rs) field for field, including the
// per-node `buyer_total_atomic` that the gateway does send and this surface
// deliberately does not show. Testing against a hand-simplified shape would
// prove that this code agrees with itself.
//
// Four things are asserted here, and each is a release gate:
//
//   the amount and the hash are the GATEWAY'S, copied, never recomputed — that
//   is the only way the App and an MCP client can show the same two numbers;
//
//   apiosk_plan spends nothing and asks once;
//
//   apiosk_execute_plan takes a plan_token and cannot take anything that would
//   let it build or alter a plan;
//
//   a job started here reads back, answers and cancels through the same routes
//   the App reads it through.

import test from "node:test";
import assert from "node:assert/strict";

import { GatewayError } from "../src/gateway-client.mjs";
import { PLAN_TOOL, runPlan } from "../src/tools/plan.mjs";
import { EXECUTE_PLAN_TOOL, jobKeyFor, runExecutePlan } from "../src/tools/execute-plan.mjs";
import { JOB_STATUS_TOOL, runJobStatus } from "../src/tools/job-status.mjs";
import { runResolveJob } from "../src/tools/resolve-job.mjs";
import { CANCEL_JOB_TOOL, runCancelJob } from "../src/tools/cancel-job.mjs";
import { normalizePlan } from "../src/plans.mjs";
import { EXECUTE_TOOL } from "../src/tools/execute.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";

const parse = (result) => JSON.parse(result.content[0].text);

const PLAN_ID = "3b1f0f5e-0a1e-4f0a-9c1a-7c9a1f0e2b31";
const VERSION_ID = "8d2a1c44-9d1f-4a3e-8e51-1f0b2c3d4e5f";
const JOB_ID = "6c5b4a39-2e1d-4c0b-8a97-5d4c3b2a1908";
const PLAN_HASH = "4f1d9c0b8a7e6d5c4b3a29180f1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6";
const PLAN_TOKEN = "pt_v1.eyJvd25lciI6InUifQ.c2ln";

// Three KVK nodes: one identity lookup two profile branches both need. The
// node amounts sum to the total, and none of them may appear in a tool result.
const NODE_ATOMIC = [21_738, 76_086, 76_086];
const TOTAL_ATOMIC = NODE_ATOMIC.reduce((a, b) => a + b, 0); // 173_910 = $0.17391

function node(id, capability, price, dependsOn = [], mayAsk = false) {
  return {
    id,
    contract_id: `c_${id}`,
    endpoint_id: `e_${id}`,
    capability_slug: capability,
    api_slug: "kvk-dutch-business-register",
    endpoint_path: `/${id}`,
    subject_role: "subject",
    produces: [capability],
    depends_on: dependsOn,
    bindings: { "company.name": { from: "known", value: "Mollie B.V." } },
    buyer_total_atomic: price,
    may_ask: mayAsk,
  };
}

/** `PlanResponse` as `POST /v1/plans` serialises it. */
const PLAN_RESPONSE = {
  plan_id: PLAN_ID,
  version_id: VERSION_ID,
  version: 1,
  plan_hash: PLAN_HASH,
  question: "Is Mollie a healthy company?",
  expires_at: "2026-09-05T12:30:00Z",
  plan: {
    nodes: [
      node("n_lookup", "company.identity", NODE_ATOMIC[0], [], true),
      node("n_profile", "company.profile", NODE_ATOMIC[1], ["n_lookup"]),
      node("n_filings", "company.financial-statements", NODE_ATOMIC[2], ["n_lookup"]),
    ],
    coverage: [
      { fact_type: "company.name", required: true, status: "already_known" },
      { fact_type: "company.profile", required: true, node_id: "n_profile", status: "planned" },
      { fact_type: "company.financial_statements", required: true, node_id: "n_filings", status: "planned" },
      { fact_type: "building.bag_id", required: false, status: "unreachable" },
    ],
    quote: {
      buyer_total_atomic: TOTAL_ATOMIC,
      lines: [
        { node_id: "n_lookup", capability_slug: "company.identity", buyer_total_atomic: NODE_ATOMIC[0] },
        { node_id: "n_profile", capability_slug: "company.profile", buyer_total_atomic: NODE_ATOMIC[1] },
        { node_id: "n_filings", capability_slug: "company.financial-statements", buyer_total_atomic: NODE_ATOMIC[2] },
      ],
      eur: { cents: 16, rate_micro: 920_000, taken_at: "2026-09-05T12:00:00Z" },
    },
    format: "json",
    limits: { max_nodes: 12, max_depth: 4, max_buyer_total_atomic: 5_000_000, max_concurrency: 3 },
  },
  summary: {
    paid_calls: 3,
    steps_deep: 2,
    buyer_total_atomic: TOTAL_ATOMIC,
    eur_cents: 16,
    format: "json",
    may_ask: true,
    missing: ["building.bag_id"],
  },
  plan_token: PLAN_TOKEN,
};

/** `JobResponse` as `POST /v1/jobs` and `GET /v1/jobs/:id` serialise it. */
const JOB_RESPONSE = {
  job_id: JOB_ID,
  status: "queued",
  plan_id: PLAN_ID,
  plan_version_id: VERSION_ID,
  plan_hash: PLAN_HASH,
  buyer_total_ceiling_atomic: TOTAL_ATOMIC,
  requests_made: 0,
  max_requests: 9,
  created_at: "2026-09-05T12:01:00Z",
};

const INTENT = {
  subjects: [{ role: "subject", known: { "company.name": "Mollie B.V." } }],
  required_outputs: ["company.profile", "company.financial_statements"],
  optional_outputs: ["building.bag_id"],
  jurisdiction: "NL",
};

/** Records every request, and answers the routes the plan flow uses. */
function fakeGateway(routes = {}) {
  const calls = [];
  return {
    calls,
    async requestJson(path, options = {}) {
      calls.push({ path, method: options.method || "GET", body: options.body ?? null, query: options.query ?? null });
      for (const [pattern, answer] of Object.entries(routes)) {
        if (path === pattern) {
          if (answer instanceof Error) throw answer;
          return typeof answer === "function" ? answer(options) : answer;
        }
      }
      throw new GatewayError(`no fixture for ${path}`, { code: "test.unrouted", status: 404 });
    },
  };
}

const planningGateway = () => fakeGateway({ "/v1/plans": PLAN_RESPONSE });

test("a Picnic question uses the Gateway reader without an MCP interpretation", async () => {
  const gateway = planningGateway();
  const value = parse(await runPlan({ question: "Picnic jaarrekening", max_price_usdc: 0.25 }, { gateway, env: {} }));
  assert.equal(value.plan.plan_hash, PLAN_HASH);
  assert.equal(gateway.calls[0].body.question, "Picnic jaarrekening");
  assert.equal(gateway.calls[0].body.intent, undefined);
  assert.equal(gateway.calls[0].body.max_buyer_total_atomic, 250000);
});

test("missing research context is returned as a question with complete examples", async () => {
  const gateway = { requestJson: async () => {
    throw new GatewayError("Which company?", { status: 422, code: "needs_input", body: { suggestions: ["Annual accounts of Picnic"] } });
  } };
  const value = parse(await runPlan({ question: "annual accounts" }, { gateway, env: {} }));
  assert.equal(value.status, "needs_input");
  assert.deepEqual(value.suggestions, ["Annual accounts of Picnic"]);
});

/** A client that declared elicitation and answers with `decision`. */
function hostAnswering(decision, seen = []) {
  return {
    capabilities: { elicitation: {} },
    sendRequest: async (message) => {
      seen.push(message);
      return { action: "accept", content: { decision } };
    },
  };
}

test("the plan hash and the amount are the gateway's, copied and not recomputed", async () => {
  const value = parse(await runPlan({ question: "Is Mollie a healthy company?", intent: INTENT }, { gateway: planningGateway(), env: {} }));

  // What the App compares against. Byte for byte, or the release gate fails.
  assert.equal(value.plan.plan_hash, PLAN_HASH);
  assert.equal(value.plan.plan_version_id, undefined, "the plan carries version_id, not a renamed copy");
  assert.equal(value.plan.version_id, VERSION_ID);
  assert.equal(value.plan.version, 1);

  // ONE amount, and it is the gateway's integer.
  assert.equal(value.plan.total_atomic, TOTAL_ATOMIC);
  assert.equal(value.plan.total_usdc, 0.17391);
  assert.equal(value.plan.total_eur_cents, 16);

  // Same object out of the shared normaliser the card and the tool both read.
  assert.deepEqual(normalizePlan(PLAN_RESPONSE).plan_hash, PLAN_HASH);
  assert.deepEqual(normalizePlan(PLAN_RESPONSE).total_atomic, TOTAL_ATOMIC);
});

test("one price: no per-step amount, no provider leg and no fee reaches the agent", async () => {
  const result = await runPlan({ question: "Is Mollie healthy?", intent: INTENT }, { gateway: planningGateway(), env: {} });
  const rendered = JSON.stringify(parse(result));

  for (const amount of NODE_ATOMIC) {
    assert.ok(!rendered.includes(String(amount)), `a per-step amount (${amount}) reached the agent`);
  }
  for (const forbidden of ["provider_price", "providerPrice", "list_price", "fee_", "markup", "buyer_total_atomic\":2"]) {
    assert.ok(!rendered.includes(forbidden), `${forbidden} must never appear in a plan result`);
  }
  // The total, on the other hand, is there once and readable.
  assert.match(parse(result).presentation, /at most: \*\*\$0\.17391\*\*/);
  assert.match(parse(result).presentation, /€0\.16/);
});

test("apiosk_plan spends nothing: it posts one plan and calls no paid route", async () => {
  const gateway = planningGateway();
  await runPlan({ question: "Is Mollie healthy?", intent: INTENT }, { gateway, env: {} });

  assert.deepEqual(gateway.calls.map((call) => `${call.method} ${call.path}`), ["POST /v1/plans"]);
  for (const call of gateway.calls) {
    assert.ok(!["/v1/run", "/v1/select", "/v1/jobs"].includes(call.path), `planning reached ${call.path}`);
  }
});

test("the intent crosses the boundary untouched, and the ceiling is the caller's own", async () => {
  const gateway = planningGateway();
  await runPlan({ question: "Is Mollie healthy?", intent: INTENT, max_price_usdc: 0.25 }, { gateway, env: {} });

  const sent = gateway.calls[0].body;
  assert.equal(sent.question, "Is Mollie healthy?");
  assert.deepEqual(sent.intent.subjects, INTENT.subjects);
  assert.deepEqual(sent.intent.required_outputs, INTENT.required_outputs);
  assert.deepEqual(sent.intent.optional_outputs, INTENT.optional_outputs);
  assert.equal(sent.intent.jurisdiction, "NL");
  // Stated in this surface's unit, sent in the gateway's. Integer, no float.
  assert.equal(sent.intent.max_buyer_total_atomic, 250_000);
  // Nothing that would let this server decide what runs.
  for (const key of Object.keys(sent.intent)) {
    assert.ok(
      ["subjects", "required_outputs", "optional_outputs", "format", "jurisdiction", "max_buyer_total_atomic"].includes(key),
      `the MCP added ${key} to the intent`
    );
  }
});

test("a plan is confirmed once, with its one price on the button", async () => {
  const seen = [];
  const value = parse(
    await runPlan({ question: "Is Mollie healthy?", intent: INTENT }, { gateway: planningGateway(), env: {}, host: hostAnswering("approve", seen) })
  );

  assert.equal(seen.length, 1, "exactly one confirmation for the whole plan");
  assert.equal(seen[0].method, "elicitation/create");
  const options = seen[0].params.requestedSchema.properties.decision.oneOf;
  assert.deepEqual(options.map((o) => o.const), ["approve", "deny"]);
  assert.match(options[0].title, /\$0\.17391/);

  assert.equal(value.status, "approved");
  assert.equal(value.approval.state, "approved_by_user");
  assert.deepEqual(value.approval.execute_arguments, { plan_token: PLAN_TOKEN });
  assert.match(value.next_steps.join(" "), /Do not ask them to confirm a second time/);
});

test("denying a plan stops, and does not leave a runnable instruction behind", async () => {
  const value = parse(
    await runPlan({ question: "Is Mollie healthy?", intent: INTENT }, { gateway: planningGateway(), env: {}, host: hostAnswering("deny") })
  );
  assert.equal(value.status, "denied");
  assert.equal(value.approval, undefined);
  assert.match(value.next_steps.join(" "), /Do not call apiosk_execute_plan/);
});

test("a host that cannot ask falls back to the App approval link", async () => {
  const value = parse(await runPlan({ question: "Is Mollie healthy?", intent: INTENT }, { gateway: planningGateway(), env: {}, host: null }));

  assert.equal(value.status, "ok");
  assert.equal(value.approval.state, "awaiting_user");
  assert.equal(value.approval.approve_url, `https://app.apiosk.com/plans/${PLAN_ID}`);
  assert.match(value.next_steps.join(" "), /approve or deny/i);
});

test("apiosk_plan refuses to plan without required outputs, before any request", async () => {
  const gateway = planningGateway();
  const result = await runPlan({ question: "something", intent: { subjects: [] } }, { gateway, env: {} });
  assert.equal(result.isError, true);
  assert.equal(parse(result).error_code, "plan.no_required_outputs");
  assert.deepEqual(gateway.calls, []);
});

test("apiosk_execute_plan accepts an approved plan version and nothing that could build one", () => {
  assert.deepEqual(EXECUTE_PLAN_TOOL.inputSchema.required, ["plan_token"]);
  assert.equal(EXECUTE_PLAN_TOOL.inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(EXECUTE_PLAN_TOOL.inputSchema.properties), ["plan_token", "idempotency_key"]);
  // Nothing in the plan vocabulary: it cannot name an output, a subject, a
  // price or an endpoint, so it cannot construct or mutate a plan.
  const described = JSON.stringify(EXECUTE_PLAN_TOOL.inputSchema);
  for (const forbidden of ["required_outputs", "subjects", "max_price", "endpoint", "offer_token", "intent"]) {
    assert.ok(!described.includes(forbidden), `apiosk_execute_plan must not accept ${forbidden}`);
  }
});

test("starting the same approved plan twice gives one job, not two", async () => {
  const gateway = fakeGateway({ "/v1/jobs": JOB_RESPONSE });
  const first = parse(await runExecutePlan({ plan_token: PLAN_TOKEN }, { gateway, env: {} }));
  const second = parse(await runExecutePlan({ plan_token: PLAN_TOKEN }, { gateway, env: {} }));

  assert.equal(first.status, "started");
  assert.equal(first.job_id, JOB_ID);
  assert.equal(second.job_id, JOB_ID);
  assert.equal(gateway.calls[0].body.idempotency_key, gateway.calls[1].body.idempotency_key);
  assert.equal(gateway.calls[0].body.idempotency_key, jobKeyFor(PLAN_TOKEN));
  assert.ok(gateway.calls[0].body.idempotency_key.length <= 200);
  // The key is derived from the token, never the token itself.
  assert.ok(!gateway.calls[0].body.idempotency_key.includes(PLAN_TOKEN));
  // The token goes back exactly as it came.
  assert.equal(gateway.calls[0].body.plan_token, PLAN_TOKEN);
  assert.deepEqual(Object.keys(gateway.calls[0].body).sort(), ["idempotency_key", "plan_token"]);
});

test("a started job carries the approved hash and ceiling, and nothing else about money", async () => {
  const gateway = fakeGateway({ "/v1/jobs": JOB_RESPONSE });
  const value = parse(await runExecutePlan({ plan_token: PLAN_TOKEN }, { gateway, env: {} }));

  assert.equal(value.plan_hash, PLAN_HASH, "the job names the same plan version the App shows");
  assert.equal(value.ceiling_atomic, TOTAL_ATOMIC);
  assert.equal(value.ceiling_usdc, 0.17391);
  assert.equal(value.ceiling_label, "$0.17391");
  assert.equal(value.max_requests, 9);
});

test("a plan that moved since approval refuses instead of starting", async () => {
  for (const code of ["approval_expired", "plan_changed", "fees_changed"]) {
    const gateway = fakeGateway({
      "/v1/jobs": new GatewayError("This plan is not the plan that was approved.", { code, status: 409, body: { error: code } }),
    });
    const value = parse(await runExecutePlan({ plan_token: PLAN_TOKEN }, { gateway, env: {} }));
    assert.equal(value.status, "plan_stale", code);
    assert.match(value.next_steps.join(" "), /Do not retry this token/);
    assert.match(value.next_steps.join(" "), /approve the new plan and its price/);
  }
});

test("apiosk_execute_plan cannot start anything without a token", async () => {
  const gateway = fakeGateway({ "/v1/jobs": JOB_RESPONSE });
  const result = await runExecutePlan({}, { gateway, env: {} });
  assert.equal(result.isError, true);
  assert.equal(parse(result).error_code, "execute_plan.no_plan_token");
  assert.deepEqual(gateway.calls, []);
});

test("a job started here is visible and manageable through the routes the App uses", async () => {
  const events = { events: [{ seq: 7, kind: "node_succeeded", node_key: "n_lookup" }], cursor: 7 };
  const gateway = fakeGateway({
    [`/v1/jobs/${JOB_ID}`]: { ...JOB_RESPONSE, status: "running", requests_made: 1 },
    [`/v1/jobs/${JOB_ID}/events`]: events,
  });

  const value = parse(await runJobStatus({ job_id: JOB_ID }, { gateway, env: {} }));
  assert.equal(value.status, "running");
  assert.equal(value.job_status, "running");
  assert.equal(value.plan_hash, PLAN_HASH);
  assert.equal(value.ceiling_atomic, TOTAL_ATOMIC);
  assert.equal(value.cursor, 7);
  assert.equal(value.events.length, 1);
  assert.deepEqual(gateway.calls.map((c) => `${c.method} ${c.path}`), [
    `GET /v1/jobs/${JOB_ID}`,
    `GET /v1/jobs/${JOB_ID}/events`,
  ]);
  assert.equal(gateway.calls[1].query.after, "0");
});

test("an unreadable event log never turns a healthy job into a failure", async () => {
  const gateway = fakeGateway({
    [`/v1/jobs/${JOB_ID}`]: { ...JOB_RESPONSE, status: "running" },
    [`/v1/jobs/${JOB_ID}/events`]: new GatewayError("events down", { code: "events_unavailable", status: 503 }),
  });
  const value = parse(await runJobStatus({ job_id: JOB_ID }, { gateway, env: {} }));
  assert.equal(value.status, "running");
  assert.deepEqual(value.events, []);
});

test("a job that asks hands the question over rather than answering it", async () => {
  const question = {
    node_key: "n_lookup",
    fact_type: "company.registration.nl.kvk",
    truncated: false,
    candidates: [
      { identity: "30528634", facts: [{ fact_type: "address.postal", value: { city: "Amsterdam" } }] },
      { identity: "68750110", facts: [{ fact_type: "address.postal", value: { city: "Rotterdam" } }] },
    ],
  };
  const gateway = fakeGateway({
    [`/v1/jobs/${JOB_ID}`]: { ...JOB_RESPONSE, status: "paused", pending_question: question },
    [`/v1/jobs/${JOB_ID}/events`]: { events: [], cursor: 0 },
  });

  const value = parse(await runJobStatus({ job_id: JOB_ID }, { gateway, env: {} }));
  assert.equal(value.status, "asking");
  assert.deepEqual(value.pending_question, question);
  assert.match(value.next_steps.join(" "), /BY NAME/);
  assert.match(value.next_steps.join(" "), /Answering costs nothing/);
});

test("an answer must be a candidate the job offered, and a refusal is not retried", async () => {
  const accepted = fakeGateway({ [`/v1/jobs/${JOB_ID}/resolve`]: { resolved: true } });
  const value = parse(await runResolveJob({ job_id: JOB_ID, node_key: "n_lookup", chosen: "30528634" }, { gateway: accepted }));
  assert.equal(value.status, "resolved");
  assert.deepEqual(accepted.calls[0].body, { node_key: "n_lookup", chosen: "30528634" });
  assert.equal(accepted.calls[0].method, "POST");

  const refused = fakeGateway({
    [`/v1/jobs/${JOB_ID}/resolve`]: new GatewayError("that answer is not one of the candidates offered", {
      code: "not_a_candidate",
      status: 409,
      body: { error: "not_a_candidate" },
    }),
  });
  const rejected = parse(await runResolveJob({ job_id: JOB_ID, node_key: "n_lookup", chosen: "99999999" }, { gateway: refused }));
  assert.equal(rejected.status, "not_a_candidate");
  assert.match(rejected.next_steps.join(" "), /Do not adjust it and retry/);
});

test("cancel stops future calls and never claims a refund", async () => {
  const gateway = fakeGateway({
    [`/v1/jobs/${JOB_ID}/cancel`]: {
      cancelled: true,
      note: "No further calls will be dispatched. Calls already sent are settled.",
    },
  });
  const value = parse(await runCancelJob({ job_id: JOB_ID }, { gateway }));
  assert.equal(value.status, "cancelled");
  assert.match(value.message, /already sent are settled/);
  assert.ok(!/refund/i.test(JSON.stringify(value)));
  // A closed chat is not a decision to stop, and the tool text has to say so.
  assert.match(CANCEL_JOB_TOOL.description, /only when the user asks to stop/);
  assert.match(CANCEL_JOB_TOOL.description, /never because a conversation is ending/);
});

test("the single-call flow is untouched by any of this", () => {
  // Additive: the original six keep their names AND their order at the front.
  assert.deepEqual(TOOL_NAMES.slice(0, 6), [
    "apiosk",
    "apiosk_connect",
    "apiosk_discover",
    "apiosk_compare",
    "apiosk_execute",
    "apiosk_approval_status",
  ]);
  // The offer_token flow still takes exactly what it always took.
  assert.deepEqual(EXECUTE_TOOL.inputSchema.required, ["offer_token", "prompt", "max_price_usdc"]);
  assert.ok(EXECUTE_TOOL.inputSchema.properties.offer_token);
  assert.ok(EXECUTE_TOOL.inputSchema.properties.input_parts);
  // And no plan concept leaked into it.
  assert.ok(!JSON.stringify(EXECUTE_TOOL.inputSchema).includes("plan_token"));
  // The plan tool is a separate door, not a change to that one.
  assert.notEqual(PLAN_TOOL.name, EXECUTE_TOOL.name);
  assert.equal(PLAN_TOOL.annotations.readOnlyHint, true);
  assert.equal(EXECUTE_PLAN_TOOL.annotations.readOnlyHint, false);
  assert.equal(JOB_STATUS_TOOL.annotations.readOnlyHint, true);
});
