// Prompts for the comparison layer.
//
// Two reasons these exist, and the second is the real one.
//
// 1. Smithery's scan reported `Failed to list prompts: MCP error -32601:
//    Method not found`. A server that declares no prompts capability answers
//    prompts/list with "method not found", which reads to a scanner as a
//    half-implemented server rather than a deliberate omission.
//
// 2. More importantly: a tool list tells an agent what CAN be called; a prompt
//    tells a person what is worth calling. The three tools chain, and the chain
//    is the product — but nothing in a flat tool list says "run these three in
//    order". These do.
//
// Each prompt returns a user message, not an assistant one: the point is to
// hand the model a well-posed task and let it choose the calls, rather than to
// script the calls and pretend the model made a decision.

const NEED = {
  name: "need",
  description: "What you need done, in plain words — e.g. 'read a web page as clean text'.",
  required: true,
};

const BUDGET = {
  name: "max_price_usdc",
  description: "Optional per-call ceiling in USDC, e.g. 0.05.",
  required: false,
};

export const PROMPTS = [
  {
    name: "find_and_choose_an_api",
    title: "Find and choose an API for a job",
    description:
      "Run the full comparison layer for a job: discover what can do it, compare the candidates on price and measured performance, and decide which to call — with the reasoning shown. Nothing is paid.",
    arguments: [NEED, BUDGET],
  },
  {
    name: "compare_providers",
    title: "Compare the providers for a job",
    description:
      "Put every provider that can do a job side by side on price, measured latency, measured success rate and input compatibility, and show the weights behind each score. Stops short of choosing.",
    arguments: [NEED, BUDGET],
  },
  {
    name: "cheapest_that_meets_my_bar",
    title: "Cheapest provider that clears a quality bar",
    description:
      "Find the cheapest provider that still meets a hard latency and reliability floor, and show what was rejected for missing the bar. Providers Apiosk has never measured are rejected rather than assumed to pass.",
    arguments: [
      NEED,
      BUDGET,
      { name: "max_latency_ms", description: "Hard ceiling on measured median latency, e.g. 800.", required: false },
      { name: "min_reliability", description: "Hard floor on measured success rate. 0..1 or 0..100.", required: false },
    ],
  },
];

function need(args) {
  const value = String(args?.need ?? "").trim();
  if (!value) throw new Error("The `need` argument is required: describe the job in plain words.");
  return value;
}

/** Only mention a constraint the caller actually set — an unset one is not "no limit", it is silence. */
function constraintLine(args) {
  const parts = [];
  const push = (key, label) => {
    const raw = args?.[key];
    if (raw === undefined || raw === null || String(raw).trim() === "") return;
    parts.push(`${label}=${String(raw).trim()}`);
  };
  push("max_price_usdc", "max_price_usdc");
  push("max_latency_ms", "max_latency_ms");
  push("min_reliability", "min_reliability");
  return parts.length ? `\n\nHard constraints: ${parts.join(", ")}. Pass these to every step.` : "";
}

const BODIES = {
  find_and_choose_an_api: (a) =>
    `I need an API that can: ${need(a)}.${constraintLine(a)}

Use the Apiosk comparison layer, in order, and do not pay for anything:
1. apiosk_discover with that need, to see what can perform it.
2. apiosk_compare with the SAME plain-words query, to put the candidates on one axis.
3. apiosk_decide with the same query and constraints, to get one provider back.

Then tell me: which provider you would call and what it costs per call, the rule that selected it, which candidates were rejected and the exact constraint each one failed, and the runners-up in case I disagree. If a score rests on dimensions Apiosk has not measured, say so rather than presenting it as complete.`,

  compare_providers: (a) =>
    `Compare every provider that can: ${need(a)}.${constraintLine(a)}

Call apiosk_discover, then apiosk_compare with the same plain-words query. Do not decide and do not pay.

Show me a table of the candidates with price per call, measured latency, measured success rate and whether each accepts the inputs the capability defines. State the weights the score used, and mark clearly which providers have no measurements — those are unknown, not zero.`,

  cheapest_that_meets_my_bar: (a) =>
    `Find me the cheapest API that can: ${need(a)} — but only among providers that actually clear my quality bar.${constraintLine(a)}

Call apiosk_decide with optimize_for="price" and those hard constraints. Nothing is paid.

A provider Apiosk has never measured cannot be shown to meet a latency or reliability floor, so I expect those to be rejected rather than assumed to pass — confirm that is what happened. Show me the winner, its price, and every rejection with the constraint that removed it. If nothing survives, tell me which constraint is binding so I can relax the right one.`,
};

export function getPrompt(name, args = {}) {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) throw new Error(`Unknown prompt: ${name}`);
  return {
    description: prompt.description,
    messages: [{ role: "user", content: { type: "text", text: BODIES[name](args) } }],
  };
}
