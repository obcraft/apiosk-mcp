import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  PUBLISHER_TOOLS,
  buildOpenApiDocument,
  clearPublisherCaches,
  defaultPathFromUpstream,
  deriveOriginUrl,
  handlePublisherTool,
  isProviderApiKey,
  isPublisherTool,
  normalizePath,
  parsePriceUsdc,
  reshapeDiscoveryItems,
  slugify,
  verifyProviderKey,
} from "./src/publisher.mjs";

const TEST_ENV = {
  APIOSK_SUPABASE_URL: "https://sb.test",
  APIOSK_SUPABASE_SERVICE_ROLE_KEY: "service-role-test-key",
  APIOSK_GATEWAY: "https://gw.test",
  APIOSK_MCP_PUBLIC_BASE_URL: "https://mcp.test",
};

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => body,
  };
}

// Scripted fetch: matches requests against [predicate, response] rules in
// order and records every call for assertions.
function scriptedFetch(rules) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    calls.push({ url: String(url), method, init });
    for (const rule of rules) {
      if (rule.match(String(url), method, init)) {
        return typeof rule.respond === "function" ? rule.respond(String(url), init) : rule.respond;
      }
    }
    throw new Error(`Unexpected fetch in test: ${method} ${url}`);
  };
  return { fetchImpl, calls };
}

function verifyKeyRule(ownerId = "owner-1") {
  return {
    match: (url, method) => method === "POST" && url.includes("rpc/verify_provider_api_key"),
    respond: jsonResponse([{ owner_id: ownerId, key_id: "key-1", label: "ci" }]),
  };
}

beforeEach(() => {
  clearPublisherCaches();
});

describe("publisher helpers", () => {
  it("slugifies names", () => {
    assert.equal(slugify("Weather API"), "weather-api");
    assert.equal(slugify("  PDF -- Tools!! "), "pdf-tools");
  });

  it("normalizes paths and rejects unsafe ones", () => {
    assert.equal(normalizePath("weather"), "/weather");
    assert.equal(normalizePath("/a//b/"), "/a/b");
    assert.equal(normalizePath(""), "/");
    assert.throws(() => normalizePath("/we ather"));
  });

  it("derives the upstream origin so the path is not doubled on forward", () => {
    assert.equal(
      deriveOriginUrl("https://example.com/api/weather", "/weather"),
      "https://example.com/api"
    );
    assert.equal(
      deriveOriginUrl("https://example.com/api", "/weather"),
      "https://example.com/api"
    );
    assert.throws(() => deriveOriginUrl("http://insecure.example.com/x", "/x"));
  });

  it("defaults the public path from the upstream URL", () => {
    assert.equal(defaultPathFromUpstream("https://example.com/api/weather"), "/weather");
    assert.equal(defaultPathFromUpstream("https://example.com"), "/");
  });

  it("parses USDC prices", () => {
    assert.equal(parsePriceUsdc("0.01"), 0.01);
    assert.equal(parsePriceUsdc(0.05), 0.05);
    assert.throws(() => parsePriceUsdc("0"));
    assert.throws(() => parsePriceUsdc("-1"));
    assert.throws(() => parsePriceUsdc("not-a-price"));
    assert.throws(() => parsePriceUsdc(5000));
  });

  it("recognizes provider keys and publisher tools", () => {
    assert.equal(isProviderApiKey("sk_live_abc123"), true);
    assert.equal(isProviderApiKey("aw_live_abc123"), false);
    assert.equal(isPublisherTool("publish_x402_route"), true);
    assert.equal(isPublisherTool("apiosk_search"), false);
    assert.equal(PUBLISHER_TOOLS.length, 7);
  });
});

