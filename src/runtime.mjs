import { ApioskClient, ApioskPaymentRequiredError } from "@apiosk/sdk";
import { privateKeyToAccount } from "viem/accounts";

import { buildFundingOptions } from "./funding-options.mjs";
import { requestGatewayManagement } from "./gateway-management.mjs";
import { buildListingMetadata, resolveCategory } from "./listing-metadata.mjs";
import {
  buildDiscoveryPaymentHint,
  buildPaymentGuidance,
  buildPaymentGuide,
} from "./payment-guidance.mjs";
import {
  createApioskLocalConfigPaths,
  parseConnectString,
  readLocalApioskConfig,
  saveLocalApioskDashboardSession,
  saveLocalApioskConfig,
} from "./local-config.mjs";
import { createLocalWalletStore } from "./wallet-store.mjs";

const DEFAULT_LIMIT = 25;
const CACHE_TTL_MS = 60_000;
const DEFAULT_GATEWAY_BASE_URL = "https://gateway.apiosk.com";

const DASHBOARD_WALLET_TOOLS = [
  {
    name: "apiosk_list_wallets",
    description: "List the signed-in user's managed Apiosk wallets. Requires an Apiosk dashboard session from local env auth or hosted MCP authorization.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "apiosk_create_wallet",
    description: "Create or import a managed Apiosk wallet for the signed-in user.",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string" },
        mode: {
          type: "string",
          enum: ["create", "import_private_key", "import_phrase"],
        },
        secret: {
          type: "string",
          description: "Private key or recovery phrase when importing.",
        },
        daily_limit_usdc: { type: "number" },
        per_tx_limit_usdc: { type: "number" },
      },
    },
  },
  {
    name: "apiosk_update_wallet",
    description: "Update wallet label, status, display metadata, or spending limits.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        label: { type: "string" },
        status: {
          type: "string",
          enum: ["active", "paused", "revoked"],
        },
        daily_limit_usdc: { type: "number" },
        per_tx_limit_usdc: { type: "number" },
        color: { type: "string" },
        icon: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_delete_wallet",
    description: "Delete one of the signed-in user's wallets.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_get_wallet_activity",
    description: "Fetch recent transactions and activity for one managed wallet.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        page: { type: "number" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "apiosk_create_wallet_connect_string",
    description: "Rotate or create a connect token for a managed wallet and return the new connect string.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        token_name: { type: "string" },
        revoke_existing: { type: "boolean" },
        private_key: {
          type: "string",
          description: "Optional legacy recovery key when requested by the backend.",
        },
      },
    },
  },
  {
    name: "apiosk_list_wallet_api_keys",
    description: "List API keys / connect tokens for a managed wallet.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_create_wallet_api_key",
    description: "Create a new API key / connect token for a managed wallet.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        name: { type: "string" },
        expiration_days: { type: "number" },
        revoke_existing: { type: "boolean" },
        private_key: {
          type: "string",
          description: "Optional legacy recovery key when requested by the backend.",
        },
      },
    },
  },
  {
    name: "apiosk_update_wallet_api_key",
    description: "Rename, revoke, or extend an existing managed wallet API key.",
    inputSchema: {
      type: "object",
      required: ["wallet_id", "key_id"],
      properties: {
        wallet_id: { type: "string" },
        key_id: { type: "string" },
        name: { type: "string" },
        expiration_days: { type: "number" },
        revoke: { type: "boolean" },
      },
    },
  },
  {
    name: "apiosk_delete_wallet_api_key",
    description: "Delete an existing managed wallet API key permanently.",
    inputSchema: {
      type: "object",
      required: ["wallet_id", "key_id"],
      properties: {
        wallet_id: { type: "string" },
        key_id: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_show_wallet_funding",
    description:
      "Show the buyer's Apiosk wallet address with a scannable QR code so they can fund it manually by sending USDC on Base mainnet from another wallet or exchange. Defaults to the user's first managed wallet when wallet_id is omitted. Always reminds the buyer that only Base mainnet USDC is accepted.",
    inputSchema: {
      type: "object",
      properties: {
        wallet_id: {
          type: "string",
          description:
            "Optional. Wallet to show funding info for. Defaults to the user's first managed wallet.",
        },
      },
    },
  },
];

const LOCAL_ACCOUNT_AND_CREDITS_TOOLS = [
  {
    name: "apiosk_create_account",
    description:
      "Create an Apiosk dashboard account for credits-based payments. Local stdio only; saves the returned dashboard session token locally when available.",
    inputSchema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string" },
        password: { type: "string" },
        save_session: {
          type: "boolean",
          description: "Defaults to true when a session token is returned immediately.",
        },
      },
    },
  },
  {
    name: "apiosk_sign_in",
    description:
      "Sign into an existing Apiosk dashboard account and save the session token locally for credits and managed-wallet tools.",
    inputSchema: {
      type: "object",
      required: ["email", "password"],
      properties: {
        email: { type: "string" },
        password: { type: "string" },
        save_session: {
          type: "boolean",
          description: "Defaults to true.",
        },
      },
    },
  },
];

const REMOTE_CREDITS_TOOLS = [];

const LOCAL_WALLET_TOOLS = [
  {
    name: "apiosk_wallet_list",
    description: "List locally stored Apiosk wallets and show which one is active for autonomous pay and publish.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: "apiosk_wallet_create",
    description: "Create or import a local wallet for autonomous Apiosk payments and publishing. The active wallet is mirrored to ~/.apiosk/wallet.json and ~/.apiosk/wallet.txt for legacy compatibility.",
    inputSchema: {
      type: "object",
      required: ["label"],
      properties: {
        label: { type: "string" },
        mode: {
          type: "string",
          enum: ["create", "import_private_key", "import_phrase"],
          description: "Defaults to create.",
        },
        secret: {
          type: "string",
          description: "Private key or recovery phrase when importing.",
        },
        set_active: {
          type: "boolean",
          description: "Defaults to true.",
        },
        return_secret: {
          type: "boolean",
          description: "Only enable this when the user explicitly asks to see the private key.",
        },
        save_secret: {
          type: "boolean",
          description: "When true, also export the secret key to a local file.",
        },
        save_to: {
          type: "string",
          description: "Optional output path for the exported secret key.",
        },
        save_format: {
          type: "string",
          enum: ["json", "txt"],
        },
        include_qr_data_url: {
          type: "boolean",
          description: "Include a QR data URL alongside the terminal QR when the client can render images.",
        },
      },
    },
  },
  {
    name: "apiosk_get_started",
    description: "Set up local Apiosk access by importing a connect string or creating/selecting a wallet, then run a discovery probe and a small test call.",
    inputSchema: {
      type: "object",
      properties: {
        connect_string: {
          type: "string",
          description: "Optional dashboard connect string to save locally for managed access.",
        },
        connect_token: {
          type: "string",
          description: "Optional connect token to save locally when you do not have the full connect string.",
        },
        connect_authorization: {
          type: "string",
          description: "Optional Authorization header value to save alongside a managed connect token.",
        },
        connect_header_name: {
          type: "string",
          description: "Optional connect header override. Defaults to X-Apiosk-Connect-Token.",
        },
        wallet_address: {
          type: "string",
          description: "Optional wallet address to save with a managed connect token.",
        },
        wallet_id: {
          type: "string",
          description: "Optional existing local wallet id to select before running the test call.",
        },
        wallet_label: {
          type: "string",
          description: "Label to use if a new local wallet must be created. Defaults to Apiosk wallet.",
        },
        create_wallet: {
          type: "boolean",
          description: "Defaults to true when no managed connect token is configured.",
        },
        test_slug: {
          type: "string",
          description: "Optional API slug for the test call. Defaults to the first discovered API.",
        },
        test_operation: {
          type: "string",
          description: "Optional explicit operation for the test call.",
        },
        test_input: {
          description: "Optional JSON input for the test call. Defaults to an empty object.",
        },
        include_qr_data_url: {
          type: "boolean",
          description: "Include QR image data when funding instructions are returned.",
        },
      },
    },
  },
  {
    name: "apiosk_configure",
    description: "Show a structured Apiosk control menu for a wallet, including funding instructions, QR code output when available, and wallet/pay/publish/data actions.",
    inputSchema: {
      type: "object",
      properties: {
        wallet_id: { type: "string" },
        section: {
          type: "string",
          enum: ["overview", "funding", "wallet", "payments", "publish", "data", "security"],
        },
        funding_provider: {
          type: "string",
          enum: ["manual", "transak", "onramper"],
        },
        include_qr_data_url: {
          type: "boolean",
          description: "Include a QR data URL alongside the terminal QR when supported by the client.",
        },
      },
    },
  },
  {
    name: "apiosk_wallet_select",
    description: "Select the active local wallet used by apiosk_execute, dynamic API tools, and publish tools.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        include_qr_data_url: {
          type: "boolean",
          description: "Include a QR data URL alongside the terminal QR when supported by the client.",
        },
      },
    },
  },
  {
    name: "apiosk_wallet_update",
    description: "Rename a local wallet or mark it active.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        label: { type: "string" },
        set_active: { type: "boolean" },
      },
    },
  },
  {
    name: "apiosk_wallet_delete",
    description: "Delete a local wallet from the MCP keystore.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_wallet_reveal_secret",
    description: "Reveal a local wallet's private key. Only call this when the user explicitly asks to see the secret key.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_wallet_save_secret",
    description: "Save a local wallet's private key to a file without going through the dashboard.",
    inputSchema: {
      type: "object",
      required: ["wallet_id"],
      properties: {
        wallet_id: { type: "string" },
        path: {
          type: "string",
          description: "Optional output path. Defaults to a file under ~/.apiosk/exports.",
        },
        format: {
          type: "string",
          enum: ["json", "txt"],
        },
      },
    },
  },
];

const PUBLISH_TOOLS = [
  {
    name: "apiosk_publish_api",
    description: "Publish a new API on Apiosk using the active local wallet or APIOSK_PRIVATE_KEY. No dashboard required.",
    inputSchema: {
      type: "object",
      required: ["name", "slug", "endpoint_url", "price_usd", "description"],
      properties: {
        wallet_id: { type: "string" },
        name: { type: "string" },
        slug: { type: "string" },
        endpoint_url: { type: "string" },
        price_usd: { type: "number" },
        description: { type: "string" },
        category: { type: "string" },
        listing_group: {
          type: "string",
          enum: ["api", "datasets", "compute"],
        },
        listing_metadata: {
          type: "object",
          additionalProperties: true,
          description: "Optional MCP-native metadata override. Defaults are generated automatically.",
        },
      },
    },
  },
  {
    name: "apiosk_list_my_apis",
    description: "List the APIs owned by the active local wallet or APIOSK_PRIVATE_KEY.",
    inputSchema: {
      type: "object",
      properties: {
        wallet_id: { type: "string" },
      },
    },
  },
  {
    name: "apiosk_update_api",
    description: "Update a published Apiosk API with signed wallet auth.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        wallet_id: { type: "string" },
        slug: { type: "string" },
        endpoint_url: { type: "string" },
        price_usd: { type: "number" },
        description: { type: "string" },
        active: { type: "boolean" },
        listing_metadata: {
          type: "object",
          additionalProperties: true,
        },
      },
    },
  },
  {
    name: "apiosk_delete_api",
    description: "Delete or deactivate one of your published Apiosk APIs with signed wallet auth.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        wallet_id: { type: "string" },
        slug: { type: "string" },
      },
    },
  },
];

const HELP_TOOL = {
  name: "apiosk_help",
  description: "Explain what Apiosk MCP is, how to connect it, how auth and x402 payments work, the settlement rails (USDC, SEPA incasso / direct debit, credits), and the recommended workflow for discovery, wallets, and publishing.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      topic: {
        type: "string",
        enum: ["overview", "setup", "auth", "workflow", "payments", "rails", "wallets", "publish", "configure"],
        description: "Optional help topic. Defaults to overview. Use 'rails' to learn how settlement works across USDC, SEPA incasso (direct debit), and credits.",
      },
    },
  },
};

