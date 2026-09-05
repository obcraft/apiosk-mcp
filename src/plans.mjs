// One reading of a gateway plan, and one reading of a gateway job.
//
// WHAT THIS FILE IS NOT. It is not a planner. Nothing here decides what to
// call, in what order, or what it costs — `POST /v1/plans` on the gateway does
// all three, and everything below only renames what came back into the words
// this surface already uses. The release gate is that the App and an MCP client
// show THE SAME plan hash and THE SAME amount, and the only way to hold that is
// for exactly one of them to be able to compute it.
//
// ONE PRICE. `total_usdc` is the ceiling the buyer approves, and it is the only
// amount in this file. The gateway's plan carries a per-node buyer total as
// well; it is deliberately not read here and not rendered anywhere, because a
// plan that prints a number per step invites the next question — what is the
// provider's share — and there is no surface in this product that answers it.
// There is no list price, no provider leg and no fee in this file.
//
// ATOMIC IN, ATOMIC OUT. The gateway counts in atomic USDC (10^-6 USD) and it
// is the only thing that is allowed to. `total_usdc` is a rendering of
// `buyer_total_atomic` for a human to read; `total_atomic` is carried beside it
// so a caller comparing two surfaces compares the integer, not the rendering.

import { trimString } from "./tool-result.mjs";
import { BUYER_PORTAL_URL } from "./tools/connect.mjs";

/** 10^-6 USD, the unit every amount in the gateway is counted in. */
export const ATOMIC_PER_USDC = 1_000_000;

/** Where a person approves a plan when this host cannot ask them here. */
export function planApprovalUrl(env = process.env, planId = "") {
  const base = (trimString(env.APIOSK_BUYER_PORTAL_URL) || BUYER_PORTAL_URL).replace(/\/+$/, "");
  const id = trimString(planId);
  return id ? `${base}/plans/${encodeURIComponent(id)}` : `${base}/plans`;
}

/** Atomic USDC to a plain number of USDC. Display only. */
export function usdcFromAtomic(atomic) {
  const value = Number(atomic);
  if (!Number.isFinite(value)) return null;
  return Math.round(value) / ATOMIC_PER_USDC;
}

/**
 * A caller's ceiling, in the units the gateway refuses plans against.
 *
 * This is the one conversion this file performs on an amount, and it is safe to
 * perform because the number is the CALLER'S OWN LIMIT rather than a price
 * anybody computed. Rounded to the nearest micro-dollar, because a ceiling with
 * a fraction of a micro in it is a ceiling the gateway cannot represent.
 */
export function atomicFromUsdc(usdc) {
  const value = Number(usdc);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * ATOMIC_PER_USDC);
}

