import test from "node:test";
import assert from "node:assert/strict";

import {
  generateConnectToken,
  mintHostedConnectToken,
  prepareHostedPaymentWallets,
} from "../src/hosted-payment.mjs";
import { createHostedOAuthSupport } from "../src/oauth.mjs";
import { createApioskMcpRuntime } from "../src/runtime.mjs";

const WALLET_TEST_ENV = {
  NODE_ENV: "test",
  APIOSK_SUPABASE_URL: "https://sb.test",
  APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

function walletMessage(address) {
  return [
    "Apiosk Provider wallet sign-in",
    `wallet: ${address.toLowerCase()}`,
    "origin: https://mcp.apiosk.com",
    "nonce: nonce_wallet",
    "issued_at: 2026-07-09T22:40:00.000Z",
  ].join("\n");
}

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

// Answers only the two calls a wallet sign-in makes (wallet-auth /verify and
// Supabase /auth/v1/verify). The connect-token mint is injected in these tests,
// so it never hits the network.
function stubWalletAuthFetch({
  address,
  sessionToken = "jwt_dashboard_session",
  userId = "user_123",
} = {}) {
  const email = `${address.toLowerCase()}@wallet.apiosk.com`;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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
            listing_metadata: { mcp_native: true, default_operation: "/" },
          },
        ],
        meta: { total: 1, returned: 1, limit: 1, offset: 0 },
      };
    },
    async execute(slug, input) {
      return { slug, input, ok: true };
    },
  };
}

test("generateConnectToken produces a gateway-compatible aw_live_ token", () => {
  const { token, tokenHash, tokenPrefix } = generateConnectToken();

  assert.match(token, /^aw_live_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
  assert.equal(tokenPrefix, token.slice(0, 22));
  assert.match(tokenHash, /^[0-9a-f]{64}$/);
  // A fresh secret every call.
  assert.notEqual(generateConnectToken().token, token);
});

test("wallet sign-in mints a connect token that survives refresh and reaches the gateway", async () => {
  const mintedToken = "aw_live_0123456789ab_MintedConnectTokenSecret000001";
  let minterCalls = 0;

  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
    connectTokenMinter: async ({ sessionToken, userId }) => {
      minterCalls += 1;
      assert.equal(sessionToken, "jwt_dashboard_session");
      assert.equal(userId, "user_123");
      return {
        connectToken: mintedToken,
        walletAddress: "0x00000000000000000000000000000000000000ab",
        walletId: "wallet_1",
      };
    },
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-pay-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
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
      redirectUri: "https://chatgpt.com/connector/oauth/callback",
      resource: new URL("http://localhost:3000/mcp"),
    };
    const authorizeResponse = createMockResponse({
      method: "POST",
      body: {
        action: "wallet_sign_in",
        wallet_address: address,
        wallet_message: walletMessage(address),
        wallet_signature: "0xsignature",
      },
    });

    await support.provider.authorize(client, oauthParams, authorizeResponse);
    assert.equal(authorizeResponse.statusCode, 302);
    assert.equal(minterCalls, 1, "the minter runs once at sign-in");

    const authorizationCode = new URL(authorizeResponse.redirectedTo).searchParams.get("code");
    assert.ok(authorizationCode);

    const tokens = await support.provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      "https://chatgpt.com/connector/oauth/callback",
      new URL("http://localhost:3000/mcp")
    );

    const authInfo = await support.provider.verifyAccessToken(tokens.access_token);
    assert.equal(authInfo.extra.apiosk_connect_token, mintedToken);
    assert.equal(
      authInfo.extra.apiosk_connect_wallet_address,
      "0x00000000000000000000000000000000000000ab"
    );

    // Refresh must reuse the same connect token, never re-mint.
    const refreshed = await support.provider.exchangeRefreshToken(
      client,
      tokens.refresh_token,
      undefined,
      new URL("http://localhost:3000/mcp")
    );
    const refreshedAuth = await support.provider.verifyAccessToken(refreshed.access_token);
    assert.equal(refreshedAuth.extra.apiosk_connect_token, mintedToken);
    assert.equal(minterCalls, 1, "refresh does not re-mint");

    // The runtime threads the connect token to the gateway as the payment rail.
    let capturedClientOptions = null;
    const runtime = createApioskMcpRuntime({
      env: {},
      enableLocalWallets: false,
      hostedAuthEnabled: true,
      clientFactory: async (options) => {
        capturedClientOptions = options;
        return createFakeGatewayClient();
      },
    });

    const result = await runtime.callTool(
      "apiosk_execute",
      { slug: "demo-api", input: { live: true } },
      authInfo
    );
    assert.equal(JSON.parse(result.content[0].text).ok, true);
    assert.equal(capturedClientOptions.connectToken, mintedToken);
  } finally {
    restoreFetch();
  }
});

