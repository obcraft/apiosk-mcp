// The primitives discovery shares with its sources.
//
// Text sanitising, tokenising and price parsing are used by both halves of
// discovery: the Apiosk catalogue reader and the external x402 sources. They
// live here so neither half owns them, and so a change to how provider text is
// sanitised applies to every source at once.


export const CACHE_MAX_ENTRIES = 256;
export const DESCRIPTION_MAX_CHARS = 300;

// Common words that add ILIKE noise without narrowing a catalog search. The
// gateway search is a single `ILIKE %term%` over slug/name/description/category/
// tags, so a raw natural-language phrase ("realtime USD exchange rate") matches
// nothing — we tokenize and search per keyword, dropping these.
export const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "for", "to", "in", "on", "with", "by",
  "at", "from", "into", "as", "is", "are", "be", "get", "give", "show", "me",
  "my", "please", "real", "realtime", "live", "current", "latest", "data",
  "api", "apis", "endpoint", "endpoints", "paid", "using", "use", "want",
  "need", "build", "make", "create", "that", "this", "some", "any", "about",
  "detailed", "detail", "info", "information",
]);

// Per-(source, term) response cache. The catalog is public so caching across
// requests/users is safe; a short TTL keeps a burst of per-segment searches off
// the gateway. Exported clear() keeps tests deterministic.
export const searchCache = new Map();

export function clearDiscoveryCache() {
  searchCache.clear();
}

export function trimString(value) {
  return String(value ?? "").trim();
}

// Strip control characters and cap length. Applied to ALL provider-supplied
// text before it leaves discovery, so a listing description can never smuggle
// hidden instructions or blow up the result payload.
export function sanitizeText(value, max = DESCRIPTION_MAX_CHARS) {
  const cleaned = String(value ?? "")
    // Strip C0/C1 control chars (incl. newlines) so provider text can't
    // smuggle hidden directives or break the payload; collapse whitespace.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

// Normalize the network identifier from an external accepts[] entry (may be
// CAIP-2 like "eip155:8453" or a plain name) to the plain name Apiosk uses.
export function normalizeNetworkName(network) {
  const value = trimString(network).toLowerCase();
  const map = {
    "eip155:8453": "base",
    "eip155:84532": "base-sepolia",
    "eip155:137": "polygon",
    "eip155:80002": "polygon-amoy",
    "eip155:42161": "arbitrum",
    "eip155:43114": "avalanche",
  };
  return map[value] || value || null;
}

// Best-effort atomic->USDC (6-decimal) conversion; every listed x402 asset is
// USDC. Returns null when unparseable so callers fall back to the catalog price.
export function atomicToUsdc(raw) {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  return n / 1_000_000;
}

// Parse a USD price that may be a number, "$0.01", or "10000" (already USD).
export function parseUsdPrice(value) {
  if (value === null || value === undefined) return null;
  const n = Number(String(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * What an agent may do with a result the Apiosk gateway does not proxy.
 *
 * Discovery sweeps the whole x402 ecosystem, which means it surfaces endpoints
 * this MCP cannot settle. Saying so on the result is the honest alternative to
 * either hiding them or handing the agent a second, unpoliced way to spend.
 */
export const EXTERNAL_EXECUTION_NOTE =
  "External to the Apiosk catalogue: the gateway cannot settle it from this surface, so it is listed as evidence of what exists, not as something to call. Prefer an Apiosk result, or ask the provider to list with Apiosk.";
