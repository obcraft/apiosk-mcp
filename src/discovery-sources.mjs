// The x402 ecosystem, as discovery sources.
//
// Discovery is a search engine, not a shop window: the point is to sweep the
// wider x402 ecosystem alongside the Apiosk catalogue, so an agent sees the
// providers no single vendor's directory lists. This module owns that sweep —
// the Bazaar, the public directories, the manifest sources and the explicit
// /.well-known probe — and nothing else.
//
// Every source is isolated: one failing or slow index never delays or breaks
// the others, and a source that fails repeatedly is skipped for a cooldown.

import {
  CACHE_MAX_ENTRIES,
  EXTERNAL_EXECUTION_NOTE,
  atomicToUsdc,
  normalizeNetworkName,
  parseUsdPrice,
  sanitizeText,
  searchCache,
  trimString,
} from "./discovery-text.mjs";



// Live discovery sources this build can actually query. Verified endpoints (see
// gateway/config/x402-sources.json). All of them are free reads: a discovery
// call never spends, whichever sources it is given. Unknown source names degrade
// to a warning rather than an error, so a client naming a source this build does
// not have still gets results.
export const IMPLEMENTED_SOURCES = new Set([
  "apiosk",
  "bazaar",
  "x402-list",
  "x402-direct",
  "agentic-market",
  "thirdweb",
  "payai",
  "x402engine",
  "anchor-x402",
  "wellknown",
]);
// `sources: ["all"]` fans out to every keyword-searchable index. Not wellknown:
// that one needs explicit probe_hosts.
export const ALL_WIREABLE_SOURCES = [
  "apiosk",
  "bazaar",
  "x402-list",
  "x402-direct",
  "agentic-market",
  "thirdweb",
  "payai",
  "x402engine",
  "anchor-x402",
];
// Default: query every live source (Apiosk catalog + the live Coinbase Bazaar),
// so the agent finds external x402 endpoints without having to remember to ask
// for them. `wellknown` is not defaulted — it needs explicit `probe_hosts`.
// Bazaar is resilient (per-source timeout + cache + circuit breaker), so if it's
// slow/down, discovery degrades to catalog results with a warning.
export const DEFAULT_SOURCES = ["apiosk", "bazaar"];

// Coinbase x402 Bazaar public discovery API (no auth for search).
const CDP_BAZAAR_SEARCH_URL = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
const EXTERNAL_SOURCE_TIMEOUT_MS = 4000;
const EXTERNAL_CACHE_TTL_MS = 15 * 60_000;
const CIRCUIT_FAILURE_THRESHOLD = 3;
const CIRCUIT_COOLDOWN_MS = 10 * 60_000;

// Per-source circuit breaker: after N consecutive failures, skip the source for
// a cooldown so a flaky/slow external index doesn't drag every discovery call.
const circuitState = new Map();

function circuitOpen(source, now) {
  const c = circuitState.get(source);
  return Boolean(c && c.openUntil > now);
}
function recordSourceFailure(source, now) {
  const c = circuitState.get(source) || { failures: 0, openUntil: 0 };
  c.failures += 1;
  if (c.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    c.openUntil = now + CIRCUIT_COOLDOWN_MS;
    c.failures = 0;
  }
  circuitState.set(source, c);
}
function recordSourceSuccess(source) {
  circuitState.set(source, { failures: 0, openUntil: 0 });
}

export function clearDiscoveryCircuit() {
  circuitState.clear();
}

