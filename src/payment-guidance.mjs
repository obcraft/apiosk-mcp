// Payment guidance for the Apiosk gateway.
//
// This module turns the Apiosk settlement model into agent-readable guidance
// that is surfaced at discovery time (search/explore/get_api) and through the
// dedicated apiosk_payment_guide tool. It covers BOTH sides of the gateway:
//   - buyers: how an agent pays for a paid API call (USDC over x402),
//     tailored to what auth the runtime currently has.
//   - providers (sellers): how to publish an API so other agents can pay for it.
//
// Everything here is pure (no I/O) so it stays trivially testable and fast.

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Settlement rails shared across every guide. Kept aligned with the
// apiosk_help topic='rails' payload so agents see one consistent story.
export const SETTLEMENT_RAILS = [
  {
    id: "usdc_x402",
    label: "USDC over x402 (Base)",
    summary:
      "On-chain USDC on Base (chain 8453), settled per call via an x402 payment proof signed by the agent's wallet or APIOSK_PRIVATE_KEY.",
    best_for: "Autonomous agents that hold a funded Base USDC wallet.",
    setup: "Fund a wallet with Base mainnet USDC, then settlement happens automatically per call.",
  },
];

// The order the gateway tries to cover a paid call. A 402 is only returned
// when none of the buyer's enabled rails can settle.
export const RAIL_FALLBACK_ORDER = [
  "1. USDC / x402 wallet when the agent can produce a payment proof.",
];

function resolvePrice(api) {
  if (!api || typeof api !== "object") return null;
  const raw =
    api.price_usd ??
    api.listing_metadata?.cost_per_call ??
    api.detail?.price_usd ??
    api.cost_per_call ??
    null;
  if (raw === null || raw === undefined) return null;
  const price = Number(raw);
  return Number.isFinite(price) ? price : null;
}

// Map the runtime's auth method onto whether the agent can settle a paid call
// right now, plus the single clearest next step to become payment-ready.
function describeReadiness(capability = {}, { localWalletsEnabled = false, mode = "remote" } = {}) {
  const method = String(capability.method || "none");
  const walletAddress = capability.wallet_address || null;

  switch (method) {
    case "env_private_key":
      return {
        ready: true,
        status: "ready_to_pay",
        active_method: "APIOSK_PRIVATE_KEY",
        detail:
          "An environment private key is configured, so the SDK auto-settles supported x402 calls. Fund this wallet with Base USDC if a call returns payment_required.",
      };
    case "local_wallet":
      return {
        ready: true,
        status: "ready_to_pay",
        active_method: "local wallet",
        detail:
          "A local wallet is selected and used automatically for paid calls. Fund it with Base USDC (apiosk_show_wallet_funding) if a call returns payment_required.",
      };
    case "connect_token":
    case "request_connect_token":
      return {
        ready: true,
        status: "ready_to_pay",
        active_method: "Apiosk connect token",
        detail:
          "A managed connect token is active. The gateway settles each call from the authorized USDC managed wallet server-side, no signing needed here.",
      };
    case "wallet_address":
      return {
        ready: false,
        status: "setup_required",
        active_method: "wallet address only",
        detail:
          "A wallet address is known but no signing key or connect token is configured, so this surface cannot settle x402 calls itself.",
      };
    default:
      return {
        ready: false,
        status: "setup_required",
        active_method: "none",
        detail: localWalletsEnabled
          ? "No payment method is configured yet. Run apiosk_get_started to create a wallet, or import a dashboard connect string."
          : mode === "hosted"
            ? "No buyer is authorized yet. Authorize the Apiosk app when your MCP client prompts so calls settle against your managed wallet."
            : "No payment method is configured. Set APIOSK_PRIVATE_KEY or APIOSK_CONNECT_TOKEN, or run the local stdio package and call apiosk_get_started.",
      };
  }
}