describe("verifyProviderKey", () => {
  it("resolves a valid key to its owner and caches the lookup", async () => {
    const { fetchImpl, calls } = scriptedFetch([verifyKeyRule("owner-42")]);
    const first = await verifyProviderKey("sk_live_cache_test", { env: TEST_ENV, fetchImpl });
    const second = await verifyProviderKey("sk_live_cache_test", { env: TEST_ENV, fetchImpl });

    assert.equal(first.ownerId, "owner-42");
    assert.equal(second.ownerId, "owner-42");
    assert.equal(calls.length, 1, "second lookup should be served from cache");
  });

  it("rejects revoked/unknown keys", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        match: (url) => url.includes("rpc/verify_provider_api_key"),
        respond: jsonResponse([]),
      },
    ]);
    await assert.rejects(
      () => verifyProviderKey("sk_live_revoked", { env: TEST_ENV, fetchImpl }),
      /Invalid or revoked/
    );
  });

  it("throws header-safe ASCII messages (they end up in WWW-Authenticate)", async () => {
    const { fetchImpl } = scriptedFetch([
      {
        match: (url) => url.includes("rpc/verify_provider_api_key"),
        respond: jsonResponse([]),
      },
    ]);
    try {
      await verifyProviderKey("sk_live_ascii_check", { env: TEST_ENV, fetchImpl });
      assert.fail("expected rejection");
    } catch (error) {
      assert.match(error.message, /^[\x20-\x7e]+$/, "message must be printable ASCII");
    }
  });

  it("fails clearly when the service-role key is not configured", async () => {
    await assert.rejects(
      () => verifyProviderKey("sk_live_whatever", { env: { APIOSK_SUPABASE_URL: "https://sb.test" } }),
      /SUPABASE_SERVICE_ROLE_KEY/
    );
  });
});

describe("publish_x402_route", () => {
  it("creates a listing plus endpoint and reports pending review honestly", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      verifyKeyRule(),
      {
        match: (url, method) => method === "GET" && url.includes("apis?slug=eq.weather-api"),
        respond: jsonResponse([]),
      },
      {
        match: (url, method) => method === "POST" && url.includes("/rest/v1/apis"),
        respond: (url, init) => {
          const body = JSON.parse(init.body);
          return jsonResponse([
            {
              id: "api-1",
              ...body,
            },
          ]);
        },
      },
      {
        match: (url, method) => method === "GET" && url.includes("api_endpoints?api_id=eq.api-1"),
        respond: jsonResponse([]),
      },
      {
        match: (url, method) => method === "POST" && url.includes("/rest/v1/api_endpoints"),
        respond: (url, init) => {
          const body = JSON.parse(init.body);
          return jsonResponse([{ id: "route-1", ...body }]);
        },
      },
    ]);

    const result = await handlePublisherTool(
      "publish_x402_route",
      {
        name: "Weather API",
        description: "Returns weather data for a city.",
        upstream_url: "https://example.com/api/weather",
        method: "GET",
        path: "/weather",
        price: "0.01",
        network: "base",
        settlement_address: "0x1111111111111111111111111111111111111111",
        tags: ["weather", "data"],
      },
      { token: "sk_live_publish_test" },
      { env: TEST_ENV, fetchImpl }
    );

    assert.equal(result.isError, undefined);
    const route = result.structuredContent;
    assert.equal(route.route_id, "route-1");
    assert.equal(route.paid_url, "https://gw.test/weather-api/weather");
    assert.equal(route.price, "0.01");
    assert.equal(route.currency, "USDC");
    assert.equal(route.network, "base");
    assert.equal(route.status, "pending_review");
    assert.match(route.note, /review/i);

    const listingInsert = calls.find(
      (call) => call.method === "POST" && call.url.includes("/rest/v1/apis")
    );
    const listingBody = JSON.parse(listingInsert.init.body);
    assert.equal(listingBody.owner_id, "owner-1");
    assert.equal(listingBody.slug, "weather-api");
    assert.equal(listingBody.status, "pending");
    assert.equal(listingBody.origin_url, "https://example.com/api");
    assert.equal(listingBody.wallet_address, "0x1111111111111111111111111111111111111111");
    assert.deepEqual(listingBody.listing_metadata.tags, ["weather", "data"]);

    const endpointInsert = calls.find(
      (call) => call.method === "POST" && call.url.includes("/rest/v1/api_endpoints")
    );
    const endpointBody = JSON.parse(endpointInsert.init.body);
    assert.equal(endpointBody.api_id, "api-1");
    assert.equal(endpointBody.method, "GET");
    assert.equal(endpointBody.path, "/weather");
    assert.equal(endpointBody.price, 0.01);
    assert.equal(endpointBody.payment_required, true);
  });

  it("requires a provider token", async () => {
    const result = await handlePublisherTool(
      "publish_x402_route",
      {
        name: "Weather API",
        upstream_url: "https://example.com/api/weather",
        price: "0.01",
        settlement_address: "0x1111111111111111111111111111111111111111",
      },
      null,
      { env: TEST_ENV, fetchImpl: async () => jsonResponse({}) }
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /sk_live_/);
  });

  it("rejects invalid settlement addresses", async () => {
    const { fetchImpl } = scriptedFetch([verifyKeyRule()]);
    const result = await handlePublisherTool(
      "publish_x402_route",
      {
        name: "Weather API",
        upstream_url: "https://example.com/api/weather",
        price: "0.01",
        settlement_address: "not-an-address",
      },
      { token: "sk_live_bad_address" },
      { env: TEST_ENV, fetchImpl }
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /settlement_address/);
  });
});

