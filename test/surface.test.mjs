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

const EXPECTED = [
  "apiosk_connect",
  "apiosk_discover",
  "apiosk_compare",
  "apiosk_execute",
  "apiosk_approval_status",
];

test("the tool surface is exactly the five buyer-flow tools", async () => {
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
    const saysSpend = /SPENDS MONEY|spends nothing|Spends nothing|Reads only/.test(tool.description);
    assert.ok(saysSpend, `${tool.name} must say whether it spends money`);
  }
});

test("only the tools that touch money are gated behind a connection", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  assert.equal(await runtime.isToolProtected("apiosk_execute"), true);
  assert.equal(await runtime.isToolProtected("apiosk_approval_status"), true);
  assert.equal(await runtime.isToolProtected("apiosk_connect"), false);
  assert.equal(await runtime.isToolProtected("apiosk_discover"), false);
  assert.equal(await runtime.isToolProtected("apiosk_compare"), false);
});

test("an unknown tool is refused by name, with the real list", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  const result = await runtime.callTool("apiosk_list_wallets", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /apiosk_connect/);
  assert.match(result.content[0].text, /tool\.unknown/);
});

test("the published manifests agree on the five names", () => {
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
