import test from "node:test";
import assert from "node:assert/strict";

import { QUICK_TOOL, runQuickBest } from "../src/tools/top.mjs";

function parse(result) {
  return JSON.parse(result.content[0].text);
}

test("apiosk tool is read-only and renders the approval card", () => {
  assert.equal(QUICK_TOOL.name, "apiosk");
  assert.equal(QUICK_TOOL.inputSchema.required[0], "query");
  assert.equal(QUICK_TOOL.annotations.readOnlyHint, true);
  assert.equal(QUICK_TOOL.annotations.destructiveHint, false);
  assert.equal(QUICK_TOOL._meta.ui.resourceUri, "ui://apiosk/offer-card.html");
});

test("apiosk returns the gateway's ranked pick, not the cheapest row", async () => {
  const calls = [];
  const response = {
    answers_job: true,
    best_relevance: 94,
    pick: {
      offer: {
        kind: "reviewed",
        source: "apiosk",
        api_slug: "finnhub",
        name: "Finnhub",
        resource_url: null,
        fields: [
          { name: "symbol", label: "Symbol", location: "query", required: true, type: "string", options: [] },
        ],
      },
      name: "Finnhub",
      price_usd: 0.05,
      relevance: 94,
      matched: ["stock price"],
      offer_token: "finn-token",
    },
    results: [
      {
        offer: {
          kind: "reviewed",
          source: "apiosk",
          api_slug: "finnhub",
          name: "Finnhub",
          resource_url: null,
        },
        name: "Finnhub",
        price_usd: 0.05,
        offer_token: "finn-token",
      },
      {
        offer: {
          kind: "reviewed",
          source: "apiosk",
          api_slug: "cityfalcon-financial-api",
          name: "CityFALCON",
          resource_url: null,
        },
        name: "CityFALCON",
        price_usd: 0.03,
        offer_token: "city-token",
      },
      {
        offer: {
          kind: "reviewed",
          source: "apiosk",
          api_slug: "missing-token",
          name: "No token row",
          resource_url: null,
        },
        name: "No token row",
        price_usd: 0.001,
      },
    ],
  };

  const result = parse(
    await runQuickBest({ query: "stock price", max_price_usdc: 0.1 }, {
      gateway: { requestJson: (path, options) => {
        calls.push({ path, options });
        return Promise.resolve(response);
      }},
    }),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/ask");
  assert.equal(calls[0].options.query.q, "stock price");
  assert.equal(calls[0].options.query.include_external, "true");
  assert.equal(result.status, "ok");
  assert.equal(result.top.offer_token, "finn-token");
  assert.equal(result.top_provider, "Finnhub");
  assert.equal(result.top_price_usdc, 0.05);
  assert.equal(result.top.relevance, 94);
  assert.equal(result.top.input_fields[0].name, "symbol");
  assert.equal(result.approval.state, "awaiting_user");
  assert.equal(result.approval.deny_label, "Deny");
});

test("apiosk enforces max price when requested", async () => {
  const calls = [];
  const response = {
    answers_job: true,
    pick: {
      offer: {
        kind: "reviewed",
        source: "apiosk",
        api_slug: "cheap",
        name: "Cheap",
        resource_url: null,
      },
      name: "Cheap",
      offer_token: "cheap",
      price_usd: 0.02,
    },
    results: [
      {
        offer: {
          kind: "reviewed",
          source: "apiosk",
          api_slug: "cheap",
          name: "Cheap",
          resource_url: null,
        },
        name: "Cheap",
        offer_token: "cheap",
        price_usd: 0.02,
      },
      {
        offer: {
          kind: "reviewed",
          source: "apiosk",
          api_slug: "expensive",
          name: "Expensive",
          resource_url: null,
        },
        name: "Expensive",
        offer_token: "expensive",
        price_usd: 0.2,
      },
    ],
  };

  const cheapResult = parse(
    await runQuickBest({ query: "weather", max_price_usdc: 0.05 }, {
      gateway: { requestJson: (path, options) => {
        calls.push({ path, options });
        return Promise.resolve(response);
      }},
    }),
  );

  assert.equal(cheapResult.top.provider, "Cheap");
  assert.equal(cheapResult.offer_count, 1);
  assert.equal(cheapResult.top.price_usdc, 0.02);
});

test("apiosk refuses to propose a near miss when the shared ranking says it does not answer", async () => {
  const result = parse(
    await runQuickBest({ query: "who runs partnerships" }, {
      gateway: {
        requestJson: async () => ({
          answers_job: false,
          best_relevance: 18,
          pick: null,
          results: [
            {
              offer: { kind: "reviewed", source: "apiosk", api_slug: "theme-linter", name: "Theme linter" },
              name: "Theme linter",
              price_usd: 0.001,
              offer_token: "wrong-token",
            },
          ],
        }),
      },
    }),
  );
  assert.equal(result.status, "empty");
  assert.equal(result.offer_count, 1);
  assert.equal(result.best_relevance, 18);
});
