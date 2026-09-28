// The tool surface, asserted by name.
//
// This test is the thing that stops the drawer refilling. Since 2.0 the only
// runtime is Gateway v2: four model-visible tools and one app-only approval
// tool the interactive card calls. Every other time this fails, something grew
// back.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { createApioskMcpRuntime, DEFAULT_GATEWAY_V2_URL, resolveGatewayV2Url } from "../src/runtime.mjs";
import { listApioskTools, SERVER_BASE_VERSION } from "../src/create-server.mjs";

// The order is the order the flow runs in, and it is asserted rather than
// sorted: a list that reorders itself is a list a reviewer stops reading.
const EXPECTED = [
  "apiosk_sources",
  "apiosk_discover",
  // The Ask page's own steps: a chatbot-filled capability object, then one endpoint.
  "apiosk_search",
  "apiosk_prepare",
  "apiosk_execute",
  "apiosk_status",
  // App-only: the card calls it after the person clicks Approve.
  "apiosk_approve",
];

test("the tool surface is exactly the Gateway v2 tools, for every transport", async () => {
  // No APIOSK_GATEWAY_V2_URL: stdio installs get v2 too, not a legacy runtime.
  const runtime = createApioskMcpRuntime({ env: {} });
  const tools = await runtime.listTools();
  assert.deepEqual(tools.map((tool) => tool.name), EXPECTED);
});

test("the gateway defaults to production and never mutates the caller's env", async () => {
  const env = {};
  assert.equal(resolveGatewayV2Url(env), "https://gateway.apiosk.com");
  assert.equal(DEFAULT_GATEWAY_V2_URL, "https://gateway.apiosk.com");
  assert.equal(resolveGatewayV2Url({ APIOSK_GATEWAY_V2_URL: "http://127.0.0.1:8082" }), "http://127.0.0.1:8082");

  let seen;
  const runtime = createApioskMcpRuntime({
    env: { ...env, APIOSK_CONNECT_TOKEN: "apk_access_fixture" },
    fetchImpl: async (url, options) => {
      seen = { url: String(url), authorization: options.headers.authorization };
      return Response.json({ protocol_version: "2", sources: [], total: 0, offset: 0, next_offset: null, categories: [], tags: [], sectors: [], capabilities: [] });
    },
  });
  await runtime.callTool("apiosk_sources", {});
  assert.equal(new URL(seen.url).origin, "https://gateway.apiosk.com");
  assert.equal(new URL(seen.url).pathname, "/v2/sources");
  assert.equal(seen.authorization, "Bearer apk_access_fixture");
  assert.deepEqual(env, {});
});

test("the surface does not vary by how the caller authenticated", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  const anonymous = await runtime.listTools();
  const connected = await listApioskTools({ runtime });
  const hosted = await listApioskTools({ env: {}, hostedAuthEnabled: true });
  assert.deepEqual(anonymous.map((tool) => tool.name), connected.map((tool) => tool.name));
  assert.deepEqual(anonymous.map((tool) => tool.name), hosted.map((tool) => tool.name));
});

test("every tool has all three explicit review annotations", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  for (const tool of await runtime.listTools()) {
    assert.ok(tool.description && tool.description.length > 120, `${tool.name} needs a real description`);
    assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
    for (const annotation of ["readOnlyHint", "openWorldHint", "destructiveHint"]) {
      assert.equal(typeof tool.annotations?.[annotation], "boolean", `${tool.name} must explicitly declare ${annotation}`);
    }
  }
});

test("every tool acts for a connected account and starts OAuth before its first request", async () => {
  const runtime = createApioskMcpRuntime({ env: {} });
  for (const name of EXPECTED) assert.equal(await runtime.isToolProtected(name), true, `${name} must be protected`);
  assert.equal(await runtime.isToolProtected("apiosk_connect"), false);
});

test("the 1.x agent-gateway tools are gone and refused by name", async () => {
  const runtime = createApioskMcpRuntime({ env: { APIOSK_CONNECT_TOKEN: "apk_access_fixture" } });
  for (const gone of ["apiosk", "apiosk_connect", "apiosk_compare", "apiosk_approval_status", "apiosk_plan", "apiosk_execute_plan", "apiosk_job_status", "apiosk_resolve_job", "apiosk_cancel_job"]) {
    const result = await runtime.callTool(gone, {});
    assert.equal(result.isError, true, `${gone} must be refused`);
    assert.match(result.content[0].text, /tool\.unknown/);
  }
});

test("the published manifests agree on the tool names", () => {
  const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));

  const dxt = read("../dxt.json");
  assert.deepEqual(dxt.tools.map((tool) => tool.name), EXPECTED);

  const serverJson = read("../server.json");
  assert.deepEqual(serverJson._meta["com.apiosk"].tools, EXPECTED);

  const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
  for (const name of EXPECTED) assert.ok(readme.includes(name), `README.md must document ${name}`);
  for (const gone of ["apiosk_compare", "apiosk_plan", "apiosk_execute_plan", "apiosk_job_status", "apiosk_approval_status", "apiosk_connect"]) {
    assert.ok(!readme.includes(gone), `README.md still documents the removed ${gone}`);
  }
});

test("every published package and UI reports the server base version", () => {
  const read = (path) => JSON.parse(fs.readFileSync(new URL(path, import.meta.url), "utf8"));
  const packageJson = read("../package.json");
  const packageLock = read("../package-lock.json");
  const serverJson = read("../server.json");
  const dxt = read("../dxt.json");
  const pluginJson = read("../plugin/apiosk/.codex-plugin/plugin.json");
  const pyproject = fs.readFileSync(new URL("../pyproject.toml", import.meta.url), "utf8");
  const pythonInit = fs.readFileSync(new URL("../python/apiosk_mcp/__init__.py", import.meta.url), "utf8");
  const uiBridge = fs.readFileSync(new URL("../src/ui-bridge.mjs", import.meta.url), "utf8");

  assert.equal(SERVER_BASE_VERSION, "2.0.0");
  assert.equal(packageJson.version, SERVER_BASE_VERSION);
  assert.equal(packageLock.version, SERVER_BASE_VERSION);
  assert.equal(packageLock.packages[""].version, SERVER_BASE_VERSION);
  assert.equal(serverJson.version, SERVER_BASE_VERSION);
  for (const publishedPackage of serverJson.packages) {
    assert.equal(publishedPackage.version, SERVER_BASE_VERSION);
  }
  assert.equal(dxt.version, SERVER_BASE_VERSION);
  assert.equal(pluginJson.version, SERVER_BASE_VERSION);
  assert.match(pyproject, new RegExp(`^version = "${SERVER_BASE_VERSION}"$`, "m"));
  assert.match(pythonInit, new RegExp(`^__version__ = "${SERVER_BASE_VERSION}"$`, "m"));
  assert.match(uiBridge, new RegExp(`appInfo:\\{name:'Apiosk',version:'${SERVER_BASE_VERSION}'`));
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
      // oauth.mjs carries the hosted OAuth provider and is the one exemption;
      // vendored browser bundles under assets/ were never hand written.
      const name = `${prefix}${entry.name}`;
      if (size > 20 * 1024 && name !== "oauth.mjs" && !name.startsWith("assets/")) {
        oversized.push(`${name} (${Math.round(size / 1024)} KB)`);
      }
    }
  };
  walk(dir);
  assert.deepEqual(oversized, [], `split these: ${oversized.join(", ")}`);
});