/** `$0.20`, and `—` when the gateway published no amount. */
export function amountLabel(usdc) {
  if (typeof usdc !== "number" || !Number.isFinite(usdc)) return "—";
  return `$${usdc.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;
}

function euroLabel(cents) {
  const value = Number(cents);
  if (!Number.isFinite(value)) return null;
  return `€${(value / 100).toFixed(2)}`;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The gateway's `PlanResponse`, in the words this surface uses.
 *
 * Every field below is copied, never derived: `plan_hash` is the gateway's,
 * `total_atomic` is `summary.buyer_total_atomic`, and the steps are the plan's
 * own nodes in the plan's own topological order. A field the gateway did not
 * send comes back null rather than as a plausible default — a reader cannot
 * tell a measurement from a guess, and this is the object a purchase is
 * approved from.
 */
export function normalizePlan(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const plan = body.plan && typeof body.plan === "object" ? body.plan : {};
  const summary = body.summary && typeof body.summary === "object" ? body.summary : {};
  const coverage = list(plan.coverage).map((entry) => ({
    fact_type: trimString(entry?.fact_type) || null,
    required: Boolean(entry?.required),
    status: trimString(entry?.status) || null,
    step_id: trimString(entry?.node_id) || null,
  }));

  const totalAtomic = Number.isFinite(Number(summary.buyer_total_atomic))
    ? Number(summary.buyer_total_atomic)
    : null;

  return {
    plan_id: trimString(body.plan_id) || null,
    version_id: trimString(body.version_id) || null,
    version: Number.isFinite(Number(body.version)) ? Number(body.version) : null,
    // The one field two surfaces compare to agree they hold the same plan.
    plan_hash: trimString(body.plan_hash) || null,
    question: trimString(body.question) || null,
    expires_at: trimString(body.expires_at) || null,
    // THE amount. Nothing is added to it later and nothing is broken out of it.
    total_usdc: usdcFromAtomic(totalAtomic),
    total_atomic: totalAtomic,
    total_eur_cents: Number.isFinite(Number(summary.eur_cents)) ? Number(summary.eur_cents) : null,
    paid_calls: Number.isFinite(Number(summary.paid_calls)) ? Number(summary.paid_calls) : null,
    steps_deep: Number.isFinite(Number(summary.steps_deep)) ? Number(summary.steps_deep) : null,
    format: trimString(summary.format) || trimString(plan.format) || null,
    may_pause_to_ask: Boolean(summary.may_ask),
    steps: list(plan.nodes).map((node) => ({
      id: trimString(node?.id) || null,
      capability: trimString(node?.capability_slug) || null,
      api: trimString(node?.api_slug) || null,
      needs: list(node?.depends_on),
      produces: list(node?.produces),
      may_ask: Boolean(node?.may_ask),
    })),
    coverage,
    already_known: coverage.filter((c) => c.status === "already_known").map((c) => c.fact_type),
    // What the plan could not reach. `summary.missing` is the gateway's own
    // list; the coverage rows are the same answer with the required flag on it.
    missing_inputs: coverage
      .filter((c) => c.status === "unreachable")
      .map((c) => ({ fact_type: c.fact_type, required: c.required })),
    plan_token: trimString(body.plan_token) || null,
  };
}

/** The plan as a person reads it. One amount, no per-step money. */
export function planPresentation(plan) {
  const euro = euroLabel(plan.total_eur_cents);
  const lines = [
    `**Plan** — ${plan.question || "this job"}`,
    `Total, at most: **${amountLabel(plan.total_usdc)}**${euro ? ` (${euro})` : ""}`,
    `${plan.paid_calls ?? "?"} paid call${plan.paid_calls === 1 ? "" : "s"}, ${plan.steps_deep ?? "?"} step${plan.steps_deep === 1 ? "" : "s"} deep, answered as ${plan.format || "json"}.`,
    "",
    "Steps:",
  ];
  for (const step of plan.steps) {
    const needs = step.needs.length ? ` (after ${step.needs.join(", ")})` : "";
    const ask = step.may_ask ? " — may pause to ask you which one is meant" : "";
    lines.push(`- **${step.capability || step.id}** via ${step.api || "an Apiosk listing"}${needs}${ask}`);
  }
  if (plan.already_known.length) {
    lines.push("", `Already known, so not paid for: ${plan.already_known.join(", ")}.`);
  }
  if (plan.missing_inputs.length) {
    lines.push(
      "",
      `Not reachable: ${plan.missing_inputs
        .map((m) => `${m.fact_type}${m.required ? " (required)" : " (optional)"}`)
        .join(", ")}.`
    );
  }
  lines.push("", "Nothing is spent until this plan is approved and started.");
  return lines.join("\n");
}

/**
 * The gateway's `JobResponse`, in the words this surface uses.
 *
 * `buyer_total_ceiling_atomic` is repeated on every read by the gateway for a
 * reason worth keeping here: a caller never has to have held the plan to know
 * what the ceiling is.
 */
export function normalizeJob(payload) {
  const body = payload && typeof payload === "object" ? payload : {};
  const ceiling = Number.isFinite(Number(body.buyer_total_ceiling_atomic))
    ? Number(body.buyer_total_ceiling_atomic)
    : null;
  return {
    job_id: trimString(body.job_id) || null,
    job_status: trimString(body.status) || null,
    plan_id: trimString(body.plan_id) || null,
    plan_version_id: trimString(body.plan_version_id) || null,
    plan_hash: trimString(body.plan_hash) || null,
    ceiling_usdc: usdcFromAtomic(ceiling),
    ceiling_atomic: ceiling,
    requests_made: Number.isFinite(Number(body.requests_made)) ? Number(body.requests_made) : null,
    max_requests: Number.isFinite(Number(body.max_requests)) ? Number(body.max_requests) : null,
    pending_question: body.pending_question ?? null,
    created_at: trimString(body.created_at) || null,
    finished_at: trimString(body.finished_at) || null,
  };
}

/** Statuses a job is still moving in. Anything else is finished. */
const RUNNING = new Set(["draft", "needs_input", "awaiting_approval", "queued", "running", "paused"]);

export function isJobRunning(status) {
  return RUNNING.has(trimString(status));
}
