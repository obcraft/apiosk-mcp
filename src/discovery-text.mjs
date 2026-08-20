// The text primitives discovery needs to present someone else's words safely.
//
// This file used to also hold a tokeniser, a stopword list and a per-term
// search cache, because discovery used to build its own catalogue queries here.
// The gateway builds them now — it reads the job with a parser before it
// searches anything — so what is left is the part that is still this repo's
// job: making provider-supplied text safe to show, and naming a network the way
// Apiosk names it.

export const DESCRIPTION_MAX_CHARS = 300;

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

// Normalize the network identifier from an external offer (may be CAIP-2 like
// "eip155:8453" or a plain name) to the plain name Apiosk uses.
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

/**
 * What an agent may do with a result the Apiosk gateway does not proxy.
 *
 * Discovery sweeps the whole x402 ecosystem, which means it surfaces endpoints
 * this MCP cannot settle. Saying so on the result is the honest alternative to
 * either hiding them or handing the agent a second, unpoliced way to spend.
 * Used only when the gateway sent no note of its own.
 */
export const EXTERNAL_EXECUTION_NOTE =
  "Unreviewed and external to the Apiosk catalogue: Apiosk has not measured it and cannot settle it from this surface. It is listed because it exists and may do the job — call it on the provider's own host and pay its 402 directly.";
