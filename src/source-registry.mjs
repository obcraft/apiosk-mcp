// Curated x402 discovery-source registry.
//
// These are discovery systems themselves, not Apiosk catalog listings. Keeping
// them in the MCP means `apiosk_search({search: "x402scan"})` can return the
// source and its callable endpoints directly even when GET /v1/apis has no API
// listing with that name. Paid endpoints are described, never called here.

const SOURCES = [
  {
    id: "coinbase-bazaar",
    name: "Coinbase x402 Bazaar",
    aliases: ["bazaar", "cdp bazaar", "coinbase discovery"],
    discover_source: "bazaar",
    layer: "discovery",
    summary: "Public x402 resource index used by Coinbase CDP.",
    cost: "free",
    wire_method: "free-rest",
    endpoints: [
      { role: "list", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources", payment_required: false },
      { role: "search", url_template: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?query={query}", payment_required: false },
      { role: "mcp", url: "https://api.cdp.coinbase.com/platform/v2/x402/discovery/mcp", payment_required: false },
    ],
  },
  {
    id: "x402-list",
    name: "x402-list.com",
    aliases: ["x402 list", "x402-list.com"],
    discover_source: "x402-list",
    layer: "discovery",
    summary: "Service-level public x402 directory; resource offers need a live 402 inspection.",
    cost: "2,000 free GET requests per IP/day, then $0.01 per request",
    wire_method: "free-rest-metered",
    endpoints: [
      { role: "search", url_template: "https://x402-list.com/api/v1/services?q={query}", payment_required: false, may_become_paid: true },
      { role: "mcp", url: "https://mcp.x402-list.com/mcp", payment_required: false },
    ],
  },
  {
    id: "x402-direct",
    name: "x402.direct",
    aliases: ["x402 direct", "x402.direct"],
    discover_source: "x402-direct",
    layer: "discovery",
    summary: "x402 service directory with crawler-derived trust scores.",
    cost: "free list; paid search costs $0.001",
    wire_method: "free-rest-plus-paid-search",
    endpoints: [
      { role: "list", url: "https://x402.direct/api/services?limit=25&sort=score", payment_required: false },
      { role: "search", url_template: "https://x402.direct/api/search?q={query}", payment_required: true, price_usdc: 0.001, executable_via: "apiosk_inspect_x402_then_apiosk_fetch_paid" },
    ],
  },
  {
    id: "agentic-market",
    name: "Agentic.Market",
    aliases: ["agentic market", "coinbase agentic market"],
    discover_source: "agentic-market",
    layer: "discovery",
    summary: "Public Coinbase Agentic.Market service directory.",
    cost: "free",
    wire_method: "free-rest",
    endpoints: [
      { role: "search", url_template: "https://api.agentic.market/v1/services/search?q={query}", payment_required: false },
      { role: "list", url: "https://api.agentic.market/v1/services", payment_required: false },
    ],
  },
  {
    id: "thirdweb",
    name: "thirdweb Payments x402 discovery",
    aliases: ["thirdweb discovery", "thirdweb payments", "thirdweb facilitator"],
    discover_source: "thirdweb",
    layer: "aggregator",
    summary: "Public thirdweb x402 discovery index; execution requires provider-specific payment/auth.",
    cost: "free discovery",
    wire_method: "free-rest",
    endpoints: [
      { role: "search", url_template: "https://api.thirdweb.com/v1/payments/x402/discovery/resources?query={query}", payment_required: false },
      { role: "mcp", url: "https://api.thirdweb.com/mcp?tools=fetchWithPayment,listPayableServices", payment_required: false, auth_required: true },
    ],
  },
  {
    id: "payai",
    name: "PayAI facilitator discovery",
    aliases: ["payai", "payai facilitator"],
    discover_source: "payai",
    layer: "facilitator",
    summary: "Public multi-chain x402 resource mirror exposed by the PayAI facilitator.",
    cost: "free discovery",
    wire_method: "free-rest",
    endpoints: [
      { role: "list", url: "https://facilitator.payai.network/discovery/resources", payment_required: false },
    ],
  },
  {
    id: "x402engine",
    name: "x402engine",
    aliases: ["x402 engine", "x402engine.app"],
    discover_source: "x402engine",
    layer: "aggregator",
    summary: "Direct manifest of paid AI, media, code, crypto, web, and travel endpoints.",
    cost: "free discovery; each resource is pay-per-call",
    wire_method: "free-rest",
    endpoints: [
      { role: "manifest", url: "https://x402engine.app/.well-known/x402.json", payment_required: false },
      { role: "mcp", url: "https://x402engine.app/mcp", payment_required: false },
    ],
  },
  {
    id: "anchor-x402",
    name: "anchor-x402",
    aliases: ["anchor x402", "anchor-x402.com"],
    discover_source: "anchor-x402",
    layer: "provider",
    summary: "Direct manifest of commodity primitives, verification, and LLM endpoints.",
    cost: "free discovery; each resource is pay-per-call",
    wire_method: "free-rest",
    endpoints: [
      { role: "manifest", url: "https://api.anchor-x402.com/.well-known/x402", payment_required: false },
    ],
  },
  {
    id: "apify",
    name: "Apify x402 prepaid access",
    aliases: ["apify", "apify actors", "apify mcp"],
    discover_source: "apify",
    layer: "aggregator",
    summary: "Buy an x402 prepaid token, then use it with the Apify Actor marketplace.",
    cost: "minimum $1 prepaid token",
    wire_method: "paid-rest",
    endpoints: [
      { role: "buy_prepaid_token", url: "https://agi.apify.com/protocols/x402/prepaid-tokens?amount=1&currency=usd", payment_required: true, price_usdc: 1, executable_via: "apiosk_inspect_x402_then_apiosk_fetch_paid" },
      { role: "actor_catalog", url_template: "https://api.apify.com/v2/store?search={query}&limit=25", payment_required: false },
      { role: "mcp", url: "https://mcp.apify.com", payment_required: false, auth_required: true },
    ],
  },
  {
    id: "x402scan",
    name: "x402scan",
    aliases: ["x402 scan", "merit x402scan", "x402scan.com"],
    discover_source: "x402scan",
    layer: "discovery",
    summary: "Paid x402 resource explorer and full-text search API.",
    cost: "$0.01 list; $0.02 search",
    wire_method: "paid-rest",
    endpoints: [
      { role: "list", url: "https://www.x402scan.com/api/x402/resources", payment_required: true, price_usdc: 0.01, executable_via: "apiosk_inspect_x402_then_apiosk_fetch_paid" },
      { role: "search", url_template: "https://www.x402scan.com/api/x402/resources/search?q={query}", payment_required: true, price_usdc: 0.02, executable_via: "apiosk_inspect_x402_then_apiosk_fetch_paid" },
      { role: "openapi", url: "https://www.x402scan.com/openapi.json", payment_required: false },
    ],
  },
  {
    id: "x402list-fun",
    name: "x402list.fun",
    aliases: ["x402list", "x402 list fun", "x402list.fun"],
    discover_source: null,
    layer: "discovery",
    summary: "Large paid MCP-only x402 directory.",
    cost: "$0.001 per MCP search",
    wire_method: "paid-mcp",
    endpoints: [
      { role: "mcp", url: "https://x402list.fun/mcp", payment_required: true, price_usdc: 0.001, executable_via: "external_mcp_client_required" },
    ],
  },
];

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function publicSource(source) {
  const { aliases: _aliases, ...rest } = source;
  return structuredClone(rest);
}

export function listKnownSources() {
  return SOURCES.map(publicSource);
}

export function searchKnownSources(query, { limit = 12 } = {}) {
  const needle = normalize(query);
  if (!needle) return [];
  const tokens = needle.split(/\s+/).filter((token) => token.length >= 2);

  return SOURCES
    .map((source) => {
      const names = [source.id, source.name, ...(source.aliases || [])].map(normalize);
      const haystack = normalize([
        ...names,
        source.summary,
        source.layer,
        source.wire_method,
        source.cost,
      ].join(" "));
      let score = 0;
      if (names.includes(needle)) score += 100;
      if (names.some((name) => name.includes(needle))) score += 50;
      for (const token of tokens) {
        if (names.some((name) => name.includes(token))) score += 10;
        else if (haystack.includes(token)) score += 2;
      }
      return { source, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.source.name.localeCompare(b.source.name))
    .slice(0, Math.max(1, Math.min(25, Math.floor(limit))))
    .map(({ source }) => publicSource(source));
}

export function materializeEndpoint(endpoint, query) {
  if (!endpoint?.url_template) return endpoint?.url || null;
  return endpoint.url_template.replace("{query}", encodeURIComponent(String(query ?? "")));
}