const EXPLORE_TOOL = {
  name: "apiosk_explore",
  description: "Browse Apiosk listing groups and explore one group at a time before narrowing with search.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      listing_type: {
        type: "string",
        enum: ["api", "dataset", "service", "connector", "skill", "product"],
      },
      search: {
        type: "string",
        description: "Optional free-text search when listing_type is set.",
      },
      sort: {
        type: "string",
        enum: ["name", "price", "newest"],
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
      },
      limit: {
        type: "number",
      },
      offset: {
        type: "number",
      },
    },
  },
};

const SEARCH_TOOL = {
  name: "apiosk_search",
  description: "Search and browse the Apiosk catalog. Use this first when you need to find APIs by capability, price, or category.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description: "Free-text search over API names and descriptions.",
      },
      category: {
        type: "string",
        description: "Optional category filter.",
      },
      sort: {
        type: "string",
        enum: ["name", "price", "newest"],
        description: "Sort order for results.",
      },
      order: {
        type: "string",
        enum: ["asc", "desc"],
        description: "Sort direction.",
      },
      limit: {
        type: "number",
        description: "Maximum number of APIs to return.",
      },
      offset: {
        type: "number",
        description: "Pagination offset.",
      },
    },
  },
};

const METADATA_TOOL_INPUT_SCHEMA = {
  type: "object",
  required: ["slug"],
  properties: {
    slug: {
      type: "string",
      description: "Apiosk API slug, for example 'agent-json-diff'.",
    },
  },
};

const GET_API_TOOL = {
  name: "apiosk_get_api",
  description: "Fetch full listing detail and agent metadata for a specific Apiosk API slug.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: METADATA_TOOL_INPUT_SCHEMA,
};

const METADATA_TOOL = {
  name: "apiosk_metadata",
  description: "Fetch full listing detail and agent metadata for a specific Apiosk API slug.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: METADATA_TOOL_INPUT_SCHEMA,
};

const EXECUTE_TOOL = {
  name: "apiosk_execute",
  description: "Execute any Apiosk API by slug through the uniform /execute contract.",
  annotations: {
    readOnlyHint: false,
    openWorldHint: true,
    destructiveHint: true,
  },
  inputSchema: {
    type: "object",
    required: ["slug"],
    properties: {
      slug: {
        type: "string",
        description: "Apiosk API slug.",
      },
      operation: {
        type: "string",
        description: "Optional explicit operation id or path.",
      },
      input: {
        type: "object",
        additionalProperties: true,
        description: "Raw JSON body for the default operation, or the envelope input field when operation is provided.",
      },
      query: {
        type: "object",
        additionalProperties: true,
        description: "Optional query override when using the execute envelope.",
      },
      path_params: {
        type: "object",
        additionalProperties: true,
        description: "Optional path parameter override when using the execute envelope.",
      },
    },
  },
};

const HEALTH_TOOL = {
  name: "apiosk_health",
  description: "Report Apiosk MCP runtime status and the configured gateway base URL.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {},
  },
};

const PAYMENT_GUIDE_TOOL = {
  name: "apiosk_payment_guide",
  description:
    "Explain how to pay through the Apiosk gateway. Returns a buyer guide (how an agent settles a paid API call over USDC/x402, SEPA incasso, or credits, tailored to the current auth) and a provider guide (how to publish an API and get paid). Pass slug to scope buyer guidance to one listing, or role to pick a side.",
  annotations: {
    readOnlyHint: true,
    openWorldHint: false,
    destructiveHint: false,
  },
  inputSchema: {
    type: "object",
    properties: {
      role: {
        type: "string",
        enum: ["buyer", "provider", "both"],
        description: "Which side to explain. Defaults to both.",
      },
      slug: {
        type: "string",
        description: "Optional API slug to scope buyer guidance (price, payment steps) to one listing.",
      },
    },
  },
};

const DISCOVERY_TOOLS = [
  HELP_TOOL,
  PAYMENT_GUIDE_TOOL,
  EXPLORE_TOOL,
  SEARCH_TOOL,
  GET_API_TOOL,
  EXECUTE_TOOL,
];
// Discovery + payment guidance available to every remote buyer, even before
// they authorize (these tools are public / read-only).
const HOSTED_DISCOVERY_TOOLS = [
  HELP_TOOL,
  PAYMENT_GUIDE_TOOL,
  SEARCH_TOOL,
  EXPLORE_TOOL,
  GET_API_TOOL,
  METADATA_TOOL,
  EXECUTE_TOOL,
  HEALTH_TOOL,
];

// Managed buyer tools that work over request-scoped dashboard auth on the
// hosted endpoint: prepaid credits + full managed agent-wallet CRUD. These are
// protected (the OAuth layer requires authorization before they run).
// apiosk_show_wallet_funding is intentionally excluded — it resolves a local /
// env wallet, which does not exist on the hosted surface.
const HOSTED_MANAGED_TOOLS = [
  ...REMOTE_CREDITS_TOOLS,
  ...DASHBOARD_WALLET_TOOLS.filter((tool) => tool.name !== "apiosk_show_wallet_funding"),
];

// The hosted/remote surface is fully capable: discovery, payment guidance,
// generic + dynamic per-API execution, credits, and managed-wallet management.
// Publishing stays local/portal-only because it requires a client-side signing
// key the hosted server never holds.
const HOSTED_REMOTE_TOOLS = [...HOSTED_DISCOVERY_TOOLS, ...HOSTED_MANAGED_TOOLS];

const ALL_STATIC_TOOLS = [
  ...DISCOVERY_TOOLS,
  ...HOSTED_REMOTE_TOOLS,
  ...LOCAL_ACCOUNT_AND_CREDITS_TOOLS,
  ...LOCAL_WALLET_TOOLS,
  ...DASHBOARD_WALLET_TOOLS,
  ...PUBLISH_TOOLS,
];

const PUBLIC_STATIC_TOOL_NAMES = new Set(
  DISCOVERY_TOOLS.map((tool) => tool.name).filter((name) => name !== "apiosk_execute")
);
const REMOTE_PROTECTED_STATIC_TOOL_NAMES = new Set([
  "apiosk_execute",
  ...REMOTE_CREDITS_TOOLS.map((tool) => tool.name),
  ...DASHBOARD_WALLET_TOOLS.map((tool) => tool.name),
]);

function trimString(value) {
  return String(value || "").trim();
}

function sanitizeToolName(name, fallback) {
  const candidate = String(name || fallback || "apiosk_tool")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return candidate || "apiosk_tool";
}

/**
 * Map the gateway's boolean active/verified flags onto the provider-portal's
 * three-state listing lifecycle (live | pending | disabled). The portal writes
 * apis.status (active|inactive) and the gateway auto-verifies owner-owned
 * (KYB-gated) listings, so for a catalog reader: not active -> disabled,
 * active but unverified -> pending review, active + verified -> live.
 *
 * NOTE: the public catalog (GET /v1/apis) hard-filters to active AND verified
 * rows, so entries built from it are always "live" — the field documents that
 * invariant for catalog readers. The pending/disabled branches are reached when
 * this runs over a richer object (e.g. a get_api_detail response, which returns
 * the real active/verified flags).
 */
function deriveListingStatus(api) {
  if (api.active === false) return "disabled";
  if (api.verified === false) return "pending";
  return "live";
}

function buildCatalogEntry(api, toolName) {
  return {
    slug: api.slug,
    name: api.name,
    description: api.description,
    category: api.category,
    listing_type:
      api.listing_type ||
      api.listing_metadata?.provider?.listing_type ||
      null,
    price_usd: api.price_usd ?? api.listing_metadata?.cost_per_call ?? null,
    docs_url: api.docs_url ?? api.listing_metadata?.provider?.docs_url ?? null,
    tool_name: toolName,
    default_operation: api.listing_metadata?.default_operation ?? null,
    tags: api.listing_metadata?.tags ?? [],
    mcp_native: api.listing_metadata?.mcp_native ?? false,
    // Listing lifecycle from the gateway /v1/apis flags so a catalog reader can
    // tell live from pending-verification from disabled, matching the portal.
    status: deriveListingStatus(api),
    active: api.active ?? true,
    verified: api.verified ?? false,
  };
}

function buildDynamicTools(catalog, reservedTools) {
  const tools = [];
  const toolIndex = new Map();
  const usedNames = new Set(reservedTools.map((tool) => tool.name));

  for (const api of catalog) {
    if (api.active === false) continue;

    const rawName = api.listing_metadata?.mcp_tool?.name || api.slug;
    let toolName = sanitizeToolName(rawName, api.slug);
    if (usedNames.has(toolName)) {
      toolName = sanitizeToolName(`${toolName}-${api.slug}`, api.slug);
    }

    usedNames.add(toolName);

    const price = api.price_usd ?? api.listing_metadata?.cost_per_call;
    const dynamicDescriptionParts = [
      api.listing_metadata?.mcp_tool?.description || api.description || api.name,
      `Apiosk slug: ${api.slug}.`,
    ];

    if (price !== undefined && price !== null) {
      dynamicDescriptionParts.push(`Cost per call: $${price}.`);
    }

    if (api.listing_metadata?.default_operation) {
      dynamicDescriptionParts.push(`Default operation: ${api.listing_metadata.default_operation}.`);
    }

    dynamicDescriptionParts.push("This tool executes the API through Apiosk's uniform /execute contract.");

    tools.push({
      name: toolName,
      description: dynamicDescriptionParts.join(" "),
      inputSchema: api.listing_metadata?.mcp_tool?.inputSchema || {
        type: "object",
        additionalProperties: true,
      },
      annotations: api.listing_metadata?.mcp_tool?.annotations,
    });

    toolIndex.set(toolName, {
      api,
      toolName,
    });
  }

  return { tools, toolIndex };
}

function resolveDashboardUserToken(env = process.env, savedConfig = null) {
  return trimString(
    env.APIOSK_DASHBOARD_JWT ||
      env.APIOSK_USER_JWT ||
      env.APIOSK_AUTH_HEADER_VALUE ||
      env.APIOSK_SESSION_TOKEN ||
      savedConfig?.dashboard_session_token
  );
}

function resolveControlPlaneUrl(env = process.env, savedConfig = null) {
  return trimString(
    env.APIOSK_CONTROL_PLANE_URL || savedConfig?.control_plane_url || "https://mcp.apiosk.com"
  ).replace(
    /\/+$/,
    ""
  );
}

function resolveGatewayBaseUrl(env = process.env, savedConfig = null) {
  return trimString(env.APIOSK_GATEWAY || savedConfig?.gateway_url || DEFAULT_GATEWAY_BASE_URL).replace(
    /\/+$/,
    ""
  );
}

function summarizeSavedConnectConfig(savedConfig = null, env = process.env) {
  if (!savedConfig) return null;

  return {
    gateway_url: trimString(savedConfig.gateway_url || DEFAULT_GATEWAY_BASE_URL),
    agent_wallet_address: trimString(savedConfig.agent_wallet_address || ""),
    connect_header_name: trimString(savedConfig.connect_header_name || "X-Apiosk-Connect-Token"),
    connect_token_saved: Boolean(trimString(savedConfig.connect_token)),
    connect_authorization_saved:
      Boolean(trimString(savedConfig.connect_authorization || env.APIOSK_CONNECT_AUTHORIZATION)),
  };
}

