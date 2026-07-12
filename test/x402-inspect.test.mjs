import test from "node:test";
import assert from "node:assert/strict";

import {
  runInspect,
  parseX402,
  isSafeInspectUrl,
  atomicToUsdc,
  INSPECT_TOOL,
} from "../src/x402-inspect.mjs";

function encodeHeader(doc) {
  return Buffer.from(JSON.stringify(doc)).toString("base64");
}

function headersWith(map) {
  const lower = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (k) => (lower.has(k.toLowerCase()) ? lower.get(k.toLowerCase()) : null) };
}

test("atomicToUsdc converts 6-decimal atomic amounts", () => {
  assert.equal(atomicToUsdc("20000"), 0.02);
  assert.equal(atomicToUsdc(1_000_000), 1);
  assert.equal(atomicToUsdc("not-a-number"), null);
  assert.equal(atomicToUsdc(null), null);
});

test("isSafeInspectUrl blocks local, metadata, private, and non-https targets", () => {
  assert.equal(isSafeInspectUrl("https://api.example.com/x").ok, true);
  assert.equal(isSafeInspectUrl("http://api.example.com/x").ok, false);
  assert.equal(isSafeInspectUrl("https://localhost/x").ok, false);
  assert.equal(isSafeInspectUrl("https://127.0.0.1/x").ok, false);
  assert.equal(isSafeInspectUrl("https://169.254.169.254/latest").ok, false);
  assert.equal(isSafeInspectUrl("https://10.1.2.3/x").ok, false);
  assert.equal(isSafeInspectUrl("https://192.168.0.1/x").ok, false);
  assert.equal(isSafeInspectUrl("https://172.16.5.5/x").ok, false);
  assert.equal(isSafeInspectUrl("not a url").ok, false);
});

test("parseX402 merges v1 body + v2 header into a single deduped offer", () => {
  const body = {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "base",
        maxAmountRequired: "20000",
        asset: "0xUSDC",
        payTo: "0xProv",
        maxTimeoutSeconds: 60,
        description: "USD rate feed",
      },
    ],
  };
  const header = encodeHeader({
    x402Version: 2,
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        amount: "20000",
        asset: "0xUSDC",
        payTo: "0xProv",
        maxTimeoutSeconds: 60,
      },
    ],
  });
  const { offers, versions_seen } = parseX402(headersWith({ "payment-required": header }), body);
  assert.equal(offers.length, 1, "identical v1/v2 terms deduped to one offer");
  assert.equal(offers[0].amount_usdc, 0.02);
  assert.equal(offers[0].network, "base");
  assert.equal(offers[0].network_caip2, "eip155:8453");
  assert.deepEqual(versions_seen.sort(), [1, 2]);
});

test("runInspect returns normalized terms and flags an unverified host", async () => {
  const body = {
    x402Version: 1,
    accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "20000", asset: "0xUSDC", payTo: "0xProv" }],
  };
  const stubFetch = async () => ({
    status: 402,
    headers: headersWith({}),
    text: async () => JSON.stringify(body),
  });
  const res = await runInspect(
    { url: "https://fx.example.com/usd" },
    { fetchImpl: stubFetch, gatewayHost: "gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.is_x402, true);
  assert.equal(payload.best_offer.amount_usdc, 0.02);
  assert.equal(payload.risk.known_host, false);
  assert.match(payload.risk.warnings.join(" "), /Unverified host/);
  assert.match(payload.next_steps, /apiosk_fetch_paid/);
});

test("runInspect marks apiosk.com hosts as known", async () => {
  const body = { x402Version: 1, accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "20000", payTo: "0xA039" }] };
  const stubFetch = async () => ({ status: 402, headers: headersWith({}), text: async () => JSON.stringify(body) });
  const res = await runInspect(
    { url: "https://gateway.apiosk.com/frankfurter" },
    { fetchImpl: stubFetch, gatewayHost: "gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.risk.known_host, true);
});

test("runInspect refuses local/SSRF targets without fetching", async () => {
  let fetched = false;
  const stubFetch = async () => {
    fetched = true;
    return { status: 402, headers: headersWith({}), text: async () => "{}" };
  };
  const res = await runInspect({ url: "https://127.0.0.1/x" }, { fetchImpl: stubFetch });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.refused, true);
  assert.equal(fetched, false, "never connected");
});

test("runInspect reports non-402 responses as not-x402", async () => {
  const stubFetch = async () => ({ status: 200, headers: headersWith({}), text: async () => "{}" });
  const res = await runInspect({ url: "https://api.example.com/free" }, { fetchImpl: stubFetch });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.is_x402, false);
  assert.equal(payload.status, 200);
});

test("runInspect handles fetch errors gracefully (no throw)", async () => {
  const stubFetch = async () => {
    throw new Error("network down");
  };
  const res = await runInspect({ url: "https://api.example.com/x" }, { fetchImpl: stubFetch });
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.ok, false);
  assert.match(payload.reason, /network down/);
});

test("INSPECT_TOOL is read-only and requires a url", () => {
  assert.equal(INSPECT_TOOL.name, "apiosk_inspect_x402");
  assert.deepEqual(INSPECT_TOOL.inputSchema.required, ["url"]);
  assert.equal(INSPECT_TOOL.annotations.readOnlyHint, true);
});
