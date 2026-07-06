// Apiosk Publisher MCP tools.
//
// Spec-shaped tool surface ("publish this API as a paid x402 endpoint") for
// coding agents: publish_x402_route, list_x402_routes, update_x402_route,
// unpublish_x402_route, test_x402_route, generate_openapi_spec,
// publish_project.
//
// Identity model: these tools authenticate with a provider API key
// (sk_live_…, minted in the provider portal) passed as
// `Authorization: Bearer sk_live_…`. The key is verified through the
// gateway database's verify_provider_api_key() RPC and resolves to the
// provider's owner_id — the same identity the provider portal writes with.
// Routes therefore show up in the portal, the gateway /.well-known/x402
// document, and the Bazaar indexing pipeline like any portal-published API.
//
// A "route" is one paid endpoint: an `api_endpoints` row under an `apis`
// listing. route_id == api_endpoints.id.

const DEFAULT_GATEWAY_BASE_URL = "https://gateway.apiosk.com";
const DEFAULT_MCP_PUBLIC_BASE_URL = "https://mcp.apiosk.com";
// The Supabase project URL is public client config (the portals ship it in
// their bundles); only the service-role key is secret and must come from env.
const DEFAULT_SUPABASE_URL = "https://jgjoiyqdyypouskftzeq.supabase.co";

const ALLOWED_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const ALLOWED_NETWORKS = ["base", "polygon", "arbitrum", "solana"];
const PROVIDER_KEY_PREFIX = "sk_live_";
const PROVIDER_KEY_CACHE_TTL_MS = 60_000;
const DISCOVERY_CACHE_TTL_MS = 60_000;
const MAX_PRICE_USDC = 1000;

const providerKeyCache = new Map();
let discoveryCache = null;

function trimString(value) {
  return String(value ?? "").trim();
}

function content(value) {
  const result = {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };

  if (value && typeof value === "object" && !Array.isArray(value)) {
    result.structuredContent = value;
  }

  return result;
}

function errorContent(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
    isError: true,
  };
}

