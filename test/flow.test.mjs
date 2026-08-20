import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { COMPARE_TOOL_INPUT_SCHEMA, runCompare } from "../src/flow.mjs";
import { COMPARE_TOOL } from "../src/tools/compare.mjs";
import { createGatewayClient } from "../src/gateway-client.mjs";

/// A stand-in gateway that records the method, path and JSON body it was asked
/// for and answers with a fixed payload. The point of these tests is the
/// translation layer — argument shapes in, request out, gateway payload back —
/// not the pricing or ranking, which live in the gateway and are tested there.
async function withStubGateway(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const gateway = createGatewayClient({ env: { APIOSK_GATEWAY_URL: `http://127.0.0.1:${port}` } });
    return await run({ gateway });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

/// A client pointed at a port nothing listens on, for the unreachable case.
function unreachableGateway() {
  return createGatewayClient({ env: { APIOSK_GATEWAY_URL: "http://127.0.0.1:1" } });
}

function jsonHandler(body, status = 200) {
  const seen = [];
  const handler = (req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = raw;
      }
      seen.push({ method: req.method, url: req.url, body: parsed });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  };
  handler.seen = seen;
  return handler;
}

test("compare is advertised as read-only and needs no required argument", () => {
  assert.equal(COMPARE_TOOL.annotations.readOnlyHint, true);
  assert.equal(COMPARE_TOOL.annotations.destructiveHint, false);
  assert.equal(COMPARE_TOOL.inputSchema, COMPARE_TOOL_INPUT_SCHEMA);
  // Either query or capability is enough, so neither is marked required.
  assert.equal(COMPARE_TOOL_INPUT_SCHEMA.required, undefined);
  for (const key of ["query", "capability", "max_price_usdc", "optimize_for"]) {
    assert.ok(COMPARE_TOOL_INPUT_SCHEMA.properties[key], `apiosk_compare is missing ${key}`);
  }
});

test("compare refuses when there is no subject to price", async () => {
  const result = await runCompare({}, { gateway: unreachableGateway() });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Nothing to compare/);
});

test("compare POSTs the job to /v1/quote and surfaces the offer_id an agent hands to execute", async () => {
  const handler = jsonHandler({
    quote_id: "q-1",
    capability: "fx.convert",
    expires_in_seconds: 900,
    offers: [
      { offer_id: "signed.token.abc", api_slug: "macropulse", price_usdc: 0.005, score: 100, p95_latency_ms: null, success_rate: null },
    ],
    rejected: [],
  });

  const result = await withStubGateway(handler, (ctx) =>
    runCompare({ query: "convert USD to EUR" }, ctx)
  );

  assert.equal(handler.seen.length, 1);
  assert.equal(handler.seen[0].method, "POST");
  assert.match(handler.seen[0].url, /\/v1\/quote$/);
  assert.equal(handler.seen[0].body.job, "convert USD to EUR");

  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.offers[0].offer_id, "signed.token.abc");
  // The guidance must tell the agent to carry that id into apiosk_execute.
  assert.match(payload.guidance, /offer_id/);
  assert.match(payload.guidance, /apiosk_execute/);
});

test("compare restates each offer price as the buyer total, list + 10%", async () => {
  const handler = jsonHandler({
    offers: [
      { offer_id: "sig.a", api_slug: "macropulse", price_usdc: 0.005, score: 100 },
      { offer_id: "sig.b", api_slug: "basics", price_usdc: 0.05, score: 20 },
    ],
    rejected: [],
  });

  const result = await withStubGateway(handler, (ctx) => runCompare({ query: "convert USD to EUR" }, ctx));
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.offers[0].price_usdc, 0.0055);
  assert.equal(payload.offers[0].list_price_usdc, 0.005);
  assert.equal(payload.offers[0].price_includes_apiosk_fee, true);
  assert.equal(payload.offers[1].price_usdc, 0.055);
  assert.equal(payload.offers[1].list_price_usdc, 0.05);
  // The offer_id is never rewritten — it pins the raw price server-side.
  assert.equal(payload.offers[0].offer_id, "sig.a");
  assert.match(payload.guidance, /BUYER TOTAL/);
});

test("compare prefers the gateway's buyer_price_usdc over the local mirror", async () => {
  const handler = jsonHandler({
    offers: [
      // Gateway buyer price present — use it verbatim, not list * 1.1.
      { offer_id: "sig.a", api_slug: "m", price_usdc: 0.005, buyer_price_usdc: 0.0055, score: 100 },
    ],
    rejected: [],
  });
  const result = await withStubGateway(handler, (ctx) => runCompare({ query: "x" }, ctx));
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.offers[0].price_usdc, 0.0055);
  assert.equal(payload.offers[0].list_price_usdc, 0.005);
  // The intermediate gateway field is dropped from the output.
  assert.equal("buyer_price_usdc" in payload.offers[0], false);
});

