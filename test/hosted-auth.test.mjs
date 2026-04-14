import test from "node:test";
import assert from "node:assert/strict";

import { createHostedOAuthSupport } from "../oauth.mjs";
import { createApioskMcpRuntime } from "../runtime.mjs";

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
    async requestJson() {
      return { apis: [], meta: { total: 0 } };
    },
  };
}

test("hosted runtime exposes dashboard tools and forwards request-scoped dashboard auth", async () => {
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

  const tools = await runtime.listTools();
  assert.equal(tools.some((tool) => tool.name === "apiosk_list_wallets"), true);
  assert.equal(tools.some((tool) => tool.name === "apiosk_buy_credits"), true);

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