test("sign-in still completes when the user has no payable managed wallet", async () => {
  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/mcp"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
    // No managed wallet -> minter returns null (best-effort).
    connectTokenMinter: async () => null,
  });

  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-nowallet-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });

  const address = "0x2222222222222222222222222222222222222222";
  const restoreFetch = stubWalletAuthFetch({
    address,
    sessionToken: "jwt_dashboard_session",
    userId: "user_123",
  });

  try {
    const authorizeResponse = createMockResponse({
      method: "POST",
      body: {
        action: "wallet_sign_in",
        wallet_address: address,
        wallet_message: walletMessage(address),
        wallet_signature: "0xsignature",
      },
    });

    await support.provider.authorize(
      client,
      {
        state: "state_x",
        scopes: ["mcp:tools"],
        codeChallenge: "challenge_x",
        redirectUri: "https://chatgpt.com/connector/oauth/callback",
        resource: new URL("http://localhost:3000/mcp"),
      },
      authorizeResponse
    );

    assert.equal(authorizeResponse.statusCode, 302);
    const code = new URL(authorizeResponse.redirectedTo).searchParams.get("code");
    const tokens = await support.provider.exchangeAuthorizationCode(
      client,
      code,
      undefined,
      "https://chatgpt.com/connector/oauth/callback",
      new URL("http://localhost:3000/mcp")
    );
    const authInfo = await support.provider.verifyAccessToken(tokens.access_token);

    // Sign-in works; there is just no payment rail (same as before the bridge).
    assert.equal(authInfo.extra.dashboardSessionToken, "jwt_dashboard_session");
    assert.equal(authInfo.extra.apiosk_connect_token, undefined);
  } finally {
    restoreFetch();
  }
});

test("production OAuth requires explicit wallet limits before returning to ChatGPT", async () => {
  const mintedToken = "aw_live_abcdef012345_ExplicitConsentTokenSecret01";
  const address = "0x3333333333333333333333333333333333333333";
  let mintArgs = null;
  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/sse"),
    appName: "Apiosk",
    resourceName: "Apiosk MCP",
    requirePaymentAuthorization: true,
    payableWalletLister: async () => [
      {
        id: "wallet_payable_1",
        label: "ChatGPT wallet",
        address: "0x00000000000000000000000000000000000000cc",
        dailyLimitUsdc: 10,
        perTxLimitUsdc: 1,
      },
    ],
    connectTokenMinter: async (args) => {
      mintArgs = args;
      return {
        connectToken: mintedToken,
        walletAddress: "0x00000000000000000000000000000000000000cc",
        walletId: "wallet_payable_1",
      };
    },
  });
  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-explicit-payment-client",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  const params = {
    state: "state_explicit",
    scopes: ["mcp:tools"],
    codeChallenge: "challenge_explicit",
    redirectUri: "https://chatgpt.com/connector/oauth/callback",
    resource: new URL("http://localhost:3000/sse"),
  };
  const restoreFetch = stubWalletAuthFetch({ address });

  try {
    const identityResponse = createMockResponse({
      method: "POST",
      body: {
        action: "wallet_sign_in",
        wallet_address: address,
        wallet_message: walletMessage(address),
        wallet_signature: "0xsignature",
      },
    });
    await support.provider.authorize(client, params, identityResponse);
    assert.equal(identityResponse.statusCode, 200);
    assert.equal(identityResponse.redirectedTo, null, "identity alone must not redirect");
    assert.match(identityResponse.body, /Authorize automatic API payments/);
    assert.match(identityResponse.body, /\/security\/settlement-contract/);
    assert.match(identityResponse.body, /Verify the settlement contract, fee history, and approval scope/);
    const pending = identityResponse.body.match(/name="pending_authorization" value="([^"]+)"/)?.[1];
    assert.ok(pending);

    const consentResponse = createMockResponse({
      method: "POST",
      body: {
        action: "authorize_payment",
        pending_authorization: pending,
        managed_wallet_id: "wallet_payable_1",
        per_tx_limit_usdc: "0.75",
        daily_limit_usdc: "12",
        payment_consent: "yes",
      },
    });
    await support.provider.authorize(client, params, consentResponse);
    assert.equal(consentResponse.statusCode, 200);
    assert.equal(consentResponse.redirectedTo, null, "consent shows the connected page, not a bare redirect");
    assert.match(consentResponse.body, /You're connected/);
    const continueHref = consentResponse.body
      .match(/id="continue" href="([^"]+)"/)?.[1]
      ?.replaceAll("&amp;", "&");
    assert.ok(continueHref, "the connected page links back to the client callback");
    assert.match(continueHref, /^https:\/\/chatgpt\.com\/connector\/oauth\/callback/);
    assert.ok(new URL(continueHref).searchParams.get("code"), "the callback link carries the authorization code");
    assert.equal(mintArgs.walletId, "wallet_payable_1");
    assert.equal(mintArgs.perTxLimitUsdc, "0.75");
    assert.equal(mintArgs.dailyLimitUsdc, "12");
    assert.equal(mintArgs.strict, true);
  } finally {
    restoreFetch();
  }
});

