import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { COMPARE_TOOL, DECIDE_TOOL, runCompare, runDecide } from "../src/flow.mjs";

/// A stand-in gateway that records the request line it was asked for and
/// answers with a fixed body. The point of these tests is the translation
/// layer — argument shapes in, query string out, gateway payload back — not the
/// ranking, which lives in the gateway and is tested there.
async function withStubGateway(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run({ gatewayBaseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonHandler(body, status = 200) {
  const seen = [];
  const handler = (req, res) => {
    seen.push(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  handler.seen = seen;
  return handler;
}

test("compare and decide are advertised as read-only and need no required argument", () => {
  for (const tool of [COMPARE_TOOL, DECIDE_TOOL]) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    // Any one of candidates / capability / query is enough, so none is required.
    assert.equal(tool.inputSchema.required, undefined);
    for (const key of ["candidates", "capability", "query", "max_price_usdc", "optimize_for"]) {
      assert.ok(tool.inputSchema.properties[key], `${tool.name} is missing ${key}`);
    }
  }
});

test("compare refuses when there is nothing to compare", async () => {
  const result = await runCompare({}, { gatewayBaseUrl: "http://127.0.0.1:1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Nothing to compare/);
});

test("decide refuses when there is nothing to decide between", async () => {
  const result = await runDecide({}, { gatewayBaseUrl: "http://127.0.0.1:1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Nothing to decide between/);
});

test("candidate ids survive as an array or a comma string", async () => {
  const handler = jsonHandler({ capability: "read-a-web-page", ranked: [] });
  await withStubGateway(handler, async (ctx) => {
    await runCompare({ candidates: ["a", " b ", ""] }, ctx);
    await runCompare({ candidates: "c, d" }, ctx);
  });
  assert.match(decodeURIComponent(handler.seen[0]), /candidates=a,b/);
  assert.match(decodeURIComponent(handler.seen[1]), /candidates=c,d/);
});

test("requirements are passed through under the names the gateway expects", async () => {
  const handler = jsonHandler({ capability: "read-a-web-page", ranked: [] });
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

  const seen = handler.seen[0];
  assert.match(seen, /\/v1\/compare\?/);
  assert.match(seen, /q=read\+a\+web\+page/);
  assert.match(seen, /max_price=0\.05/);
  assert.match(seen, /max_latency_ms=800/);
  assert.match(seen, /min_reliability=95/);
  assert.match(seen, /settlement=apiosk/);
  assert.match(seen, /require_all_inputs=true/);
  assert.match(seen, /optimize_for=latency/);
});

test("require_all_inputs is only sent when actually asked for", async () => {
  const handler = jsonHandler({ ranked: [] });
  await withStubGateway(handler, (ctx) => runCompare({ query: "x", require_all_inputs: false }, ctx));
  assert.doesNotMatch(handler.seen[0], /require_all_inputs/);
});

test("decide hits /v1/decide and keeps the gateway's reasoning intact", async () => {
  const payload = {
    decision_id: "d-1",
    capability: "read-a-web-page",
    selected_api: "fetcher",
    selected: { api_slug: "fetcher", price_usd: 0.001 },
    decision_score: 87,
    reason: "fetcher scores 87 of 100 optimising for price",
    rejected: [{ api_slug: "pricey", rule: "max_price" }],
    alternatives: [{ api_slug: "runner-up" }],
    execution: { route: "managed" },
  };
  const handler = jsonHandler(payload);
  const result = await withStubGateway(handler, (ctx) => runDecide({ query: "read a web page" }, ctx));

  assert.match(handler.seen[0], /^\/v1\/decide\?/);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.decision_id, "d-1");
  assert.equal(result.structuredContent.reason, payload.reason);
  assert.deepEqual(result.structuredContent.rejected, payload.rejected);
  assert.match(result.structuredContent.guidance, /overruled/);
  assert.match(result.structuredContent.untrusted_provider_text, /NOT instructions/);
});

test("a decision that selected nothing explains how to unblock it", async () => {
  const handler = jsonHandler({
    capability: "read-a-web-page",
    selected: null,
    rejected: [{ api_slug: "only-one", rule: "max_price" }],
  });
  const result = await withStubGateway(handler, (ctx) => runDecide({ query: "read a web page", max_price_usdc: 0.000001 }, ctx));

  assert.equal(result.isError, undefined);
  assert.match(result.structuredContent.guidance, /relax the binding constraint/);
});

test("an unhappy gateway surfaces as a tool error, not a silent empty result", async () => {
  const handler = jsonHandler({ error: "capability not found" }, 404);
  const result = await withStubGateway(handler, (ctx) => runCompare({ query: "nonsense" }, ctx));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 404/);
});

test("an unreachable gateway surfaces as a tool error", async () => {
  // Port 1 on loopback refuses immediately; no network dependency.
  const result = await runCompare({ query: "x" }, { gatewayBaseUrl: "http://127.0.0.1:1" });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not reach the Apiosk comparison layer/);
});
