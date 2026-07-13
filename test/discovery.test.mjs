import test from "node:test";
import assert from "node:assert/strict";

import {
  runDiscover,
  normalizeApioskItem,
  tokenize,
  scoreItem,
  clearDiscoveryCache,
  clearDiscoveryCircuit,
  DISCOVER_TOOL,
} from "../src/discovery.mjs";

const FX_CATALOG = [
  {
    slug: "frankfurter",
    name: "Frankfurter FX",
    description: "Free foreign exchange rates and currency conversion for EUR, USD, GBP.",
    category: "finance",
    listing_type: "api",
    price_usd: 0.02,
    gateway_url: "https://gateway.apiosk.com/frankfurter",
    operations: [{ method: "GET", path: "/latest" }],
    listing_metadata: { tags: ["fx", "currency", "exchange"] },
    listing_quality: "production",
    hosted_externally: false,
  },
  {
    slug: "twelve-data",
    name: "Twelve Data",
    description: "Real-time and historical stock, forex, and crypto market data with exchange rate endpoints.",
    category: "finance",
    listing_type: "api",
    price_usd: 0.03,
    gateway_url: "https://gateway.apiosk.com/twelve-data",
    operations: [{ method: "GET", path: "/exchange_rate" }],
    listing_metadata: { tags: ["forex", "exchange rate", "stocks"] },
    listing_quality: "production",
    hosted_externally: false,
  },
  {
    slug: "open-meteo",
    name: "Open-Meteo Weather",
    description: "Weather forecast and historical weather data.",
    category: "weather",
    listing_type: "api",
    price_usd: 0.02,
    gateway_url: "https://gateway.apiosk.com/open-meteo",
    operations: [{ method: "GET", path: "/forecast" }],
    listing_metadata: { tags: ["weather", "forecast"] },
    listing_quality: "production",
    hosted_externally: false,
  },
  {
    slug: "ext-fx-oracle",
    name: "External FX Oracle",
    description: "Federated exchange rate oracle paid directly at the provider.",
    category: "finance",
    listing_type: "federated",
    price_usd: 0.05,
    hosted_externally: true,
    external_resources: [
      {
        resource: "https://fx.example.com/usd",
        method: "GET",
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "50000",
            asset: "0xUSDC",
            payTo: "0xProviderWallet",
          },
        ],
      },
    ],
    listing_metadata: { tags: ["fx", "exchange", "oracle"] },
    listing_quality: "production",
  },
];

