import test from "node:test";
import assert from "node:assert/strict";

import { runFetchPaid, FETCH_PAID_TOOL } from "../src/external-fetch.mjs";

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test("runFetchPaid requires url and confirmed price", async () => {
  const r1 = await runFetchPaid({ confirmed_price_usdc: 0.02 }, { connectToken: "aw_live_x" });
  assert.match(JSON.parse(r1.content[0].text).error, /url/);
  const r2 = await runFetchPaid({ url: "https://x.com" }, { connectToken: "aw_live_x" });
  assert.match(JSON.parse(r2.content[0].text).error, /confirmed_price_usdc/);
});

test("runFetchPaid needs a connect token", async () => {
  const res = await runFetchPaid(
    { url: "https://fx.example.com/usd", confirmed_price_usdc: 0.02 },
    { connectToken: "" }
  );
  assert.match(JSON.parse(res.content[0].text).error, /connect token|connected wallet/i);
});

test("runFetchPaid posts to the gateway payer and returns the receipt on success", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return jsonResponse(200, {
      data: { rate: 1.08 },
      receipt: { paid_usdc: 0.02, fee_usdc: 0.0004, external_tx: "0xabc", remaining_daily_usdc: 9.9 },
    });
  };
  const res = await runFetchPaid(
    { url: "https://fx.example.com/usd", confirmed_price_usdc: 0.02 },
    { connectToken: "aw_live_token", gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "success");
  assert.deepEqual(payload.data, { rate: 1.08 });
  assert.equal(payload.receipt.paid_usdc, 0.02);
  assert.equal(captured.url, "https://gateway.apiosk.com/v1/x402/fetch");
  assert.equal(captured.init.headers["X-Apiosk-Connect-Token"], "aw_live_token");
  assert.ok(captured.init.headers["Idempotency-Key"], "sends an idempotency key");
  const sentBody = JSON.parse(captured.init.body);
  assert.equal(sentBody.confirmed_price_usdc, 0.02);
});

test("runFetchPaid surfaces a gateway refusal code (error field) as data, not an error", async () => {
  // The Rust gateway emits refusal codes under `error` (json_error_response).
  const fetchImpl = async () => jsonResponse(403, { error: "agent_wallet_per_tx_limit_exceeded", message: "over limit" });
  const res = await runFetchPaid(
    { url: "https://fx.example.com/usd", confirmed_price_usdc: 5 },
    { connectToken: "aw_live_token", fetchImpl }
  );
  assert.notEqual(res.isError, true);
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.code, "agent_wallet_per_tx_limit_exceeded");
});

test("runFetchPaid degrades gracefully when the feature is disabled (error field)", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: "feature_disabled", message: "off" }) });
  const res = await runFetchPaid(
    { url: "https://fx.example.com/usd", confirmed_price_usdc: 0.02 },
    { connectToken: "aw_live_token", fetchImpl }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.status, "unavailable");
  assert.equal(payload.code, "feature_disabled");
  assert.match(payload.message, /apiosk_execute/);
});

test("runFetchPaid reuses a provided idempotency key", async () => {
  let sentKey = null;
  const fetchImpl = async (_url, init) => {
    sentKey = init.headers["Idempotency-Key"];
    return jsonResponse(200, { data: {}, receipt: {} });
  };
  await runFetchPaid(
    { url: "https://fx.example.com/usd", confirmed_price_usdc: 0.02, idempotency_key: "my-key-123" },
    { connectToken: "aw_live_token", fetchImpl }
  );
  assert.equal(sentKey, "my-key-123");
});

test("FETCH_PAID_TOOL is destructive and requires url + confirmed price", () => {
  assert.equal(FETCH_PAID_TOOL.name, "apiosk_fetch_paid");
  assert.deepEqual(FETCH_PAID_TOOL.inputSchema.required, ["url", "confirmed_price_usdc"]);
  assert.equal(FETCH_PAID_TOOL.annotations.destructiveHint, true);
});
