import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";

import { createApioskMcpRuntime } from "../src/runtime.mjs";

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

function createRuntime(homeDir, env = {}, runtimeOptions = {}) {
  return createApioskMcpRuntime({
    env: {
      APIOSK_HOME: homeDir,
      ...env,
    },
    enableLocalWallets: true,
    walletManager: runtimeOptions.walletManager ?? { isConfigured: () => false, request: async () => ({}) },
    client: Object.prototype.hasOwnProperty.call(runtimeOptions, "client")
      ? runtimeOptions.client
      : createFakeClient(),
    clientFactory: runtimeOptions.clientFactory ?? null,
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

test("get started creates a local wallet and completes a test call", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-get-started-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_get_started", {
    wallet_label: "Starter wallet",
    test_slug: "demo-api",
    test_input: { hello: "world" },
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.status, "ready");
  assert.equal(payload.auth.mode, "local_wallet");
  assert.equal(payload.setup.created_wallet.label, "Starter wallet");
  assert.equal(payload.test.slug, "demo-api");
  assert.deepEqual(payload.test.result, {
    slug: "demo-api",
    input: { hello: "world" },
    status: "success",
  });
  assert.ok(payload.configure);

  await rm(homeDir, { recursive: true, force: true });
});

test("get started saves a connect string and reuses it for client construction", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-connect-${Date.now()}`);
  let lastClientOptions = null;
  const runtime = createRuntime(
    homeDir,
    {},
    {
      client: null,
      clientFactory: async (options) => {
        lastClientOptions = options;
        return createFakeClient();
      },
    }
  );

  const result = await runtime.callTool("apiosk_get_started", {
    connect_string: [
      "export APIO_GATEWAY_URL=https://gateway.apiosk.com",
      "export APIO_CHAIN_ID=8453",
      "export APIO_AGENT_WALLET_ADDRESS=0x1111111111111111111111111111111111111111",
      "export APIO_CONNECT_TOKEN=aw_demo_token",
      "export APIO_CONNECT_AUTHORIZATION=Bearer aw_demo_token",
      "export APIO_CONNECT_HEADER_NAME=X-Apiosk-Connect-Token",
    ].join("\n"),
    test_slug: "demo-api",
    test_input: { ping: true },
    create_wallet: false,
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.status, "ready");
  assert.equal(payload.auth.mode, "connect_token");
  assert.equal(payload.auth.saved_connect_config.connect_token_saved, true);
  assert.equal(lastClientOptions.connectToken, "aw_demo_token");
  assert.equal(lastClientOptions.baseUrl, "https://gateway.apiosk.com");
  assert.equal(
    payload.auth.local_config_paths.configFile,
    path.join(homeDir, "config.json")
  );

  await rm(homeDir, { recursive: true, force: true });
});

test("dashboard sign-in saves a local session and credits tools return the Adyen checkout URL", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-credits-${Date.now()}`);
  const requests = [];
  const runtime = createRuntime(homeDir, {}, {
    walletManager: {
      isConfigured: () => false,
      async request(route, init = {}) {
        requests.push({ route, init });
        if (route === "/api/auth/mcp-sign-in") {
          return {
            success: true,
            signed_in: true,
            email: "demo@example.com",
            session_token: "jwt_demo_token",
            expires_at: 1_800_000_000,
          };
        }

        if (route === "/api/credits/topup") {
          return {
            payment_intent_id: "intent_123",
            adyen_payment_link_id: "plink_123",
            checkout_url: "https://checkout.adyen.test/pay/123",
            credits_to_add: 1000,
            amount_eur: 10,
            status: "active",
          };
        }

        if (route === "/api/credits/reconcile") {
          return {
            attempted: 1,
            reconciled: 1,
            already_processed: 0,
            credits: 1000,
            pending_intents: [],
            results: [
              {
                payment_intent_id: "intent_123",
                provider_payment_id: "plink_123",
                credited: true,
                already_processed: false,
                status: "paid",
              },
            ],
          };
        }

        return {};
      },
    },
  });

  const signIn = await runtime.callTool("apiosk_sign_in", {
    email: "demo@example.com",
    password: "secret123",
  });
  const signInPayload = JSON.parse(signIn.content[0].text);
  assert.equal(signInPayload.saved_session, true);

  const rawConfig = await readFile(path.join(homeDir, "config.json"), "utf8");
  const savedConfig = JSON.parse(rawConfig);
  assert.equal(savedConfig.dashboard_session_token, "jwt_demo_token");
  assert.equal(savedConfig.dashboard_session_email, "demo@example.com");

  const topup = await runtime.callTool("apiosk_buy_credits", { amount_eur: 10 });
  const topupPayload = JSON.parse(topup.content[0].text);
  assert.equal(topupPayload.payment_intent_id, "intent_123");
  assert.equal(topupPayload.payment_url, "https://checkout.adyen.test/pay/123");

  const status = await runtime.callTool("apiosk_get_credits_status", {
    payment_intent_id: "intent_123",
  });
  const statusPayload = JSON.parse(status.content[0].text);
  assert.equal(statusPayload.credits, 1000);
  assert.equal(statusPayload.reconciled, 1);

  assert.deepEqual(
    requests.map((entry) => entry.route),
    ["/api/auth/mcp-sign-in", "/api/credits/topup", "/api/credits/reconcile"]
  );

  await rm(homeDir, { recursive: true, force: true });
});