test("production OAuth blocks the callback when no payable wallet exists", async () => {
  const address = "0x4444444444444444444444444444444444444444";
  const support = createHostedOAuthSupport({
    env: WALLET_TEST_ENV,
    issuerUrl: new URL("http://localhost:3000"),
    mcpServerUrl: new URL("http://localhost:3000/sse"),
    requirePaymentAuthorization: true,
    payableWalletLister: async () => [],
    connectTokenMinter: async () => {
      throw new Error("must not mint");
    },
  });
  const client = await support.provider.clientsStore.registerClient({
    client_id: "chatgpt-no-payable-wallet",
    client_name: "ChatGPT",
    redirect_uris: ["https://chatgpt.com/connector/oauth/callback"],
    token_endpoint_auth_method: "none",
  });
  const restoreFetch = stubWalletAuthFetch({ address });
  try {
    const response = createMockResponse({
      method: "POST",
      body: {
        action: "wallet_sign_in",
        wallet_address: address,
        wallet_message: walletMessage(address),
        wallet_signature: "0xsignature",
      },
    });
    await support.provider.authorize(
      client,
      {
        state: "state_no_wallet",
        scopes: ["mcp:tools"],
        codeChallenge: "challenge_no_wallet",
        redirectUri: "https://chatgpt.com/connector/oauth/callback",
        resource: new URL("http://localhost:3000/sse"),
      },
      response
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.redirectedTo, null);
    assert.match(response.body, /no active managed payment wallet/i);
  } finally {
    restoreFetch();
  }
});