async function fetchJsonWithTimeout(url, { fetchImpl, timeoutMs, headers } = {}) {
  const impl = fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || EXTERNAL_SOURCE_TIMEOUT_MS);
  try {
    const response = await impl(url, {
      signal: controller.signal,
      headers: { accept: "application/json", ...(headers || {}) },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

// Extract the payment terms (url + first offer) from an external x402 discovery
// row, whether it came from the CDP Bazaar or a raw /.well-known/x402 document.
function normalizeExternalRow(row, source, trustTier) {
  const url = trimString(row?.resource || row?.url);
  if (!url) return null;
  const accepts = Array.isArray(row?.accepts) ? row.accepts : [];
  // Prefer Base: it is the network Apiosk settles on.
  // Several mirrors put Solana first even when a Base offer is also present.
  const offer = accepts.find((entry) => normalizeNetworkName(entry?.network) === "base") || accepts[0] || {};
  const meta = row?.metadata || {};
  const name = sanitizeText(meta.serviceName || meta.name || row?.name || url, 120);
  return {
    id: `${source}:${url}`,
    source,
    trust_tier: trustTier,
    external: true,
    executable_via: null,
    execution_note: EXTERNAL_EXECUTION_NOTE,
    url,
    method: trimString(row?.method || meta.method) || "GET",
    name,
    description: sanitizeText(row?.description || meta.description || ""),
    category: sanitizeText(meta.category || "", 60) || null,
    tags: Array.isArray(meta.tags) ? meta.tags.map((t) => sanitizeText(t, 40)).filter(Boolean) : [],
    price_usdc: atomicToUsdc(offer.amount ?? offer.maxAmountRequired ?? offer.max_amount_required),
    asset: offer.asset ? sanitizeText(offer.asset, 80) : "USDC",
    network: normalizeNetworkName(offer.network) || "base",
    pay_to: (offer.payTo || offer.pay_to) ? sanitizeText(offer.payTo || offer.pay_to, 80) : null,
    docs_url: trimString(meta.docsUrl || meta.docs_url) || null,
    listing_quality: "production",
  };
}

function externalRowsFrom(doc) {
  if (Array.isArray(doc?.resources)) return doc.resources;
  if (Array.isArray(doc?.items)) return doc.items;
  return [];
}

// Coinbase x402 Bazaar (live). One search over the raw query — the Bazaar has a
// real search index (unlike the catalog's ILIKE), so the phrase is fine.
export async function fetchBazaarCandidates(query, { fetchImpl, now, maxResults }) {
  if (circuitOpen("bazaar", now)) return { items: [], warnings: ["Bazaar temporarily skipped (circuit open after repeated failures)."] };
  const cacheKey = `bazaar:${query}`;
  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return { items: hit.items, warnings: [] };

  const url = `${CDP_BAZAAR_SEARCH_URL}?limit=${Math.min(20, maxResults * 2)}&query=${encodeURIComponent(query)}`;
  try {
    const doc = await fetchJsonWithTimeout(url, { fetchImpl, timeoutMs: EXTERNAL_SOURCE_TIMEOUT_MS });
    const items = externalRowsFrom(doc)
      .map((row) => normalizeExternalRow(row, "bazaar", "bazaar"))
      .filter(Boolean);
    recordSourceSuccess("bazaar");
    if (searchCache.size >= CACHE_MAX_ENTRIES) searchCache.clear();
    searchCache.set(cacheKey, { items, expiresAt: now + EXTERNAL_CACHE_TTL_MS });
    return { items, warnings: [] };
  } catch (error) {
    recordSourceFailure("bazaar", now);
    return { items: [], warnings: [`Bazaar search failed: ${trimString(error?.message || error)}`] };
  }
}

// Build a unified external item from a directory row (no accepts[] — the model
// price is whatever the provider's own 402 says at call time).
function makeExternalItem({ source, tier, url, name, description, priceUsdc, network, category, payTo }) {
  const u = trimString(url);
  if (!u) return null;
  return {
    id: `${source}:${u}`,
    source,
    trust_tier: tier,
    external: true,
    executable_via: null,
    execution_note: EXTERNAL_EXECUTION_NOTE,
    url: u,
    method: "GET",
    name: sanitizeText(name || u, 120),
    description: sanitizeText(description || ""),
    category: category ? sanitizeText(category, 60) : null,
    tags: [],
    price_usdc: Number.isFinite(priceUsdc) ? priceUsdc : null,
    asset: "USDC",
    network: normalizeNetworkName(network) || "base",
    pay_to: payTo ? sanitizeText(payTo, 80) : null,
    docs_url: null,
    listing_quality: "production",
  };
}

// Verified free-REST directory sources (gateway/config/x402-sources.json). Each
// is a keyless GET returning a service directory; we normalize into the unified
// item shape. These carry no payTo/accepts, so results point the model to the
// provider's own 402 for live terms.
export const DIRECTORY_SOURCES = {
  "x402-list": {
    tier: "x402list",
    urlFor: (q) => `https://x402-list.com/api/v1/services?per_page=25${q ? `&q=${encodeURIComponent(q)}` : ""}`,
    rows: (doc) => (Array.isArray(doc?.data) ? doc.data : []),
    normalize: (r) =>
      makeExternalItem({
        source: "x402-list",
        tier: "x402list",
        url: r?.base_url,
        name: r?.name,
        description: r?.description,
        priceUsdc: parseUsdPrice(r?.min_price_usd),
        network: Array.isArray(r?.networks_caip2) ? r.networks_caip2[0] : r?.networks?.[0],
        category: r?.category,
      }),
  },
  "x402-direct": {
    tier: "x402direct",
    urlFor: () => `https://x402.direct/api/services?limit=25&sort=score`,
    rows: (doc) => (Array.isArray(doc?.services) ? doc.services : []),
    normalize: (r) =>
      makeExternalItem({
        source: "x402-direct",
        tier: "x402direct",
        url: r?.resourceUrl,
        name: r?.provider || r?.description,
        description: r?.description,
        priceUsdc: parseUsdPrice(r?.priceUsd),
        network: r?.network,
        category: r?.category,
      }),
  },
  "agentic-market": {
    tier: "agentic",
    urlFor: (q) =>
      q
        ? `https://api.agentic.market/v1/services/search?q=${encodeURIComponent(q)}`
        : `https://api.agentic.market/v1/services`,
    rows: (doc) => (Array.isArray(doc?.services) ? doc.services : []),
    normalize: (r) => {
      const ep = Array.isArray(r?.endpoints) ? r.endpoints[0] : null;
      const price = r?.priceSummary?.avgCostPerTransaction ?? ep?.pricing?.amount;
      return makeExternalItem({
        source: "agentic-market",
        tier: "agentic",
        url: ep?.url,
        name: r?.name,
        description: r?.description,
        priceUsdc: parseUsdPrice(price),
        network: ep?.pricing?.network,
        category: r?.category,
      });
    },
  },
  thirdweb: {
    tier: "thirdweb",
    urlFor: (q) =>
      `https://api.thirdweb.com/v1/payments/x402/discovery/resources?limit=25${q ? `&query=${encodeURIComponent(q)}` : ""}`,
    rows: (doc) => (Array.isArray(doc?.items) ? doc.items : []),
    normalize: (r) => normalizeExternalRow(r, "thirdweb", "thirdweb"),
  },
  payai: {
    tier: "payai",
    urlFor: () => "https://facilitator.payai.network/discovery/resources?limit=100",
    rows: (doc) => (Array.isArray(doc?.items) ? doc.items : []),
    normalize: (r) => normalizeExternalRow(r, "payai", "payai"),
  },
};

export const MANIFEST_SOURCES = {
  x402engine: {
    tier: "x402engine",
    url: "https://x402engine.app/.well-known/x402.json",
    rows(doc) {
      const routes = doc?.routes && typeof doc.routes === "object" ? doc.routes : {};
      return (Array.isArray(doc?.services) ? doc.services : []).map((service) => {
        let path = "";
        try {
          path = new URL(service?.endpoint).pathname;
        } catch {
          path = "";
        }
        const method = trimString(service?.method).toUpperCase() || "GET";
        const route = routes[`${method} ${path}`] || {};
        return {
          resource: service?.endpoint,
          method,
          description: service?.description || route?.description,
          metadata: { serviceName: service?.name, category: service?.category },
          accepts: Array.isArray(route?.accepts) ? route.accepts : [],
        };
      });
    },
    normalize: (r) => normalizeExternalRow(r, "x402engine", "x402engine"),
  },
  "anchor-x402": {
    tier: "anchor",
    url: "https://api.anchor-x402.com/.well-known/x402",
    rows(doc) {
      const baseUrl = trimString(doc?.base_url) || "https://api.anchor-x402.com";
      const networks = Array.isArray(doc?.networks) ? doc.networks : [];
      const base = networks.find((network) => normalizeNetworkName(network?.id) === "base") || networks[0] || {};
      return (Array.isArray(doc?.routes) ? doc.routes : []).map((route) => ({
        resource: `${baseUrl.replace(/\/+$/, "")}/${trimString(route?.path).replace(/^\/+/, "")}`,
        method: route?.method,
        description: route?.description,
        metadata: { serviceName: route?.name || `anchor-x402 ${route?.path}`, category: route?.category, tags: route?.tags },
        accepts: [{
          scheme: "exact",
          network: base?.id,
          amount: Number.isFinite(route?.price_usd) ? String(Math.round(route.price_usd * 1_000_000)) : null,
          asset: base?.asset,
          payTo: base?.payment_address,
        }],
      }));
    },
    normalize: (r) => normalizeExternalRow(r, "anchor-x402", "anchor"),
  },
};

// Query one free-REST directory source (resilient: circuit breaker + cache +
// timeout, exactly like the Bazaar fetcher).
export async function fetchDirectorySource(sourceId, query, { fetchImpl, now }) {
  const cfg = DIRECTORY_SOURCES[sourceId];
  if (!cfg) return { items: [], warnings: [] };
  if (circuitOpen(sourceId, now)) {
    return { items: [], warnings: [`${sourceId} temporarily skipped (circuit open).`] };
  }
  const cacheKey = `${sourceId}:${query}`;
  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return { items: hit.items, warnings: [] };

  try {
    const doc = await fetchJsonWithTimeout(cfg.urlFor(query), { fetchImpl, timeoutMs: EXTERNAL_SOURCE_TIMEOUT_MS });
    const items = cfg.rows(doc).map((row) => cfg.normalize(row)).filter(Boolean);
    recordSourceSuccess(sourceId);
    if (searchCache.size >= CACHE_MAX_ENTRIES) searchCache.clear();
    searchCache.set(cacheKey, { items, expiresAt: now + EXTERNAL_CACHE_TTL_MS });
    return { items, warnings: [] };
  } catch (error) {
    recordSourceFailure(sourceId, now);
    return { items: [], warnings: [`${sourceId} search failed: ${trimString(error?.message || error)}`] };
  }
}

export async function fetchManifestSource(sourceId, { fetchImpl, now }) {
  const cfg = MANIFEST_SOURCES[sourceId];
  if (!cfg) return { items: [], warnings: [] };
  if (circuitOpen(sourceId, now)) {
    return { items: [], warnings: [`${sourceId} temporarily skipped (circuit open).`] };
  }
  const cacheKey = `${sourceId}:manifest`;
  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return { items: hit.items, warnings: [] };

  try {
    const doc = await fetchJsonWithTimeout(cfg.url, { fetchImpl, timeoutMs: EXTERNAL_SOURCE_TIMEOUT_MS });
    const items = cfg.rows(doc).map((row) => cfg.normalize(row)).filter(Boolean);
    recordSourceSuccess(sourceId);
    if (searchCache.size >= CACHE_MAX_ENTRIES) searchCache.clear();
    searchCache.set(cacheKey, { items, expiresAt: now + EXTERNAL_CACHE_TTL_MS });
    return { items, warnings: [] };
  } catch (error) {
    recordSourceFailure(sourceId, now);
    return { items: [], warnings: [`${sourceId} manifest failed: ${trimString(error?.message || error)}`] };
  }
}

// Generic /.well-known probing — ONLY for hosts the caller explicitly names, so
// we never speculatively crawl. Tries /.well-known/x402 then the .json alias.
export async function probeWellKnownHost(host, { fetchImpl, now }) {
  const cleanHost = trimString(host).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!cleanHost || cleanHost === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.)/.test(cleanHost)) {
    return { items: [], warnings: [`Refused to probe host "${host}".`] };
  }
  const cacheKey = `wellknown:${cleanHost}`;
  const hit = searchCache.get(cacheKey);
  if (hit && hit.expiresAt > now) return { items: hit.items, warnings: [] };

  for (const path of ["/.well-known/x402", "/.well-known/x402.json"]) {
    try {
      const doc = await fetchJsonWithTimeout(`https://${cleanHost}${path}`, { fetchImpl, timeoutMs: EXTERNAL_SOURCE_TIMEOUT_MS });
      const items = externalRowsFrom(doc)
        .map((row) => normalizeExternalRow(row, "wellknown", "wellknown_probe"))
        .filter(Boolean);
      if (items.length) {
        if (searchCache.size >= CACHE_MAX_ENTRIES) searchCache.clear();
        searchCache.set(cacheKey, { items, expiresAt: now + EXTERNAL_CACHE_TTL_MS });
        return { items, warnings: [] };
      }
    } catch {
      // try next path
    }
  }
  return { items: [], warnings: [`No x402 discovery document found at ${cleanHost}.`] };
}
