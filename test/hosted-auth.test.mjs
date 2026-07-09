import test from "node:test";
import assert from "node:assert/strict";

import {
  createHostedOAuthSupport,
  createMcpWalletAuthNonce,
} from "../src/oauth.mjs";
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

// Env that makes the wallet sign-in path "configured" (needs a Supabase URL +
// key). Sign-in on the hosted authorize page is wallet-only; email/password was
// removed because its dashboard backend route never existed.
const WALLET_TEST_ENV = {
  NODE_ENV: "test",
  APIOSK_SUPABASE_URL: "https://sb.test",
  APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

// A signed wallet message the way the browser builds it (multi-line, "\n").
function walletMessage(address) {
  return [
    "Apiosk Provider wallet sign-in",
    `wallet: ${address.toLowerCase()}`,
    "origin: https://mcp.apiosk.com",
    "nonce: nonce_wallet",
    "issued_at: 2026-07-09T22:40:00.000Z",
  ].join("\n");
}

// Replace globalThis.fetch with a stub that answers the two calls a wallet
// sign-in makes: the wallet-auth /verify (recovers the signer) and the Supabase
// /auth/v1/verify (mints the dashboard session). Returns a restore function.
function stubWalletAuthFetch({
  address,
  sessionToken = "jwt_wallet_dashboard_session",
  userId = "wallet_user_123",
} = {}) {
  const email = `${address.toLowerCase()}@wallet.apiosk.com`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href === "https://sb.test/functions/v1/wallet-auth/verify") {
      return new Response(
        JSON.stringify({ tokenHash: "wallet_token_hash", email }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (href === "https://sb.test/auth/v1/verify") {
      return new Response(
        JSON.stringify({
          access_token: sessionToken,
          expires_in: 3600,
          user: { id: userId, email },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  return () => {
    globalThis.fetch = originalFetch;
  };
}

test("hosted OAuth support issues tokens and challenges protected MCP tools", async () => {
  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
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

  const address = "0x1111111111111111111111111111111111111111";
  const restoreFetch = stubWalletAuthFetch({
    address,
    sessionToken: "jwt_dashboard_session",
    userId: "user_123",
  });

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
        action: "wallet_sign_in",
        wallet_address: address,
        wallet_message: walletMessage(address),
        wallet_signature: "0xsignature",
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
    restoreFetch();
  }
});

test("hosted authorize form POSTs handle cancel and wallet sign-in over a real form encoding", async () => {
  const express = (await import("express")).default;
  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-form-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const app = express();
  app.use("/authorize", support.authorizationRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const originalFetch = globalThis.fetch;

  function form(action, extra = {}) {
    return new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://chatgpt.com/connector/oauth/callback",
      response_type: "code",
      code_challenge: "challenge_form",
      code_challenge_method: "S256",
      scope: "mcp:tools offline_access",
      state: "state_form",
      resource: "http://localhost:3000/sse",
      action,
      ...extra,
    });
  }

  const address = "0x2222222222222222222222222222222222222222";
  // The exact bytes the wallet signs — multi-line, joined with "\n".
  const message = walletMessage(address);
  // The client base64url-encodes the signed message before putting it in the
  // hidden field. This is what protects the "\n" bytes from being rewritten to
  // "\r\n" by form submission, which would otherwise break signature recovery
  // on the wallet-auth server. Assert the encoded field carries no raw newline.
  const encodedMessage = Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.ok(!/[\r\n]/.test(encodedMessage), "encoded message must be newline-free");

  try {
    globalThis.fetch = async (url) => {
      throw new Error(`Unexpected dashboard call during cancel: ${url}`);
    };
    const cancelResponse = await originalFetch(new URL("/authorize", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form("cancel"),
      redirect: "manual",
    });
    assert.equal(cancelResponse.status, 302);
    const cancelLocation = new URL(cancelResponse.headers.get("location"));
    assert.equal(cancelLocation.searchParams.get("error"), "access_denied");
    assert.equal(cancelLocation.searchParams.get("state"), "state_form");

    // The wallet-auth server must receive the message with its original "\n"
    // line breaks intact (decoded from base64url) — not the "\r\n" a raw text
    // field would have produced.
    let seenMessage = null;
    globalThis.fetch = async (url, init = {}) => {
      const href = String(url);
      if (href === "https://sb.test/functions/v1/wallet-auth/verify") {
        seenMessage = JSON.parse(init.body).message;
        return new Response(
          JSON.stringify({
            tokenHash: "wallet_token_hash",
            email: `${address.toLowerCase()}@wallet.apiosk.com`,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (href === "https://sb.test/auth/v1/verify") {
        return new Response(
          JSON.stringify({
            access_token: "jwt_form_dashboard_session",
            expires_in: 3600,
            user: { id: "user_form_123", email: `${address.toLowerCase()}@wallet.apiosk.com` },
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected fetch: ${href}`);
    };
    const signInResponse = await originalFetch(new URL("/authorize", base), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form("wallet_sign_in", {
        wallet_address: address,
        wallet_message: encodedMessage,
        wallet_message_encoding: "base64url",
        wallet_signature: "0xsignature",
        wallet_method: "connected_wallet",
      }),
      redirect: "manual",
    });
    assert.equal(signInResponse.status, 302);
    const signInLocation = new URL(signInResponse.headers.get("location"));
    assert.ok(signInLocation.searchParams.get("code"));
    assert.equal(signInLocation.searchParams.get("state"), "state_form");
    assert.equal(seenMessage, message, "server must recover the exact signed message bytes");
  } finally {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("dynamic registered OAuth clients survive a fresh provider instance", async () => {
  const env = {
    NODE_ENV: "test",
    APIOSK_MCP_OAUTH_SECRET: "shared-hosted-oauth-secret",
  };
  const support = createHostedOAuthSupport({
    env,
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

test("protected-resource metadata is served for every transport surface so ChatGPT's /sse discovery resolves", async () => {
  const express = (await import("express")).default;
  const support = createHostedOAuthSupport({
    env: { NODE_ENV: "test" },
    issuerUrl: new URL("https://mcp.apiosk.com"),
    mcpServerUrl: new URL("https://mcp.apiosk.com/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  const app = express();
  app.use(support.metadataRouter);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // Streamable HTTP, legacy SSE handshake, SSE POST channel, and the origin
    // root all resolve to protected-resource metadata pointing at the issuer.
    const cases = [
      ["/.well-known/oauth-protected-resource/mcp", "https://mcp.apiosk.com/mcp"],
      ["/.well-known/oauth-protected-resource/sse", "https://mcp.apiosk.com/sse"],
      ["/.well-known/oauth-protected-resource/messages", "https://mcp.apiosk.com/messages"],
      ["/.well-known/oauth-protected-resource", "https://mcp.apiosk.com/"],
    ];
    for (const [path, expectedResource] of cases) {
      const response = await fetch(new URL(path, base));
      assert.equal(response.status, 200, `${path} should serve PRM`);
      const body = await response.json();
      assert.equal(body.resource, expectedResource, `${path} resource`);
      assert.deepEqual(body.authorization_servers, ["https://mcp.apiosk.com/"]);
    }

    // The RFC 8414 authorization-server metadata is discoverable too.
    const asResponse = await fetch(
      new URL("/.well-known/oauth-authorization-server", base)
    );
    assert.equal(asResponse.status, 200);
    const asBody = await asResponse.json();
    assert.equal(asBody.issuer, "https://mcp.apiosk.com/");
    assert.ok(asBody.authorization_endpoint.endsWith("/authorize"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("access tokens minted for the /sse resource verify against the hosted server", async () => {
  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
    issuerUrl: new URL("https://mcp.apiosk.com"),
    mcpServerUrl: new URL("https://mcp.apiosk.com/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-sse-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const address = "0x3333333333333333333333333333333333333333";
  const restoreFetch = stubWalletAuthFetch({ address });

  try {
    // ChatGPT connected via /sse, so it requests resource=<origin>/sse.
    const oauthParams = {
      state: "state_sse",
      scopes: ["mcp:tools"],
      codeChallenge: "challenge_sse",
      redirectUri: "https://chatgpt.com/connector/oauth/callback",
      resource: new URL("https://mcp.apiosk.com/sse"),
    };
    const authorizeRequest = {
      method: "POST",
      body: {
        action: "wallet_sign_in",
        wallet_address: address,
        wallet_message: walletMessage(address),
        wallet_signature: "0xsignature",
      },
    };
    const authorizeResponse = createMockResponse(authorizeRequest);
    await support.provider.authorize(client, oauthParams, authorizeResponse);
    const authorizationCode = new URL(authorizeResponse.redirectedTo).searchParams.get("code");

    const tokens = await support.provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      "https://chatgpt.com/connector/oauth/callback",
      new URL("https://mcp.apiosk.com/sse")
    );

    const authInfo = await support.provider.verifyAccessToken(tokens.access_token);
    assert.equal(authInfo.resource.href, "https://mcp.apiosk.com/sse");
    assert.equal(authInfo.scopes.includes("mcp:tools"), true);
  } finally {
    restoreFetch();
  }
});

test("hosted wallet nonce helper proxies the provider wallet-auth nonce", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        nonce: "nonce_123",
        expiresAt: "2026-07-09T22:40:00.000Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  };

  try {
    const body = await createMcpWalletAuthNonce({
      env: {
        APIOSK_SUPABASE_URL: "https://sb.test",
        APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
      },
    });

    assert.equal(body.nonce, "nonce_123");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://sb.test/functions/v1/wallet-auth/nonce");
    assert.equal(calls[0].init.headers.apikey, "service-role-test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("hosted OAuth support issues tokens after wallet sign-in", async () => {
  const env = {
    NODE_ENV: "test",
    APIOSK_SUPABASE_URL: "https://sb.test",
    APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
  };
  const support = createHostedOAuthSupport({
    env,
    issuerUrl: new URL("https://mcp.apiosk.com"),
    mcpServerUrl: new URL("https://mcp.apiosk.com/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-wallet-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    calls.push({ href, init });
    if (href === "https://sb.test/functions/v1/wallet-auth/verify") {
      const payload = JSON.parse(init.body);
      assert.equal(payload.address, "0x1111111111111111111111111111111111111111");
      assert.equal(payload.method, "connected_wallet");
      assert.match(payload.message, /nonce: nonce_wallet/);
      return new Response(
        JSON.stringify({
          tokenHash: "wallet_token_hash",
          email: "0x1111111111111111111111111111111111111111@wallet.apiosk.com",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (href === "https://sb.test/auth/v1/verify") {
      const payload = JSON.parse(init.body);
      assert.deepEqual(payload, {
        token_hash: "wallet_token_hash",
        type: "magiclink",
      });
      return new Response(
        JSON.stringify({
          access_token: "jwt_wallet_dashboard_session",
          expires_in: 3600,
          user: {
            id: "wallet_user_123",
            email: "0x1111111111111111111111111111111111111111@wallet.apiosk.com",
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };

  try {
    const oauthParams = {
      state: "state_wallet",
      scopes: ["mcp:tools", "offline_access"],
      codeChallenge: "challenge_wallet",
      redirectUri: "https://chatgpt.com/connector/oauth/callback",
      resource: new URL("https://mcp.apiosk.com/sse"),
    };
    const authorizeRequest = {
      method: "POST",
      body: {
        action: "wallet_sign_in",
        wallet_address: "0x1111111111111111111111111111111111111111",
        wallet_message:
          "Apiosk Provider wallet sign-in\nwallet: 0x1111111111111111111111111111111111111111\norigin: https://mcp.apiosk.com\nnonce: nonce_wallet\nissued_at: 2026-07-09T22:40:00.000Z",
        wallet_signature: "0xsignature",
      },
    };
    const authorizeResponse = createMockResponse(authorizeRequest);

    await support.provider.authorize(client, oauthParams, authorizeResponse);

    assert.equal(authorizeResponse.statusCode, 302);
    const authorizationCode = new URL(authorizeResponse.redirectedTo).searchParams.get("code");
    assert.ok(authorizationCode);
    assert.equal(calls.length, 2);

    const tokens = await support.provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      "https://chatgpt.com/connector/oauth/callback",
      new URL("https://mcp.apiosk.com/sse")
    );
    const authInfo = await support.provider.verifyAccessToken(tokens.access_token);

    assert.equal(authInfo.extra.dashboardSessionToken, "jwt_wallet_dashboard_session");
    assert.equal(authInfo.extra.userId, "wallet_user_123");
    assert.equal(
      authInfo.extra.walletAddress,
      "0x1111111111111111111111111111111111111111"
    );
    assert.equal(authInfo.resource.href, "https://mcp.apiosk.com/sse");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
