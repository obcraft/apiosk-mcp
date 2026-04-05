import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { rm } from "node:fs/promises";

import { createApioskMcpRuntime } from "../runtime.mjs";

function createFakeClient() {
  return {
    async listApis() {
      return {
        apis: [
          {
            slug: "demo-api",
            name: "Demo API",
            description: "Demo tool",
            category: "data",
            price_usd: 0.01,
            active: true,
            listing_metadata: {
              mcp_native: true,
              default_operation: "/",
              mcp_tool: {
                name: "demo-api",
                description: "Demo tool",
                inputSchema: { type: "object", additionalProperties: true },
              },
            },
          },
        ],
        meta: { total: 1, returned: 1, limit: 1, offset: 0 },
      };
    },
    async getApi(slug) {
      return { slug };
    },
    async getMetadata(slug) {
      return { slug, ok: true };
    },
    async execute(slug, input) {
      return { slug, input, status: "success" };
    },
    async requestJson(pathValue) {
      if (pathValue === "/types") {
        return { supported_types: [{ key: "api" }, { key: "dataset" }] };
      }
      return { apis: [], meta: { total: 0 } };
    },
  };
}

function createRuntime(homeDir, env = {}) {
  return createApioskMcpRuntime({
    client: createFakeClient(),
    env: {
      APIOSK_HOME: homeDir,
      ...env,
    },
    enableLocalWallets: true,
    walletManager: { isConfigured: () => false, request: async () => ({}) },
  });
}

test("wallet create returns configure menu and funding QR data", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-test-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_wallet_create", { label: "Test wallet" });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.wallet.label, "Test wallet");
  assert.match(payload.wallet.address, /^0x[a-f0-9]{40}$/);
  assert.ok(payload.configure);
  assert.equal(payload.configure.selected_section, "overview");
  assert.ok(payload.configure.funding.receive_on_base.qr_image_url);
  assert.ok(payload.configure.funding.receive_on_base.qr_code_terminal);
  assert.equal(payload.configure.options_menu.title, "Apiosk Control Menu");
  assert.ok(
    payload.configure.options_menu.sections.some((section) => section.id === "funding")
  );

  await rm(homeDir, { recursive: true, force: true });
});

test("configure returns provider checkout details when environment allows", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-provider-${Date.now()}`);
  const runtime = createRuntime(homeDir, {
    ONRAMPER_API_KEY: "demo-api-key",
    ONRAMPER_WIDGET_SECRET: "demo-secret",
  });

  const created = await runtime.callTool("apiosk_wallet_create", { label: "Fundable wallet" });
  const createPayload = JSON.parse(created.content[0].text);

  const configured = await runtime.callTool("apiosk_configure", {
    wallet_id: createPayload.wallet.id,
    section: "funding",
    funding_provider: "onramper",
  });
  const configurePayload = JSON.parse(configured.content[0].text);

  assert.equal(configurePayload.selected_section, "funding");
  assert.equal(configurePayload.funding.selected_provider.id, "onramper");
  assert.match(configurePayload.funding.selected_provider.widget_url, /^https:\/\/buy\.onramper\.com\//);
  assert.ok(
    configurePayload.options_menu.sections
      .find((section) => section.id === "funding")
      .options.some((option) => option.label === "Request Onramper checkout")
  );

  await rm(homeDir, { recursive: true, force: true });
});

test("local-wallet-disabled mode hides configure and wallet-create tools", async () => {
  const runtime = createApioskMcpRuntime({
    client: createFakeClient(),
    env: {},
    enableLocalWallets: false,
    walletManager: { isConfigured: () => false, request: async () => ({}) },
  });

  const tools = await runtime.listTools();

  assert.equal(tools.some((tool) => tool.name === "apiosk_wallet_create"), false);
  assert.equal(tools.some((tool) => tool.name === "apiosk_configure"), false);
});