export const PUBLISHER_TOOLS = [
  {
    name: "publish_x402_route",
    description:
      "Publish an API endpoint as a paid x402 route on the Apiosk gateway. The route gets a paid URL that returns 402 Payment Required until the caller pays in USDC, then forwards to your upstream API. New routes enter Apiosk's review queue (status pending_review) and go live on approval. Requires an Apiosk provider token (Authorization: Bearer sk_live_…).",
    inputSchema: {
      type: "object",
      required: ["name", "upstream_url", "price", "settlement_address"],
      properties: {
        name: { type: "string", description: "Human-readable API name, e.g. 'Weather API'." },
        description: { type: "string" },
        upstream_url: {
          type: "string",
          description: "Full HTTPS URL of your existing endpoint the gateway forwards paid requests to.",
        },
        method: { type: "string", enum: ALLOWED_METHODS, description: "Defaults to GET." },
        path: {
          type: "string",
          description: "Public path under the route's gateway slug, e.g. /weather. Defaults to the last segment of upstream_url.",
        },
        price: {
          type: ["string", "number"],
          description: "Price per call in USDC, e.g. \"0.01\".",
        },
        currency: { type: "string", enum: ["USDC"], description: "Only USDC is supported." },
        network: {
          type: "string",
          enum: ALLOWED_NETWORKS,
          description: "Settlement network. Defaults to base.",
        },
        settlement_address: {
          type: "string",
          description: "Wallet that receives 98% of each payment (Apiosk keeps a 2% platform fee).",
        },
        input_schema: { type: "object", additionalProperties: true },
        output_schema: { type: "object", additionalProperties: true },
        tags: { type: "array", items: { type: "string" } },
        slug: {
          type: "string",
          description: "Optional gateway slug override (lowercase letters, numbers, hyphens). Defaults to a slug derived from name.",
        },
      },
    },
  },
  {
    name: "update_x402_route",
    description:
      "Update a published x402 route: price, description, upstream URL, schemas, settlement address, or status. Requires an Apiosk provider token.",
    inputSchema: {
      type: "object",
      required: ["route_id"],
      properties: {
        route_id: { type: "string" },
        name: { type: "string" },
        description: { type: "string" },
        upstream_url: { type: "string" },
        method: { type: "string", enum: ALLOWED_METHODS },
        path: { type: "string" },
        price: { type: ["string", "number"] },
        settlement_address: { type: "string" },
        input_schema: { type: "object", additionalProperties: true },
        output_schema: { type: "object", additionalProperties: true },
        tags: { type: "array", items: { type: "string" } },
        status: {
          type: "string",
          enum: ["active", "disabled"],
          description: "Re-enable ('active', re-enters review if not yet approved) or disable the route's listing.",
        },
      },
    },
  },
  {
    name: "list_x402_routes",
    description:
      "List all x402 routes published by the authenticated provider, with paid URLs, prices, and live status. Requires an Apiosk provider token.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          type: "string",
          enum: ["active", "pending_review", "disabled"],
          description: "Optional status filter.",
        },
      },
    },
  },
  {
    name: "unpublish_x402_route",
    description:
      "Disable a paid x402 route (its gateway listing stops serving). Reversible with update_x402_route {status: 'active'}. Requires an Apiosk provider token.",
    inputSchema: {
      type: "object",
      required: ["route_id"],
      properties: {
        route_id: { type: "string" },
      },
    },
  },
  {
    name: "test_x402_route",
    description:
      "Send an unpaid test request to a route's paid URL and verify x402 behavior: expects 402 Payment Required with a valid accepts[] payment offer. Requires an Apiosk provider token.",
    inputSchema: {
      type: "object",
      required: ["route_id"],
      properties: {
        route_id: { type: "string" },
        test_payload: {
          type: "object",
          additionalProperties: true,
          description: "Sent as query params for GET, JSON body otherwise.",
        },
      },
    },
  },
  {
    name: "generate_openapi_spec",
    description:
      "Generate a hosted OpenAPI 3.1 spec for a route's API listing (all its endpoints) and return its public URL. Requires an Apiosk provider token.",
    inputSchema: {
      type: "object",
      required: ["route_id"],
      properties: {
        route_id: { type: "string" },
        title: { type: "string" },
        version: { type: "string" },
        endpoints: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Optional extra path items merged into the generated spec.",
        },
      },
    },
  },
  {
    name: "publish_project",
    description:
      "Publish multiple API routes from one project in a single call. Creates one gateway listing for the project and one paid x402 route per entry. Requires an Apiosk provider token.",
    inputSchema: {
      type: "object",
      required: ["project_name", "base_url", "settlement_address", "routes"],
      properties: {
        project_name: { type: "string" },
        description: { type: "string" },
        base_url: {
          type: "string",
          description: "HTTPS base URL of the project's API. Each route's path is appended to it upstream.",
        },
        settlement_address: { type: "string" },
        network: { type: "string", enum: ALLOWED_NETWORKS },
        tags: { type: "array", items: { type: "string" } },
        routes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            required: ["name", "path", "price"],
            properties: {
              name: { type: "string" },
              path: { type: "string" },
              method: { type: "string", enum: ALLOWED_METHODS },
              price: { type: ["string", "number"] },
              description: { type: "string" },
              input_schema: { type: "object", additionalProperties: true },
              output_schema: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
  },
];

export const PUBLISHER_TOOL_NAMES = new Set(PUBLISHER_TOOLS.map((tool) => tool.name));

export function isPublisherTool(name) {
  return PUBLISHER_TOOL_NAMES.has(name);
}

export function isProviderApiKey(token) {
  return typeof token === "string" && token.trim().toLowerCase().startsWith(PROVIDER_KEY_PREFIX);
}

export function slugify(value) {
  return trimString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export function normalizePath(value, fallback = "/") {
  let path = trimString(value);
  if (!path) return fallback;
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9\-._~/{}%]*$/.test(path)) {
    throw new Error(`Invalid route path: ${JSON.stringify(value)}. Use URL-safe characters, e.g. /weather.`);
  }
  return path;
}

// The gateway forwards <origin_url> + <endpoint path>. When the agent hands
// us a full upstream URL that already ends with the public path, strip it so
// the path isn't doubled on forward.
export function deriveOriginUrl(upstreamUrl, path) {
  const url = new URL(trimString(upstreamUrl));
  if (url.protocol !== "https:") {
    throw new Error("upstream_url must be HTTPS.");
  }

  const cleanPath = trimString(path);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (cleanPath && cleanPath !== "/" && pathname.toLowerCase().endsWith(cleanPath.toLowerCase())) {
    pathname = pathname.slice(0, pathname.length - cleanPath.length);
  }

  return `${url.origin}${pathname}`.replace(/\/+$/, "") || url.origin;
}

export function defaultPathFromUpstream(upstreamUrl) {
  try {
    const segments = new URL(trimString(upstreamUrl)).pathname
      .split("/")
      .filter(Boolean);
    const last = segments[segments.length - 1];
    return last ? normalizePath(last) : "/";
  } catch {
    return "/";
  }
}

export function parsePriceUsdc(value) {
  const raw = typeof value === "number" ? value : Number.parseFloat(trimString(value));
  if (!Number.isFinite(raw) || raw <= 0) {
    throw new Error("price must be a positive USDC amount per call, e.g. \"0.01\".");
  }
  if (raw > MAX_PRICE_USDC) {
    throw new Error(`price exceeds the ${MAX_PRICE_USDC} USDC per-call maximum.`);
  }
  // USDC has 6 decimals; anything finer can't settle on-chain.
  return Math.round(raw * 1e6) / 1e6;
}

function validateSettlementAddress(address, network) {
  const value = trimString(address);
  if (network === "solana") {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
      throw new Error("settlement_address must be a base58 Solana address for network 'solana'.");
    }
    return value;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("settlement_address must be a 0x-prefixed EVM address.");
  }
  return value;
}

function resolveNetwork(value) {
  const network = trimString(value).toLowerCase() || "base";
  if (!ALLOWED_NETWORKS.includes(network)) {
    throw new Error(`Unsupported network '${network}'. Supported: ${ALLOWED_NETWORKS.join(", ")}.`);
  }
  return network;
}