// Concrete, ordered steps to go from "found an API" to "paid call succeeded",
// tailored to the current readiness and server mode.
function buildHowToPaySteps({ readiness, localWalletsEnabled, mode, slug }) {
  const execHint = slug
    ? `Call the API's dynamic tool or apiosk_execute with slug "${slug}".`
    : "Call the API's dynamic tool (see tool_name) or apiosk_execute with the slug.";

  if (readiness.ready) {
    return [
      execHint,
      "Settlement is automatic, the gateway charges the active method and returns the result.",
      "If a call still returns payment_required, fund the wallet with USDC on Base and retry.",
    ];
  }

  if (localWalletsEnabled) {
    return [
      "Run apiosk_get_started to create or select a local wallet (or import a dashboard connect string).",
      "Fund the wallet with Base mainnet USDC using apiosk_show_wallet_funding.",
      execHint,
    ];
  }

  if (mode === "hosted") {
    return [
      "Authorize the Apiosk app when your MCP client prompts, so calls settle against your managed wallet.",
      execHint,
      "If a call returns payment_required, fund your managed wallet with USDC on Base, then retry.",
    ];
  }

  return [
    "Configure settlement: set APIOSK_PRIVATE_KEY (autonomous x402) or APIOSK_CONNECT_TOKEN (managed rails) in the MCP environment.",
    "Or run the local stdio package (npx -y @apiosk/mcp) and call apiosk_get_started.",
    execHint,
  ];
}

/**
 * Buyer-side payment guidance, optionally scoped to one listing.
 * Surfaced inline in discovery responses and inside apiosk_payment_guide.
 */
export function buildPaymentGuidance({
  api = null,
  capability = {},
  mode = "remote",
  localWalletsEnabled = false,
} = {}) {
  const price = resolvePrice(api);
  const isFree = price !== null && price <= 0;
  const slug = api?.slug || api?.detail?.slug || null;
  const readiness = describeReadiness(capability, { localWalletsEnabled, mode });

  if (isFree) {
    return {
      role: "buyer",
      summary: `This listing is free (cost_per_call ${price}). Call it directly, no payment required.`,
      cost_per_call_usd: price,
      free: true,
      status: "ready_to_pay",
      how_to_pay: [
        slug
          ? `Call the dynamic tool or apiosk_execute with slug "${slug}".`
          : "Call the dynamic tool (see tool_name) or apiosk_execute with the slug.",
      ],
      settlement_rails: SETTLEMENT_RAILS,
    };
  }

  return {
    role: "buyer",
    summary: slug
      ? `How to pay for "${slug}" through the Apiosk gateway.`
      : "How an agent pays for paid Apiosk APIs.",
    cost_per_call_usd: price,
    free: false,
    status: readiness.status,
    payment_ready: readiness.ready,
    active_method: readiness.active_method,
    readiness_detail: readiness.detail,
    active_wallet_address: capability.wallet_address || null,
    how_to_pay: buildHowToPaySteps({ readiness, localWalletsEnabled, mode, slug }),
    settlement_rails: SETTLEMENT_RAILS,
    rail_fallback_order: RAIL_FALLBACK_ORDER,
    on_payment_required:
      "A paid call can return a structured payment_required error when the wallet cannot cover it. Fund the wallet with USDC on Base, then retry the same call.",
    base_chain: { chain_id: BASE_CHAIN_ID, usdc_contract: BASE_USDC_CONTRACT, network: "base" },
    learn_more: "Call apiosk_help with topic='rails' for the full settlement model.",
  };
}

/**
 * Provider-side (seller) guidance: how to publish an API so other agents can
 * discover and pay for it through the gateway.
 */