function buildAuthState({ env = process.env, savedConfig = null, activeWallet = null } = {}) {
  const envConnectToken = trimString(env.APIOSK_CONNECT_TOKEN);
  const savedConnectToken = trimString(savedConfig?.connect_token);
  const envAuthorization = trimString(env.APIOSK_CONNECT_AUTHORIZATION);
  const savedAuthorization = trimString(savedConfig?.connect_authorization);
  const envWalletAddress = trimString(env.APIOSK_WALLET_ADDRESS).toLowerCase();
  const savedWalletAddress = trimString(savedConfig?.agent_wallet_address).toLowerCase();

  let mode = "none";
  if (envConnectToken || savedConnectToken) {
    mode = "connect_token";
  } else if (envAuthorization || savedAuthorization) {
    mode = "authorization";
  } else if (trimString(env.APIOSK_PRIVATE_KEY)) {
    mode = "env_private_key";
  } else if (activeWallet?.source === "local_store") {
    mode = "local_wallet";
  } else if (envWalletAddress || savedWalletAddress || activeWallet?.address) {
    mode = "wallet_address";
  }

  return {
    mode,
    connect_token_configured: Boolean(envConnectToken || savedConnectToken),
    authorization_configured: Boolean(envAuthorization || savedAuthorization),
    wallet_address:
      activeWallet?.address ||
      envWalletAddress ||
      savedWalletAddress ||
      null,
    gateway_url: resolveGatewayBaseUrl(env, savedConfig),
  };
}

function resolveRequestDashboardUserToken(authInfo = null) {
  const extra = authInfo?.extra;
  if (!extra || typeof extra !== "object") return "";

  return trimString(
    extra.dashboardSessionToken ||
      extra.dashboard_session_token ||
      extra.userToken ||
      extra.user_token ||
      ""
  );
}

function hasRequestScopedDashboardAccess(authInfo = null) {
  return Boolean(resolveRequestDashboardUserToken(authInfo));
}

function buildRequestScopedDashboardHeaders(authInfo = null) {
  const token = resolveRequestDashboardUserToken(authInfo);
  if (!token) return null;

  return {
    "x-apiosk-user-jwt": token,
    authorization: `Bearer ${token}`,
  };
}

