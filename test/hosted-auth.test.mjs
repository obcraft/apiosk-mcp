import test from "node:test";
import assert from "node:assert/strict";

import { createHostedOAuthSupport } from "../src/oauth.mjs";

function createMockResponse(req, query = {}) {
  return {
    req,
    query,
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
    type() {
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

const TEST_ENV = {
  NODE_ENV: "test",
  APIOSK_MCP_OAUTH_SECRET: "shared-hosted-oauth-secret",
  APIOSK_BUYER_PORTAL_URL: "https://buy.apiosk.test",
};

function createTestSupport(overrides = {}) {
  return createHostedOAuthSupport({
    env: TEST_ENV,
    issuerUrl: new URL("https://mcp.apiosk.test"),
    mcpServerUrl: new URL("https://mcp.apiosk.test/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
    ...overrides,
  });
}

// The tool surface itself is asserted in test/surface.test.mjs. What is left
// here is the OAuth issuer: the handoff to buy.apiosk.com, token minting and
// refresh, resource metadata, and the challenge on a tool that spends.
test("authorize() redirects to the buyer portal, never renders a local sign-in page", async () => {
  const support = createTestSupport();

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-test-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const oauthParams = {
    state: "state_123",
    scopes: ["mcp:tools"],
    codeChallenge: "original_client_challenge",
    redirectUri: "https://chatgpt.com/connector/oauth/callback",
    resource: new URL("https://mcp.apiosk.test/mcp"),
  };

  const res = createMockResponse({ method: "GET" });
  await support.provider.authorize(client, oauthParams, res);

  assert.equal(res.statusCode, 302);
  const location = new URL(res.redirectedTo);
  assert.equal(`${location.protocol}//${location.host}`, "https://buy.apiosk.test");
  assert.equal(location.pathname, "/connect");
  assert.equal(location.searchParams.get("client_id"), "apiosk-mcp");
  assert.equal(location.searchParams.get("redirect_uri"), "https://mcp.apiosk.test/authorize/callback");
  assert.equal(location.searchParams.get("response_type"), "code");
  assert.equal(location.searchParams.get("app_name"), "ChatGPT");
  // A fresh, 43-char S256 PKCE challenge for the OUTER (portal-facing) leg —
  // distinct from the ORIGINAL client's own codeChallenge, which travels
  // inside the opaque, signed `state` instead of being forwarded verbatim.
  const outerChallenge = location.searchParams.get("code_challenge");
  assert.equal(outerChallenge.length, 43);
  assert.notEqual(outerChallenge, oauthParams.codeChallenge);
  assert.ok(location.searchParams.get("state"));
  assert.notEqual(location.searchParams.get("state"), oauthParams.state);
});

test("full round trip: authorize -> portal callback -> exchange -> verify", async () => {
  let exchangeCall = null;
  const support = createTestSupport({
    exchangePortalCode: async (env, args) => {
      exchangeCall = args;
      assert.equal(env, TEST_ENV);
      assert.equal(args.code, "portal_code_abc");
      assert.equal(args.redirectUri, "https://mcp.apiosk.test/authorize/callback");
      assert.ok(args.codeVerifier);
      return { connectToken: "aw_test_minted_token", expiresInSeconds: 3600 };
    },
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-round-trip",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const oauthParams = {
    state: "state_round_trip",
    scopes: ["mcp:tools", "offline_access"],
    codeChallenge: "original_client_challenge",
    redirectUri: "https://chatgpt.com/connector/oauth/callback",
    resource: new URL("https://mcp.apiosk.test/mcp"),
  };

  const authorizeRes = createMockResponse({ method: "GET" });
  await support.provider.authorize(client, oauthParams, authorizeRes);
  const portalState = new URL(authorizeRes.redirectedTo).searchParams.get("state");

  // buy.apiosk.com sends the browser back with our own state echoed verbatim.
  const callbackRes = createMockResponse({ method: "GET" });
  await support.provider.completePortalCallback(
    { query: { code: "portal_code_abc", state: portalState } },
    callbackRes
  );

  assert.ok(exchangeCall, "the gateway exchange must have been called");
  assert.equal(callbackRes.statusCode, 200);
  assert.match(callbackRes.body, /You're connected/);
  const finalRedirectMatch = callbackRes.body.match(/window\.location\.replace\((".*?")\)/);
  const finalRedirect = JSON.parse(finalRedirectMatch[1]);
  const finalUrl = new URL(finalRedirect);
  assert.equal(`${finalUrl.origin}${finalUrl.pathname}`, "https://chatgpt.com/connector/oauth/callback");
  assert.equal(finalUrl.searchParams.get("state"), "state_round_trip");

  const authorizationCode = finalUrl.searchParams.get("code");
  assert.ok(authorizationCode);

  const tokens = await support.provider.exchangeAuthorizationCode(
    client,
    authorizationCode,
    undefined,
    "https://chatgpt.com/connector/oauth/callback",
    new URL("https://mcp.apiosk.test/mcp")
  );
  assert.equal(tokens.token_type, "bearer");
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);

  const authInfo = await support.provider.verifyAccessToken(tokens.access_token);
  assert.equal(authInfo.extra.apiosk_connect_token, "aw_test_minted_token");
  assert.equal(authInfo.resource.href, "https://mcp.apiosk.test/mcp");
  assert.ok(authInfo.scopes.includes("mcp:tools"));
});

test("portal callback rejects a tampered or unknown state rather than redirecting blindly", async () => {
  const support = createTestSupport({
    exchangePortalCode: async () => {
      throw new Error("must not be called for an invalid state");
    },
  });

  const res = createMockResponse({ method: "GET" });
  await support.provider.completePortalCallback(
    { query: { code: "portal_code_abc", state: "not-a-real-signed-token" } },
    res
  );

  assert.equal(res.statusCode, 400);
  assert.equal(res.redirectedTo, null);
});

test("portal callback passes through a portal-side denial as access_denied to the original client", async () => {
  const support = createTestSupport();

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-denied",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const authorizeRes = createMockResponse({ method: "GET" });
  await support.provider.authorize(
    client,
    {
      state: "state_denied",
      scopes: ["mcp:tools"],
      codeChallenge: "challenge",
      redirectUri: "https://chatgpt.com/connector/oauth/callback",
      resource: new URL("https://mcp.apiosk.test/mcp"),
    },
    authorizeRes
  );
  const portalState = new URL(authorizeRes.redirectedTo).searchParams.get("state");

  const callbackRes = createMockResponse({ method: "GET" });
  await support.provider.completePortalCallback(
    { query: { error: "access_denied", error_description: "The buyer cancelled.", state: portalState } },
    callbackRes
  );

  assert.equal(callbackRes.statusCode, 302);
  const location = new URL(callbackRes.redirectedTo);
  assert.equal(`${location.origin}${location.pathname}`, "https://chatgpt.com/connector/oauth/callback");
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("state"), "state_denied");
});

test("dynamic registered OAuth clients survive a fresh provider instance", async () => {
  const support = createTestSupport();

  const registered = await support.provider.clientsStore.registerClient({
    client_id: "3622cef6-582f-4050-a615-5f01be7a6ed9",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });

  assert.notEqual(registered.client_id, "3622cef6-582f-4050-a615-5f01be7a6ed9");
  assert.match(registered.client_id, /^apiosk\./);

  const freshSupport = createTestSupport();
  const restored = await freshSupport.provider.clientsStore.getClient(registered.client_id);
  assert.ok(restored);
  assert.equal(restored.client_name, "ChatGPT");
  assert.deepEqual(restored.redirect_uris, ["https://chatgpt.com/connector/oauth/callback"]);
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
    const asResponse = await fetch(new URL("/.well-known/oauth-authorization-server", base));
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
    env: TEST_ENV,
    issuerUrl: new URL("https://mcp.apiosk.com"),
    mcpServerUrl: new URL("https://mcp.apiosk.com/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
    exchangePortalCode: async () => ({ connectToken: "aw_test_sse_token", expiresInSeconds: null }),
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-sse-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  // ChatGPT connected via /sse, so it requests resource=<origin>/sse.
  const oauthParams = {
    state: "state_sse",
    scopes: ["mcp:tools"],
    codeChallenge: "challenge_sse",
    redirectUri: "https://chatgpt.com/connector/oauth/callback",
    resource: new URL("https://mcp.apiosk.com/sse"),
  };
  const authorizeRes = createMockResponse({ method: "GET" });
  await support.provider.authorize(client, oauthParams, authorizeRes);
  const portalState = new URL(authorizeRes.redirectedTo).searchParams.get("state");

  const callbackRes = createMockResponse({ method: "GET" });
  await support.provider.completePortalCallback(
    { query: { code: "portal_code_sse", state: portalState } },
    callbackRes
  );
  const redirectMatch = callbackRes.body.match(/window\.location\.replace\((".*?")\)/);
  const finalUrl = new URL(JSON.parse(redirectMatch[1]));
  const authorizationCode = finalUrl.searchParams.get("code");

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
});

test("verifyAccessToken accepts an Apiosk connect token directly, for headless agents", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), "https://gateway.apiosk.test/v1/me");
    return new Response(JSON.stringify({ token_id: "tok_headless_1", user_id: "user_1", rails: ["x402"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const support = createHostedOAuthSupport({
      env: { ...TEST_ENV, APIOSK_GATEWAY_URL: "https://gateway.apiosk.test" },
      issuerUrl: new URL("https://mcp.apiosk.test"),
      mcpServerUrl: new URL("https://mcp.apiosk.test/mcp"),
      appName: "Apiosk",
      resourceName: "Apiosk MCP",
    });

    const authInfo = await support.provider.verifyAccessToken("aw_live_headless_token");
    assert.equal(authInfo.clientId, "tok_headless_1");
    assert.equal(authInfo.extra.apiosk_connect_token, "aw_live_headless_token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