function makeListApis(catalog) {
  return async ({ search }) => {
    const q = String(search || "").toLowerCase();
    const apis = catalog.filter((a) => {
      const hay = [
        a.slug,
        a.name,
        a.description,
        a.category,
        (a.listing_metadata?.tags || []).join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
    return { apis, meta: { total: apis.length } };
  };
}

test("tokenize drops stopwords and short noise", () => {
  assert.deepEqual(
    tokenize("Build an HTML canvas of the realtime USD exchange rate"),
    ["html", "canvas", "usd", "exchange", "rate"]
  );
});

test("discover ranks FX endpoints first and excludes unrelated weather", async () => {
  clearDiscoveryCache();
  const res = await runDiscover(
    { query: "realtime USD exchange rate", segments: ["exchange rate", "currency conversion"], sources: ["apiosk"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  const slugs = payload.results.map((r) => r.listing_slug);
  assert.ok(slugs.includes("frankfurter"), "frankfurter present");
  assert.ok(slugs.includes("twelve-data"), "twelve-data present");
  assert.ok(!slugs.includes("open-meteo"), "weather excluded");
  assert.equal(payload.results[0].trust_tier, "apiosk_verified");
});

test("discover normalizes federated externals with url + payTo + fetch_paid routing", async () => {
  clearDiscoveryCache();
  const res = await runDiscover(
    { query: "exchange rate oracle", sources: ["apiosk"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  const ext = payload.results.find((r) => r.listing_slug === "ext-fx-oracle");
  assert.ok(ext, "federated listing surfaced");
  assert.equal(ext.external, true);
  assert.equal(ext.executable_via, "apiosk_fetch_paid");
  assert.equal(ext.trust_tier, "apiosk_federated");
  assert.equal(ext.url, "https://fx.example.com/usd");
  assert.equal(ext.pay_to, "0xProviderWallet");
  assert.equal(ext.network, "base");
});

test("normalizeApioskItem builds gateway url from base when gateway_url is blank", () => {
  const item = normalizeApioskItem(
    { slug: "demo", name: "Demo", description: "d", listing_type: "api", price_usd: 0.01 },
    { gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  assert.equal(item.url, "https://gateway.apiosk.com/demo");
  assert.equal(item.executable_via, "apiosk_execute");
});

test("discover enforces max_price_usdc ceiling", async () => {
  clearDiscoveryCache();
  const res = await runDiscover(
    { query: "exchange rate", max_price_usdc: 0.02, sources: ["apiosk"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.ok(
    payload.results.every((r) => r.price_usdc === null || r.price_usdc <= 0.02),
    "no result above the price ceiling"
  );
  assert.ok(!payload.results.some((r) => r.listing_slug === "twelve-data"), "0.03 dropped");
});

test("discover flags only genuinely unimplemented sources without failing", async () => {
  clearDiscoveryCache();
  const res = await runDiscover(
    { query: "exchange rate", sources: ["x402scan", "x402list"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.deepEqual(payload.sources_unavailable, ["x402list"]);
  assert.ok(payload.sources_queried.includes("x402scan"), "paid x402scan source is now wired");
  assert.ok(payload.sources_queried.includes("apiosk"), "apiosk always queried");
  assert.ok(payload.results.length > 0, "still returns catalog results");
});

test("source-name discovery returns direct source metadata and a paid x402scan search pointer", async () => {
  clearDiscoveryCache();
  const res = await runDiscover(
    { query: "x402scan", sources: ["x402scan"], max_results: 5 },
    { listApis: makeListApis([]), gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.equal(payload.sources_unavailable.length, 0);
  assert.equal(payload.source_matches[0].id, "x402scan");
  const paid = payload.results.find((result) => result.source === "x402scan");
  assert.ok(paid, "paid search endpoint is returned even without a catalog listing");
  assert.equal(paid.result_kind, "paid_source_endpoint");
  assert.equal(paid.price_usdc, 0.02);
  assert.match(paid.url, /resources\/search\?q=x402scan/);
  assert.equal(paid.executable_via, "apiosk_fetch_paid");
  assert.equal(paid.price_must_be_inspected_live, true);
});

test("discover directly normalizes thirdweb, PayAI, x402engine, and anchor manifests", async () => {
  clearDiscoveryCache();
  clearDiscoveryCircuit();
  const offer = { scheme: "exact", network: "eip155:8453", amount: "5000", asset: "0xUSDC", payTo: "0xPay" };
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.includes("thirdweb.com")) {
      return { ok: true, status: 200, json: async () => ({ items: [{ resource: "https://third.example/weather", description: "weather", accepts: [offer] }] }) };
    }
    if (target.includes("payai.network")) {
      return { ok: true, status: 200, json: async () => ({ items: [{ resource: "https://payai.example/weather", description: "weather", accepts: [offer] }] }) };
    }
    if (target.includes("x402engine.app")) {
      return { ok: true, status: 200, json: async () => ({
        services: [{ name: "Engine Weather", description: "weather", endpoint: "https://engine.example/api/weather", method: "POST", category: "weather" }],
        routes: { "POST /api/weather": { description: "weather", accepts: [offer] } },
      }) };
    }
    if (target.includes("anchor-x402.com")) {
      return { ok: true, status: 200, json: async () => ({
        base_url: "https://api.anchor-x402.com",
        networks: [{ id: "eip155:8453", asset: "0xUSDC", payment_address: "0xAnchor" }],
        routes: [{ path: "/v1/weather", method: "POST", price_usd: 0.007, category: "weather", description: "weather anchor" }],
      }) };
    }
    throw new Error(`unexpected ${target}`);
  };
  const res = await runDiscover(
    { query: "weather", sources: ["thirdweb", "payai", "x402engine", "anchor-x402"], max_results: 25 },
    { listApis: makeListApis([]), gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl }
  );
  const payload = JSON.parse(res.content[0].text);
  for (const source of ["thirdweb", "payai", "x402engine", "anchor-x402"]) {
    assert.ok(payload.results.some((result) => result.source === source), `${source} result present`);
  }
  assert.equal(payload.results.find((result) => result.source === "anchor-x402").price_usdc, 0.007);
});

test("discover queries the Bazaar by default (no sources needed)", async () => {
  clearDiscoveryCache();
  clearDiscoveryCircuit();
  let bazaarHit = false;
  const bazaarFetch = async (url) => {
    bazaarHit = true;
    assert.match(String(url), /x402\/discovery\/search/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        resources: [
          {
            resource: "https://weather.example.com/now",
            description: "External weather feed",
            metadata: { serviceName: "Weather X" },
            accepts: [{ scheme: "exact", network: "base", amount: "3000", asset: "0xUSDC", payTo: "0xW" }],
          },
        ],
      }),
    };
  };
  // No `sources` passed → the default must include the live Bazaar.
  const res = await runDiscover(
    { query: "weather forecast" },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl: bazaarFetch }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.ok(bazaarHit, "Bazaar was queried without an explicit sources arg");
  assert.ok(payload.sources_queried.includes("bazaar"), "bazaar reported as queried by default");
  assert.ok(payload.results.some((r) => r.source === "bazaar"), "external Bazaar result merged in");
});

test("discover queries the Bazaar live source and merges external results", async () => {
  clearDiscoveryCache();
  clearDiscoveryCircuit();
  const bazaarFetch = async (url) => {
    assert.match(String(url), /x402\/discovery\/search/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        resources: [
          {
            resource: "https://bazaar-fx.example.com/usd",
            description: "Bazaar-listed USD exchange rate feed",
            metadata: { serviceName: "Bazaar FX", method: "GET" },
            accepts: [{ scheme: "exact", network: "base", amount: "10000", asset: "0xUSDC", payTo: "0xBazaarProv" }],
          },
        ],
      }),
    };
  };
  const res = await runDiscover(
    { query: "USD exchange rate", sources: ["apiosk", "bazaar"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl: bazaarFetch }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.sources_queried.includes("bazaar"));
  const b = payload.results.find((r) => r.source === "bazaar");
  assert.ok(b, "bazaar result merged in");
  assert.equal(b.trust_tier, "bazaar");
  assert.equal(b.executable_via, "apiosk_fetch_paid");
  assert.equal(b.url, "https://bazaar-fx.example.com/usd");
  assert.equal(b.pay_to, "0xBazaarProv");
  assert.equal(b.price_usdc, 0.01);
});

test("discover isolates a failing Bazaar source (catalog still returned)", async () => {
  clearDiscoveryCache();
  clearDiscoveryCircuit();
  const failingFetch = async () => {
    throw new Error("bazaar down");
  };
  const res = await runDiscover(
    { query: "exchange rate", sources: ["apiosk", "bazaar"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl: failingFetch }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.ok(payload.results.some((r) => r.source === "apiosk"), "catalog results survive a Bazaar failure");
  assert.ok(payload.warnings.some((w) => /Bazaar/.test(w)), "records a Bazaar warning");
});

test("sources:['all'] fans out to the free directory sources and normalizes each shape", async () => {
  clearDiscoveryCache();
  clearDiscoveryCircuit();
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes("x402-list.com")) {
      return { ok: true, status: 200, json: async () => ({ data: [{ name: "WeatherX", description: "weather", base_url: "https://wx.example.com", category: "weather", min_price_usd: 0.004, networks_caip2: ["eip155:8453"] }] }) };
    }
    if (u.includes("x402.direct")) {
      return { ok: true, status: 200, json: async () => ({ services: [{ resourceUrl: "https://d.example.com/w", provider: "DirectW", description: "weather", network: "base", priceUsd: "$0.006" }] }) };
    }
    if (u.includes("agentic.market")) {
      return { ok: true, status: 200, json: async () => ({ services: [{ name: "AgenticW", description: "weather", priceSummary: { avgCostPerTransaction: 0.008 }, endpoints: [{ url: "https://a.example.com/w", pricing: { amount: 0.008, network: "eip155:8453" } }] }] }) };
    }
    throw new Error(`unexpected ${u}`); // bazaar stub throws → resilient, no items
  };
  const res = await runDiscover(
    { query: "weather", sources: ["all"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl }
  );
  const payload = JSON.parse(res.content[0].text);
  for (const s of ["apiosk", "bazaar", "x402-list", "x402-direct", "agentic-market"]) {
    assert.ok(payload.sources_queried.includes(s), `all → queried ${s}`);
  }
  const bySource = Object.fromEntries(payload.results.map((r) => [r.source, r]));
  assert.equal(bySource["x402-list"].url, "https://wx.example.com");
  assert.equal(bySource["x402-list"].price_usdc, 0.004);
  assert.equal(bySource["x402-direct"].url, "https://d.example.com/w");
  assert.equal(bySource["x402-direct"].price_usdc, 0.006);
  assert.equal(bySource["agentic-market"].url, "https://a.example.com/w");
  assert.ok(payload.results.every((r) => !r.external || r.executable_via === "apiosk_fetch_paid"));
});

test("wellknown source needs probe_hosts and probes only named hosts", async () => {
  clearDiscoveryCache();
  clearDiscoveryCircuit();
  const wkFetch = async (url) => {
    assert.match(String(url), /^https:\/\/x402\.example\.com\/\.well-known\/x402/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        resources: [
          {
            resource: "https://x402.example.com/rate",
            description: "well-known FX",
            accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "5000", payTo: "0xWK" }],
          },
        ],
      }),
    };
  };
  const res = await runDiscover(
    { query: "rate", sources: ["apiosk", "wellknown"], probe_hosts: ["x402.example.com"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com", fetchImpl: wkFetch }
  );
  const payload = JSON.parse(res.content[0].text);
  const wk = payload.results.find((r) => r.source === "wellknown");
  assert.ok(wk, "well-known result present");
  assert.equal(wk.trust_tier, "wellknown_probe");
  assert.equal(wk.pay_to, "0xWK");
});

test("discover requires a query", async () => {
  const res = await runDiscover({}, { listApis: makeListApis(FX_CATALOG) });
  assert.equal(res.isError, true);
});

test("discover result carries the untrusted-text guardrail", async () => {
  clearDiscoveryCache();
  const res = await runDiscover(
    { query: "exchange rate", sources: ["apiosk"] },
    { listApis: makeListApis(FX_CATALOG), gatewayBaseUrl: "https://gateway.apiosk.com" }
  );
  const payload = JSON.parse(res.content[0].text);
  assert.match(payload.untrusted_provider_text, /not instructions/i);
});

test("scoreItem gives a floor of 1 to server-matched items", () => {
  const item = { name: "x", description: "", category: "", tags: [], listing_slug: "x" };
  assert.equal(scoreItem(item, ["zzz"]), 1);
});

test("DISCOVER_TOOL declares a required query and read-only annotations", () => {
  assert.equal(DISCOVER_TOOL.name, "apiosk_discover");
  assert.deepEqual(DISCOVER_TOOL.inputSchema.required, ["query"]);
  assert.equal(DISCOVER_TOOL.annotations.readOnlyHint, true);
});