test("a capability can be priced directly, skipping the search", async () => {
  const handler = jsonHandler({ offers: [], rejected: [] });
  await withStubGateway(handler, (ctx) => runCompare({ capability: "fx.convert" }, ctx));
  assert.equal(handler.seen[0].body.capability, "fx.convert");
  assert.equal(handler.seen[0].body.job, undefined);
});

test("requirements are passed through under the names the gateway expects", async () => {
  const handler = jsonHandler({ offers: [], rejected: [] });
  await withStubGateway(handler, (ctx) =>
    runCompare(
      {
        query: "read a web page",
        max_price_usdc: 0.05,
        max_latency_ms: 800,
        min_reliability: 95,
        settlement: "apiosk",
        require_all_inputs: true,
        optimize_for: "latency",
      },
      ctx
    )
  );

  const body = handler.seen[0].body;
  assert.match(handler.seen[0].url, /\/v1\/quote$/);
  assert.equal(body.job, "read a web page");
  assert.equal(body.max_price, 0.05);
  assert.equal(body.max_latency_ms, 800);
  assert.equal(body.min_reliability, 95);
  assert.equal(body.settlement, "apiosk");
  assert.equal(body.require_all_inputs, true);
  assert.equal(body.optimize_for, "latency");
});

test("require_all_inputs is only sent when actually asked for", async () => {
  const handler = jsonHandler({ offers: [] });
  await withStubGateway(handler, (ctx) => runCompare({ query: "x", require_all_inputs: false }, ctx));
  assert.equal(handler.seen[0].body.require_all_inputs, undefined);
});

test("the choice belongs to the user: there is no decide step to call", async () => {
  const flow = await import("../src/flow.mjs");
  assert.equal(flow.runDecide, undefined);
  assert.equal(flow.DECIDE_TOOL, undefined);
});

test("an unhappy gateway surfaces as a tool error, not a silent empty result", async () => {
  const handler = jsonHandler({ error: "no_capability", message: "nothing serves this" }, 404);
  const result = await withStubGateway(handler, (ctx) => runCompare({ query: "nonsense" }, ctx));
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, 404);
  assert.match(body.message, /nothing serves this/);
});

test("an unreachable gateway surfaces as a tool error", async () => {
  // Port 1 on loopback refuses immediately; no network dependency.
  const result = await runCompare({ query: "x" }, { gateway: unreachableGateway() });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not reach the Apiosk gateway/);
});

test("the offer table is rendered here, with a number the user can say back", async () => {
  // Same reason discovery renders its own table: prose guidance about columns
  // and prices is a suggestion, and this is the step where a rewritten price
  // would be a rewritten invoice.
  const handler = jsonHandler({
    capability: "news.search",
    expires_in_seconds: 900,
    offers: [
      {
        offer_id: "signed-1",
        provider: "CityFALCON",
        api_slug: "cityfalcon-financial-api",
        price_usdc: 0.03,
        buyer_price_usdc: 0.033,
        score: 100,
        p95_latency_ms: null,
        success_rate: null,
      },
      {
        offer_id: "signed-2",
        provider: "Apiosk Basics",
        api_slug: "newsapi",
        price_usdc: 0.06,
        buyer_price_usdc: 0.066,
        score: 60,
        p95_latency_ms: 412.4,
        success_rate: 0.97,
        policy: { verdict: "require_approval", reason: "over the approval threshold you set" },
      },
    ],
  });

  const data = await withStubGateway(handler, async ({ gateway }) => {
    const result = await runCompare({ query: "news about a company" }, { gateway });
    return JSON.parse(result.content[0].text);
  });

  assert.match(data.presentation, /\*\*2 offers\*\* for `news\.search`/);
  assert.match(data.presentation, /\| 1 \| \*\*CityFALCON\*\* \| 0\.033 \(incl\. 10% fee\) \| 100 \| not measured \| not measured \|/);
  assert.match(data.presentation, /\| 2 \| \*\*Apiosk Basics\*\* `newsapi` \| 0\.066 \(incl\. 10% fee\) \| 60 \| 412 ms \| 97% \|/);
  // The buyer's own rules travel with the offer they refuse, not in a footnote
  // the model may drop.
  assert.match(data.presentation, /⏸️ #2 would be held for your approval: over the approval threshold you set/);
  assert.match(data.presentation, /pinned for 15 minutes/);
  // The number in the table is the number in the data.
  assert.deepEqual(data.offers.map((offer) => offer.index), [1, 2]);
});

test("an empty offer set says which way out there is, and never invents one", async () => {
  const handler = jsonHandler({ capability: "news.search", offers: [], rejected: [] });
  const data = await withStubGateway(handler, async ({ gateway }) => {
    const result = await runCompare({ query: "news", max_price_usdc: 0.0001 }, { gateway });
    return JSON.parse(result.content[0].text);
  });
  assert.match(data.presentation, /No provider survived the requirements you set/);
  assert.ok(!/\| 1 \|/.test(data.presentation));
});