export function buildProviderGuidance({ mode = "remote", localWalletsEnabled = false } = {}) {
  const canPublishHere = localWalletsEnabled;

  return {
    role: "provider",
    summary:
      "How to list an API or MCP toolset on Apiosk so other agents discover it and pay you per call.",
    publish_channel: canPublishHere
      ? "This local stdio package can publish directly with a signed wallet (apiosk_publish_api)."
      : mode === "hosted"
        ? "This hosted surface is read-only for publishing. Publish from the provider portal or the local stdio package."
        : "Run the local stdio package (npx -y @apiosk/mcp, or the legacy apiosk-mcp-server package) to publish with a signed wallet, or use the provider portal.",
    steps: [
      canPublishHere
        ? "Create or select a signing wallet: apiosk_wallet_create then apiosk_wallet_select (or set APIOSK_PRIVATE_KEY). This wallet receives USDC payouts."
        : "Set up a signing wallet via the local stdio package or sign up in the provider portal.",
      "Expose your API over HTTPS. The endpoint receives the forwarded request body and returns JSON.",
      "Publish it with apiosk_publish_api: name, slug (lowercase-with-hyphens), endpoint_url (https), price_usd, and description.",
      "Verify it is live: apiosk_list_my_apis. It now appears in apiosk_search/apiosk_explore for every agent.",
      "Manage it over time with apiosk_update_api (price, endpoint, active) and apiosk_delete_api.",
    ],
    mcp_provider_flow: [
      "Host your MCP over HTTPS and support initialize, tools/list, and tools/call.",
      "Protect the upstream MCP with bearer auth or another server-side secret; Apiosk injects that credential after payment.",
      "Import the MCP in the provider portal. Apiosk scans tools/list and creates one paid action per selected tool.",
      "Buyers should use https://mcp.apiosk.com/mcp, GET https://gateway.apiosk.com/<slug>/metadata, or POST https://gateway.apiosk.com/<slug>/execute, not your raw MCP URL.",
      "Your MCP should not return 402 or inspect X-Payment. Apiosk handles payment challenges, settlement, and revenue splits before calling your MCP.",
    ],
    requirements: [
      "A signing wallet must be active (local wallet or APIOSK_PRIVATE_KEY).",
      "endpoint_url must use HTTPS.",
      "slug must use lowercase letters, numbers, and hyphens only.",
      "For MCP imports, the provider MCP should be reachable over HTTPS and locked down so only Apiosk can call it directly.",
    ],
    listing_metadata_note:
      "MCP-native metadata (operations, input/output schema, default_operation, mcp_tool) is generated automatically from your inputs. Override it via the listing_metadata argument when you need a custom tool shape.",
    earnings: {
      summary: "Providers receive each call's gross minus the current Apiosk platform fee. The gateway default is 2%.",
      usdc: "USDC earnings settle to the API's payout wallet (the publishing wallet address).",
      offramp:
        "Optional crypto→EUR off-ramp: providers can sign a non-custodial mandate so accumulated USDC auto-converts to EUR and redeems to their IBAN.",
    },
    identity_note:
      "apiosk_publish_api manages listings via wallet signature (the community/MCP publish channel). The provider portal uses a separate Supabase-auth identity after KYB; listings do not currently round-trip between the two surfaces.",
    tools: ["apiosk_publish_api", "apiosk_list_my_apis", "apiosk_update_api", "apiosk_delete_api"],
  };
}

/**
 * Full payload for the dedicated apiosk_payment_guide tool. role selects which
 * side(s) to return: "buyer" | "provider" | "both" (default).
 */
export function buildPaymentGuide({
  role = "both",
  api = null,
  capability = {},
  mode = "remote",
  localWalletsEnabled = false,
} = {}) {
  const normalizedRole = ["buyer", "provider", "both"].includes(role) ? role : "both";

  const payload = {
    role: normalizedRole,
    overview:
      "Apiosk is one gateway, any rail: a single buyer identity can pay for any API over USDC (x402 on Base) or prepaid credits, the gateway picks the rail per call. Providers list APIs once and get paid per call.",
    quickstart: {
      buyer: [
        "Discover: apiosk_search or apiosk_explore.",
        "Inspect: apiosk_get_api for price, schema, and a per-listing payment block.",
        "Pay & run: call the dynamic tool or apiosk_execute, settlement is automatic once a rail is configured.",
      ],
      provider: [
        "Get a signing wallet (apiosk_wallet_create or APIOSK_PRIVATE_KEY).",
        "Publish: apiosk_publish_api with name, slug, https endpoint_url, price_usd, description.",
        "Confirm: apiosk_list_my_apis, your listing is now discoverable and payable.",
      ],
    },
  };

  if (normalizedRole === "buyer" || normalizedRole === "both") {
    payload.buyer = buildPaymentGuidance({ api, capability, mode, localWalletsEnabled });
  }
  if (normalizedRole === "provider" || normalizedRole === "both") {
    payload.provider = buildProviderGuidance({ mode, localWalletsEnabled });
  }

  return payload;
}

// Compact buyer hint attached to multi-result discovery responses so an agent
// learns how to pay without a second tool call, without bloating every entry.
export function buildDiscoveryPaymentHint({ capability = {}, mode = "remote", localWalletsEnabled = false } = {}) {
  const readiness = describeReadiness(capability, { localWalletsEnabled, mode });
  return {
    payment_ready: readiness.ready,
    active_method: readiness.active_method,
    how_to_pay: readiness.ready
      ? "Paid calls settle automatically, just call the tool or apiosk_execute."
      : readiness.detail,
    settlement_rails: SETTLEMENT_RAILS.map((rail) => rail.id),
    learn_more: "Call apiosk_payment_guide for full buyer + provider instructions.",
  };
}