describe("test_x402_route", () => {
  const routeLookupRule = {
    match: (url, method) => method === "GET" && url.includes("api_endpoints?id=eq.route-1"),
    respond: jsonResponse([
      {
        id: "route-1",
        method: "GET",
        path: "/weather",
        price: 0.01,
        apis: {
          id: "api-1",
          owner_id: "owner-1",
          slug: "weather-api",
          name: "Weather API",
          status: "active",
          wallet_address: "0x1111111111111111111111111111111111111111",
          listing_metadata: { x402_network: "base" },
        },
      },
    ]),
  };

  it("confirms x402 behavior on a 402 with an accepts[] offer", async () => {
    const { fetchImpl } = scriptedFetch([
      verifyKeyRule(),
      routeLookupRule,
      {
        match: (url) => url.startsWith("https://gw.test/weather-api/weather"),
        respond: jsonResponse(
          {
            x402Version: 1,
            accepts: [
              {
                scheme: "eip191",
                network: "base",
                maxAmountRequired: "10000",
                payTo: "0x1111111111111111111111111111111111111111",
                asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
              },
            ],
          },
          402
        ),
      },
    ]);

    const result = await handlePublisherTool(
      "test_x402_route",
      { route_id: "route-1", test_payload: { city: "Amsterdam" } },
      { token: "sk_live_test_route" },
      { env: TEST_ENV, fetchImpl }
    );

    const report = result.structuredContent;
    assert.equal(report.success, true);
    assert.equal(report.http_status, 402);
    assert.equal(report.payment_required, true);
    assert.equal(report.x402_enabled, true);
    assert.equal(report.payment_offer.network, "base");
    assert.equal(report.payment_offer.max_amount_required, "10000");
  });

  it("explains a 404 while the listing is pending review", async () => {
    const pendingLookup = {
      ...routeLookupRule,
      respond: jsonResponse([
        {
          id: "route-1",
          method: "GET",
          path: "/weather",
          price: 0.01,
          apis: {
            id: "api-1",
            owner_id: "owner-1",
            slug: "weather-api",
            name: "Weather API",
            status: "pending",
            wallet_address: "0x1111111111111111111111111111111111111111",
            listing_metadata: {},
          },
        },
      ]),
    };
    const { fetchImpl } = scriptedFetch([
      verifyKeyRule(),
      pendingLookup,
      {
        match: (url) => url.startsWith("https://gw.test/weather-api/weather"),
        respond: jsonResponse({ error: "not found" }, 404),
      },
    ]);

    const result = await handlePublisherTool(
      "test_x402_route",
      { route_id: "route-1" },
      { token: "sk_live_test_pending" },
      { env: TEST_ENV, fetchImpl }
    );

    const report = result.structuredContent;
    assert.equal(report.success, false);
    assert.equal(report.listing_status, "pending_review");
    assert.match(report.hint, /review/i);
  });

  it("refuses to test another provider's route", async () => {
    const { fetchImpl } = scriptedFetch([verifyKeyRule("someone-else"), routeLookupRule]);
    const result = await handlePublisherTool(
      "test_x402_route",
      { route_id: "route-1" },
      { token: "sk_live_wrong_owner" },
      { env: TEST_ENV, fetchImpl }
    );

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /different provider/);
  });
});

