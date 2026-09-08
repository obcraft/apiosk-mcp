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
  // The agent gateway. It is BOTH legs now - the browser is sent to its
  // /v1/oauth/authorize and the code is redeemed at its /v1/oauth/token - which
  // is why there is one variable here where there used to be a portal and a
  // gateway. `APIOSK_BUYER_PORTAL_URL` is gone on purpose; see
  // `resolveAuthorizeBaseUrl`.
  APIOSK_GATEWAY_URL: "https://api.apiosk.test/functions/v1/agent-gateway",
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
// here is the OAuth issuer: the handoff to the agent gateway, token minting
// and refresh, resource metadata, and the challenge on a tool that spends.
test("authorize() hands off to the agent gateway, never renders a local sign-in page", async () => {
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
  assert.equal(`${location.protocol}//${location.host}`, "https://api.apiosk.test");
  /* THE GATEWAY IS MOUNTED UNDER A PATH, and a root-relative `new URL("/v1/…",
     base)` would throw that path away and address the project root. The whole
     handoff would then 404 on a host that exists, which is the failure that
     looks least like its cause. */
  assert.equal(location.pathname, "/functions/v1/agent-gateway/v1/oauth/authorize");
  assert.equal(location.searchParams.get("client_id"), "apiosk-mcp");
  assert.equal(location.searchParams.get("redirect_uri"), "https://mcp.apiosk.test/authorize/callback");
  assert.equal(location.searchParams.get("response_type"), "code");
  // `name`, not `app_name`: that is what the gateway's `startAuthorization`
  // reads and carries to the approval screen as the suggested connection name.
  assert.equal(location.searchParams.get("name"), "ChatGPT");
  assert.equal(location.searchParams.get("provider"), "openai");
  // Required by the gateway, which refuses `plain` rather than downgrading.
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
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

test("a connection survives the upstream access token expiring", async () => {
  /* THE SECOND DAY. The agent gateway's access tokens live 24 hours and this
     server's live one, so a client refreshing hourly eventually holds a token
     carrying a dead upstream credential — and every tool call then fails with
     a 401 the person can only fix by approving a connection they approved
     yesterday. Holding the rotating refresh token is what makes that this
     server's problem instead of theirs. */
  const refreshCalls = [];
  const support = createTestSupport({
    exchangePortalCode: async () => ({
      connectToken: "apk_live_day_one",
      refreshToken: "apk_refresh_day_one",
      // Already spent, so the very next refresh has to renew it.
      expiresInSeconds: 1,
    }),
    refreshPortalToken: async (env, args) => {
      refreshCalls.push(args.refreshToken);
      return {
        connectToken: "apk_live_day_two",
        refreshToken: "apk_refresh_day_two",
        expiresInSeconds: 24 * 60 * 60,
      };
    },
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "cursor-renewal",
    client_name: "Cursor",
    redirect_uris: ["https://cursor.sh/callback"],
    token_endpoint_auth_method: "none",
  });
  const oauthParams = {
    state: "state_renewal",
    scopes: ["mcp:tools", "offline_access"],
    codeChallenge: "original_client_challenge",
    redirectUri: "https://cursor.sh/callback",
    resource: new URL("https://mcp.apiosk.test/mcp"),
  };

  const authorizeRes = createMockResponse({ method: "GET" });
  await support.provider.authorize(client, oauthParams, authorizeRes);
  const callbackRes = createMockResponse({ method: "GET" });
  await support.provider.completePortalCallback(
    {
      query: {
        code: "code_renewal",
        state: new URL(authorizeRes.redirectedTo).searchParams.get("state"),
      },
    },
    callbackRes
  );
  const finalUrl = new URL(
    JSON.parse(callbackRes.body.match(/window\.location\.replace\((".*?")\)/)[1])
  );

  const first = await support.provider.exchangeAuthorizationCode(
    client,
    finalUrl.searchParams.get("code"),
    undefined,
    "https://cursor.sh/callback",
    new URL("https://mcp.apiosk.test/mcp")
  );
  assert.equal(refreshCalls.length, 0, "nothing to renew before the first refresh");

  const renewed = await support.provider.exchangeRefreshToken(client, first.refresh_token, [
    "mcp:tools",
    "offline_access",
  ]);

  assert.deepEqual(refreshCalls, ["apk_refresh_day_one"]);
  const authInfo = await support.provider.verifyAccessToken(renewed.access_token);
  assert.equal(authInfo.extra.apiosk_connect_token, "apk_live_day_two");

  /* The refresh token must be REISSUED, not echoed. Handing back the one that
     came in would hand back the upstream refresh token that was just rotated
     away, and the refresh after this one would fail. */
  assert.notEqual(renewed.refresh_token, first.refresh_token);
  const again = await support.provider.exchangeRefreshToken(client, renewed.refresh_token, [
    "mcp:tools",
    "offline_access",
  ]);
  assert.ok(again.access_token);
  assert.equal(refreshCalls.length, 1, "a token with life left in it is not renewed again");
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

test('v2 challenges before anonymous initialization so hosts configure OAuth on connection', async () => {
  const support = createTestSupport({env:{...TEST_ENV,APIOSK_GATEWAY_V2_URL:'https://gateway.apiosk.test'}});
  const middleware = support.createMcpAuthMiddleware({isToolProtected:async()=>true});
  for (const method of ['initialize','tools/list','resources/list','tools/call']) {
    const req={headers:{},path:'/mcp',body:{method,params:{name:'apiosk_sources'}}};
    const res=createMockResponse(req); let passed=false;
    await middleware(req,res,()=>{passed=true});
    assert.equal(passed,false);assert.equal(res.statusCode,401);
    assert.match(res.headers.get('www-authenticate'),/resource_metadata=.*oauth-protected-resource\/mcp/);
  }
});

test('hosted OAuth defaults to DCR rather than unavailable external client metadata', () => {
  const support=createTestSupport();
  assert.equal(support.oauthMetadata.client_id_metadata_document_supported,false);
  assert.equal(support.oauthMetadata.registration_endpoint,'https://mcp.apiosk.test/register');
  const optIn=createTestSupport({env:{...TEST_ENV,APIOSK_MCP_CIMD_ENABLED:'1'}});
  assert.equal(optIn.oauthMetadata.client_id_metadata_document_supported,true);
});
