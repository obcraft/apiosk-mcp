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
