import test from "node:test";
import assert from "node:assert/strict";

import { ApioskPaymentRequiredError } from "@apiosk/sdk";

import { createApioskMcpRuntime } from "../src/runtime.mjs";

const HOSTED_ENV = {
  NODE_ENV: "test",
  APIOSK_SUPABASE_URL: "https://sb.test",
  APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
};

const SESSION_AUTH = {
  extra: {
    dashboardSessionToken: "jwt_dashboard_session",
    userId: "user_123",
  },
};

const CUSTODIAL_WALLET_ROW = {
  id: "wallet_1",
  label: "Primary agent wallet",
  wallet_address: "0xAbCd000000000000000000000000000000000001",
  status: "active",
  daily_limit_usdc: 25,
  per_tx_limit_usdc: 5,
  last_used_at: null,
  created_at: "2026-07-01T00:00:00Z",
  encrypted_private_key: '{"v":2,"ciphertext":"secret-material"}',
  icon: null,
  color: null,
};

const WATCH_WALLET_ROW = {
  ...CUSTODIAL_WALLET_ROW,
  id: "wallet_2",
  label: "Watch-only",
  wallet_address: "0xAbCd000000000000000000000000000000000002",
  encrypted_private_key: null,
};

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createHostedRuntime() {
  return createApioskMcpRuntime({
    env: HOSTED_ENV,
    enableLocalWallets: false,
    hostedAuthEnabled: true,
    client: {
      async listApis() {
        return { apis: [], meta: { total: 0 } };
      },
      async execute() {
        throw new ApioskPaymentRequiredError("Payment required", {
          accepts: [{ scheme: "exact", network: "base" }],
        });
      },
      async getApi(slug) {
        return { slug };
      },
      async getMetadata(slug) {
        return { slug };
      },
      async requestJson() {
        return { apis: [], meta: { total: 0 } };
      },
    },
  });
}

test("hosted apiosk_list_wallets reads Supabase REST with the caller's JWT and never leaks key material", async (t) => {
  const seenRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    seenRequests.push({ href, init });
    if (href.startsWith("https://sb.test/rest/v1/agent_wallets?select=")) {
      return jsonResponse([CUSTODIAL_WALLET_ROW, WATCH_WALLET_ROW]);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = createHostedRuntime();
  const result = await runtime.callTool("apiosk_list_wallets", {}, SESSION_AUTH);
  const text = result.content[0].text;
  const payload = JSON.parse(text);

  assert.equal(payload.wallets.length, 2);
  assert.equal(payload.wallets[0].custodial, true);
  assert.equal(payload.wallets[1].custodial, false);
  assert.equal(payload.payable_wallet.id, "wallet_1");
  assert.equal(
    payload.funding.address,
    CUSTODIAL_WALLET_ROW.wallet_address.toLowerCase()
  );
  // The custodied key must never reach the MCP client in any shape.
  assert.ok(!text.includes("secret-material"));
  assert.ok(!text.includes("encrypted_private_key"));

  const request = seenRequests[0];
  assert.equal(request.init.headers.authorization, "Bearer jwt_dashboard_session");
  assert.equal(request.init.headers.apikey, "service-role-test");
});

test("hosted apiosk_create_wallet_api_key mints a gateway-compatible connect token for a payable wallet", async (t) => {
  const inserts = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/rest/v1/agent_wallets?select=") && href.includes("id=eq.wallet_1")) {
      return jsonResponse([CUSTODIAL_WALLET_ROW]);
    }
    if (href.endsWith("/rest/v1/agent_wallet_connect_tokens")) {
      inserts.push(JSON.parse(init.body));
      return jsonResponse([{ id: "token_row_1" }], 201);
    }
    if (href.endsWith("/rest/v1/agent_wallet_connect_token_wallets")) {
      inserts.push(JSON.parse(init.body));
      return jsonResponse([], 201);
    }
    throw new Error(`Unexpected fetch: ${href}`);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const runtime = createHostedRuntime();
  const result = await runtime.callTool(
    "apiosk_create_wallet_api_key",
    { wallet_id: "wallet_1", name: "ChatGPT key" },
    SESSION_AUTH
  );
  const payload = JSON.parse(result.content[0].text);

  assert.match(payload.connect_token, /^aw_live_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
  assert.equal(payload.token_prefix, payload.connect_token.slice(0, 22));
  assert.equal(payload.wallet.id, "wallet_1");
  assert.match(payload.warning, /only time/i);

  const tokenInsert = inserts[0];
  assert.equal(tokenInsert.wallet_id, "wallet_1");
  assert.equal(tokenInsert.user_id, "user_123");
  assert.equal(tokenInsert.token_prefix, payload.token_prefix);
  // Only the hash is persisted, never the raw token.
  assert.match(tokenInsert.token_hash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(tokenInsert).includes(payload.connect_token));

  const joinInsert = inserts[1];
  assert.deepEqual(joinInsert, [
    { token_id: "token_row_1", wallet_id: "wallet_1", user_id: "user_123" },
  ]);
});

test("hosted apiosk_create_wallet explains custodial creation is unavailable instead of proxying HTML", async () => {
  const runtime = createHostedRuntime();
  const result = await runtime.callTool(
    "apiosk_create_wallet",
    { label: "New wallet" },
    SESSION_AUTH
  );

  assert.equal(result.isError, true);
  const payload = JSON.parse(result.content[0].text);
  assert.equal(payload.error, "custodial_wallet_creation_unavailable");
  assert.ok(Array.isArray(payload.what_you_can_do));
});

test("402 hint names the managed wallet for connect-token sessions and guides walletless sign-ins", async () => {
  const runtime = createHostedRuntime();

  const withToken = await runtime.callTool(
    "apiosk_execute",
    { slug: "demo-api", input: {} },
    {
      extra: {
        dashboardSessionToken: "jwt_dashboard_session",
        apiosk_connect_token: "aw_live_0dd02139bd57_secret",
        apiosk_connect_wallet_address: "0xabcd000000000000000000000000000000000001",
      },
    }
  );
  const withTokenPayload = JSON.parse(withToken.content[0].text);
  assert.notEqual(withToken.isError, true);
  assert.equal(withTokenPayload.status, "payment_required");
  assert.equal(withTokenPayload.error_code, "payment.wallet_unfunded_or_unavailable");
  assert.match(
    withTokenPayload.hint,
    /0xabcd000000000000000000000000000000000001/
  );
  assert.match(withTokenPayload.hint, /USDC on Base/);

  const withoutWallet = await runtime.callTool(
    "apiosk_execute",
    { slug: "demo-api", input: {} },
    SESSION_AUTH
  );
  const withoutWalletPayload = JSON.parse(withoutWallet.content[0].text);
  assert.notEqual(withoutWallet.isError, true);
  assert.match(withoutWalletPayload.hint, /no payable managed wallet/i);
  assert.match(withoutWalletPayload.hint, /apiosk_list_wallets/);
});