test("create account tells the caller to confirm email when signup does not return a session", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-signup-${Date.now()}`);
  const runtime = createRuntime(homeDir, {}, {
    walletManager: {
      isConfigured: () => false,
      async request(route) {
        assert.equal(route, "/api/auth/mcp-sign-up");
        return {
          success: true,
          account_created: true,
          email: "new@example.com",
          email_confirmation_required: true,
          session_token: null,
        };
      },
    },
  });

  const result = await runtime.callTool("apiosk_create_account", {
    email: "new@example.com",
    password: "secret123",
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.account_created, true);
  assert.equal(payload.email_confirmation_required, true);
  assert.equal(payload.saved_session, false);
  assert.match(payload.next_steps[0], /confirm their email/i);

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
  assert.equal(tools.some((tool) => tool.name === "apiosk_get_started"), false);
  assert.equal(tools.some((tool) => tool.name === "apiosk_configure"), false);
  assert.equal(tools.some((tool) => tool.name === "apiosk_buy_credits"), false);
  assert.equal(tools.some((tool) => tool.name === "apiosk_sign_in"), false);
});

test("dynamic order tools return a human confirmation summary with structured content", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-order-${Date.now()}`);
  const runtime = createApioskMcpRuntime({
    env: { APIOSK_HOME: homeDir },
    enableLocalWallets: true,
    walletManager: { isConfigured: () => false, request: async () => ({}) },
    client: {
      async listApis() {
        return {
          apis: [
            {
              slug: "bella-pizza",
              name: "La Bella Pizza API",
              description: "Order fictional pizzas",
              category: "demo",
              price_usd: 5,
              active: true,
              listing_metadata: {
                mcp_native: true,
                default_operation: "/orders",
                mcp_tool: {
                  name: "bella-pizza",
                  description: "Order pizza",
                  inputSchema: {
                    type: "object",
                    required: ["type", "size"],
                    properties: {
                      type: { type: "string" },
                      size: { type: "string" },
                    },
                  },
                },
              },
            },
          ],
          meta: { total: 1, returned: 1, limit: 1, offset: 0 },
        };
      },
      async execute(slug, input) {
        return {
          status: "success",
          api: slug,
          operation: "/orders",
          upstream_status: 200,
          cost: 5,
          latency: 120,
          result: {
            order_id: "12345",
            pizza: {
              type: input.type,
              size: input.size,
            },
            address: "Saved address on file",
            receipt_url: "https://tmpfiles.org/dl/demo/receipt_12345.pdf",
          },
        };
      },
      async getApi(slug) {
        return { slug };
      },
      async getMetadata(slug) {
        return { slug, ok: true };
      },
      async requestJson() {
        return { apis: [], meta: { total: 0 } };
      },
    },
    clientFactory: null,
  });

  const result = await runtime.callTool("bella-pizza", {
    type: "Tonno",
    size: "Small",
  });

  assert.match(result.content[0].text, /order confirmed/i);
  assert.match(result.content[0].text, /Small Tonno/);
  assert.equal(result.structuredContent.result.order_id, "12345");

  await rm(homeDir, { recursive: true, force: true });
});
