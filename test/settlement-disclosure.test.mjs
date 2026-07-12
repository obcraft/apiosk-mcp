import test from "node:test";
import assert from "node:assert/strict";

import {
  BASE_USDC_ADDRESS,
  SETTLEMENT_CONTRACT_ADDRESS,
  SETTLEMENT_DISCLOSURE_PATH,
  createSettlementDisclosurePage,
} from "../src/settlement-disclosure.mjs";

test("settlement disclosure publishes verifiable deployment and fee history", () => {
  const page = createSettlementDisclosurePage();
  assert.equal(SETTLEMENT_DISCLOSURE_PATH, "/security/settlement-contract");
  assert.match(page, new RegExp(SETTLEMENT_CONTRACT_ADDRESS));
  assert.match(page, new RegExp(BASE_USDC_ADDRESS));
  assert.match(page, /initializes the platform fee at 10%/);
  assert.match(page, /changed it to 2%/);
  assert.match(page, /not an unlimited approval/i);
  assert.match(page, /verified source/i);
});