describe("openapi + discovery", () => {
  it("builds an OpenAPI 3.1 document with x402 pricing extensions", () => {
    const document = buildOpenApiDocument(
      TEST_ENV,
      {
        slug: "weather-api",
        name: "Weather API",
        description: "Weather data.",
        listing_metadata: { x402_network: "base" },
      },
      [
        {
          method: "GET",
          path: "/weather",
          price: 0.01,
          description: "City weather",
          request_body: { type: "object", properties: { city: { type: "string" } } },
          response_body: { type: "object" },
        },
      ],
      { title: "Weather API", version: "1.0.0" }
    );

    assert.equal(document.openapi, "3.1.0");
    assert.equal(document.info.title, "Weather API");
    assert.equal(document.servers[0].url, "https://gw.test/weather-api");
    const operation = document.paths["/weather"].get;
    assert.equal(operation["x-price"].amount, "0.01");
    assert.equal(operation["x-payment-protocol"], "x402");
    assert.ok(operation.responses[402]);
  });

  it("reshapes the gateway x402 document into discovery routes", () => {
    const routes = reshapeDiscoveryItems(TEST_ENV, {
      x402Version: 1,
      items: [
        {
          resource: "https://gw.test/weather-api/weather",
          x402Version: 1,
          accepts: [
            {
              network: "base",
              maxAmountRequired: "50000",
              payTo: "0xabc0000000000000000000000000000000000000",
            },
          ],
          metadata: {
            api: "weather-api",
            name: "Weather API",
            method: "GET",
            description: "City weather",
          },
        },
      ],
    });

    assert.equal(routes.length, 1);
    assert.equal(routes[0].url, "https://gw.test/weather-api/weather");
    assert.equal(routes[0].price, "0.05");
    assert.equal(routes[0].currency, "USDC");
    assert.equal(routes[0].network, "base");
  });

  it("handles x402 v2 documents (CAIP-2 networks, `amount` field)", () => {
    const routes = reshapeDiscoveryItems(TEST_ENV, {
      x402Version: 2,
      items: [
        {
          resource: "https://gw.test/alpha-vantage/query",
          x402Version: 2,
          accepts: [
            {
              scheme: "exact",
              network: "eip155:8453",
              amount: "60000",
              payTo: "0xabc0000000000000000000000000000000000000",
            },
          ],
          metadata: { name: "Alpha Vantage", method: "GET" },
        },
      ],
    });

    assert.equal(routes[0].price, "0.06");
    assert.equal(routes[0].network, "base");
    assert.equal(routes[0].x402_version, 2);
  });
});

describe("unpublish_x402_route", () => {
  it("disables the listing and warns about shared sibling routes", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      verifyKeyRule(),
      {
        match: (url, method) => method === "GET" && url.includes("api_endpoints?id=eq.route-1"),
        respond: jsonResponse([
          {
            id: "route-1",
            method: "GET",
            path: "/extract",
            price: 0.05,
            apis: {
              id: "api-1",
              owner_id: "owner-1",
              slug: "pdf-tools",
              name: "PDF Tools API",
              status: "active",
              wallet_address: "0x1111111111111111111111111111111111111111",
              listing_metadata: {},
            },
          },
        ]),
      },
      {
        match: (url, method) => method === "PATCH" && url.includes("apis?id=eq.api-1"),
        respond: jsonResponse([
          {
            id: "api-1",
            slug: "pdf-tools",
            status: "inactive",
            api_endpoints: [{ id: "route-1" }, { id: "route-2" }],
          },
        ]),
      },
    ]);

    const result = await handlePublisherTool(
      "unpublish_x402_route",
      { route_id: "route-1" },
      { token: "sk_live_unpublish" },
      { env: TEST_ENV, fetchImpl }
    );

    const report = result.structuredContent;
    assert.equal(report.route_id, "route-1");
    assert.equal(report.status, "disabled");
    assert.match(report.warning, /1 other route/);

    const patch = calls.find((call) => call.method === "PATCH");
    assert.deepEqual(JSON.parse(patch.init.body), { status: "inactive" });
  });
});

