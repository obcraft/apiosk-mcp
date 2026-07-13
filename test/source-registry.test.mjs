import test from "node:test";
import assert from "node:assert/strict";

import { materializeEndpoint, searchKnownSources } from "../src/source-registry.mjs";

test("source registry resolves names without relying on catalog or web search", () => {
  const [source] = searchKnownSources("x402scan");
  assert.equal(source.id, "x402scan");
  assert.equal(source.wire_method, "paid-rest");
  const paidSearch = source.endpoints.find((endpoint) => endpoint.role === "search");
  assert.equal(paidSearch.payment_required, true);
  assert.equal(paidSearch.price_usdc, 0.02);
  assert.equal(
    materializeEndpoint(paidSearch, "weather alerts"),
    "https://www.x402scan.com/api/x402/resources/search?q=weather%20alerts"
  );
});

test("source registry includes direct paid endpoints as well as free discovery endpoints", () => {
  const [direct] = searchKnownSources("x402.direct");
  assert.ok(direct.endpoints.some((endpoint) => endpoint.payment_required === false));
  assert.ok(direct.endpoints.some((endpoint) => endpoint.payment_required === true));

  const [apify] = searchKnownSources("apify");
  assert.ok(apify.endpoints.some((endpoint) => endpoint.role === "buy_prepaid_token" && endpoint.payment_required));
});
