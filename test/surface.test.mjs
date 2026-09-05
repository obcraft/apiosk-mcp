// The tool surface, asserted by name.
//
// This test is the thing that stops the drawer refilling. It failed once for a
// good reason — a tool was added deliberately, the plan changed, and the list
// here changed with it. Every other time it fails, something grew back.
//
// Adding a name here without a corresponding entry in
// apiosk-buyer-flow-tasks/mcp/ is how thirty nine tools happened.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createApioskMcpRuntime } from "../src/runtime.mjs";
import { TOOL_NAMES } from "../src/tools/index.mjs";
import { listApioskTools } from "../src/create-server.mjs";

// The order is the order the two flows run in, and it is asserted rather than
// sorted: a list that reorders itself is a list a reviewer stops reading.
const EXPECTED = [
  "apiosk",
  "apiosk_connect",
  "apiosk_discover",
  "apiosk_compare",
  "apiosk_execute",
  "apiosk_approval_status",
  // Step 7 of goal-plan-price-result: the multi-call flow. Added deliberately,
  // with the plan compiled and priced by the gateway and by nothing here.
  "apiosk_plan",
  "apiosk_execute_plan",
  "apiosk_job_status",
  "apiosk_resolve_job",
  "apiosk_cancel_job",
];

test("the tool surface is exactly the eleven buyer-flow tools", async () => {
  assert.deepEqual(TOOL_NAMES, EXPECTED);

  const runtime = createApioskMcpRuntime({ env: {} });
  const tools = await runtime.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED);
});

test("the surface does not vary by how the caller authenticated", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  const anonymous = await runtime.listTools();
  const connected = await listApioskTools({ runtime });
  assert.deepEqual(
    anonymous.map((tool) => tool.name),
    connected.map((tool) => tool.name)
  );
});

test("every tool declares a description that says whether it spends", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  for (const tool of await runtime.listTools()) {
    assert.ok(tool.description && tool.description.length > 120, `${tool.name} needs a real description`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    // A tool has to say which side of the money line it is on. "SPENDS MONEY"
    // used to be the only accepted way to say it, and it said the wrong thing:
    // the user is not reaching for a card, Apiosk settles the call from a
    // balance they funded and capped in advance. The claim still has to be
    // there, in one of the words that actually mean it.
    const saysSpend = /settles the call|settles its calls|settles the plan's calls|spends nothing|Spends nothing|Spends nothing itself|Reads only/.test(
      tool.description
    );
    assert.ok(saysSpend, `${tool.name} must say whether it spends money`);
  }
});

test("every agent-gateway data tool starts OAuth before its first request", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  assert.equal(await runtime.isToolProtected("apiosk"), true);
  assert.equal(await runtime.isToolProtected("apiosk_execute"), true);
  assert.equal(await runtime.isToolProtected("apiosk_approval_status"), true);
  assert.equal(await runtime.isToolProtected("apiosk_connect"), false);
  assert.equal(await runtime.isToolProtected("apiosk_discover"), true);
  assert.equal(await runtime.isToolProtected("apiosk_compare"), true);
  for (const name of ["apiosk_plan", "apiosk_execute_plan", "apiosk_job_status", "apiosk_resolve_job", "apiosk_cancel_job"]) {
    assert.equal(await runtime.isToolProtected(name), true, `${name} must start OAuth before its first request`);
  }
});

test("the quick card has real approve and deny actions", async () => {
  const { APIO_OFFER_CARD_HTML, APIO_OFFER_CARD_META } = await import("../src/offer-card.mjs");
  assert.match(APIO_OFFER_CARD_HTML, /id="approve"/);
  assert.match(APIO_OFFER_CARD_HTML, /id="deny"/);
  assert.match(APIO_OFFER_CARD_HTML, /callTool\('apiosk_execute'/);
  assert.match(APIO_OFFER_CARD_HTML, /sendFollowUpMessage/);
  assert.deepEqual(APIO_OFFER_CARD_META.ui.csp.connectDomains, []);
});

test("an unknown tool is refused by name, with the real list", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  const result = await runtime.callTool("apiosk_list_wallets", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /apiosk_connect/);
  assert.match(result.content[0].text, /tool\.unknown/);
});

test("the plan card has real approve and deny actions and starts nothing else", async () => {
  const { APIO_PLAN_CARD_HTML, APIO_PLAN_CARD_META } = await import("../src/plan-card.mjs");
  assert.match(APIO_PLAN_CARD_HTML, /id="approve"/);
  assert.match(APIO_PLAN_CARD_HTML, /id="deny"/);
  assert.match(APIO_PLAN_CARD_HTML, /callTool\('apiosk_execute_plan'/);
  assert.match(APIO_PLAN_CARD_HTML, /sendFollowUpMessage/);
  assert.deepEqual(APIO_PLAN_CARD_META.ui.csp.connectDomains, []);
  // The card carries the token through; it never assembles a plan of its own.
  assert.ok(!/required_outputs|apiosk_plan'/.test(APIO_PLAN_CARD_HTML));
});

test("the published manifests agree on the eleven names", () => {
  const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));

  const dxt = read("../dxt.json");
  assert.deepEqual(dxt.tools.map((tool) => tool.name), EXPECTED);

  const serverJson = read("../server.json");
  const described = JSON.stringify(serverJson);
  for (const name of EXPECTED) assert.ok(described.includes(name), `server.json must name ${name}`);

  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const name of EXPECTED) assert.ok(readme.includes(name), `README.md must document ${name}`);
  for (const gone of ["apiosk_decide", "apiosk_fetch_paid", "apiosk_list_wallets", "apiosk_publish_api"]) {
    assert.ok(!readme.includes(gone), `README.md still documents the removed ${gone}`);
  }
});

test("no module in src/ is allowed to grow past 20 KB", () => {
  const dir = new URL("../src/", import.meta.url);
  const oversized = [];
  const walk = (base, prefix = "") => {
    for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(new URL(`${entry.name}/`, base), `${prefix}${entry.name}/`);
        continue;
      }
      if (!entry.name.endsWith(".mjs")) continue;
      const size = fs.statSync(new URL(entry.name, base)).size;
      // Two exemptions, both temporary and both owned by mcp/01, which replaces
      // the browser wallet sign-in page with the buyer portal handoff:
      //   oauth.mjs   carries that page
      //   assets/     the vendored browser bundles the page loads. Not hand
      //               written, so the 20 KB rule was never about them.
      const name = `${prefix}${entry.name}`;
      if (size > 20 * 1024 && name !== "oauth.mjs" && !name.startsWith("assets/")) {
        oversized.push(`${name} (${Math.round(size / 1024)} KB)`);
      }
    }
  };
  walk(dir);
  assert.deepEqual(oversized, [], `split these: ${oversized.join(", ")}`);
});
