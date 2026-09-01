// /.well-known/apiosk-routes.json — a served page, not a tool.
//
// This is a crawler-facing surface, and it is how agents that never install an
// MCP server find out that a route exists at all. It reshapes the gateway's own
// /.well-known/x402 document, which is the canonical one; nothing here is a
// second source of truth, and nothing here is a capability an agent can call.
//
// It survived the earlier cut-to-five refactor for the same reason
// src/settlement-disclosure.mjs did: it is a page this server serves, not a
// choice an agent has to make.

import { resolveGatewayBaseUrl } from "./gateway-client.mjs";
import { trimString } from "./tool-result.mjs";

const DEFAULT_MCP_PUBLIC_BASE_URL = "https://mcp.apiosk.com";
const CACHE_TTL_MS = 60_000;

/**
 * Pages the gateway's discovery document is walked in. The gateway caps
 * `perPage` at 100; asking for it keeps a full catalogue walk to a dozen or so
 * requests instead of one per fifteen resources.
 */
const PAGE_SIZE = 100;

/**
 * Safety bound on the walk. At the cap this is 5,000 resources — well past the
 * live catalogue — and it stops a gateway bug that always advertises a `next`
 * from turning this endpoint into an infinite loop.
 */
const MAX_PAGES = 50;

const CAIP2_NETWORK_NAMES = {
  "eip155:8453": "base",
  "eip155:137": "polygon",
  "eip155:42161": "arbitrum",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
};

let cache = null;

export function clearWellKnownRoutesCache() {
  cache = null;
}

function friendlyNetworkName(network) {
  const value = trimString(network);
  if (!value) return "base";
  if (CAIP2_NETWORK_NAMES[value]) return CAIP2_NETWORK_NAMES[value];
  if (value.startsWith("solana:")) return "solana";
  return value;
}

function resolveMcpPublicBaseUrl(env = process.env) {
  return (trimString(env.APIOSK_MCP_PUBLIC_BASE_URL) || DEFAULT_MCP_PUBLIC_BASE_URL).replace(/\/+$/, "");
}

export function reshapeDiscoveryItems(wellKnownDocument) {
  const items = Array.isArray(wellKnownDocument?.items) ? wellKnownDocument.items : [];
  return items.map((item) => {
    const offer = Array.isArray(item.accepts) ? item.accepts[0] : null;
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    // x402 v2 calls the atomic amount `amount`; v1 called it
    // `maxAmountRequired`. Both are USDC 6-decimal atomic units.
    const atomic = Number.parseInt(trimString(offer?.amount ?? offer?.maxAmountRequired), 10);
    return {
      name: metadata.name || metadata.api || undefined,
      description: metadata.description || undefined,
      url: item.resource,
      method: metadata.method || "GET",
      price: Number.isFinite(atomic)
        ? (atomic / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")
        : undefined,
      currency: "USDC",
      network: friendlyNetworkName(offer?.network),
      pay_to: offer?.payTo || undefined,
      x402_version: item.x402Version ?? wellKnownDocument?.x402Version ?? 1,
    };
  });
}

/**
 * Every item in the gateway's x402 document, following `links.next` to the end.
 *
 * The document is paginated (a single response was 7.3 MB and unreadable), so
 * an endpoint that promises an index of EVERY paid route has to walk it. A
 * document without `links.next` is treated as complete, which is also what an
 * older, unpaginated gateway produces.
 */
async function fetchAllItems(gateway, doFetch) {
  // `include=all`: the gateway document publishes managed listings by default,
  // and this endpoint promises every paid route, federated ones included.
  let url = `${gateway}/.well-known/x402?perPage=${PAGE_SIZE}&include=all`;
  let first = null;
  const items = [];

  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const response = await doFetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`Gateway discovery document unavailable (HTTP ${response.status}).`);
    }
    const document = await response.json();
    first = first || document;
    if (Array.isArray(document.items)) items.push(...document.items);

    const next = document?.links?.next;
    url = typeof next === "string" && next ? next : null;
  }

  return { document: first || {}, items };
}

export async function buildDiscoveryDocument({ env = process.env, fetchImpl } = {}) {
  if (cache && cache.expiresAt > Date.now()) return cache.document;

  const gateway = resolveGatewayBaseUrl(env);
  const doFetch = fetchImpl || globalThis.fetch;
  const { document: wellKnown, items } = await fetchAllItems(gateway, doFetch);

  const routes = reshapeDiscoveryItems({ ...wellKnown, items });
  const document = {
    name: "Apiosk paid API routes",
    description:
      "Machine-readable index of paid x402 routes published through Apiosk. Each route returns 402 Payment Required with an x402 offer until paid in USDC.",
    generated_from: `${gateway}/.well-known/x402`,
    mcp_endpoint: `${resolveMcpPublicBaseUrl(env)}/mcp`,
    count: routes.length,
    routes,
  };

  cache = { document, expiresAt: Date.now() + CACHE_TTL_MS };
  return document;
}