test("a signed browser wallet is registered and receives a scoped token after confirmed USDC approval", async () => {
  const payer = "0x5555555555555555555555555555555555555555";
  const settlement = "0x512c770ef7b651298cbfa2ab865a81c12f0c703d";
  const usdc = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const txHash = `0x${"ab".repeat(32)}`;
  const walletRow = {
    id: "wallet_connected_1",
    label: "Connected wallet",
    wallet_address: payer,
    status: "active",
    daily_limit_usdc: 10,
    per_tx_limit_usdc: 1,
    encrypted_private_key: null,
    created_at: "2026-07-12T00:00:00Z",
  };
  const calls = [];
  let walletReads = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || "GET";
    calls.push({ href, method, body: options.body ? JSON.parse(options.body) : null });
    if (href.includes("/rest/v1/agent_wallets?select=")) {
      walletReads += 1;
      return new Response(JSON.stringify(walletReads === 1 ? [] : [walletRow]), { status: 200 });
    }
    if (href.endsWith("/rest/v1/agent_wallets") && method === "POST") {
      return new Response(JSON.stringify([walletRow]), { status: 201 });
    }
    if (href === "https://base-rpc.test") {
      const request = JSON.parse(options.body);
      if (request.method === "eth_getTransactionReceipt") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { status: "0x1" } }));
      }
      if (request.method === "eth_getTransactionByHash") {
        const amount = 12_000_000n.toString(16).padStart(64, "0");
        const input = `0x095ea7b3${settlement.slice(2).padStart(64, "0")}${amount}`;
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { from: payer, to: usdc, input } }));
      }
    }
    if (href.endsWith("/rest/v1/agent_wallet_connect_tokens") && method === "POST") {
      return new Response(JSON.stringify([{ id: "token_connected_1" }]), { status: 201 });
    }
    if (href.endsWith("/rest/v1/agent_wallet_connect_token_wallets") && method === "POST") {
      return new Response("", { status: 201 });
    }
    throw new Error(`Unexpected fetch: ${method} ${href}`);
  };

  try {
    const env = {
      ...WALLET_TEST_ENV,
      SETTLEMENT_CONTRACT_ADDRESS: settlement,
      SETTLEMENT_RPC_URL: "https://base-rpc.test",
    };
    const wallets = await prepareHostedPaymentWallets({
      env,
      sessionToken: "jwt_dashboard_session",
      userId: "user_123",
      connectedAddress: payer,
    });
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0].connected, true);
    assert.equal(wallets[0].requiresApproval, true);

    const minted = await mintHostedConnectToken({
      env,
      sessionToken: "jwt_dashboard_session",
      userId: "user_123",
      walletId: "wallet_connected_1",
      dailyLimitUsdc: 12,
      perTxLimitUsdc: 0.5,
      approvalTxHash: txHash,
      strict: true,
    });
    assert.match(minted.connectToken, /^aw_live_/);
    const join = calls.find((call) => call.href.endsWith("agent_wallet_connect_token_wallets"));
    assert.equal(join.body[0].daily_limit_usdc, 12);
    assert.equal(join.body[0].per_tx_limit_usdc, 0.5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconnecting re-activates the user's own revoked wallet row instead of inserting a duplicate", async () => {
  const payer = "0x6666666666666666666666666666666666666666";
  const activeRow = {
    id: "wallet_revoked_1",
    label: "Connected wallet",
    wallet_address: payer,
    status: "active",
    daily_limit_usdc: 10,
    per_tx_limit_usdc: 1,
    encrypted_private_key: null,
    created_at: "2026-07-12T00:00:00Z",
  };
  const calls = [];
  let reactivated = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || "GET";
    calls.push({ href, method });
    if (href.includes("/rest/v1/agent_wallets") && href.includes("status=eq.active")) {
      return new Response(JSON.stringify(reactivated ? [activeRow] : []), { status: 200 });
    }
    if (href.includes("/rest/v1/agent_wallets") && href.includes(`wallet_address=eq.${payer}`)) {
      return new Response(
        JSON.stringify([{ id: "wallet_revoked_1", status: "revoked" }]),
        { status: 200 }
      );
    }
    if (href.includes("/rest/v1/agent_wallets?id=eq.wallet_revoked_1") && method === "PATCH") {
      reactivated = true;
      assert.equal(options.headers.authorization, "Bearer jwt_dashboard_session");
      assert.equal(JSON.parse(options.body).status, "active");
      return new Response(JSON.stringify([activeRow]), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${href}`);
  };

  try {
    const wallets = await prepareHostedPaymentWallets({
      env: WALLET_TEST_ENV,
      sessionToken: "jwt_dashboard_session",
      userId: "user_123",
      connectedAddress: payer,
    });
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0].connected, true);
    assert.ok(!calls.some((call) => call.method === "POST"), "no duplicate insert attempted");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconnecting reclaims a wallet row owned by a stale user via the service role", async () => {
  const payer = "0x7777777777777777777777777777777777777777";
  const activeRow = {
    id: "wallet_stale_1",
    label: "Connected wallet",
    wallet_address: payer,
    status: "active",
    daily_limit_usdc: 10,
    per_tx_limit_usdc: 1,
    encrypted_private_key: null,
    created_at: "2026-07-12T00:00:00Z",
  };
  const calls = [];
  let reclaimed = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const href = String(url);
    const method = options.method || "GET";
    const bearer = options.headers?.authorization || "";
    calls.push({ href, method, bearer, body: options.body ? JSON.parse(options.body) : null });
    if (href.includes("/rest/v1/agent_wallets") && href.includes("status=eq.active")) {
      return new Response(JSON.stringify(reclaimed ? [activeRow] : []), { status: 200 });
    }
    if (href.includes("/rest/v1/agent_wallets") && href.includes(`wallet_address=eq.${payer}`)) {
      // Invisible to the user's JWT (owned by a stale auth user); only the
      // service role can see it.
      if (bearer === "Bearer service-role-test") {
        return new Response(
          JSON.stringify([
            { id: "wallet_stale_1", user_id: "user_old", status: "active", encrypted_private_key: null },
          ]),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (href.endsWith("/rest/v1/agent_wallets") && method === "POST") {
      return new Response(
        JSON.stringify({
          message: 'duplicate key value violates unique constraint "agent_wallets_wallet_address_key"',
        }),
        { status: 409 }
      );
    }
    if (href.includes("/rest/v1/agent_wallets?id=eq.wallet_stale_1") && method === "PATCH") {
      reclaimed = true;
      assert.equal(bearer, "Bearer service-role-test");
      const body = JSON.parse(options.body);
      assert.equal(body.user_id, "user_123");
      assert.equal(body.status, "active");
      return new Response(JSON.stringify([activeRow]), { status: 200 });
    }
    if (href.includes("/rest/v1/agent_wallet_connect_tokens?wallet_id=eq.wallet_stale_1") && method === "PATCH") {
      assert.equal(bearer, "Bearer service-role-test");
      return new Response(JSON.stringify([]), { status: 200 });
    }
    throw new Error(`Unexpected fetch: ${method} ${href}`);
  };

  try {
    const wallets = await prepareHostedPaymentWallets({
      env: WALLET_TEST_ENV,
      sessionToken: "jwt_dashboard_session",
      userId: "user_123",
      connectedAddress: payer,
    });
    assert.equal(wallets.length, 1);
    assert.equal(wallets[0].connected, true);
    const tokenRevoke = calls.find((call) =>
      call.href.includes("agent_wallet_connect_tokens?wallet_id=eq.wallet_stale_1")
    );
    assert.ok(tokenRevoke, "stale owner's connect tokens are revoked on reclaim");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
