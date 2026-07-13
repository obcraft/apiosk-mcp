import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { readFile, rm } from "node:fs/promises";

import { createApioskMcpRuntime } from "../src/runtime.mjs";
import { APIO_RESULT_CANVAS_HTML, APIO_RESULT_CANVAS_URI } from "../src/result-canvas.mjs";

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
      if (pathValue === "/health") {
        return { status: "ok" };
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

test("apiosk_wallet_create response includes inline QR image content block", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-create-image-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_wallet_create", { label: "Inline QR wallet" });

  // Backwards-compat: the first content block is still the JSON payload
  // older clients parsed.
  assert.equal(result.content[0].type, "text");
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload.wallet.address, /^0x[a-f0-9]{40}$/);
  // The configure.funding bundle keeps shipping qr_image_url + ANSI QR.
  assert.ok(payload.configure.funding.receive_on_base.qr_image_url);
  assert.ok(payload.configure.funding.receive_on_base.qr_code_terminal);

  // New: an image content block with the PNG QR is appended automatically
  // so Claude Desktop / MCP Inspector renders the QR inline with the
  // create-wallet response — no follow-up tool call required.
  const imageBlock = result.content.find((block) => block.type === "image");
  assert.ok(imageBlock, "expected inline image content block on wallet create");
  assert.equal(imageBlock.mimeType, "image/png");
  assert.ok(imageBlock.data && imageBlock.data.length > 100, "PNG data should not be empty");

  await rm(homeDir, { recursive: true, force: true });
});

test("apiosk_show_wallet_funding returns address text + QR image content", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-funding-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  await runtime.callTool("apiosk_wallet_create", { label: "Buyer wallet" });

  const tools = (await runtime.listTools()).map((t) => t.name);
  assert.ok(
    tools.includes("apiosk_show_wallet_funding"),
    "apiosk_show_wallet_funding should be exposed in the tool list",
  );

  const result = await runtime.callTool("apiosk_show_wallet_funding", {});
  // First content block must carry the wallet address as plain text so
  // clients without image rendering still see useful output.
  assert.equal(result.content[0].type, "text");
  assert.match(result.content[0].text, /Address: 0x[a-fA-F0-9]{40}/);
  assert.match(result.content[0].text, /Base mainnet/);
  // The structured payload exposes the address + Base USDC contract for
  // any agent that wants to drive a bridge / exchange flow itself.
  assert.match(result.structuredContent.address, /^0x[a-f0-9]{40}$/);
  assert.equal(result.structuredContent.network, "base");
  assert.equal(result.structuredContent.chain_id, 8453);
  assert.equal(result.structuredContent.token_symbol, "USDC");
  // Image content block should be present (we always set
  // includeQrDataUrl=true) and base64-encoded.
  const imageBlock = result.content.find((block) => block.type === "image");
  assert.ok(imageBlock, "image content block should be present");
  assert.equal(imageBlock.mimeType, "image/png");
  assert.ok(imageBlock.data && imageBlock.data.length > 100, "QR PNG data should not be empty");

  await rm(homeDir, { recursive: true, force: true });
});