function pickMessage(payload, fallback) {
  if (payload && typeof payload === "object") {
    if (typeof payload.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error.trim();
    }
  }

  return fallback;
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function createDashboardWalletManagerFromEnv(env = process.env) {
  const dashboardUrl = resolveControlPlaneUrl(env);
  const token = resolveDashboardUserToken(env);

  return {
    isConfigured() {
      return Boolean(token);
    },
    async request(path, init = {}) {
      if (!token) {
        throw new Error(
          "Wallet tools require APIOSK_DASHBOARD_JWT or APIOSK_USER_JWT in the local MCP environment."
        );
      }

      const headers = new Headers(init.headers || {});
      headers.set("accept", "application/json");
      headers.set("x-apiosk-user-jwt", token);
      headers.set("authorization", `Bearer ${token}`);

      let body = init.body;
      if (body !== undefined && body !== null && typeof body !== "string") {
        headers.set("content-type", "application/json");
        body = JSON.stringify(body);
      }

      const response = await fetch(`${dashboardUrl}${path}`, {
        ...init,
        body,
        cache: "no-store",
        headers,
      });

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch {
        payload = text || null;
      }

      if (!response.ok) {
        throw new Error(
          pickMessage(payload, `Dashboard wallet request failed with HTTP ${response.status}`)
        );
      }

      return payload;
    },
  };
}

function content(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const result = {
    content: [
      {
        type: "text",
        text,
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

function summarizeDynamicToolResult(tool, result) {
  if (!result || typeof result !== "object") return null;
  if (result.status !== "success") return null;

  const payload =
    result.result && typeof result.result === "object" && !Array.isArray(result.result)
      ? result.result
      : null;
  if (!payload) return null;

  const orderId = payload.order_id;
  const pizzaType = payload.pizza?.type || payload.pizza_type;
  const pizzaSize = payload.pizza?.size || payload.size;
  const address = payload.address;
  const receiptUrl = payload.receipt_url;

  if (orderId && pizzaType && pizzaSize) {
    const parts = [
      `${tool.api.name || tool.api.slug} order confirmed.`,
      `${pizzaSize} ${pizzaType}.`,
      `Order ID ${orderId}.`,
    ];
    if (address) parts.push(`Delivery: ${address}.`);
    if (receiptUrl) parts.push(`Receipt: ${receiptUrl}.`);
    if (typeof result.cost === "number" && Number.isFinite(result.cost)) {
      parts.push(`Cost: $${result.cost.toFixed(2)}.`);
    }
    return parts.join(" ");
  }

  return null;
}

function buildHelpPayload(topic = "overview", options = {}) {
  const selectedTopic = String(topic || "overview");
  const localWalletsEnabled = Boolean(options.localWalletsEnabled);
  const hostedAuthEnabled = Boolean(options.hostedAuthEnabled);

  const topics = {
    overview: {
      topic: "overview",
      summary:
        "Apiosk MCP turns the Apiosk gateway into agent-native tools so Claude, Codex, and other MCP clients can discover APIs, inspect metadata, create local wallets, execute paid endpoints, and publish APIs from one surface.",
      what_you_get: [
        "Built-in discovery tools for explore, search, detail lookup, and generic execute",
        "Dynamic API-specific tools generated from Apiosk listing metadata",
        "Autonomous payment with APIOSK_PRIVATE_KEY or a selected local wallet",
        localWalletsEnabled
          ? "Local wallet and publish tools that do not require the dashboard"
          : hostedAuthEnabled
            ? "Managed wallet CRUD and prepaid-credits tools over your authorized session; publishing is local/portal-only"
            : "Wallet and publish tools are disabled in this server mode unless local wallets are enabled",
      ],
      next_steps: [
        localWalletsEnabled
          ? "Use apiosk_get_started first to save a connect string or create a wallet and run a test call"
          : "Start with apiosk_search or apiosk_explore to discover APIs",
        "Use apiosk_explore or apiosk_search to find an API",
        "Use apiosk_payment_guide to learn exactly how to pay (buyer) or publish (provider)",
        "Use apiosk_get_api to inspect detail and metadata",
        "Use the API-specific dynamic tool or apiosk_execute to call it",
        localWalletsEnabled
          ? "Use apiosk_wallet_create to create a local wallet for autonomous pay and publish"
          : "Run the local stdio package to unlock local wallet and publish tools",
      ],
    },
    setup: {
      topic: "setup",
      summary: "Connect Apiosk MCP over remote HTTP or local stdio.",
      claude_code: [
        "Remote HTTP: claude mcp add --transport http apiosk https://mcp.apiosk.com/mcp",
        "Verify: claude mcp get apiosk",
      ],
      local_stdio: [
        "npx -y apiosk-mcp-server",
        "Or add a stdio config that runs npx -y apiosk-mcp-server",
        "Then call apiosk_get_started to save a managed connect string or create a local wallet and run a test call",
        "Use apiosk_create_account or apiosk_sign_in when you want a human to fund credits through Adyen and let the agent spend those credits later",
      ],
      endpoint: "https://mcp.apiosk.com/mcp",
      local_wallet_note:
        "Local wallet creation, secret export, and publish tools are intended for the local stdio package. The public HTTP deployment keeps them disabled by default.",
    },
    auth: {
      topic: "auth",
      summary: "Apiosk supports multiple auth paths depending on how you want the agent to pay or identify itself.",
      auth_modes: [
        "APIOSK_PRIVATE_KEY: automatic x402 settlement for paid endpoints and signed publish requests",
        "Local wallet tools: create/select a wallet inside the MCP package and use it automatically for pay and publish",
        "APIOSK_CONNECT_TOKEN: dashboard-managed access token",
        "APIOSK_CONNECT_AUTHORIZATION: custom Authorization header",
        "APIOSK_WALLET_ADDRESS: wallet-aware flows without a token",
        "APIOSK_X_PAYMENT: manually attach a prebuilt x402 proof",
        "APIOSK_DASHBOARD_JWT or APIOSK_USER_JWT: unlock dashboard-managed wallet CRUD tools",
        "Saved local dashboard session from apiosk_sign_in or apiosk_create_account: reuse credits and managed-wallet tools without exporting a JWT manually",
      ],
      notes: [
        "Connect token is the simplest managed option",
        "Private key or a selected local wallet is the best fit for autonomous paid execution",
        "Dashboard JWT is optional and only needed for managed-wallet dashboard endpoints",
      ],
    },
    workflow: {
      topic: "workflow",
      summary: "Recommended usage pattern for agents working with Apiosk.",
      steps: [
        localWalletsEnabled
          ? "Call apiosk_get_started first when you want the MCP package to configure local auth and prove the setup with a test call"
          : "Call apiosk_search or apiosk_explore to find a capability",
        "Call apiosk_explore to browse listing groups or apiosk_search to find a capability",
        "Read tool_name from search results when a dynamic tool is available",
        "Call apiosk_get_api when you need detail, docs_url, or listing metadata",
        "Use the dynamic tool directly for the cleanest invocation shape",
        "Use apiosk_execute when you need to force a slug, operation, query, or path_params envelope",
        localWalletsEnabled
          ? "Create or select a local wallet before making paid calls or publishing APIs"
          : "Use APIOSK_PRIVATE_KEY if you need autonomous payment on the public server mode",
      ],
    },
    payments: {
      topic: "payments",
      summary: "Paid Apiosk APIs can return x402 payment requirements if the client is not configured to settle automatically.",
      behavior: [
        "With APIOSK_PRIVATE_KEY configured, the SDK can auto-settle supported x402 flows",
        "With a selected local wallet, the MCP package uses that wallet automatically for paid execution",
        "Without auto-pay, paid calls return structured payment_required data",
        "The MCP server surfaces payment errors with hints that explain how to configure settlement",
      ],
      recommended_setup: [
        "Use apiosk_get_started in the local stdio package for the shortest path from install to first paid-capable call",
        "Use apiosk_wallet_create and apiosk_wallet_select in the local stdio package for the cleanest autonomous workflow",
        "Use APIOSK_PRIVATE_KEY when you want deterministic wallet selection from environment variables",
        "Use APIOSK_CONNECT_TOKEN when access is managed in the dashboard",
        "Use the buyer portal to top up a prepaid credits balance and let the agent keep spending from it",
      ],
      see_also:
        "x402/USDC is only one settlement rail. Call apiosk_help with topic='rails' to learn how the same connect token also settles over SEPA incasso (EU bank direct debit) and prepaid credits, including the rail fallback order.",
    },
    rails: {
      topic: "rails",
      summary:
        "Apiosk is one mandate, any rail. A single buyer connect token can settle paid calls over USDC (x402 on Base), SEPA incasso (EU bank direct debit), or prepaid credits. The gateway picks the rail per call; the agent does not need to know which one is used.",
      settlement_rails: [
        "usdc_x402: on-chain USDC on Base (chain 8453), settled per call via an x402 payment proof from the agent wallet or APIOSK_PRIVATE_KEY.",
        "sepa_incasso: EU SEPA Direct Debit. Paid calls are appended to a ledger and collected later in batches from the buyer's bank account. No per-call bank transaction. Best for EU buyers; lowest fees on high call volume.",
        "credits: prepaid balance topped up once by a human via the buyer portal (Adyen/Mollie), then spent down per call.",
      ],
      rail_fallback_order: [
        "1. USDC / x402 wallet when the agent can produce a payment proof.",
        "2. SEPA incasso ledger when the buyer has an active SEPA mandate (no proof needed — the call is recorded, not blocked).",
        "3. Prepaid credits balance.",
        "A 402 is only returned when none of the buyer's enabled rails can cover the call.",
      ],
      sepa_incasso: {
        what_it_is:
          "An incasso (SEPA Direct Debit) lets Apiosk pull euros from the buyer's bank account under a one-time mandate, so the agent can keep calling paid APIs without signing or funding each call.",
        how_it_works: [
          "1. Mandate setup (once): the buyer authorizes a recurring SEPA mandate in the buyer portal. iDEAL does a one-cent verification (NL banks) that returns a reusable direct-debit mandate; PayPal and card mandates are alternatives for non-NL buyers.",
          "2. Collection terms (once): the buyer sets a threshold (€25–€500, default €25) and a max age (7, 14, or 30 days) that bound how much / how long can accrue before a collection.",
          "3. Per call: when a paid call settles over SEPA, the gateway appends a SEPA ledger debit row carrying the full breakdown — gross EUR, Apiosk fee (3%), Mollie fee, and provider net. No bank transaction happens yet.",
          "4. Batch collection: a background worker flushes a buyer's unbatched ledger into ONE Mollie SEPA Direct Debit when the outstanding sum crosses the threshold OR the oldest entry passes the max age. Many micro-calls become a single bank debit.",
        ],
        economics: [
          "Apiosk platform fee: 3% of each call's gross, recorded per ledger row.",
          "Mollie SEPA Direct Debit fee: ~€0.30 per COLLECTION (per batch), not per call — which is why sub-€25 thresholds are not offered.",
          "Provider receives gross minus the 3% Apiosk fee; the Mollie fee is netted at collection time.",
        ],
        operational_defaults: {
          threshold_eur: "25–500 (buyer-set, default 25, floor 25)",
          max_age_days: "7, 14, or 30 (buyer-set)",
          batch_worker_cadence_seconds: "SEPA_BATCH_POLL_SECONDS (default 1800)",
          batch_flush_amount_eur: "MOLLIE_BATCH_FLUSH_EUR (default 25)",
          batch_flush_age_days: "MOLLIE_BATCH_FLUSH_DAYS (default 7)",
        },
        agent_guidance: [
          "Agents never set up the mandate — that is a human, one-time action in the buyer portal. The agent only needs the connect token; the SEPA rail is selected server-side.",
          "SEPA-backed calls succeed immediately even with no wallet balance and no x402 proof; settlement is deferred to the batch.",
          "Use the buyer portal to inspect outstanding (unbatched) SEPA balance and upcoming collections.",
        ],
      },
      connect_string_note:
        "The connect string identifies the buyer's managed wallet and connect token; APIO_WALLET_* limits bound the USDC rail. The SEPA mandate and its threshold/age terms live server-side against the same buyer account, so the same connect token transparently settles over SEPA when USDC is unavailable. See help topic 'setup' for the connect string format.",
      provider_settlement: {
        what_it_is:
          "The settlement_rails above are how BUYERS pay. This is the PROVIDER (seller) side: how an API owner receives their earnings. Agents do not interact with it — it is provider-account configuration in the provider portal — but it completes the 'any rail' picture.",
        how_it_works: [
          "USDC earnings settle to the API's payout wallet (apis.wallet_address), which the portal links to a verified, Monerium-linked payout_wallets row.",
          "EUR via SEPA incasso routing: the provider's share of buyer SEPA collections is paid to their verified receiver IBAN (provider_compliance_profiles gates this on KYB approval).",
          "Crypto -> EUR off-ramp mandate (optional): the provider signs an EIP-191 authorization and an on-chain mandate (ApioskOfframpExecutor on Base). Apiosk's offramp keeper then auto-converts their accumulated USDC to EURe via Monerium and redeems it to their IBAN over SEPA once the balance crosses their bundle threshold. Non-custodial — the keeper can never redirect funds or exceed the provider's on-chain per-run cap or cooldown.",
        ],
        note: "The off-ramp mandate is the provider-side counterpart of the buyer-side SEPA incasso; they are distinct mechanisms. Both require a one-time human action (KYB + signing), never an agent.",
      },
    },
    wallets: {
      topic: "wallets",
      summary: "Local wallet tools let Claude or Codex create, select, reveal, and save wallet secrets without opening the dashboard.",
      tools: [
        "apiosk_get_started",
        "apiosk_wallet_create",
        "apiosk_configure",
        "apiosk_wallet_list",
        "apiosk_wallet_select",
        "apiosk_wallet_reveal_secret",
        "apiosk_wallet_save_secret",
      ],
      notes: [
        "The active wallet is mirrored to ~/.apiosk/wallet.json and ~/.apiosk/wallet.txt",
        "Use apiosk_wallet_reveal_secret only when the user explicitly asks to see the private key",
        "Use apiosk_wallet_save_secret to write a backup file without showing the secret in chat",
      ],
    },
    publish: {
      topic: "publish",
      summary: "Apiosk publish tools sign gateway management requests directly with the active local wallet or APIOSK_PRIVATE_KEY.",
      tools: [
        "apiosk_publish_api",
        "apiosk_list_my_apis",
        "apiosk_update_api",
        "apiosk_delete_api",
      ],
      requirements: [
        "A signing wallet must be available from a selected local wallet or APIOSK_PRIVATE_KEY",
        "endpoint_url must use HTTPS",
        "slug must use lowercase letters, numbers, and hyphens",
      ],
      identity_note:
        "These tools manage listings via WALLET SIGNATURE — the community/MCP publish channel, owned by a synthetic platform account. That is a different identity from the provider portal, where providers manage APIs under a Supabase-auth account (owner_id) after Monerium KYB, and where listings auto-verify on create. A listing published here and one created in the portal are managed through different identities and do not currently round-trip between the two surfaces.",
    },
    configure: {
      topic: "configure",
      summary: "Use apiosk_configure to open a structured control panel for the active wallet, including funding QR codes, provider options, wallet actions, publish actions, and local data paths.",
      examples: [
        "{ \"section\": \"funding\" }",
        "{ \"wallet_id\": \"...\", \"section\": \"security\" }",
        "{ \"section\": \"funding\", \"funding_provider\": \"onramper\" }",
      ],
    },
  };

  const fallback =
    topics[selectedTopic] ||
    {
      topic: "overview",
      error: `Unknown help topic: ${selectedTopic}`,
      available_topics: Object.keys(topics),
    };

  return {
    ...fallback,
    available_topics: Object.keys(topics),
  };
}

function hasExecuteEnvelope(argumentsObject) {
  return Boolean(
    argumentsObject &&
      typeof argumentsObject === "object" &&
      ("operation" in argumentsObject ||
        "input" in argumentsObject ||
        "query" in argumentsObject ||
        "path_params" in argumentsObject)
  );
}

function validateSlug(slug) {
  return /^[a-z0-9-]+$/.test(String(slug || ""));
}

function buildWalletToolArguments(wallet, extra = {}) {
  const base = { ...extra };
  if (wallet?.source === "local_store" && wallet?.id) {
    base.wallet_id = wallet.id;
  }
  return base;
}

function normalizePrivateKeyHex(value) {
  const trimmed = trimString(value);
  if (!trimmed) return "";

  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("APIOSK_PRIVATE_KEY must be a 32-byte hex private key.");
  }

  return normalized;
}

function resolveEnvPrivateWallet(env = process.env) {
  const privateKey = normalizePrivateKeyHex(env.APIOSK_PRIVATE_KEY);
  if (!privateKey) return null;

  const account = privateKeyToAccount(privateKey);
  const derivedAddress = account.address.toLowerCase();
  const configuredAddress = trimString(env.APIOSK_WALLET_ADDRESS).toLowerCase();

  if (configuredAddress && configuredAddress !== derivedAddress) {
    throw new Error("APIOSK_WALLET_ADDRESS does not match APIOSK_PRIVATE_KEY.");
  }

  return {
    address: derivedAddress,
    private_key: privateKey,
    label: "Environment wallet",
    source: "env_private_key",
  };
}

export function createApioskMcpRuntime(options = {}) {
  const env = options.env || process.env;
  const fixedClient = options.client || null;
  const clientFactory = options.clientFactory || null;
  const providedDashboardManager = options.walletManager || null;
  const hostedAuthEnabled = options.hostedAuthEnabled === true;
  const localWalletStore =
    options.localWalletStore ||
    (options.enableLocalWallets === false ? null : createLocalWalletStore(env));
  const cache = {
    catalog: null,
    expiresAt: 0,
    dynamicTools: null,
    toolIndex: new Map(),
    toolNamesBySlug: new Map(),
  };

  async function getActiveExecutionWallet() {
    try {
      const envWallet = resolveEnvPrivateWallet(env);
      if (envWallet) return envWallet;
    } catch (error) {
      throw error;
    }

    if (!localWalletStore) return null;
    return localWalletStore.resolveSigningWallet();
  }

  async function getSavedConfig() {
    return readLocalApioskConfig(env);
  }

  // Summarize whether the agent can settle a paid call right now, and how, so
  // discovery responses and apiosk_payment_guide can give tailored buyer
  // instructions without a second round trip.
  async function resolvePaymentCapability(authInfo = null) {
    const savedConfig = await getSavedConfig().catch(() => null);
    let activeWallet = null;
    try {
      activeWallet = await getActiveExecutionWallet();
    } catch {
      activeWallet = null;
    }

    const requestConnectToken = trimString(authInfo?.extra?.apiosk_connect_token);
    const envConnectToken = trimString(env.APIOSK_CONNECT_TOKEN || savedConfig?.connect_token);
    const envAuthorization = trimString(
      env.APIOSK_CONNECT_AUTHORIZATION || savedConfig?.connect_authorization
    );
    const envWalletAddress = trimString(env.APIOSK_WALLET_ADDRESS).toLowerCase();
    const savedWalletAddress = trimString(savedConfig?.agent_wallet_address).toLowerCase();

    let method = "none";
    if (activeWallet?.source === "env_private_key") method = "env_private_key";
    else if (activeWallet?.source === "local_store") method = "local_wallet";
    else if (requestConnectToken) method = "request_connect_token";
    else if (envConnectToken || envAuthorization) method = "connect_token";
    else if (envWalletAddress || savedWalletAddress || activeWallet?.address) method = "wallet_address";

    const mode = hostedAuthEnabled ? "hosted" : localWalletStore ? "local" : "remote";

    return {
      method,
      ready: ["env_private_key", "local_wallet", "connect_token", "request_connect_token"].includes(
        method
      ),
      wallet_address: activeWallet?.address || envWalletAddress || savedWalletAddress || null,
      has_connect_token: Boolean(requestConnectToken || envConnectToken),
      local_wallets_enabled: Boolean(localWalletStore),
      mode,
    };
  }

  function hasConfiguredDashboardAccess(authInfo = null) {
    if (hasRequestScopedDashboardAccess(authInfo)) {
      return true;
    }

    if (providedDashboardManager?.isConfigured) {
      return Boolean(providedDashboardManager.isConfigured());
    }

    return Boolean(resolveDashboardUserToken(env));
  }

  async function requestDashboard(path, init = {}, options = {}, authInfo = null) {
    const requireAuth = options.requireAuth !== false;
    const requestScopedToken = resolveRequestDashboardUserToken(authInfo);

    if (providedDashboardManager && !requestScopedToken) {
      return providedDashboardManager.request(path, init);
    }

    const savedConfig = await getSavedConfig();
    const dashboardUrl = resolveControlPlaneUrl(env, savedConfig);
    const token = requestScopedToken || resolveDashboardUserToken(env, savedConfig);

    if (requireAuth && !token) {
      throw new Error(
        hostedAuthEnabled ?
          "This tool needs an Apiosk dashboard session. In ChatGPT or another remote MCP client, authorize the Apiosk app when prompted and then retry the tool call." :
          "This tool needs an Apiosk dashboard session. Ask whether the user wants an account, then call apiosk_create_account or apiosk_sign_in. If they already have an account, sign in first or set APIOSK_DASHBOARD_JWT / APIOSK_USER_JWT."
      );
    }

    const headers = new Headers(init.headers || {});
    headers.set("accept", "application/json");

    if (token) {
      headers.set("x-apiosk-user-jwt", token);
      headers.set("authorization", `Bearer ${token}`);
    }

    let body = init.body;
    if (body !== undefined && body !== null && typeof body !== "string") {
      headers.set("content-type", "application/json");
      body = JSON.stringify(body);
    }

    const response = await fetch(`${dashboardUrl}${path}`, {
      ...init,
      body,
      cache: "no-store",
      headers,
    });

    const text = await response.text();
    let payload = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text || null;
    }

    if (!response.ok) {
      throw new Error(pickMessage(payload, `Dashboard request failed with HTTP ${response.status}`));
    }

    return payload;
  }

  async function getClient(authInfo = null) {
    if (fixedClient) {
      return fixedClient;
    }

    const savedConfig = await getSavedConfig();
    const activeWallet = await getActiveExecutionWallet();
    const requestScopedHeaders = buildRequestScopedDashboardHeaders(authInfo);
    const envWalletAddress = trimString(env.APIOSK_WALLET_ADDRESS).toLowerCase();
    const savedWalletAddress = trimString(savedConfig?.agent_wallet_address).toLowerCase();
    const privateKey = activeWallet?.private_key || normalizePrivateKeyHex(env.APIOSK_PRIVATE_KEY) || undefined;
    const walletAddress = privateKey
      ? activeWallet?.address
      : envWalletAddress || activeWallet?.address || savedWalletAddress;

    // Hosted MCP path: a headless caller authenticated by presenting an
    // Apiosk connect token. oauth.mjs stashes it on req.auth.extra so we
    // can thread it back through to the gateway as X-Apiosk-Connect-Token,
    // which lets the gateway settle the call via the buyer's managed
    // wallet (no APIOSK_PRIVATE_KEY needed). This is the request-scoped
    // override; it beats the per-process env/saved-config token.
    const requestConnectToken = trimString(authInfo?.extra?.apiosk_connect_token);
    const envConnectToken = trimString(env.APIOSK_CONNECT_TOKEN || savedConfig?.connect_token);
    const effectiveConnectToken = requestConnectToken || envConnectToken || undefined;
    const requestAuthorization = requestConnectToken ? `Bearer ${requestConnectToken}` : undefined;
    const envAuthorization = trimString(env.APIOSK_CONNECT_AUTHORIZATION || savedConfig?.connect_authorization);
    const effectiveAuthorization = requestAuthorization || envAuthorization || undefined;

    const clientOptions = {
      baseUrl: resolveGatewayBaseUrl(env, savedConfig),
      connectToken: effectiveConnectToken,
      connectHeaderName:
        trimString(env.APIOSK_CONNECT_HEADER_NAME || savedConfig?.connect_header_name) || undefined,
      authorization: effectiveAuthorization,
      walletAddress: walletAddress || undefined,
      xPayment: trimString(env.APIOSK_X_PAYMENT) || undefined,
      privateKey,
      headers: requestScopedHeaders || undefined,
    };

    if (clientFactory) {
      return await clientFactory(clientOptions);
    }

    return new ApioskClient(clientOptions);
  }

  function getStaticTools(authInfo = null) {
    if (hostedAuthEnabled) {
      return [...HOSTED_REMOTE_TOOLS];
    }

    const tools = [...DISCOVERY_TOOLS];

    if (localWalletStore) {
      tools.push(...LOCAL_WALLET_TOOLS, ...LOCAL_ACCOUNT_AND_CREDITS_TOOLS, ...DASHBOARD_WALLET_TOOLS, ...PUBLISH_TOOLS);
    } else if (hasConfiguredDashboardAccess(authInfo)) {
      tools.push(...DASHBOARD_WALLET_TOOLS);
    }

    return tools;
  }

  async function getCatalog(force = false, authInfo = null) {
    if (!force && cache.catalog && Date.now() < cache.expiresAt) {
      return cache.catalog;
    }

    const client = await getClient(authInfo);
    const response = await client.listApis({ limit: 500, offset: 0 });
    cache.catalog = response.apis || [];
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    cache.dynamicTools = null;
    cache.toolIndex = new Map();
    cache.toolNamesBySlug = new Map();
    return cache.catalog;
  }

  async function getTools(force = false, authInfo = null) {
    if (!force && cache.dynamicTools && Date.now() < cache.expiresAt) {
      return [...getStaticTools(authInfo), ...cache.dynamicTools];
    }

    const catalog = await getCatalog(force, authInfo);
    const { tools, toolIndex } = buildDynamicTools(catalog, ALL_STATIC_TOOLS);

    cache.dynamicTools = tools;
    cache.toolIndex = toolIndex;
    cache.toolNamesBySlug = new Map(
      Array.from(toolIndex.values()).map((entry) => [entry.api.slug, entry.toolName])
    );

    return [...getStaticTools(authInfo), ...tools];
  }

  async function resolveConfigurationWallet(walletId = null) {
    const targetWalletId = trimString(walletId);

    if (targetWalletId && localWalletStore) {
      const wallet = await localWalletStore.getWalletRecord(targetWalletId);
      return {
        ...wallet,
        source: "local_store",
      };
    }

    if (localWalletStore) {
      const activeWallet = await localWalletStore.resolveActiveWallet();
      if (activeWallet) {
        return {
          ...activeWallet,
          source: "local_store",
        };
      }
    }

    const envWallet = resolveEnvPrivateWallet(env);
    if (envWallet) {
      return {
        id: null,
        label: envWallet.label || "Environment wallet",
        address: envWallet.address,
        active: true,
        source: envWallet.source,
      };
    }

    return null;
  }

  function buildApioskOptionsMenu(wallet, funding) {
    const walletArgs = buildWalletToolArguments(wallet);
    const fundingWalletArgs = buildWalletToolArguments(wallet, { section: "funding" });

    return {
      title: "Apiosk Control Menu",
      description: wallet
        ? "Use the sections below to fund the wallet, explore APIs, pay for calls, publish listings, and manage local Apiosk data."
        : "Create or select a wallet first, then use the sections below to fund it and manage Apiosk data.",
      sections: [
        {
          id: "wallet",
          label: "Wallet",
          options: [
            {
              label: "Get started",
              tool: "apiosk_get_started",
              arguments: buildWalletToolArguments(wallet, {}),
            },
            {
              label: "List wallets",
              tool: "apiosk_wallet_list",
              arguments: {},
            },
            {
              label: "Create wallet",
              tool: "apiosk_wallet_create",
              arguments: {},
            },
            {
              label: "Select active wallet",
              tool: "apiosk_wallet_select",
              arguments: walletArgs,
              available: Boolean(wallet?.source === "local_store"),
            },
          ],
        },
        {
          id: "funding",
          label: "Fund Wallet",
          options: [
            {
              label: "Show funding QR and Base deposit instructions",
              tool: "apiosk_configure",
              arguments: fundingWalletArgs,
              available: Boolean(wallet),
            },
            {
              label: "Request Onramper checkout",
              tool: "apiosk_configure",
              arguments: buildWalletToolArguments(wallet, {
                section: "funding",
                funding_provider: "onramper",
              }),
              available: Boolean(funding?.providers?.find((provider) => provider.id === "onramper")?.available),
            },
            {
              label: "Request Transak checkout",
              tool: "apiosk_configure",
              arguments: buildWalletToolArguments(wallet, {
                section: "funding",
                funding_provider: "transak",
              }),
              available: Boolean(funding?.providers?.find((provider) => provider.id === "transak")?.available),
            },
          ],
        },
        {
          id: "payments",
          label: "Explore And Pay",
          options: [
            {
              label: "Browse listing groups",
              tool: "apiosk_explore",
              arguments: {},
            },
            {
              label: "Search APIs",
              tool: "apiosk_search",
              arguments: {},
            },
            {
              label: "Execute an API",
              tool: "apiosk_execute",
              arguments: { slug: "<api-slug>" },
            },
          ],
        },
        {
          id: "publish",
          label: "Publish And Manage",
          options: [
            {
              label: "Publish a new API",
              tool: "apiosk_publish_api",
              arguments: buildWalletToolArguments(wallet, {
                name: "<name>",
                slug: "<slug>",
                endpoint_url: "https://example.com",
                price_usd: 0.01,
                description: "<description>",
              }),
              available: Boolean(wallet),
            },
            {
              label: "List my APIs",
              tool: "apiosk_list_my_apis",
              arguments: walletArgs,
              available: Boolean(wallet),
            },
            {
              label: "Update an API",
              tool: "apiosk_update_api",
              arguments: buildWalletToolArguments(wallet, { slug: "<slug>" }),
              available: Boolean(wallet),
            },
          ],
        },
        {
          id: "security",
          label: "Security",
          options: [
            {
              label: "Reveal secret key",
              tool: "apiosk_wallet_reveal_secret",
              arguments: walletArgs,
              available: Boolean(wallet?.source === "local_store" && wallet?.id),
            },
            {
              label: "Save secret key to file",
              tool: "apiosk_wallet_save_secret",
              arguments: walletArgs,
              available: Boolean(wallet?.source === "local_store" && wallet?.id),
            },
          ],
        },
        {
          id: "data",
          label: "Local Data",
          options: [
            {
              label: "Show local data paths and wallet status",
              tool: "apiosk_configure",
              arguments: buildWalletToolArguments(wallet, { section: "data" }),
            },
          ],
        },
      ],
    };
  }

  async function buildConfigurePayload(argumentsObject = {}) {
    const wallet = await resolveConfigurationWallet(argumentsObject.wallet_id);
    const funding = wallet
      ? await buildFundingOptions({
          wallet,
          env,
          fundingProvider: argumentsObject.funding_provider,
          includeQrDataUrl: argumentsObject.include_qr_data_url === true,
        })
      : null;

    const dataPaths = localWalletStore
      ? {
          store_file: localWalletStore.paths.storeFile,
          wallet_json_file: localWalletStore.paths.activeWalletJsonFile,
          wallet_txt_file: localWalletStore.paths.activeWalletTextFile,
          secret_export_dir: localWalletStore.paths.secretExportDir,
        }
      : null;

    const section = trimString(argumentsObject.section || "overview").toLowerCase() || "overview";
    const menu = buildApioskOptionsMenu(wallet, funding);
    const sections = {
      overview: {
        wallet,
        funding_preview: funding?.receive_on_base || null,
        next_steps: wallet
          ? [
              "Fund the wallet on Base with ETH or USDC.",
              "Use apiosk_search or apiosk_explore to find an API.",
              "Use apiosk_publish_api when you want to list your own API.",
            ]
          : [
              "Create or select a wallet first.",
              "Then reopen apiosk_configure with section='funding' to fund it.",
            ],
      },
      funding,
      wallet: {
        wallet,
        local_wallet_tools_enabled: Boolean(localWalletStore),
        dashboard_wallet_tools_enabled: hasConfiguredDashboardAccess(),
      },
      payments: {
        wallet,
        active_payment_source: wallet ? `${wallet.label || wallet.address} (${wallet.source})` : null,
        recommendation: wallet
          ? "This wallet will be used for autonomous paid execution unless APIOSK_PRIVATE_KEY overrides it."
          : "No active wallet is available yet.",
      },
      publish: {
        wallet,
        requirements: [
          "A signing wallet must be active.",
          "endpoint_url must use HTTPS.",
          "slug must use lowercase letters, numbers, and hyphens.",
        ],
      },
      data: {
        wallet,
        data_paths: dataPaths,
      },
      security: {
        wallet,
        rules: [
          "Only reveal or export the private key when the user explicitly asks.",
          "The active local wallet is mirrored to ~/.apiosk/wallet.json and ~/.apiosk/wallet.txt.",
          "Exported secret-key files should be treated as sensitive credentials.",
        ],
      },
    };

    return {
      selected_section: Object.prototype.hasOwnProperty.call(sections, section) ? section : "overview",
      wallet,
      funding,
      options_menu: menu,
      sections,
      section_payload:
        sections[Object.prototype.hasOwnProperty.call(sections, section) ? section : "overview"],
    };
  }

  async function resolveDynamicTool(name, authInfo = null) {
    await getTools(false, authInfo);
    if (cache.toolIndex.has(name)) {
      return cache.toolIndex.get(name);
    }

    await getTools(true, authInfo);
    return cache.toolIndex.get(name) || null;
  }

  function isDynamicToolProtectedApi(api) {
    const price = Number(api?.price_usd ?? api?.listing_metadata?.cost_per_call ?? 0);
    const annotations = api?.listing_metadata?.mcp_tool?.annotations || {};

    if (Number.isFinite(price) && price > 0) {
      return true;
    }

    if (annotations.destructiveHint === true) {
      return true;
    }

    if (annotations.readOnlyHint === false) {
      return true;
    }

    return false;
  }

  async function isToolProtected(name, authInfo = null) {
    if (PUBLIC_STATIC_TOOL_NAMES.has(name)) {
      return false;
    }

    if (REMOTE_PROTECTED_STATIC_TOOL_NAMES.has(name)) {
      return true;
    }

    const dynamicTool = await resolveDynamicTool(name, authInfo);
    if (!dynamicTool) {
      return false;
    }

    return isDynamicToolProtectedApi(dynamicTool.api);
  }

  async function resolvePublishingWallet(walletId = null) {
    if (trimString(walletId)) {
      if (!localWalletStore) {
        throw new Error("Local wallet selection is not enabled in this server mode.");
      }

      const wallet = await localWalletStore.resolveSigningWallet(trimString(walletId));
      if (!wallet) {
        throw new Error("No local wallet found for the provided wallet_id.");
      }
      return wallet;
    }

    const envWallet = resolveEnvPrivateWallet(env);
    if (envWallet) return envWallet;

    if (localWalletStore) {
      const activeWallet = await localWalletStore.resolveSigningWallet();
      if (activeWallet) return activeWallet;
    }

    throw new Error(
      "No signing wallet available. Create/select a local wallet or set APIOSK_PRIVATE_KEY."
    );
  }

  async function handleExplore(argumentsObject = {}, authInfo = null) {
    const client = await getClient(authInfo);
    const capability = await resolvePaymentCapability(authInfo);
    const paymentHint = buildDiscoveryPaymentHint({
      capability,
      mode: capability.mode,
      localWalletsEnabled: capability.local_wallets_enabled,
    });

    if (!argumentsObject.listing_type) {
      const response = await client.requestJson("/types", { method: "GET" });
      return content({
        ...response,
        payment: paymentHint,
        next_steps:
          hostedAuthEnabled ?
            "Pick a listing_type and call apiosk_explore again. Then use apiosk_metadata for a slug you want to inspect or apiosk_execute to run it. Call apiosk_payment_guide to learn how to pay." :
            "Pick a listing_type and call apiosk_explore again, or use apiosk_search for full-text discovery. Call apiosk_payment_guide to learn how to pay.",
      });
    }

    const listingType = String(argumentsObject.listing_type).trim().toLowerCase();
    const response = await client.requestJson(`/types/${encodeURIComponent(listingType)}/v1`, {
      method: "GET",
      query: {
        search: argumentsObject.search,
        sort: argumentsObject.sort,
        order: argumentsObject.order,
        limit: argumentsObject.limit || DEFAULT_LIMIT,
        offset: argumentsObject.offset || 0,
      },
    });

    return content({
      ...response,
      payment: paymentHint,
      next_steps:
        hostedAuthEnabled ?
          "Use apiosk_metadata for listing detail and apiosk_execute when you are ready to run a slug. Call apiosk_payment_guide to learn how to pay." :
          "Use apiosk_get_api for detail or call apiosk_search if you want category filtering across the whole catalog. Call apiosk_payment_guide to learn how to pay.",
    });
  }

  async function handleSearch(argumentsObject = {}, authInfo = null) {
    const client = await getClient(authInfo);
    const response = await client.listApis({
      search: argumentsObject.search,
      category: argumentsObject.category,
      sort: argumentsObject.sort,
      order: argumentsObject.order,
      limit: argumentsObject.limit || DEFAULT_LIMIT,
      offset: argumentsObject.offset || 0,
    });

    const catalog = response.apis || [];
    await getTools(false, authInfo);
    const capability = await resolvePaymentCapability(authInfo);

    return content({
      apis: catalog.map((api) => buildCatalogEntry(api, cache.toolNamesBySlug.get(api.slug) || null)),
      meta: response.meta,
      payment: buildDiscoveryPaymentHint({
        capability,
        mode: capability.mode,
        localWalletsEnabled: capability.local_wallets_enabled,
      }),
      for_providers:
        "Listing your own API? Call apiosk_payment_guide with role='provider' (or apiosk_publish_api) to publish it for other agents.",
      next_steps:
        "Call apiosk_get_api for full metadata plus a per-listing payment block, use the API-specific tool directly when tool_name is present, or call apiosk_payment_guide to learn exactly how to settle a paid call.",
    });
  }

  async function handleGetApi(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.slug) {
      return errorContent("Missing required field: slug");
    }

    const client = await getClient(authInfo);
    const [detail, metadata, capability] = await Promise.all([
      client.getApi(argumentsObject.slug),
      client.getMetadata(argumentsObject.slug).catch(() => null),
      resolvePaymentCapability(authInfo),
    ]);

    return content({
      detail,
      metadata,
      payment: buildPaymentGuidance({
        api: {
          slug: argumentsObject.slug,
          price_usd: detail?.price_usd ?? metadata?.cost_per_call ?? null,
          listing_metadata: metadata || detail?.listing_metadata || null,
        },
        capability,
        mode: capability.mode,
        localWalletsEnabled: capability.local_wallets_enabled,
      }),
    });
  }

  async function handleHealth(argumentsObject = {}, authInfo = null) {
    const savedConfig = await getSavedConfig();
    let gateway = null;

    try {
      const client = await getClient(authInfo);
      gateway =
        typeof client.requestJson === "function" ?
          await client.requestJson("/health", { method: "GET" }) :
          { status: "unknown" };
    } catch (error) {
      gateway = {
        status: "degraded",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (typeof gateway === "string") {
      gateway = {
        status: gateway.toLowerCase() === "ok" ? "ok" : gateway,
        raw: gateway,
      };
    } else if (gateway && typeof gateway === "object" && !gateway.status && gateway.ok === true) {
      gateway = {
        ...gateway,
        status: "ok",
      };
    }

    return content({
      status: gateway?.status || "ok",
      mcp: {
        mode: hostedAuthEnabled ? "hosted" : localWalletStore ? "local" : "remote",
        tools: hostedAuthEnabled ? HOSTED_REMOTE_TOOLS.map((tool) => tool.name) : undefined,
      },
      gateway,
      gateway_base_url: resolveGatewayBaseUrl(env, savedConfig),
    });
  }

  async function handleExecute(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.slug) {
      return errorContent("Missing required field: slug");
    }

    const client = await getClient(authInfo);
    const result = await client.execute(argumentsObject.slug, argumentsObject.input, {
      operation: argumentsObject.operation,
      query: argumentsObject.query,
      pathParams: argumentsObject.path_params,
      headers: {
        accept: "application/json",
      },
    });

    return content(result);
  }

  async function handleDynamicExecute(tool, argumentsObject = {}, authInfo = null) {
    const client = await getClient(authInfo);
    const result = hasExecuteEnvelope(argumentsObject)
      ? await client.execute(tool.api.slug, argumentsObject.input, {
          operation: argumentsObject.operation,
          query: argumentsObject.query,
          pathParams: argumentsObject.path_params,
          headers: {
            accept: "application/json",
          },
        })
      : await client.execute(tool.api.slug, argumentsObject, {
          headers: {
            accept: "application/json",
          },
        });
    const summary = summarizeDynamicToolResult(tool, result);
    if (summary) {
      return {
        content: [
          {
            type: "text",
            text: summary,
          },
        ],
        structuredContent: result,
      };
    }
    return content(result);
  }

  async function handleHelp(argumentsObject = {}) {
    return content(
      buildHelpPayload(argumentsObject.topic, {
        localWalletsEnabled: Boolean(localWalletStore),
        hostedAuthEnabled,
      })
    );
  }

  async function handlePaymentGuide(argumentsObject = {}, authInfo = null) {
    const capability = await resolvePaymentCapability(authInfo);
    const slug = trimString(argumentsObject.slug);

    let api = null;
    if (slug) {
      try {
        const client = await getClient(authInfo);
        const [detail, metadata] = await Promise.all([
          client.getApi(slug).catch(() => null),
          client.getMetadata(slug).catch(() => null),
        ]);
        api = {
          slug,
          price_usd: detail?.price_usd ?? metadata?.cost_per_call ?? null,
          listing_metadata: metadata || detail?.listing_metadata || null,
        };
      } catch {
        api = { slug };
      }
    }

    return content(
      buildPaymentGuide({
        role: argumentsObject.role,
        api,
        capability,
        mode: capability.mode,
        localWalletsEnabled: capability.local_wallets_enabled,
      })
    );
  }

  function ensureLocalDashboardSessionTools(toolName) {
    if (!localWalletStore) {
      return errorContent(
        `${toolName} is only available in the local stdio package because it stores dashboard session state on the local machine.`
      );
    }

    return null;
  }

  function ensureDashboardSessionTool(toolName, authInfo = null) {
    if (localWalletStore || hasConfiguredDashboardAccess(authInfo) || hostedAuthEnabled) {
      return null;
    }

    return errorContent(
      "This tool needs an Apiosk dashboard session. In remote MCP clients, authorize the Apiosk app first. In the local stdio package, call apiosk_create_account or apiosk_sign_in."
    );
  }

  async function handleCreateAccount(argumentsObject = {}) {
    const localOnlyError = ensureLocalDashboardSessionTools("apiosk_create_account");
    if (localOnlyError) return localOnlyError;

    const email = trimString(argumentsObject.email);
    const password = trimString(argumentsObject.password);

    if (!email) return errorContent("Missing required field: email");
    if (!password) return errorContent("Missing required field: password");

    const payload = await requestDashboard(
      "/api/auth/mcp-sign-up",
      {
        method: "POST",
        body: { email, password },
      },
      { requireAuth: false }
    );
    const record = asObject(payload) || {};

    let savedSession = false;
    if (typeof record.session_token === "string" && record.session_token.trim() && argumentsObject.save_session !== false) {
      await saveLocalApioskDashboardSession(
        {
          session_token: record.session_token,
          expires_at: record.expires_at,
          email,
          control_plane_url: resolveControlPlaneUrl(env),
          dashboard_url: trimString(env.APIOSK_DASHBOARD_URL || "https://dashboard.apiosk.com"),
        },
        env
      );
      savedSession = true;
    }

    return content({
      ...record,
      saved_session: savedSession,
      local_config_paths: createApioskLocalConfigPaths(env),
      next_steps:
        record.email_confirmation_required ?
          [
            "Tell the user to confirm their email from the Supabase/Apiosk email they just received.",
            "After confirmation, call apiosk_sign_in.",
          ] :
          [
            "Explore the Apiosk catalog with apiosk_search or apiosk_explore.",
          ],
    });
  }

  async function handleSignIn(argumentsObject = {}) {
    const localOnlyError = ensureLocalDashboardSessionTools("apiosk_sign_in");
    if (localOnlyError) return localOnlyError;

    const email = trimString(argumentsObject.email);
    const password = trimString(argumentsObject.password);

    if (!email) return errorContent("Missing required field: email");
    if (!password) return errorContent("Missing required field: password");

    const payload = await requestDashboard(
      "/api/auth/mcp-sign-in",
      {
        method: "POST",
        body: { email, password },
      },
      { requireAuth: false }
    );
    const record = asObject(payload) || {};

    let savedSession = false;
    if (typeof record.session_token === "string" && record.session_token.trim() && argumentsObject.save_session !== false) {
      await saveLocalApioskDashboardSession(
        {
          session_token: record.session_token,
          expires_at: record.expires_at,
          email,
          control_plane_url: resolveControlPlaneUrl(env),
          dashboard_url: trimString(env.APIOSK_DASHBOARD_URL || "https://dashboard.apiosk.com"),
        },
        env
      );
      savedSession = true;
    }

    return content({
      ...record,
      saved_session: savedSession,
      local_config_paths: createApioskLocalConfigPaths(env),
      next_steps: [
        "Explore the Apiosk catalog with apiosk_search or apiosk_explore.",
      ],
    });
  }

  async function handleWalletList(authInfo = null) {
    return content(await requestDashboard("/api/agent-wallets", {}, {}, authInfo));
  }

  async function handleWalletCreate(argumentsObject = {}, authInfo = null) {
    return content(
      await requestDashboard(
        "/api/agent-wallets",
        {
          method: "POST",
          body: argumentsObject,
        },
        {},
        authInfo
      )
    );
  }

  async function handleWalletUpdate(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const { wallet_id, ...updates } = argumentsObject;
    return content(
      await requestDashboard(
        `/api/agent-wallets/${wallet_id}`,
        {
          method: "PATCH",
          body: updates,
        },
        {},
        authInfo
      )
    );
  }

  async function handleWalletDelete(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(
      await requestDashboard(
        `/api/agent-wallets/${argumentsObject.wallet_id}`,
        {
          method: "DELETE",
        },
        {},
        authInfo
      )
    );
  }

  async function handleWalletActivity(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const params = new URLSearchParams();
    if (argumentsObject.page !== undefined) params.set("page", String(argumentsObject.page));
    if (argumentsObject.limit !== undefined) params.set("limit", String(argumentsObject.limit));
    const query = params.toString();

    return content(
      await requestDashboard(
        `/api/agent-wallets/${argumentsObject.wallet_id}/transactions${query ? `?${query}` : ""}`,
        {},
        {},
        authInfo
      )
    );
  }

  async function handleWalletConnectString(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const { wallet_id, ...body } = argumentsObject;
    return content(
      await requestDashboard(
        `/api/agent-wallets/${wallet_id}/connect-string`,
        {
          method: "POST",
          body,
        },
        {},
        authInfo
      )
    );
  }

  async function handleWalletApiKeys(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(
      await requestDashboard(
        `/api/agent-wallets/${argumentsObject.wallet_id}/api-keys`,
        {},
        {},
        authInfo
      )
    );
  }

  async function handleWalletApiKeyCreate(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const { wallet_id, ...body } = argumentsObject;
    return content(
      await requestDashboard(
        `/api/agent-wallets/${wallet_id}/api-keys`,
        {
          method: "POST",
          body,
        },
        {},
        authInfo
      )
    );
  }

  async function handleWalletApiKeyUpdate(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }
    if (!argumentsObject.key_id) {
      return errorContent("Missing required field: key_id");
    }

    const { wallet_id, key_id, ...body } = argumentsObject;
    return content(
      await requestDashboard(
        `/api/agent-wallets/${wallet_id}/api-keys/${key_id}`,
        {
          method: "PATCH",
          body,
        },
        {},
        authInfo
      )
    );
  }

  async function handleWalletApiKeyDelete(argumentsObject = {}, authInfo = null) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }
    if (!argumentsObject.key_id) {
      return errorContent("Missing required field: key_id");
    }

    return content(
      await requestDashboard(
        `/api/agent-wallets/${argumentsObject.wallet_id}/api-keys/${argumentsObject.key_id}`,
        { method: "DELETE" },
        {},
        authInfo
      )
    );
  }

  async function handleLocalWalletList() {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }

    return content(await localWalletStore.listWallets());
  }

  async function handleLocalWalletCreate(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }

    const created = await localWalletStore.createWallet(argumentsObject);

    if (argumentsObject.return_secret === true) {
      const secret = await localWalletStore.revealSecret(created.wallet.id);
      created.private_key = secret.private_key;
      created.warning = secret.warning;
    }

    if (argumentsObject.save_secret === true) {
      created.secret_export = await localWalletStore.saveSecret(created.wallet.id, {
        path: argumentsObject.save_to,
        format: argumentsObject.save_format,
      });
    }

    // Force include_qr_data_url so we can append an inline image content
    // block below — clients that render images (Claude Desktop, MCP
    // Inspector) will then show the funding QR right next to the
    // newly-created wallet without a follow-up tool call.
    created.configure = await buildConfigurePayload({
      wallet_id: created.wallet.id,
      section: "overview",
      include_qr_data_url: true,
    });

    const result = content(created);
    const dataUrl = created.configure?.funding?.receive_on_base?.qr_code_data_url;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
      result.content.push({
        type: "image",
        data: dataUrl.slice("data:image/png;base64,".length),
        mimeType: "image/png",
      });
    }
    return result;
  }

  async function handleConfigure(argumentsObject = {}) {
    return content(await buildConfigurePayload(argumentsObject));
  }

  async function handleShowWalletFunding(argumentsObject = {}) {
    const wallet = await resolveConfigurationWallet(argumentsObject.wallet_id);
    if (!wallet?.address) {
      return errorContent(
        "No managed wallet is available. Use apiosk_create_wallet (or apiosk_get_started) to create one first.",
      );
    }

    const funding = await buildFundingOptions({
      wallet,
      env,
      fundingProvider: "manual",
      includeQrDataUrl: true,
    });
    if (!funding?.receive_on_base) {
      return errorContent("Could not build funding instructions for this wallet.");
    }

    const receive = funding.receive_on_base;
    const baseUsdcContract = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
    const lines = [
      "Send USDC to your Apiosk wallet:",
      "",
      `Address: ${receive.address}`,
      "Network: Base mainnet (chain id 8453)",
      `Token:   USDC (${baseUsdcContract})`,
      "",
      "WARNING: only Base mainnet USDC. Sending from Ethereum, Polygon, Solana,",
      "or any other network will permanently lose the funds — this address is",
      "Base only.",
      "",
      `Block explorer: ${receive.explorer_url}`,
    ];
    if (receive.qr_code_terminal) {
      lines.push("", receive.qr_code_terminal);
    } else if (receive.qr_image_url) {
      lines.push("", `QR image: ${receive.qr_image_url}`);
    }

    const messageContent = [{ type: "text", text: lines.join("\n") }];

    // Render the QR inline via MCP image content when the buyer's client
    // supports images (Claude Desktop, the MCP Inspector, etc.). Falls back
    // gracefully on terminals without image support — the text block above
    // still has the address and the ANSI QR.
    const dataUrl = receive.qr_code_data_url;
    if (typeof dataUrl === "string" && dataUrl.startsWith("data:image/png;base64,")) {
      messageContent.push({
        type: "image",
        data: dataUrl.slice("data:image/png;base64,".length),
        mimeType: "image/png",
      });
    }

    return {
      content: messageContent,
      structuredContent: {
        wallet_id: wallet.id ?? null,
        wallet_label: wallet.label ?? null,
        address: receive.address,
        network: "base",
        chain_id: 8453,
        token_symbol: "USDC",
        token_contract: baseUsdcContract,
        explorer_url: receive.explorer_url,
        qr_payload: receive.qr_payload,
        qr_image_url: receive.qr_image_url,
        transfer_uri: receive.transfer_uri,
      },
    };
  }

  async function handleGetStarted(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent(
        "apiosk_get_started is only available in the local stdio package because it saves wallet and connect-token state on the local machine."
      );
    }

    let savedConfig = await getSavedConfig();
    let savedConnectConfig = summarizeSavedConnectConfig(savedConfig, env);
    let createdWallet = null;
    let selectedWallet = null;

    if (trimString(argumentsObject.connect_string)) {
      const parsed = parseConnectString(argumentsObject.connect_string);
      await saveLocalApioskConfig(
        {
          gateway_url: parsed.gateway_url,
          chain_id: parsed.chain_id,
          wallet_address: parsed.wallet_address,
          connect_token: parsed.connect_token,
          connect_authorization: parsed.connect_authorization,
          connect_header_name: parsed.connect_header_name,
          daily_limit_usdc: parsed.daily_limit_usdc,
          per_request_limit_usdc: parsed.per_request_limit_usdc,
        },
        env
      );
      savedConfig = await getSavedConfig();
      savedConnectConfig = summarizeSavedConnectConfig(savedConfig, env);
    } else if (
      trimString(argumentsObject.connect_token) ||
      trimString(argumentsObject.connect_authorization)
    ) {
      await saveLocalApioskConfig(
        {
          gateway_url: resolveGatewayBaseUrl(env, savedConfig),
          chain_id: savedConfig?.chain_id || 8453,
          wallet_address:
            trimString(argumentsObject.wallet_address) ||
            trimString(savedConfig?.agent_wallet_address),
          connect_token:
            trimString(argumentsObject.connect_token) || trimString(savedConfig?.connect_token),
          connect_authorization:
            trimString(argumentsObject.connect_authorization) ||
            trimString(savedConfig?.connect_authorization),
          connect_header_name:
            trimString(argumentsObject.connect_header_name) ||
            trimString(savedConfig?.connect_header_name) ||
            "X-Apiosk-Connect-Token",
          daily_limit_usdc: savedConfig?.daily_limit_usdc,
          per_request_limit_usdc: savedConfig?.per_request_limit_usdc,
        },
        env
      );
      savedConfig = await getSavedConfig();
      savedConnectConfig = summarizeSavedConnectConfig(savedConfig, env);
    }

    if (trimString(argumentsObject.wallet_id)) {
      const selected = await localWalletStore.selectWallet(trimString(argumentsObject.wallet_id));
      selectedWallet = selected.wallet;
    }

    let activeWallet = await resolveConfigurationWallet(argumentsObject.wallet_id);
    let authState = buildAuthState({ env, savedConfig, activeWallet });

    if (authState.mode === "none" && argumentsObject.create_wallet !== false) {
      const created = await localWalletStore.createWallet({
        label: trimString(argumentsObject.wallet_label) || "Apiosk wallet",
        set_active: true,
      });
      createdWallet = created.wallet;
      activeWallet = await resolveConfigurationWallet(created.wallet.id);
      authState = buildAuthState({ env, savedConfig, activeWallet });
    }

    if (authState.mode === "none") {
      return errorContent({
        error:
          "No Apiosk payment or access method is configured yet. Provide a connect string or allow apiosk_get_started to create a local wallet.",
        local_config_paths: createApioskLocalConfigPaths(env),
        next_steps: [
          "Call apiosk_get_started with connect_string from the dashboard, or set create_wallet=true.",
          "If you already manage auth outside the MCP package, set APIOSK_PRIVATE_KEY or APIOSK_CONNECT_TOKEN in the MCP environment.",
        ],
      });
    }

    const client = await getClient();
    const discoveryResponse = await client.listApis({ limit: 5, offset: 0 });
    await getTools(true);

    const discoveredApis = (discoveryResponse.apis || []).map((api) =>
      buildCatalogEntry(api, cache.toolNamesBySlug.get(api.slug) || null)
    );
    const testSlug =
      trimString(argumentsObject.test_slug) ||
      discoveredApis.find((api) => api.slug)?.slug ||
      null;
    const testInput =
      Object.prototype.hasOwnProperty.call(argumentsObject, "test_input") ?
        argumentsObject.test_input :
        {};

    let metadata = null;
    if (testSlug) {
      metadata = await client.getMetadata(testSlug).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    let status = "configured";
    let summary =
      "Apiosk is configured locally. Discovery worked, but the test execute call still needs a specific slug or input payload.";
    let executeResult = null;
    let executeError = null;
    let configure = null;

    if (testSlug) {
      try {
        executeResult = await client.execute(testSlug, testInput, {
          operation: argumentsObject.test_operation,
        });
        status = "ready";
        summary = `Apiosk is configured and the test call to ${testSlug} succeeded.`;
      } catch (error) {
        if (error instanceof ApioskPaymentRequiredError) {
          status = "needs_funding";
          summary =
            "Apiosk is configured, but the first paid execute call still needs wallet funding or a managed wallet with spend available.";
          executeError = {
            error: error.message,
            payment_required: error.paymentRequired,
          };
          if (activeWallet?.source === "local_store" && activeWallet?.id) {
            configure = await buildConfigurePayload({
              wallet_id: activeWallet.id,
              section: "funding",
              include_qr_data_url: argumentsObject.include_qr_data_url,
            });
          }
        } else {
          executeError = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    if (!configure && activeWallet?.source === "local_store" && activeWallet?.id) {
      configure = await buildConfigurePayload({
        wallet_id: activeWallet.id,
        section: "overview",
        include_qr_data_url: argumentsObject.include_qr_data_url,
      });
    }

    const nextSteps = [];
    if (status === "ready") {
      nextSteps.push(
        "Call the API-specific dynamic tool from discovery, or use apiosk_execute with a different slug.",
        "Use apiosk_publish_api when you want to list your own API behind the gateway."
      );
    } else if (status === "needs_funding") {
      nextSteps.push(
        "Fund the selected local wallet, then rerun apiosk_get_started or retry the API-specific tool.",
        "If you prefer managed access, import a dashboard connect string into apiosk_get_started instead of using a local wallet."
      );
    } else {
      nextSteps.push(
        "Provide test_slug and test_input to apiosk_get_started if you want a more representative first execute call.",
        "Use apiosk_get_api on one of the discovered slugs to inspect its metadata and input shape before retrying."
      );
    }

    return content({
      status,
      summary,
      auth: {
        ...authState,
        saved_connect_config: savedConnectConfig,
        local_config_paths: createApioskLocalConfigPaths(env),
      },
      setup: {
        created_wallet: createdWallet,
        selected_wallet: selectedWallet,
        active_wallet: activeWallet,
      },
      discovery: {
        apis: discoveredApis,
        meta: discoveryResponse.meta || null,
      },
      test: {
        slug: testSlug,
        operation: trimString(argumentsObject.test_operation) || null,
        input: testInput,
        metadata,
        result: executeResult,
        error: executeError,
      },
      configure,
      next_steps: nextSteps,
    });
  }

  async function handleLocalWalletSelect(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const selected = await localWalletStore.selectWallet(argumentsObject.wallet_id);
    selected.configure = await buildConfigurePayload({
      wallet_id: argumentsObject.wallet_id,
      section: "overview",
      include_qr_data_url: argumentsObject.include_qr_data_url,
    });
    return content(selected);
  }

  async function handleLocalWalletUpdate(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(
      await localWalletStore.updateWallet(argumentsObject.wallet_id, {
        label: argumentsObject.label,
        set_active: argumentsObject.set_active,
      })
    );
  }

  async function handleLocalWalletDelete(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(await localWalletStore.deleteWallet(argumentsObject.wallet_id));
  }

  async function handleLocalWalletReveal(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(await localWalletStore.revealSecret(argumentsObject.wallet_id));
  }

  async function handleLocalWalletSave(argumentsObject = {}) {
    if (!localWalletStore) {
      return errorContent("Local wallet tools are not enabled in this server mode.");
    }
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(
      await localWalletStore.saveSecret(argumentsObject.wallet_id, {
        path: argumentsObject.path,
        format: argumentsObject.format,
      })
    );
  }

  async function handlePublishApi(argumentsObject = {}) {
    const wallet = await resolvePublishingWallet(argumentsObject.wallet_id);
    const slug = trimString(argumentsObject.slug);
    const endpointUrl = trimString(argumentsObject.endpoint_url);
    const priceUsd = Number(argumentsObject.price_usd);
    const name = trimString(argumentsObject.name);
    const description = trimString(argumentsObject.description);

    if (!name || !slug || !endpointUrl || !description || !Number.isFinite(priceUsd)) {
      return errorContent(
        "Missing required publish fields. Expected name, slug, endpoint_url, price_usd, and description."
      );
    }

    if (!validateSlug(slug)) {
      return errorContent("Slug must use lowercase letters, numbers, and hyphens only.");
    }

    if (!endpointUrl.startsWith("https://")) {
      return errorContent("endpoint_url must start with https://");
    }

    const category = resolveCategory(argumentsObject.category, argumentsObject.listing_group);
    const payload = {
      name,
      slug,
      endpoint_url: endpointUrl,
      price_usd: priceUsd,
      description,
      owner_wallet: wallet.address,
      category,
      listing_metadata: buildListingMetadata({
        name,
        slug,
        description,
        endpoint_url: endpointUrl,
        price_usd: priceUsd,
        category,
        listing_group: argumentsObject.listing_group,
        listing_metadata: argumentsObject.listing_metadata,
      }),
    };

    const response = await requestGatewayManagement({
      baseUrl: resolveGatewayBaseUrl(env),
      path: "/v1/apis/register",
      method: "POST",
      body: payload,
      action: "register_api",
      resource: `register:${slug}`,
      wallet,
    });

    cache.expiresAt = 0;

    return content({
      ...response,
      wallet: {
        address: wallet.address,
        source: wallet.source,
      },
    });
  }

  async function handleListMyApis(argumentsObject = {}) {
    const wallet = await resolvePublishingWallet(argumentsObject.wallet_id);
    const response = await requestGatewayManagement({
      baseUrl: resolveGatewayBaseUrl(env),
      path: `/v1/apis/mine?wallet=${encodeURIComponent(wallet.address)}`,
      method: "GET",
      action: "my_apis",
      resource: `mine:${wallet.address}`,
      wallet,
    });

    return content({
      wallet: {
        address: wallet.address,
        source: wallet.source,
      },
      ...response,
    });
  }

  async function handleUpdateApi(argumentsObject = {}) {
    const wallet = await resolvePublishingWallet(argumentsObject.wallet_id);
    const slug = trimString(argumentsObject.slug);

    if (!slug) {
      return errorContent("Missing required field: slug");
    }

    const body = {
      owner_wallet: wallet.address,
    };

    if (argumentsObject.endpoint_url !== undefined) {
      const endpointUrl = trimString(argumentsObject.endpoint_url);
      if (!endpointUrl.startsWith("https://")) {
        return errorContent("endpoint_url must start with https://");
      }
      body.endpoint_url = endpointUrl;
    }

    if (argumentsObject.price_usd !== undefined) {
      const priceUsd = Number(argumentsObject.price_usd);
      if (!Number.isFinite(priceUsd)) {
        return errorContent("price_usd must be a valid number");
      }
      body.price_usd = priceUsd;
    }

    if (argumentsObject.description !== undefined) {
      body.description = trimString(argumentsObject.description);
    }

    if (argumentsObject.active !== undefined) {
      body.active = Boolean(argumentsObject.active);
    }

    if (argumentsObject.listing_metadata !== undefined) {
      body.listing_metadata = argumentsObject.listing_metadata;
    }

    const response = await requestGatewayManagement({
      baseUrl: resolveGatewayBaseUrl(env),
      path: `/v1/apis/${encodeURIComponent(slug)}`,
      method: "POST",
      body,
      action: "update_api",
      resource: `update:${slug}`,
      wallet,
    });

    cache.expiresAt = 0;

    return content({
      slug,
      wallet: {
        address: wallet.address,
        source: wallet.source,
      },
      ...response,
    });
  }

  async function handleDeleteApi(argumentsObject = {}) {
    const wallet = await resolvePublishingWallet(argumentsObject.wallet_id);
    const slug = trimString(argumentsObject.slug);

    if (!slug) {
      return errorContent("Missing required field: slug");
    }

    const response = await requestGatewayManagement({
      baseUrl: resolveGatewayBaseUrl(env),
      path: `/v1/apis/${encodeURIComponent(slug)}?wallet=${encodeURIComponent(wallet.address)}`,
      method: "DELETE",
      action: "delete_api",
      resource: `delete:${slug}`,
      wallet,
    });

    cache.expiresAt = 0;

    return content({
      slug,
      wallet: {
        address: wallet.address,
        source: wallet.source,
      },
      ...response,
    });
  }

  async function callTool(name, argumentsObject = {}, authInfo = null) {
    try {
      if (name === "apiosk_help") return await handleHelp(argumentsObject);
      if (name === "apiosk_payment_guide") return await handlePaymentGuide(argumentsObject, authInfo);
      if (name === "apiosk_explore") return await handleExplore(argumentsObject, authInfo);
      if (name === "apiosk_search") return await handleSearch(argumentsObject, authInfo);
      if (name === "apiosk_get_api" || name === "apiosk_metadata") {
        return await handleGetApi(argumentsObject, authInfo);
      }
      if (name === "apiosk_execute") return await handleExecute(argumentsObject, authInfo);
      if (name === "apiosk_health") return await handleHealth(argumentsObject, authInfo);

      if (name === "apiosk_wallet_list") return await handleLocalWalletList();
      if (name === "apiosk_wallet_create") return await handleLocalWalletCreate(argumentsObject);
      if (name === "apiosk_get_started") return await handleGetStarted(argumentsObject);
      if (name === "apiosk_configure") return await handleConfigure(argumentsObject);
      if (name === "apiosk_show_wallet_funding")
        return await handleShowWalletFunding(argumentsObject);
      if (name === "apiosk_wallet_select") return await handleLocalWalletSelect(argumentsObject);
      if (name === "apiosk_wallet_update") return await handleLocalWalletUpdate(argumentsObject);
      if (name === "apiosk_wallet_delete") return await handleLocalWalletDelete(argumentsObject);
      if (name === "apiosk_wallet_reveal_secret") return await handleLocalWalletReveal(argumentsObject);
      if (name === "apiosk_wallet_save_secret") return await handleLocalWalletSave(argumentsObject);

      if (name === "apiosk_publish_api") return await handlePublishApi(argumentsObject);
      if (name === "apiosk_list_my_apis") return await handleListMyApis(argumentsObject);
      if (name === "apiosk_update_api") return await handleUpdateApi(argumentsObject);
      if (name === "apiosk_delete_api") return await handleDeleteApi(argumentsObject);

      if (name === "apiosk_create_account") return await handleCreateAccount(argumentsObject);
      if (name === "apiosk_sign_in") return await handleSignIn(argumentsObject);
      if (name === "apiosk_list_wallets") return await handleWalletList(authInfo);
      if (name === "apiosk_create_wallet") return await handleWalletCreate(argumentsObject, authInfo);
      if (name === "apiosk_update_wallet") return await handleWalletUpdate(argumentsObject, authInfo);
      if (name === "apiosk_delete_wallet") return await handleWalletDelete(argumentsObject, authInfo);
      if (name === "apiosk_get_wallet_activity") return await handleWalletActivity(argumentsObject, authInfo);
      if (name === "apiosk_create_wallet_connect_string") return await handleWalletConnectString(argumentsObject, authInfo);
      if (name === "apiosk_list_wallet_api_keys") return await handleWalletApiKeys(argumentsObject, authInfo);
      if (name === "apiosk_create_wallet_api_key") return await handleWalletApiKeyCreate(argumentsObject, authInfo);
      if (name === "apiosk_update_wallet_api_key") return await handleWalletApiKeyUpdate(argumentsObject, authInfo);
      if (name === "apiosk_delete_wallet_api_key") return await handleWalletApiKeyDelete(argumentsObject, authInfo);

      const tool = await resolveDynamicTool(name, authInfo);
      if (!tool) {
        return errorContent(`Unknown Apiosk tool: ${name}`);
      }

      return await handleDynamicExecute(tool, argumentsObject, authInfo);
    } catch (error) {
      if (error instanceof ApioskPaymentRequiredError) {
        return errorContent({
          error: error.message,
          hint:
            "Run apiosk_get_started in the local stdio package, or configure APIOSK_PRIVATE_KEY, to enable automatic x402 settlement.",
          payment_required: error.paymentRequired,
        });
      }

      return errorContent({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    listTools: (authInfo = null) => getTools(false, authInfo),
    isToolProtected,
    callTool,
  };
}