function resolveMethod(value) {
  const method = trimString(value).toUpperCase() || "GET";
  if (!ALLOWED_METHODS.includes(method)) {
    throw new Error(`Unsupported method '${method}'. Supported: ${ALLOWED_METHODS.join(", ")}.`);
  }
  return method;
}

function resolveGatewayBaseUrl(env = process.env) {
  return (
    trimString(env.APIOSK_GATEWAY) ||
    trimString(env.APIOSK_GATEWAY_URL) ||
    DEFAULT_GATEWAY_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveMcpPublicBaseUrl(env = process.env) {
  return (
    trimString(env.APIOSK_MCP_PUBLIC_BASE_URL) || DEFAULT_MCP_PUBLIC_BASE_URL
  ).replace(/\/+$/, "");
}

function resolveSupabaseConfig(env = process.env) {
  const url = (
    trimString(env.APIOSK_SUPABASE_URL) ||
    trimString(env.SUPABASE_URL) ||
    DEFAULT_SUPABASE_URL
  ).replace(/\/+$/, "");
  const serviceRoleKey =
    trimString(env.APIOSK_SUPABASE_SERVICE_ROLE_KEY) ||
    trimString(env.SUPABASE_SERVICE_ROLE_KEY);

  if (!serviceRoleKey) {
    throw new Error(
      "Publisher tools are not configured on this server: missing APIOSK_SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_ROLE_KEY)."
    );
  }

  return { url, serviceRoleKey };
}

function resolveFetch(ctx = {}) {
  return ctx.fetchImpl || globalThis.fetch;
}

async function supabaseRest(ctx, path, { method = "GET", body, headers = {} } = {}) {
  const { url, serviceRoleKey } = resolveSupabaseConfig(ctx.env);
  const fetchImpl = resolveFetch(ctx);

  const response = await fetchImpl(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceRoleKey,
      authorization: `Bearer ${serviceRoleKey}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(method === "GET" ? {} : { prefer: "return=representation" }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === "object" && (payload.message || payload.hint || payload.details)) ||
      (typeof payload === "string" ? payload.slice(0, 300) : `HTTP ${response.status}`);
    throw new Error(`Apiosk database request failed (${response.status}): ${message}`);
  }

  return payload;
}

export async function verifyProviderKey(token, { env = process.env, fetchImpl } = {}) {
  const secret = trimString(token);
  if (!isProviderApiKey(secret)) {
    throw new Error("Not an Apiosk provider token (expected sk_live_… prefix).");
  }

  const cached = providerKeyCache.get(secret);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  const rows = await supabaseRest(
    { env, fetchImpl },
    "rpc/verify_provider_api_key",
    { method: "POST", body: { p_secret: secret } }
  );

  const row = Array.isArray(rows) ? rows[0] : rows;
  const ownerId = trimString(row?.owner_id);
  if (!ownerId) {
    // Header-safe ASCII only: this message can end up inside a
    // WWW-Authenticate challenge header, where non-ASCII throws.
    throw new Error("Invalid or revoked Apiosk provider token. Mint one in the provider portal (Settings, API keys).");
  }

  const context = {
    ownerId,
    keyId: trimString(row?.key_id) || undefined,
    label: trimString(row?.label) || undefined,
  };
  providerKeyCache.set(secret, { context, expiresAt: Date.now() + PROVIDER_KEY_CACHE_TTL_MS });
  return context;
}

function extractProviderToken(authInfo, env = process.env) {
  const fromExtra = trimString(authInfo?.extra?.apiosk_provider_key);
  if (isProviderApiKey(fromExtra)) return fromExtra;

  const fromToken = trimString(authInfo?.token);
  if (isProviderApiKey(fromToken)) return fromToken;

  const fromEnv =
    trimString(env.APIOSK_PROVIDER_TOKEN) ||
    trimString(env.APIOSK_PROVIDER_API_KEY) ||
    trimString(env.APIOSK_PROVIDER_KEY);
  if (isProviderApiKey(fromEnv)) return fromEnv;

  return null;
}

async function requireProvider(authInfo, ctx) {
  const token = extractProviderToken(authInfo, ctx.env);
  if (!token) {
    throw new Error(
      "Publisher tools need an Apiosk provider token. Connect with header `Authorization: Bearer sk_live_...` (mint the key in the provider portal under Settings, API keys), or set APIOSK_PROVIDER_TOKEN for local stdio use."
    );
  }

  const context = await verifyProviderKey(token, { env: ctx.env, fetchImpl: ctx.fetchImpl });
  return { ...context, token };
}

function mapListingStatus(status) {
  const value = trimString(status).toLowerCase();
  if (value === "active") return "active";
  if (value === "pending") return "pending_review";
  return "disabled";
}

function buildPaidUrl(env, slug, path) {
  const base = resolveGatewayBaseUrl(env);
  const routePath = path === "/" ? "" : path;
  return `${base}/${slug}${routePath}`;
}

function routeResponse(env, api, endpoint) {
  const status = mapListingStatus(api.status);
  const metadata = api.listing_metadata && typeof api.listing_metadata === "object" ? api.listing_metadata : {};
  return {
    route_id: endpoint.id,
    name: api.name,
    description: api.description || undefined,
    paid_url: buildPaidUrl(env, api.slug, endpoint.path),
    upstream_url: api.origin_url || api.endpoint_url || undefined,
    method: endpoint.method,
    path: endpoint.path,
    price: String(endpoint.price),
    currency: "USDC",
    network: trimString(metadata.x402_network) || "base",
    settlement_address: api.wallet_address || undefined,
    tags: Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags : undefined,
    status,
  };
}

function activationNote(api) {
  const status = mapListingStatus(api.status);
  if (status === "active") {
    return "Route is live: the paid URL returns 402 with an x402 payment offer until paid, then forwards to your upstream.";
  }
  if (status === "pending_review") {
    return "Route created and queued for Apiosk review (all new listings are approved by an operator before going live). Once approved it serves x402 payments, appears in gateway.apiosk.com/.well-known/x402, and is auto-indexed in the Coinbase x402 Bazaar. Use test_x402_route to verify once active.";
  }
  return "Route is disabled. Re-enable with update_x402_route {status: 'active'}.";
}

async function fetchRouteWithApi(ctx, routeId) {
  const id = trimString(routeId);
  if (!id) throw new Error("Missing required field: route_id");

  const rows = await supabaseRest(
    ctx,
    `api_endpoints?id=eq.${encodeURIComponent(id)}&select=*,apis(*)`
  );
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.apis) {
    throw new Error(`No route found for route_id ${id}. Use list_x402_routes to see your routes.`);
  }

  const { apis: api, ...endpoint } = row;
  return { api, endpoint };
}

function assertRouteOwnership(api, provider) {
  if (trimString(api.owner_id) !== provider.ownerId) {
    throw new Error("This route belongs to a different provider account.");
  }
}

async function findAvailableSlug(ctx, desiredSlug, ownerId) {
  const base = slugify(desiredSlug);
  if (!base) throw new Error("Could not derive a slug from the provided name.");

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const rows = await supabaseRest(
      ctx,
      `apis?slug=eq.${encodeURIComponent(candidate)}&select=id,owner_id,slug`
    );
    const existing = Array.isArray(rows) ? rows[0] : null;
    if (!existing) {
      return { slug: candidate, existing: null };
    }
    if (trimString(existing.owner_id) === ownerId) {
      return { slug: candidate, existing };
    }
  }

  throw new Error(`Slug '${base}' and its variants are taken. Pass an explicit unique 'slug'.`);
}

// Best-effort resolution of the multi-chain endpoint token (migration 047).
// Base is the gateway default (NULL network_token_id), so failure to resolve
// a non-base token degrades to Base settlement with a warning, not an error.
async function resolveNetworkTokenId(ctx, network) {
  if (network === "base") return { networkTokenId: null, warning: null };

  try {
    const networks = await supabaseRest(
      ctx,
      `networks?name=eq.${encodeURIComponent(network)}&is_testnet=eq.false&select=id`
    );
    const networkId = Array.isArray(networks) ? trimString(networks[0]?.id) : "";
    if (!networkId) throw new Error("network not found");

    const tokens = await supabaseRest(
      ctx,
      `network_tokens?network_id=eq.${encodeURIComponent(networkId)}&select=id,tokens(symbol)`
    );
    const match = (Array.isArray(tokens) ? tokens : []).find(
      (row) => trimString(row?.tokens?.symbol).toUpperCase() === "USDC"
    );
    if (!match) throw new Error("USDC token not registered for network");

    return { networkTokenId: match.id, warning: null };
  } catch (error) {
    return {
      networkTokenId: null,
      warning: `Could not bind the route to ${network} USDC (${error.message}); it will settle on Base USDC (the gateway default). You can change the network later in the provider portal.`,
    };
  }
}

function buildListingMetadataPatch(existing, { tags, network, publisherExtras } = {}) {
  const base = existing && typeof existing === "object" ? { ...existing } : {};
  if (Array.isArray(tags) && tags.length) {
    base.tags = tags.map((tag) => trimString(tag)).filter(Boolean);
  }
  if (network) {
    base.x402_network = network;
  }
  base.publisher = "mcp-x402-publisher";
  if (publisherExtras && typeof publisherExtras === "object") {
    Object.assign(base, publisherExtras);
  }
  return base;
}

async function upsertListing(ctx, provider, input) {
  const network = resolveNetwork(input.network);
  const settlementAddress = validateSettlementAddress(input.settlement_address, network);
  const { slug, existing } = await findAvailableSlug(ctx, input.slug || input.name, provider.ownerId);

  const listingFields = {
    name: trimString(input.name),
    description: trimString(input.description) || trimString(input.name),
    origin_url: input.origin_url,
    endpoint_url: input.origin_url,
    wallet_address: settlementAddress,
    category: trimString(input.category) || "data",
    listing_type: "api",
  };

  if (existing) {
    const patched = await supabaseRest(
      ctx,
      `apis?id=eq.${encodeURIComponent(existing.id)}&select=*`,
      {
        method: "PATCH",
        body: {
          ...listingFields,
          listing_metadata: buildListingMetadataPatch(await fetchListingMetadata(ctx, existing.id), {
            tags: input.tags,
            network,
          }),
        },
      }
    );
    return { api: Array.isArray(patched) ? patched[0] : patched, network };
  }

  const inserted = await supabaseRest(ctx, "apis?select=*", {
    method: "POST",
    body: {
      ...listingFields,
      owner_id: provider.ownerId,
      slug,
      // The api-review gate (migration admin/0004) forces fresh publishes to
      // 'pending' regardless; writing it explicitly keeps intent obvious.
      status: "pending",
      listing_metadata: buildListingMetadataPatch(null, { tags: input.tags, network }),
    },
  });

  return { api: Array.isArray(inserted) ? inserted[0] : inserted, network };
}

async function fetchListingMetadata(ctx, apiId) {
  const rows = await supabaseRest(
    ctx,
    `apis?id=eq.${encodeURIComponent(apiId)}&select=listing_metadata`
  );
  return Array.isArray(rows) ? rows[0]?.listing_metadata : null;
}

async function upsertEndpoint(ctx, apiId, { method, path, price, description, inputSchema, outputSchema, networkTokenId }) {
  const existing = await supabaseRest(
    ctx,
    `api_endpoints?api_id=eq.${encodeURIComponent(apiId)}&method=eq.${encodeURIComponent(method)}&path=eq.${encodeURIComponent(path)}&select=id`
  );
  const existingId = Array.isArray(existing) ? trimString(existing[0]?.id) : "";

  const fields = {
    method,
    path,
    price,
    payment_required: price > 0,
    description: trimString(description) || undefined,
    request_body: inputSchema && Object.keys(inputSchema).length ? inputSchema : undefined,
    response_body: outputSchema && Object.keys(outputSchema).length ? outputSchema : undefined,
  };
  if (networkTokenId) {
    fields.network_token_id = networkTokenId;
  }
  for (const key of Object.keys(fields)) {
    if (fields[key] === undefined) delete fields[key];
  }

  if (existingId) {
    const patched = await supabaseRest(
      ctx,
      `api_endpoints?id=eq.${encodeURIComponent(existingId)}&select=*`,
      { method: "PATCH", body: fields }
    );
    return Array.isArray(patched) ? patched[0] : patched;
  }

  const inserted = await supabaseRest(ctx, "api_endpoints?select=*", {
    method: "POST",
    body: { api_id: apiId, ...fields },
  });
  return Array.isArray(inserted) ? inserted[0] : inserted;
}

async function handlePublishRoute(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);

  const name = trimString(args.name);
  if (!name) throw new Error("Missing required field: name");
  if (trimString(args.currency) && trimString(args.currency).toUpperCase() !== "USDC") {
    throw new Error("Only USDC pricing is supported.");
  }

  const method = resolveMethod(args.method);
  const path = args.path ? normalizePath(args.path) : defaultPathFromUpstream(args.upstream_url);
  const price = parsePriceUsdc(args.price);
  const originUrl = deriveOriginUrl(args.upstream_url, path);
  const network = resolveNetwork(args.network);

  const { api } = await upsertListing(ctx, provider, {
    name,
    description: args.description,
    origin_url: originUrl,
    settlement_address: args.settlement_address,
    network,
    tags: args.tags,
    slug: args.slug,
  });

  const { networkTokenId, warning } = await resolveNetworkTokenId(ctx, network);
  const endpoint = await upsertEndpoint(ctx, api.id, {
    method,
    path,
    price,
    description: args.description || name,
    inputSchema: args.input_schema,
    outputSchema: args.output_schema,
    networkTokenId,
  });

  const result = {
    ...routeResponse(ctx.env, api, endpoint),
    note: activationNote(api),
  };
  if (warning) result.warning = warning;
  return content(result);
}

async function handleListRoutes(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);

  const listings = await supabaseRest(
    ctx,
    `apis?owner_id=eq.${encodeURIComponent(provider.ownerId)}&select=*,api_endpoints(*)&order=created_at.desc`
  );

  const statusFilter = trimString(args.status);
  const routes = [];
  for (const api of Array.isArray(listings) ? listings : []) {
    for (const endpoint of Array.isArray(api.api_endpoints) ? api.api_endpoints : []) {
      const route = routeResponse(ctx.env, api, endpoint);
      if (statusFilter && route.status !== statusFilter) continue;
      routes.push(route);
    }
  }

  return content({ routes, count: routes.length });
}

async function handleUpdateRoute(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);
  const { api, endpoint } = await fetchRouteWithApi(ctx, args.route_id);
  assertRouteOwnership(api, provider);

  const endpointPatch = {};
  if (args.price !== undefined) {
    endpointPatch.price = parsePriceUsdc(args.price);
    endpointPatch.payment_required = endpointPatch.price > 0;
  }
  if (args.method !== undefined) endpointPatch.method = resolveMethod(args.method);
  if (args.path !== undefined) endpointPatch.path = normalizePath(args.path);
  if (args.input_schema !== undefined) endpointPatch.request_body = args.input_schema;
  if (args.output_schema !== undefined) endpointPatch.response_body = args.output_schema;

  const listingPatch = {};
  if (args.name !== undefined) listingPatch.name = trimString(args.name);
  if (args.description !== undefined) listingPatch.description = trimString(args.description);
  if (args.settlement_address !== undefined) {
    const metadata = api.listing_metadata && typeof api.listing_metadata === "object" ? api.listing_metadata : {};
    listingPatch.wallet_address = validateSettlementAddress(
      args.settlement_address,
      trimString(metadata.x402_network) || "base"
    );
  }
  if (args.upstream_url !== undefined) {
    const path = endpointPatch.path || endpoint.path;
    const origin = deriveOriginUrl(args.upstream_url, path);
    listingPatch.origin_url = origin;
    listingPatch.endpoint_url = origin;
  }
  if (args.tags !== undefined) {
    listingPatch.listing_metadata = buildListingMetadataPatch(api.listing_metadata, { tags: args.tags });
  }
  if (args.status !== undefined) {
    // 'active' requests re-entry into serving; the DB review gate decides
    // whether that lands as 'active' or 'pending'. 'disabled' maps to
    // 'inactive'.
    listingPatch.status = trimString(args.status) === "disabled" ? "inactive" : "active";
  }

  let updatedEndpoint = endpoint;
  if (Object.keys(endpointPatch).length) {
    const rows = await supabaseRest(
      ctx,
      `api_endpoints?id=eq.${encodeURIComponent(endpoint.id)}&select=*`,
      { method: "PATCH", body: endpointPatch }
    );
    updatedEndpoint = (Array.isArray(rows) ? rows[0] : rows) || endpoint;
  }

  let updatedApi = api;
  if (Object.keys(listingPatch).length) {
    const rows = await supabaseRest(
      ctx,
      `apis?id=eq.${encodeURIComponent(api.id)}&select=*`,
      { method: "PATCH", body: listingPatch }
    );
    updatedApi = (Array.isArray(rows) ? rows[0] : rows) || api;
  }

  return content({
    ...routeResponse(ctx.env, updatedApi, updatedEndpoint),
    note: activationNote(updatedApi),
  });
}

async function handleUnpublishRoute(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);
  const { api, endpoint } = await fetchRouteWithApi(ctx, args.route_id);
  assertRouteOwnership(api, provider);

  const rows = await supabaseRest(
    ctx,
    `apis?id=eq.${encodeURIComponent(api.id)}&select=*,api_endpoints(id)`,
    { method: "PATCH", body: { status: "inactive" } }
  );
  const updated = (Array.isArray(rows) ? rows[0] : rows) || api;
  const siblingCount = Array.isArray(updated.api_endpoints)
    ? Math.max(0, updated.api_endpoints.length - 1)
    : 0;

  const result = {
    route_id: endpoint.id,
    status: "disabled",
    note: "Listing disabled: the paid URL no longer serves. Re-enable with update_x402_route {status: 'active'}.",
  };
  if (siblingCount > 0) {
    result.warning = `This route shares its gateway listing '${api.slug}' with ${siblingCount} other route(s); disabling took the whole listing offline.`;
  }
  return content(result);
}

async function handleTestRoute(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);
  const { api, endpoint } = await fetchRouteWithApi(ctx, args.route_id);
  assertRouteOwnership(api, provider);

  const paidUrl = buildPaidUrl(ctx.env, api.slug, endpoint.path);
  const payload = args.test_payload && typeof args.test_payload === "object" ? args.test_payload : null;

  const url = new URL(paidUrl);
  const requestInit = { method: endpoint.method, headers: { accept: "application/json" } };
  if (payload) {
    if (endpoint.method === "GET") {
      for (const [key, value] of Object.entries(payload)) {
        url.searchParams.set(key, typeof value === "string" ? value : JSON.stringify(value));
      }
    } else {
      requestInit.headers["content-type"] = "application/json";
      requestInit.body = JSON.stringify(payload);
    }
  }

  const fetchImpl = resolveFetch(ctx);
  let response;
  try {
    response = await fetchImpl(url.href, requestInit);
  } catch (error) {
    return content({
      success: false,
      paid_url: paidUrl,
      error: `Gateway unreachable: ${error.message}`,
    });
  }

  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text.slice(0, 500);
  }

  const accepts = body && typeof body === "object" && Array.isArray(body.accepts) ? body.accepts : null;
  const x402Enabled = response.status === 402 && Boolean(accepts?.length) && body?.x402Version != null;
  const listingStatus = mapListingStatus(api.status);

  let responsePreview = body;
  if (body && typeof body === "object") {
    const serialized = JSON.stringify(body);
    if (serialized.length > 4000) {
      responsePreview = `${serialized.slice(0, 4000)}…`;
    }
  }

  const result = {
    success: response.status === 402 ? x402Enabled : response.ok,
    http_status: response.status,
    paid_url: paidUrl,
    payment_required: response.status === 402,
    x402_enabled: x402Enabled,
    listing_status: listingStatus,
    response_preview: responsePreview,
  };

  if (accepts?.length) {
    const offer = accepts[0];
    result.payment_offer = {
      scheme: offer.scheme,
      network: friendlyNetworkName(offer.network),
      // x402 v2 uses `amount`; v1 used `maxAmountRequired`.
      max_amount_required: offer.amount ?? offer.maxAmountRequired,
      pay_to: offer.payTo,
      asset: offer.asset,
    };
  }

  if (response.status === 404 && listingStatus !== "active") {
    result.hint =
      listingStatus === "pending_review"
        ? "The route is still awaiting Apiosk review approval, so the gateway does not serve it yet. Re-run this test once it is approved."
        : "The route's listing is disabled. Re-enable it with update_x402_route {status: 'active'}.";
  }

  return content(result);
}

export function buildOpenApiDocument(env, api, endpoints, overrides = {}) {
  const metadata = api.listing_metadata && typeof api.listing_metadata === "object" ? api.listing_metadata : {};
  const stored = metadata.openapi && typeof metadata.openapi === "object" ? metadata.openapi : {};
  const paths = {};

  for (const endpoint of endpoints) {
    const path = endpoint.path || "/";
    paths[path] = paths[path] || {};
    const operation = {
      operationId: `${trimString(endpoint.method).toLowerCase()}${path.replace(/[^A-Za-z0-9]+/g, "_")}`,
      summary: endpoint.description || api.name,
      "x-price": { amount: String(endpoint.price), currency: "USDC", per: "request" },
      "x-payment-protocol": "x402",
      responses: {
        200: { description: "Successful, paid response." },
        402: {
          description:
            "Payment required. Body contains an x402 payment offer (x402Version, accepts[]). Pay via the x402 protocol and retry with the X-Payment header.",
        },
      },
    };

    if (endpoint.request_body && typeof endpoint.request_body === "object" && Object.keys(endpoint.request_body).length) {
      if (endpoint.method === "GET") {
        operation["x-input-schema"] = endpoint.request_body;
      } else {
        operation.requestBody = {
          content: { "application/json": { schema: endpoint.request_body } },
        };
      }
    }
    if (endpoint.response_body && typeof endpoint.response_body === "object" && Object.keys(endpoint.response_body).length) {
      operation.responses[200].content = {
        "application/json": { schema: endpoint.response_body },
      };
    }

    paths[path][trimString(endpoint.method).toLowerCase()] = operation;
  }

  for (const extra of Array.isArray(overrides.endpoints) ? overrides.endpoints : []) {
    if (extra && typeof extra === "object" && trimString(extra.path)) {
      paths[trimString(extra.path)] = { ...(paths[trimString(extra.path)] || {}), ...extra.pathItem };
    }
  }

  return {
    openapi: "3.1.0",
    info: {
      title: trimString(overrides.title) || trimString(stored.title) || api.name,
      version: trimString(overrides.version) || trimString(stored.version) || "1.0.0",
      description: api.description || undefined,
    },
    servers: [{ url: buildPaidUrl(env, api.slug, "/").replace(/\/$/, "") }],
    paths,
    "x-x402": {
      network: trimString(metadata.x402_network) || "base",
      currency: "USDC",
      discovery: `${resolveGatewayBaseUrl(env)}/.well-known/x402`,
    },
  };
}

async function handleGenerateOpenApi(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);
  const { api, endpoint } = await fetchRouteWithApi(ctx, args.route_id);
  assertRouteOwnership(api, provider);

  const overrides = {
    title: trimString(args.title) || undefined,
    version: trimString(args.version) || undefined,
    endpoints: args.endpoints,
  };

  const metadata = buildListingMetadataPatch(api.listing_metadata, {
    publisherExtras: {
      openapi: {
        title: overrides.title || api.name,
        version: overrides.version || "1.0.0",
      },
    },
  });
  await supabaseRest(ctx, `apis?id=eq.${encodeURIComponent(api.id)}`, {
    method: "PATCH",
    body: { listing_metadata: metadata },
  });

  const endpoints = await supabaseRest(
    ctx,
    `api_endpoints?api_id=eq.${encodeURIComponent(api.id)}&select=*`
  );
  const document = buildOpenApiDocument(
    ctx.env,
    { ...api, listing_metadata: metadata },
    Array.isArray(endpoints) ? endpoints : [endpoint],
    overrides
  );

  return content({
    route_id: endpoint.id,
    openapi_url: `${resolveMcpPublicBaseUrl(ctx.env)}/openapi/${endpoint.id}.json`,
    preview: { info: document.info, paths: Object.keys(document.paths) },
  });
}

async function handlePublishProject(args, authInfo, ctx) {
  const provider = await requireProvider(authInfo, ctx);

  const projectName = trimString(args.project_name);
  if (!projectName) throw new Error("Missing required field: project_name");
  const routesInput = Array.isArray(args.routes) ? args.routes : [];
  if (!routesInput.length) throw new Error("routes must contain at least one route.");

  const baseUrl = new URL(trimString(args.base_url));
  if (baseUrl.protocol !== "https:") throw new Error("base_url must be HTTPS.");
  const origin = `${baseUrl.origin}${baseUrl.pathname}`.replace(/\/+$/, "");
  const network = resolveNetwork(args.network);

  const { api } = await upsertListing(ctx, provider, {
    name: projectName,
    description: args.description || projectName,
    origin_url: origin,
    settlement_address: args.settlement_address,
    network,
    tags: args.tags,
  });

  const { networkTokenId, warning } = await resolveNetworkTokenId(ctx, network);
  const routes = [];
  for (const route of routesInput) {
    const endpoint = await upsertEndpoint(ctx, api.id, {
      method: resolveMethod(route.method),
      path: normalizePath(route.path),
      price: parsePriceUsdc(route.price),
      description: route.description || route.name || projectName,
      inputSchema: route.input_schema,
      outputSchema: route.output_schema,
      networkTokenId,
    });
    routes.push({
      route_id: endpoint.id,
      name: trimString(route.name) || projectName,
      paid_url: buildPaidUrl(ctx.env, api.slug, endpoint.path),
      method: endpoint.method,
      path: endpoint.path,
      price: String(endpoint.price),
    });
  }

  const result = {
    project_id: api.id,
    project_slug: api.slug,
    status: mapListingStatus(api.status),
    routes_created: routes.length,
    routes,
    note: activationNote(api),
  };
  if (warning) result.warning = warning;
  return content(result);
}

// Public (unauthenticated) helpers used by server.mjs HTTP routes. ---------

export async function getOpenApiRouteDocument(routeId, { env = process.env, fetchImpl } = {}) {
  const ctx = { env, fetchImpl };
  const id = trimString(routeId).replace(/\.json$/i, "");
  if (!id) return null;

  let route;
  try {
    route = await fetchRouteWithApi(ctx, id);
  } catch {
    return null;
  }

  const endpoints = await supabaseRest(
    ctx,
    `api_endpoints?api_id=eq.${encodeURIComponent(route.api.id)}&select=*`
  );
  return buildOpenApiDocument(
    env,
    route.api,
    Array.isArray(endpoints) && endpoints.length ? endpoints : [route.endpoint]
  );
}

// CAIP-2 chain ids (x402 v2) → the friendly network names the publisher
// tools speak. Unknown ids pass through untouched.
const CAIP2_NETWORK_NAMES = {
  "eip155:8453": "base",
  "eip155:137": "polygon",
  "eip155:42161": "arbitrum",
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana",
};

function friendlyNetworkName(network) {
  const value = trimString(network);
  if (!value) return "base";
  if (CAIP2_NETWORK_NAMES[value]) return CAIP2_NETWORK_NAMES[value];
  if (value.startsWith("solana:")) return "solana";
  return value;
}

export function reshapeDiscoveryItems(env, wellKnownDocument) {
  const items = Array.isArray(wellKnownDocument?.items) ? wellKnownDocument.items : [];
  return items.map((item) => {
    const offer = Array.isArray(item.accepts) ? item.accepts[0] : null;
    const metadata = item.metadata && typeof item.metadata === "object" ? item.metadata : {};
    // x402 v2 calls the atomic amount `amount`; v1 called it
    // `maxAmountRequired`. Both are USDC 6-decimal atomic units.
    const atomic = Number.parseInt(
      trimString(offer?.amount ?? offer?.maxAmountRequired),
      10
    );
    return {
      name: metadata.name || metadata.api || undefined,
      description: metadata.description || undefined,
      url: item.resource,
      method: metadata.method || "GET",
      price: Number.isFinite(atomic) ? (atomic / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "") : undefined,
      currency: "USDC",
      network: friendlyNetworkName(offer?.network),
      pay_to: offer?.payTo || undefined,
      x402_version: item.x402Version ?? wellKnownDocument?.x402Version ?? 1,
    };
  });
}

export async function buildDiscoveryDocument({ env = process.env, fetchImpl } = {}) {
  if (discoveryCache && discoveryCache.expiresAt > Date.now()) {
    return discoveryCache.document;
  }

  const gateway = resolveGatewayBaseUrl(env);
  const doFetch = fetchImpl || globalThis.fetch;
  const response = await doFetch(`${gateway}/.well-known/x402`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Gateway discovery document unavailable (HTTP ${response.status}).`);
  }
  const wellKnown = await response.json();

  const routes = reshapeDiscoveryItems(env, wellKnown);
  const document = {
    name: "Apiosk paid API routes",
    description:
      "Machine-readable index of paid x402 routes published through Apiosk. Each route returns 402 Payment Required with an x402 offer until paid in USDC.",
    generated_from: `${gateway}/.well-known/x402`,
    mcp_endpoint: `${resolveMcpPublicBaseUrl(env)}/mcp`,
    count: routes.length,
    routes,
  };

  discoveryCache = { document, expiresAt: Date.now() + DISCOVERY_CACHE_TTL_MS };
  return document;
}

export function clearPublisherCaches() {
  providerKeyCache.clear();
  discoveryCache = null;
}

export async function handlePublisherTool(name, args = {}, authInfo = null, ctx = {}) {
  const context = { env: ctx.env || process.env, fetchImpl: ctx.fetchImpl };

  try {
    if (name === "publish_x402_route") return await handlePublishRoute(args, authInfo, context);
    if (name === "update_x402_route") return await handleUpdateRoute(args, authInfo, context);
    if (name === "list_x402_routes") return await handleListRoutes(args, authInfo, context);
    if (name === "unpublish_x402_route") return await handleUnpublishRoute(args, authInfo, context);
    if (name === "test_x402_route") return await handleTestRoute(args, authInfo, context);
    if (name === "generate_openapi_spec") return await handleGenerateOpenApi(args, authInfo, context);
    if (name === "publish_project") return await handlePublishProject(args, authInfo, context);
    return errorContent(`Unknown publisher tool: ${name}`);
  } catch (error) {
    return errorContent({ error: error instanceof Error ? error.message : String(error) });
  }
}