describe("update_x402_route status transitions", () => {
  function routeGetRule(apiOverrides) {
    return {
      match: (url, method) => method === "GET" && url.includes("api_endpoints?id=eq.route-1"),
      respond: jsonResponse([
        {
          id: "route-1",
          method: "GET",
          path: "/extract",
          price: 0.05,
          apis: {
            id: "api-1",
            owner_id: "owner-1",
            slug: "pdf-tools",
            name: "PDF Tools API",
            status: "inactive",
            approved_at: null,
            wallet_address: "0x1111111111111111111111111111111111111111",
            listing_metadata: {},
            ...apiOverrides,
          },
        },
      ]),
    };
  }

  // supabaseRest writes with the service-role key, so the provider-only DB
  // trigger does not fire. The publisher must always enforce review itself.
  it("enters review instead of going active", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      verifyKeyRule(),
      routeGetRule({ approved_at: null }),
      {
        match: (url, method) => method === "PATCH" && url.includes("apis?id=eq.api-1"),
        respond: jsonResponse([{ id: "api-1", slug: "pdf-tools", status: "pending" }]),
      },
    ]);

    await handlePublisherTool(
      "update_x402_route",
      { route_id: "route-1", status: "active" },
      { token: "sk_live_update" },
      { env: TEST_ENV, fetchImpl }
    );

    const patch = calls.find((call) => call.method === "PATCH" && call.url.includes("apis?id=eq.api-1"));
    assert.deepEqual(JSON.parse(patch.init.body), { status: "pending" });
  });

  it("re-enters review even when the listing was approved before", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      verifyKeyRule(),
      routeGetRule({ approved_at: "2026-06-01T00:00:00Z" }),
      {
        match: (url, method) => method === "PATCH" && url.includes("apis?id=eq.api-1"),
        respond: jsonResponse([{ id: "api-1", slug: "pdf-tools", status: "pending" }]),
      },
    ]);

    await handlePublisherTool(
      "update_x402_route",
      { route_id: "route-1", status: "active" },
      { token: "sk_live_update" },
      { env: TEST_ENV, fetchImpl }
    );

    const patch = calls.find((call) => call.method === "PATCH" && call.url.includes("apis?id=eq.api-1"));
    assert.deepEqual(JSON.parse(patch.init.body), { status: "pending" });
  });
});

describe("publish_project", () => {
  it("creates one listing with a route per project entry", async () => {
    const { fetchImpl } = scriptedFetch([
      verifyKeyRule(),
      {
        match: (url, method) => method === "GET" && url.includes("apis?slug=eq.pdf-tools-api"),
        respond: jsonResponse([]),
      },
      {
        match: (url, method) => method === "POST" && url.includes("/rest/v1/apis"),
        respond: (url, init) => jsonResponse([{ id: "proj-api-1", ...JSON.parse(init.body) }]),
      },
      {
        match: (url, method) => method === "GET" && url.includes("api_endpoints?api_id=eq.proj-api-1"),
        respond: jsonResponse([]),
      },
      {
        match: (url, method) => method === "POST" && url.includes("/rest/v1/api_endpoints"),
        respond: (url, init) => {
          const body = JSON.parse(init.body);
          return jsonResponse([{ id: `route-${body.path.replaceAll("/", "")}`, ...body }]);
        },
      },
    ]);

    const result = await handlePublisherTool(
      "publish_project",
      {
        project_name: "PDF Tools API",
        base_url: "https://example.com/api",
        settlement_address: "0x1111111111111111111111111111111111111111",
        routes: [
          { name: "Extract PDF Text", path: "/extract", method: "POST", price: "0.05" },
          { name: "Merge PDFs", path: "/merge", method: "POST", price: "0.10" },
        ],
      },
      { token: "sk_live_project" },
      { env: TEST_ENV, fetchImpl }
    );

    const report = result.structuredContent;
    assert.equal(report.project_id, "proj-api-1");
    assert.equal(report.routes_created, 2);
    assert.equal(report.routes[0].paid_url, "https://gw.test/pdf-tools-api/extract");
    assert.equal(report.routes[1].paid_url, "https://gw.test/pdf-tools-api/merge");
    assert.equal(report.status, "pending_review");
  });
});