test("apiosk_show_wallet_funding errors cleanly when no wallet exists", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-funding-empty-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_show_wallet_funding", {});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /No managed wallet/);

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

// The remote credits tools (apiosk_buy_credits / apiosk_get_credits_status)
// were removed with the legacy dashboard backend, so this covers only the
// local sign-in + saved-session flow they used to piggyback on.
test("dashboard sign-in saves a local session for managed-wallet tools", async () => {
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

  assert.deepEqual(
    requests.map((entry) => entry.route),
    ["/api/auth/mcp-sign-in"]
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

test("search surfaces a payment hint and provider pointer so agents learn how to pay", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-search-pay-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_search", { search: "weather" });
  const payload = JSON.parse(result.content[0].text);

  assert.ok(payload.payment, "search response should carry a payment hint");
  assert.deepEqual(payload.payment.settlement_rails, ["usdc_x402"]);
  assert.ok(payload.payment.how_to_pay, "payment hint should explain how to pay");
  assert.match(payload.for_providers, /apiosk_payment_guide|apiosk_publish_api/);
  assert.match(payload.next_steps, /apiosk_payment_guide/);

  await rm(homeDir, { recursive: true, force: true });
});

test("search returns known x402 sources and paid endpoints even when the API catalog has no match", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-source-search-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_search", { search: "x402scan" });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.sources[0].id, "x402scan");
  assert.ok(payload.sources[0].endpoints.some((endpoint) => endpoint.payment_required === true));
  assert.match(payload.next_steps, /apiosk_inspect_x402/);

  await rm(homeDir, { recursive: true, force: true });
});

test("paid execution advertises a credential-free result canvas", async () => {
  const runtime = createApioskMcpRuntime({
    client: createFakeClient(),
    env: {},
    enableLocalWallets: false,
  });
  const tools = await runtime.listTools();
  const execute = tools.find((tool) => tool.name === "apiosk_execute");
  assert.equal(execute?._meta?.["openai/outputTemplate"], APIO_RESULT_CANVAS_URI);
  assert.equal(execute?._meta?.ui?.resourceUri, APIO_RESULT_CANVAS_URI);
  assert.match(APIO_RESULT_CANVAS_HTML, /window\.openai/);
  assert.doesNotMatch(APIO_RESULT_CANVAS_HTML, /connect.token|private.key|authorization/i);
});

test("apiosk_execute resolves old weather slugs to the live weather listing", async () => {
  const calls = [];
  const runtime = createApioskMcpRuntime({
    env: {},
    enableLocalWallets: false,
    client: {
      async listApis() {
        return {
          apis: [
            {
              slug: "open-meteo",
              name: "Open-Meteo",
              description: "Free global weather forecasts.",
              category: "weather",
              active: true,
              verified: true,
              price_usd: 0.05,
              listing_metadata: { tags: ["weather", "forecast"] },
            },
          ],
          meta: { total: 1 },
        };
      },
      async execute(slug, input) {
        calls.push({ slug, input });
        return { status: "success", slug, input };
      },
    },
  });

  const result = await runtime.callTool("apiosk_execute", {
    slug: "weather",
    input: { latitude: 52.37, longitude: 4.9 },
  });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(calls[0].slug, "open-meteo");
  assert.equal(payload.requested_slug, "weather");
  assert.equal(payload.resolved_slug, "open-meteo");
  assert.equal(payload.result.status, "success");
});

test("get_api attaches a listing-scoped buyer payment guide with price", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-getapi-pay-${Date.now()}`);
  const runtime = createApioskMcpRuntime({
    env: { APIOSK_HOME: homeDir },
    enableLocalWallets: true,
    walletManager: { isConfigured: () => false, request: async () => ({}) },
    client: {
      async listApis() {
        return { apis: [], meta: { total: 0 } };
      },
      async getApi(slug) {
        return { slug, price_usd: 0.02 };
      },
      async getMetadata(slug) {
        return { slug, cost_per_call: 0.02 };
      },
      async execute(slug, input) {
        return { slug, input, status: "success" };
      },
      async requestJson() {
        return { apis: [], meta: { total: 0 } };
      },
    },
  });

  const result = await runtime.callTool("apiosk_get_api", { slug: "weather-now" });
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.payment.role, "buyer");
  assert.equal(payload.payment.cost_per_call_usd, 0.02);
  assert.equal(payload.payment.free, false);
  assert.match(payload.payment.summary, /weather-now/);
  assert.ok(Array.isArray(payload.payment.how_to_pay));
  assert.ok(Array.isArray(payload.payment.settlement_rails));

  await rm(homeDir, { recursive: true, force: true });
});

test("apiosk_payment_guide returns both buyer and provider guidance", async () => {
  const homeDir = path.join(os.tmpdir(), `apiosk-mcp-guide-${Date.now()}`);
  const runtime = createRuntime(homeDir);

  const result = await runtime.callTool("apiosk_payment_guide", {});
  const payload = JSON.parse(result.content[0].text);

  assert.equal(payload.role, "both");
  assert.equal(payload.buyer.role, "buyer");
  assert.equal(payload.provider.role, "provider");
  assert.ok(payload.quickstart.buyer.length > 0);
  assert.ok(payload.quickstart.provider.length > 0);
  assert.ok(
    payload.provider.tools.includes("apiosk_publish_api"),
    "provider guide should point to the publish tool",
  );

  const providerOnly = await runtime.callTool("apiosk_payment_guide", { role: "provider" });
  const providerPayload = JSON.parse(providerOnly.content[0].text);
  assert.equal(providerPayload.role, "provider");
  assert.equal(providerPayload.buyer, undefined);
  assert.ok(providerPayload.provider);

  await rm(homeDir, { recursive: true, force: true });
});

test("hosted remote surface exposes discovery + payment guidance tools", async () => {
  const runtime = createApioskMcpRuntime({
    client: createFakeClient(),
    env: {},
    enableLocalWallets: false,
    hostedAuthEnabled: true,
    walletManager: { isConfigured: () => false, request: async () => ({}) },
  });

  const tools = (await runtime.listTools()).map((tool) => tool.name);
  assert.ok(tools.includes("apiosk_payment_guide"), "hosted should expose the payment guide");
  assert.ok(tools.includes("apiosk_help"), "hosted should expose help");
  assert.ok(tools.includes("apiosk_search"), "hosted should expose search");
  // The payment guide is public/unprotected so buyers can read it pre-auth.
  assert.equal(await runtime.isToolProtected("apiosk_payment_guide"), false);
  assert.equal(await runtime.isToolProtected("apiosk_execute"), true);
});

test("dynamic order tools return a human confirmation summary with structured content", async () => {
  // Dynamic per-API tools are opt-in (see buildDynamicTools); enable them so
  // the summary formatting stays covered.
  process.env.APIOSK_MCP_DYNAMIC_TOOLS = "true";
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

  try {
    const result = await runtime.callTool("bella-pizza", {
      type: "Tonno",
      size: "Small",
    });

    assert.match(result.content[0].text, /order confirmed/i);
    assert.match(result.content[0].text, /Small Tonno/);
    assert.equal(result.structuredContent.result.order_id, "12345");
  } finally {
    delete process.env.APIOSK_MCP_DYNAMIC_TOOLS;
    await rm(homeDir, { recursive: true, force: true });
  }
});
