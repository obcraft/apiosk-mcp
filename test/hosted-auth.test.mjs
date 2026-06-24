import test from "node:test";
import assert from "node:assert/strict";

import { createHostedOAuthSupport } from "../src/oauth.mjs";
import { createApioskMcpRuntime } from "../src/runtime.mjs";

function createFakeGatewayClient() {
  return {
    async listApis() {
      return {
        apis: [
          {
            slug: "demo-api",
            name: "Demo API",
            description: "Demo tool",
            category: "data",
            price_usd: 0.1,
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
    async execute(slug, input) {
      return {
        slug,
        input,
        ok: true,
      };
    },
    async getApi(slug) {
      return { slug };
    },
    async getMetadata(slug) {
      return { slug, ok: true };
    },
    async requestJson(pathValue) {
      if (pathValue === "/health") {
        return { status: "ok" };
      }
      return { apis: [], meta: { total: 0 } };
    },
  };
}

test("hosted runtime exposes the full remote surface (discovery + managed + dynamic) and forwards request-scoped dashboard auth", async () => {
  let capturedClientOptions = null;
  const runtime = createApioskMcpRuntime({
    env: {},
    enableLocalWallets: false,
    hostedAuthEnabled: true,
    client: null,
    clientFactory: async (options) => {
      capturedClientOptions = options;
      return createFakeGatewayClient();
    },
    walletManager: { isConfigured: () => false, request: async () => ({}) },
  });

  const toolNames = (await runtime.listTools()).map((tool) => tool.name);

  // Discovery + payment guidance (public, pre-auth).
  for (const name of [
    "apiosk_help",
    "apiosk_payment_guide",
    "apiosk_search",
    "apiosk_explore",
    "apiosk_get_api",
    "apiosk_metadata",
    "apiosk_execute",
    "apiosk_health",
  ]) {
    assert.ok(toolNames.includes(name), `hosted surface should expose ${name}`);
  }

  // Managed buyer tools now available remotely over request-scoped auth.
  for (const name of [
    "apiosk_buy_credits",
    "apiosk_get_credits_status",
    "apiosk_list_wallets",
    "apiosk_create_wallet",
    "apiosk_update_wallet",
    "apiosk_delete_wallet",
    "apiosk_create_wallet_connect_string",
    "apiosk_create_wallet_api_key",
  ]) {
    assert.ok(toolNames.includes(name), `hosted surface should expose managed tool ${name}`);
  }

  // Dynamic per-API tools are now generated for hosted clients too.
  assert.ok(toolNames.includes("demo-api"), "hosted surface should expose dynamic per-API tools");

  // Local-only tools stay off the hosted surface (no client-side signing key).
  for (const name of ["apiosk_get_started", "apiosk_wallet_create", "apiosk_publish_api", "apiosk_show_wallet_funding"]) {
    assert.ok(!toolNames.includes(name), `hosted surface should not expose local-only tool ${name}`);
  }

  // Protection model: discovery/guidance public, paid execute + managed tools protected.
  assert.equal(await runtime.isToolProtected("apiosk_payment_guide"), false);
  assert.equal(await runtime.isToolProtected("apiosk_execute"), true);
  assert.equal(await runtime.isToolProtected("apiosk_list_wallets"), true);
  assert.equal(await runtime.isToolProtected("demo-api"), true); // paid dynamic tool

  const result = await runtime.callTool(
    "apiosk_execute",
    {
      slug: "demo-api",
      input: { live: true },
    },
    {
      extra: {
        dashboardSessionToken: "jwt_remote_user",
      },
    }
  );
  const payload = JSON.parse(result.content[0].text);

  assert.deepEqual(payload, {
    slug: "demo-api",
    input: { live: true },
    ok: true,
  });
  assert.equal(capturedClientOptions.headers["x-apiosk-user-jwt"], "jwt_remote_user");
  assert.equal(capturedClientOptions.headers.authorization, "Bearer jwt_remote_user");

  const healthResult = await runtime.callTool("apiosk_health", {}, {
    extra: {
      dashboardSessionToken: "jwt_remote_user",
    },
  });
  const healthPayload = JSON.parse(healthResult.content[0].text);

  assert.equal(healthPayload.status, "ok");
  assert.equal(healthPayload.gateway.status, "ok");
  assert.ok(healthPayload.mcp.tools.includes("apiosk_payment_guide"));
  assert.ok(healthPayload.mcp.tools.includes("apiosk_list_wallets"));
});

function createMockResponse(req) {
  return {
    req,
    headers: new Map(),
    statusCode: 200,
    body: null,
    redirectedTo: null,
    status(value) {
      this.statusCode = value;
      return this;
    },
    setHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), value);
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    send(payload) {
      this.body = payload;
      return this;
    },
    redirect(statusOrLocation, maybeLocation) {
      if (typeof maybeLocation === "string") {
        this.statusCode = statusOrLocation;
        this.redirectedTo = maybeLocation;
      } else {
        this.statusCode = 302;
        this.redirectedTo = statusOrLocation;
      }
      return this;
    },
  };
}

test("hosted OAuth support issues tokens and challenges protected MCP tools", async () => {
  const support = createHostedOAuthSupport({
    env: { NODE_ENV: "test" },
    controlPlaneBaseUrl: "https://apiosk.com",
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  assert.deepEqual(
    support.oauthMetadata.scopes_supported,
    ["mcp:tools", "offline_access"]
  );

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-test-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chat.openai.com/aip/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        signed_in: true,
        email: "demo@example.com",
        user_id: "user_123",
        session_token: "jwt_dashboard_session",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }
    );

  try {
    const oauthParams = {
      state: "state_123",
      scopes: ["mcp:tools"],
      codeChallenge: "challenge_abc",
      redirectUri: "https://chat.openai.com/aip/oauth/callback",
      resource: new URL("http://localhost:3000/mcp"),
    };
    const authorizeRequest = {
      method: "POST",
      body: {
        action: "sign_in",
        email: "demo@example.com",
        password: "secret123",
      },
    };
    const authorizeResponse = createMockResponse(authorizeRequest);

    await support.provider.authorize(client, oauthParams, authorizeResponse);

    assert.equal(authorizeResponse.statusCode, 302);
    assert.ok(authorizeResponse.redirectedTo);

    const redirected = new URL(authorizeResponse.redirectedTo);
    const authorizationCode = redirected.searchParams.get("code");
    assert.ok(authorizationCode);
    assert.equal(redirected.searchParams.get("state"), "state_123");

    const challenge = await support.provider.challengeForAuthorizationCode(client, authorizationCode);
    assert.equal(challenge, "challenge_abc");

    const tokens = await support.provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      "https://chat.openai.com/aip/oauth/callback",
      new URL("http://localhost:3000/mcp")
    );
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);

    const authInfo = await support.provider.verifyAccessToken(tokens.access_token);
    assert.equal(authInfo.extra.dashboardSessionToken, "jwt_dashboard_session");
    assert.equal(authInfo.scopes.includes("mcp:tools"), true);

    const runtime = {
      async isToolProtected(name) {
        return name === "apiosk_execute";
      },
    };
    const middleware = support.createMcpAuthMiddleware(runtime);

    const unauthenticatedReq = {
      headers: {},
      body: {
        method: "tools/call",
        params: {
          name: "apiosk_execute",
        },
      },
    };
    const unauthenticatedRes = createMockResponse(unauthenticatedReq);
    let nextCalled = false;

    await middleware(unauthenticatedReq, unauthenticatedRes, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, false);
    assert.equal(unauthenticatedRes.statusCode, 401);
    assert.match(
      unauthenticatedRes.headers.get("www-authenticate"),
      /resource_metadata=/
    );

    const authenticatedReq = {
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: {
        method: "tools/call",
        params: {
          name: "apiosk_execute",
        },
      },
    };
    const authenticatedRes = createMockResponse(authenticatedReq);
    nextCalled = false;

    await middleware(authenticatedReq, authenticatedRes, () => {
      nextCalled = true;
    });

    assert.equal(nextCalled, true);
    assert.equal(authenticatedReq.auth.extra.dashboardSessionToken, "jwt_dashboard_session");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("dynamic registered OAuth clients survive a fresh provider instance", async () => {
  const env = {
    NODE_ENV: "test",
    APIOSK_MCP_OAUTH_SECRET: "shared-hosted-oauth-secret",
  };
  const support = createHostedOAuthSupport({
    env,
    controlPlaneBaseUrl: "https://dashboard.apiosk.com",
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  const registered = await support.provider.clientsStore.registerClient({
    client_id: "3622cef6-582f-4050-a615-5f01be7a6ed9",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  assert.notEqual(
    registered.client_id,
    "3622cef6-582f-4050-a615-5f01be7a6ed9"
  );
  assert.match(registered.client_id, /^apiosk\./);

  const freshSupport = createHostedOAuthSupport({
    env,
    controlPlaneBaseUrl: "https://dashboard.apiosk.com",
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  const restored = await freshSupport.provider.clientsStore.getClient(registered.client_id);
  assert.ok(restored);
  assert.equal(restored.client_name, "ChatGPT");
  assert.deepEqual(
    restored.redirect_uris,
    ["https://chatgpt.com/connector/oauth/callback"]
  );
  assert.equal(restored.token_endpoint_auth_method, "none");
});
