import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { COMPARE_TOOL_INPUT_SCHEMA, runCompare } from "../src/flow.mjs";
import { COMPARE_TOOL } from "../src/tools/compare.mjs";
import { runExecute } from "../src/tools/execute.mjs";
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
      const request = { method: req.method, url: req.url, body: parsed, headers: req.headers };
      seen.push(request);
      res.writeHead(status, { "content-type": "application/json" });
      // A FUNCTION when one stub has to answer two routes differently — which
      // it does now that a purchase is `/v1/select` then `/v1/run`.
      res.end(JSON.stringify(typeof body === "function" ? body(request) : body));
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
  /* THE ID IS STILL THERE AND IS NO LONGER THE THING YOU BUY WITH.
     `offer_id` pins a quote on the settlement gateway, which is what compare
     talks to. A purchase goes through the agent gateway now — `/v1/select`
     then `/v1/run` — against the signed `offer_token` apiosk_discover minted.
     So the guidance has to send the agent back to the discovery row, or it
     would send it to apiosk_execute with an argument that is refused. */
  assert.match(payload.guidance, /offer_token/);
  assert.match(payload.guidance, /apiosk_discover/);
  assert.match(payload.guidance, /apiosk_execute/);
  assert.doesNotMatch(payload.guidance, /THAT offer's `offer_id`/);
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
  // A price is written as a price, and what it includes is said once under the
  // table rather than in every cell.
  assert.match(data.presentation, /\| 1 \| \*\*CityFALCON\*\* \| Apiosk catalogue \| \$0\.033 \|/);
  assert.match(data.presentation, /\| 2 \| \*\*Apiosk Basics\*\* `newsapi` \| Apiosk catalogue \| \$0\.066 \|/);
  assert.match(data.presentation, /Apiosk's 10% fee included/);
  // The measured columns are gone from the table, not from the data: they said
  // "not measured" on nearly every row and taught the reader to skip the table.
  assert.ok(!/p95 latency/.test(data.presentation));
  assert.equal(data.offers[1].p95_latency_ms, 412.4);
  // The buyer's own rules travel with the offer they refuse, not in a footnote
  // the model may drop.
  assert.match(data.presentation, /⏸️ #2 would be held for your approval: over the approval threshold you set/);
  assert.match(data.presentation, /pinned for 15 minutes/);
  // The number in the table is the number in the data.
  assert.deepEqual(data.offers.map((offer) => offer.index), [1, 2]);
});


test("the wider ecosystem is in the comparison table too, priced and settled by Apiosk", async () => {
  // The complaint this answers: five rows, all Apiosk, on a screen whose whole
  // job is "what are my options?". An external endpoint is not unbuyable — the
  // gateway fronts its 402 and bills list + 10% — so it belongs in the same
  // table, at the price the buyer's wallet will actually be debited.
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
      },
    ],
    external_offers: {
      count: 3,
      settleable_by_apiosk: 1,
      offers: [
        {
          resource: "https://www.x402financialdata.com/news",
          host: "www.x402financialdata.com",
          description: "Headlines by ticker.",
          price_usd: 0.005,
          buyer_price_usd: 0.0055,
          settlement: "apiosk",
          network: "eip155:8453",
          method: "GET",
          source: "coinbase-x402-bazaar",
        },
        {
          resource: "https://earnings.lonestaroracle.xyz/calendar",
          host: "earnings.lonestaroracle.xyz",
          price_usd: 0.03,
          settlement: "direct",
          settlement_reason: "This host is not on the gateway's external-payment allowlist yet.",
          source: "thirdweb",
        },
        // No resource URL: nothing to call, so nothing to show.
        { host: "ghost.example", price_usd: 0.001, source: "thirdweb" },
      ],
    },
  });

  const data = await withStubGateway(handler, async ({ gateway }) => {
    const result = await runCompare({ query: "news about a company" }, { gateway });
    return JSON.parse(result.content[0].text);
  });

  assert.match(data.presentation, /\*\*3 offers\*\*/);
  // A host is named the way a person would say it, and the index it came from
  // is a name rather than a slug.
  assert.match(data.presentation, /\| 2 \| \*\*x402 Financial Data\*\*.*\| Coinbase Bazaar \| \$0\.0055 \|/);
  // The row Apiosk will not pay for says so, at the provider's own price.
  assert.match(data.presentation, /\| 3 \| \*\*Lone Star Oracle\*\*.*pay the provider yourself \| \$0\.03 \|/);
  assert.match(data.presentation, /#3 is one Apiosk cannot pay for you/);

  const [settled, direct] = data.external_offers.offers;
  // Numbering runs on from the reviewed offers, so "the second one" means one thing.
  assert.deepEqual(data.external_offers.offers.map((o) => o.index), [2, 3]);
  // The buyer total is shown; the provider's own price travels with it, because
  // that is what apiosk_execute confirms against the live 402.
  assert.equal(settled.price_usdc, 0.0055);
  assert.equal(settled.list_price_usdc, 0.005);
  assert.equal(settled.executable_via, "apiosk_execute");
  // No fee is invented on a transaction Apiosk is not in.
  assert.equal(direct.price_usdc, 0.03);
  assert.equal(direct.price_includes_apiosk_fee, false);
  assert.equal(direct.executable_via, null);
  assert.equal(settled.offer_id, null);
  // Same balance, same way in, whichever half of the sweep a row came from.
  assert.match(data.guidance_for_external, /from the same balance/);
  assert.match(data.guidance_for_external, /offer_token/);
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

test("a purchase goes select then run, through the one payment path", async () => {
  /* WHAT THIS REPLACED. There were two tests here, one for `POST /v1/do` and
     one for `POST /v1/x402/fetch`, both on the settlement gateway and both
     reached with the buyer's own connect token — this server asking that
     gateway to spend a buyer's wallet directly, beside the path the app uses.

     Both of those still happen, one layer down: `/v1/run` picks between them
     from the selection's own kind. What changed is who is asked, and what it
     does first — reserve against the BALANCE, and settle or refund. */
  const handler = jsonHandler(({ url }) =>
    url === "/v1/select"
      ? { selection_id: "sel-1" }
      : { data: { headlines: [] }, receipt: { total_usdc: "0.0055" } }
  );
  const result = await withStubGateway(handler, ({ gateway }) =>
    runExecute(
      {
        offer_token: "tok_x402financialdata",
        prompt: "latest ASML headlines",
        max_price_usdc: 0.0055,
        query: { ticker: "ASML" },
      },
      { gateway, env: {} }
    )
  );

  const [select, run] = handler.seen;
  assert.equal(select.url, "/v1/select");
  assert.equal(select.body.offer_token, "tok_x402financialdata");
  // The job is recorded with the pick, so the charge reads back as an answer to
  // a question rather than a bare line in a ledger.
  assert.equal(select.body.prompt, "latest ASML headlines");
  // THE PRICE IS NOT IN THIS REQUEST. It is inside the signed token, which this
  // server cannot read and could not alter if it could.
  assert.equal(select.body.offer, undefined);

  assert.equal(run.url, "/v1/run");
  assert.equal(run.body.selection_id, "sel-1");
  assert.equal(run.body.max_price_usdc, 0.0055);
  assert.deepEqual(run.body.query, { ticker: "ASML" });
  // A retry after a timeout must not pay twice.
  assert.match(run.body.idempotency_key, /^[0-9a-f-]{36}$/);

  const body = JSON.parse(result.content[0].text);
  assert.equal(body.status, "ok");
  assert.equal(body.selection_id, "sel-1");
});

test("a purchase without an offer token is refused before anything is sent", async () => {
  const handler = jsonHandler({});
  const result = await withStubGateway(handler, ({ gateway }) =>
    runExecute({ prompt: "latest ASML headlines" }, { gateway, env: {} })
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /offer_token/);
  // Nothing was recorded and nothing was run: there was no signed price to run
  // against, and inventing one is the whole thing the token prevents.
  assert.equal(handler.seen.length, 0);
});

