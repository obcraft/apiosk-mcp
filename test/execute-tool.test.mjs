import test from "node:test";
import assert from "node:assert/strict";

import { GatewayError } from "../src/gateway-client.mjs";
import { EXECUTE_TOOL, runExecute } from "../src/tools/execute.mjs";

const parse = (result) => JSON.parse(result.content[0].text);

function failingGateway(error) {
  const calls = [];
  return {
    calls,
    async requestJson(path, options) {
      calls.push({ path, options });
      if (path === "/v1/select") return { selection_id: "0f8656ec-e667-4c8f-a340-a8dc2ddc36bc" };
      throw error;
    },
  };
}

test("execute is callable by the offer card and receives exact input locations", () => {
  assert.equal(EXECUTE_TOOL._meta["openai/widgetAccessible"], true);
  assert.deepEqual(EXECUTE_TOOL._meta.ui.visibility, ["model", "app"]);
  assert.ok(EXECUTE_TOOL.inputSchema.properties.input_parts);
});

test("a normal 402 is payment_required, never a fake approval", async () => {
  const gateway = failingGateway(
    new GatewayError("Your balance does not cover this call.", {
      code: "insufficient_funds",
      status: 402,
      body: { error: "insufficient_funds", balance_micro_usd: 10, required_micro_usd: 100 },
    }),
  );
  const value = parse(
    await runExecute(
      { offer_token: "signed", prompt: "weather", max_price_usdc: 0.01 },
      { gateway, env: {} },
    ),
  );
  assert.equal(value.status, "payment_required");
  assert.equal(value.error_code, "insufficient_funds");
  assert.equal(value.approval_id, undefined);
});

test("only an explicit approval_required 402 becomes an approval hold", async () => {
  const gateway = failingGateway(
    new GatewayError("Approval needed.", {
      code: "approval_required",
      status: 402,
      body: {
        status: "approval_required",
        error: "approval_required",
        approval_id: "2f8656ec-e667-4c8f-a340-a8dc2ddc36bc",
        approve_url: "https://buy.apiosk.com/approvals/2f8656ec-e667-4c8f-a340-a8dc2ddc36bc",
        price_usdc: "0.01",
      },
    }),
  );
  const value = parse(
    await runExecute(
      { offer_token: "signed", prompt: "weather", max_price_usdc: 0.01 },
      { gateway, env: {} },
    ),
  );
  assert.equal(value.status, "approval_required");
  assert.equal(value.approval_id, "2f8656ec-e667-4c8f-a340-a8dc2ddc36bc");
  assert.equal(value.max_price_usdc, 0.01);
  assert.match(value.approve_url, /^https:\/\/buy\.apiosk\.com/);
});

test("connection spending limits remain distinct from authentication failures", async () => {
  const gateway = failingGateway(
    new GatewayError("Over the per-call limit.", {
      code: "limit_exceeded",
      status: 403,
      body: { error: "limit_exceeded" },
    }),
  );
  const value = parse(
    await runExecute(
      { offer_token: "signed", prompt: "weather", max_price_usdc: 0.01 },
      { gateway, env: {} },
    ),
  );
  assert.equal(value.status, "limit_exceeded");
  assert.notEqual(value.status, "not_authorised");
});

/* A purchase with no stated ceiling is a purchase nobody approved an amount
   for. `max_price_usdc` is declared `required` in the tool schema, but a schema
   steers a model rather than gating a call: a client that omitted it — or
   passed the `null` an unpriced row hands over — used to reach `/v1/run` with
   the ceiling quietly dropped from the body. */
test("a call with no price ceiling is refused before anything is selected", async () => {
  let touched = false;
  const gateway = {
    requestJson: async () => {
      touched = true;
      return {};
    },
  };
  for (const args of [
    { offer_token: "signed", prompt: "weather" },
    { offer_token: "signed", prompt: "weather", max_price_usdc: null },
    { offer_token: "signed", prompt: "weather", max_price_usdc: 0 },
    { offer_token: "signed", prompt: "weather", max_price_usdc: "not a number" },
  ]) {
    const value = parse(await runExecute(args, { gateway, env: {} }));
    assert.equal(value.error_code, "execute.no_ceiling");
    // Refused BEFORE the gateway is touched: no selection is recorded, so
    // there is nothing half-made to reconcile.
    assert.equal(touched, false, `gateway was called for ${JSON.stringify(args)}`);
  }
});

test("a stated ceiling is always sent, never dropped", async () => {
  const sent = [];
  const gateway = {
    requestJson: async (path, init) => {
      sent.push({ path, body: init?.body });
      return path === "/v1/select" ? { selection_id: "sel-1" } : { answer: "ok" };
    },
  };
  // Not parsed: a result carrying `answer` renders as plain text, not JSON.
  // What is under test is the body that went out, not the shape that came back.
  await runExecute(
    { offer_token: "signed", prompt: "weather", max_price_usdc: 0.0125 },
    { gateway, env: {} },
  );
  const run = sent.find((call) => call.path === "/v1/run");
  assert.equal(run.body.max_price_usdc, 0.0125);
});

