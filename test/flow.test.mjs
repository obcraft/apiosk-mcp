import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { COMPARE_TOOL_INPUT_SCHEMA, runCompare } from "../src/flow.mjs";
import { COMPARE_TOOL } from "../src/tools/compare.mjs";
import { createGatewayClient } from "../src/gateway-client.mjs";

/// A stand-in gateway that records the request line it was asked for and
/// answers with a fixed body. The point of these tests is the translation
/// layer — argument shapes in, query string out, gateway payload back — not the
/// ranking, which lives in the gateway and is tested there.
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
    seen.push(req.url);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  handler.seen = seen;
  return handler;
}

test("compare is advertised as read-only and needs no required argument", () => {
  assert.equal(COMPARE_TOOL.annotations.readOnlyHint, true);
  assert.equal(COMPARE_TOOL.annotations.destructiveHint, false);
  assert.equal(COMPARE_TOOL.inputSchema, COMPARE_TOOL_INPUT_SCHEMA);
  // Any one of candidates / capability / query is enough, so none is required.
  assert.equal(COMPARE_TOOL_INPUT_SCHEMA.required, undefined);
  for (const key of ["candidates", "capability", "query", "max_price_usdc", "optimize_for"]) {
    assert.ok(COMPARE_TOOL_INPUT_SCHEMA.properties[key], `apiosk_compare is missing ${key}`);
  }
});

test("compare refuses when there is nothing to compare", async () => {
  const result = await runCompare({}, { gateway: unreachableGateway() });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Nothing to compare/);
});

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "66666666-7777-4888-8999-aaaaaaaaaaaa";

test("gateway candidate ids survive as an array or a comma string", async () => {
  const handler = jsonHandler({ capability: "read-a-web-page", ranked: [] });
  await withStubGateway(handler, async (ctx) => {
    await runCompare({ candidates: [UUID_A, ` ${UUID_B} `, ""] }, ctx);
    await runCompare({ candidates: `${UUID_A}, ${UUID_B}` }, ctx);
  });
  assert.match(decodeURIComponent(handler.seen[0]), new RegExp(`candidates=${UUID_A},${UUID_B}`));
  assert.match(decodeURIComponent(handler.seen[1]), new RegExp(`candidates=${UUID_A},${UUID_B}`));
});

/// The bug this guards: apiosk_discover is a cross-source search and mints its
/// own ids (`apiosk:<slug>`, `bazaar:<url>`). Forwarding one reached the gateway
/// as an unresolvable candidate and came back 404 "nothing performs that", which
/// reads as "no such providers" rather than "wrong kind of id".
test("apiosk_discover ids are refused with the fix, not forwarded into a 404", async () => {
  const handler = jsonHandler({ ranked: [] });
  const result = await withStubGateway(handler, (ctx) =>
    runCompare({ candidates: ["apiosk:apyhub-extract-links", "bazaar:https://x.example/y"] }, ctx),
  );

  assert.equal(handler.seen.length, 0, "must not reach the gateway at all");
  assert.equal(result.isError, true);
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.error, "unusable_candidates");
  assert.deepEqual(body.rejected, ["apiosk:apyhub-extract-links", "bazaar:https://x.example/y"]);
  // The message has to say what to do instead, or the agent just retries.
  assert.match(body.message, /query/);
});

test("a discover id alongside a query is dropped, and the query still runs", async () => {
  const handler = jsonHandler({ ranked: [] });
  await withStubGateway(handler, (ctx) =>
    runCompare({ candidates: ["apiosk:something", UUID_A], query: "read a web page" }, ctx),
  );
  const seen = decodeURIComponent(handler.seen[0]);
  // The UUID survives, the discover id does not, and the query goes along so
  // the gateway can still resolve a capability.
  assert.match(seen, new RegExp(`candidates=${UUID_A}`));
  assert.doesNotMatch(seen, /apiosk:something/);
  assert.match(seen, /q=read\+a\+web\+page/);
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

test("the choice belongs to the user: there is no decide step to call", async () => {
  const flow = await import("../src/flow.mjs");
  assert.equal(flow.runDecide, undefined);
  assert.equal(flow.DECIDE_TOOL, undefined);
});



test("an unhappy gateway surfaces as a tool error, not a silent empty result", async () => {
  const handler = jsonHandler({ error: "capability not found" }, 404);
  const result = await withStubGateway(handler, (ctx) => runCompare({ query: "nonsense" }, ctx));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /HTTP 404/);
});

test("an unreachable gateway surfaces as a tool error", async () => {
  // Port 1 on loopback refuses immediately; no network dependency.
  const result = await runCompare({ query: "x" }, { gateway: unreachableGateway() });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Could not reach the Apiosk gateway/);
});
