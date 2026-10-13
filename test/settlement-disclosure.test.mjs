import test from "node:test";
import assert from "node:assert/strict";
import { SETTLEMENT_DISCLOSURE_PATH, createSettlementDisclosurePage } from "../src/settlement-disclosure.mjs";

test("historical payment link describes current balance authorization without contract claims", () => {
  const page = createSettlementDisclosurePage();
  assert.equal(SETTLEMENT_DISCLOSURE_PATH, "/security/settlement-contract");
  assert.match(page, /account or workspace balance/);
  assert.match(page, /one total price ceiling/);
  assert.match(page, /smart-contract payment flow is retired/);
  assert.match(page, /does not require a wallet transaction or a token allowance/);
  assert.doesNotMatch(page, /0x[0-9a-f]{40}|platformFeeBps|setPlatformFee|USDC allowance|2%/i);
});
