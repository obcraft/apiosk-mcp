import { ApioskClient, ApioskPaymentRequiredError } from "@apiosk/sdk";
import { privateKeyToAccount } from "viem/accounts";

import { buildFundingOptions } from "./funding-options.mjs";
import { requestGatewayManagement } from "./gateway-management.mjs";
import { buildListingMetadata, resolveCategory } from "./listing-metadata.mjs";
import { createLocalWalletStore } from "./wallet-store.mjs";

const DEFAULT_LIMIT = 25;
const CACHE_TTL_MS = 60_000;
const DEFAULT_GATEWAY_BASE_URL = "https://gateway.apiosk.com";

const DASHBOARD_WALLET_TOOLS = [
  {
    name: "apiosk_list_wallets",
    description: "List the signed-in user's managed Apiosk wallets. Requires APIOSK_DASHBOARD_JWT or APIOSK_USER_JWT in the local MCP environment.",
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
];

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

const DISCOVERY_TOOLS = [
  {
    name: "apiosk_help",
    description: "Explain what Apiosk MCP is, how to connect it, how auth and x402 payments work, and the recommended workflow for discovery, wallets, and publishing.",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          enum: ["overview", "setup", "auth", "workflow", "payments", "wallets", "publish", "configure"],
          description: "Optional help topic. Defaults to overview.",
        },
      },
    },
  },
  {
    name: "apiosk_explore",
    description: "Browse Apiosk listing groups and explore one group at a time before narrowing with search.",
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
  },
  {
    name: "apiosk_search",
    description: "Search and browse the Apiosk catalog. Use this first when you need to find APIs by capability, price, or category.",
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
  },
  {
    name: "apiosk_get_api",
    description: "Fetch full listing detail and agent metadata for a specific Apiosk API slug.",
    inputSchema: {
      type: "object",
      required: ["slug"],
      properties: {
        slug: {
          type: "string",
          description: "Apiosk API slug, for example 'agent-json-diff'.",
        },
      },
    },
  },
  {
    name: "apiosk_execute",
    description: "Fallback execute tool for any Apiosk API. Prefer the API-specific dynamic tool when one is available.",
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
  },
];

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

function resolveDashboardUserToken(env = process.env) {
  return trimString(
    env.APIOSK_DASHBOARD_JWT ||
      env.APIOSK_USER_JWT ||
      env.APIOSK_AUTH_HEADER_VALUE ||
      env.APIOSK_SESSION_TOKEN
  );
}

function resolveDashboardUrl(env = process.env) {
  return trimString(env.APIOSK_DASHBOARD_URL || "https://dashboard.apiosk.com").replace(/\/+$/, "");
}

function resolveGatewayBaseUrl(env = process.env) {
  return trimString(env.APIOSK_GATEWAY || DEFAULT_GATEWAY_BASE_URL).replace(/\/+$/, "");
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

function createDashboardWalletManagerFromEnv(env = process.env) {
  const dashboardUrl = resolveDashboardUrl(env);
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
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
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

function buildHelpPayload(topic = "overview", options = {}) {
  const selectedTopic = String(topic || "overview");
  const localWalletsEnabled = Boolean(options.localWalletsEnabled);

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
          : "Wallet and publish tools are disabled in this server mode unless local wallets are enabled",
      ],
      next_steps: [
        "Use apiosk_explore or apiosk_search to find an API",
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
        "Remote HTTP: claude mcp add --transport http apiosk https://apiosk-mcp.fly.dev/mcp",
        "Verify: claude mcp get apiosk",
      ],
      local_stdio: [
        "npx -y apiosk-mcp-server",
        "Or add a stdio config that runs npx -y apiosk-mcp-server",
      ],
      endpoint: "https://apiosk-mcp.fly.dev/mcp",
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
        "Use apiosk_wallet_create and apiosk_wallet_select in the local stdio package for the cleanest autonomous workflow",
        "Use APIOSK_PRIVATE_KEY when you want deterministic wallet selection from environment variables",
        "Use APIOSK_CONNECT_TOKEN when access is managed in the dashboard",
      ],
    },
    wallets: {
      topic: "wallets",
      summary: "Local wallet tools let Claude or Codex create, select, reveal, and save wallet secrets without opening the dashboard.",
      tools: [
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
  const walletManager = options.walletManager || createDashboardWalletManagerFromEnv(env);
  const localWalletStore =
    options.localWalletStore ||
    (options.enableLocalWallets === false ? null : createLocalWalletStore(env));
  const cache = {
    catalog: null,
    expiresAt: 0,
    tools: null,
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

  async function getClient() {
    if (fixedClient) {
      return fixedClient;
    }

    const activeWallet = await getActiveExecutionWallet();
    const envWalletAddress = trimString(env.APIOSK_WALLET_ADDRESS).toLowerCase();
    const privateKey = activeWallet?.private_key || normalizePrivateKeyHex(env.APIOSK_PRIVATE_KEY) || undefined;
    const walletAddress = privateKey
      ? activeWallet?.address
      : envWalletAddress || activeWallet?.address;

    return new ApioskClient({
      baseUrl: resolveGatewayBaseUrl(env),
      connectToken: trimString(env.APIOSK_CONNECT_TOKEN) || undefined,
      connectHeaderName: trimString(env.APIOSK_CONNECT_HEADER_NAME) || undefined,
      authorization: trimString(env.APIOSK_CONNECT_AUTHORIZATION) || undefined,
      walletAddress: walletAddress || undefined,
      xPayment: trimString(env.APIOSK_X_PAYMENT) || undefined,
      privateKey,
    });
  }

  function getStaticTools() {
    const tools = [...DISCOVERY_TOOLS];

    if (localWalletStore) {
      tools.push(...LOCAL_WALLET_TOOLS, ...PUBLISH_TOOLS);
    }

    if (walletManager.isConfigured()) {
      tools.push(...DASHBOARD_WALLET_TOOLS);
    }

    return tools;
  }

  async function getCatalog(force = false) {
    if (!force && cache.catalog && Date.now() < cache.expiresAt) {
      return cache.catalog;
    }

    const client = await getClient();
    const response = await client.listApis({ limit: 500, offset: 0 });
    cache.catalog = response.apis || [];
    cache.expiresAt = Date.now() + CACHE_TTL_MS;
    cache.tools = null;
    cache.toolIndex = new Map();
    cache.toolNamesBySlug = new Map();
    return cache.catalog;
  }

  async function getTools(force = false) {
    if (!force && cache.tools && Date.now() < cache.expiresAt) {
      return cache.tools;
    }

    const catalog = await getCatalog(force);
    const staticTools = getStaticTools();
    const { tools, toolIndex } = buildDynamicTools(catalog, staticTools);

    cache.tools = [...staticTools, ...tools];
    cache.toolIndex = toolIndex;
    cache.toolNamesBySlug = new Map(
      Array.from(toolIndex.values()).map((entry) => [entry.api.slug, entry.toolName])
    );

    return cache.tools;
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
        dashboard_wallet_tools_enabled: walletManager.isConfigured(),
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

  async function resolveDynamicTool(name) {
    await getTools();
    if (cache.toolIndex.has(name)) {
      return cache.toolIndex.get(name);
    }

    await getTools(true);
    return cache.toolIndex.get(name) || null;
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

  async function handleExplore(argumentsObject = {}) {
    const client = await getClient();
    if (!argumentsObject.listing_type) {
      const response = await client.requestJson("/types", { method: "GET" });
      return content({
        ...response,
        next_steps:
          "Pick a listing_type and call apiosk_explore again, or use apiosk_search for full-text discovery.",
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
      next_steps:
        "Use apiosk_get_api for detail or call apiosk_search if you want category filtering across the whole catalog.",
    });
  }

  async function handleSearch(argumentsObject = {}) {
    const client = await getClient();
    const response = await client.listApis({
      search: argumentsObject.search,
      category: argumentsObject.category,
      sort: argumentsObject.sort,
      order: argumentsObject.order,
      limit: argumentsObject.limit || DEFAULT_LIMIT,
      offset: argumentsObject.offset || 0,
    });

    const catalog = response.apis || [];
    await getTools();

    return content({
      apis: catalog.map((api) => buildCatalogEntry(api, cache.toolNamesBySlug.get(api.slug) || null)),
      meta: response.meta,
      next_steps: "Call apiosk_get_api for full metadata, or use the API-specific tool directly when tool_name is present.",
    });
  }

  async function handleGetApi(argumentsObject = {}) {
    if (!argumentsObject.slug) {
      return errorContent("Missing required field: slug");
    }

    const client = await getClient();
    const [detail, metadata] = await Promise.all([
      client.getApi(argumentsObject.slug),
      client.getMetadata(argumentsObject.slug).catch(() => null),
    ]);

    return content({
      detail,
      metadata,
    });
  }

  async function handleExecute(argumentsObject = {}) {
    if (!argumentsObject.slug) {
      return errorContent("Missing required field: slug");
    }

    const client = await getClient();
    const result = await client.execute(argumentsObject.slug, argumentsObject.input, {
      operation: argumentsObject.operation,
      query: argumentsObject.query,
      pathParams: argumentsObject.path_params,
    });

    return content(result);
  }

  async function handleDynamicExecute(tool, argumentsObject = {}) {
    const client = await getClient();
    const result = hasExecuteEnvelope(argumentsObject)
      ? await client.execute(tool.api.slug, argumentsObject.input, {
          operation: argumentsObject.operation,
          query: argumentsObject.query,
          pathParams: argumentsObject.path_params,
        })
      : await client.execute(tool.api.slug, argumentsObject);
    return content(result);
  }

  async function handleHelp(argumentsObject = {}) {
    return content(
      buildHelpPayload(argumentsObject.topic, {
        localWalletsEnabled: Boolean(localWalletStore),
      })
    );
  }

  async function handleWalletList() {
    return content(await walletManager.request("/api/agent-wallets"));
  }

  async function handleWalletCreate(argumentsObject = {}) {
    return content(
      await walletManager.request("/api/agent-wallets", {
        method: "POST",
        body: argumentsObject,
      })
    );
  }

  async function handleWalletUpdate(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const { wallet_id, ...updates } = argumentsObject;
    return content(
      await walletManager.request(`/api/agent-wallets/${wallet_id}`, {
        method: "PATCH",
        body: updates,
      })
    );
  }

  async function handleWalletDelete(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(
      await walletManager.request(`/api/agent-wallets/${argumentsObject.wallet_id}`, {
        method: "DELETE",
      })
    );
  }

  async function handleWalletActivity(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const params = new URLSearchParams();
    if (argumentsObject.page !== undefined) params.set("page", String(argumentsObject.page));
    if (argumentsObject.limit !== undefined) params.set("limit", String(argumentsObject.limit));
    const query = params.toString();

    return content(
      await walletManager.request(
        `/api/agent-wallets/${argumentsObject.wallet_id}/transactions${query ? `?${query}` : ""}`
      )
    );
  }

  async function handleWalletConnectString(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const { wallet_id, ...body } = argumentsObject;
    return content(
      await walletManager.request(`/api/agent-wallets/${wallet_id}/connect-string`, {
        method: "POST",
        body,
      })
    );
  }

  async function handleWalletApiKeys(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    return content(
      await walletManager.request(`/api/agent-wallets/${argumentsObject.wallet_id}/api-keys`)
    );
  }

  async function handleWalletApiKeyCreate(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }

    const { wallet_id, ...body } = argumentsObject;
    return content(
      await walletManager.request(`/api/agent-wallets/${wallet_id}/api-keys`, {
        method: "POST",
        body,
      })
    );
  }

  async function handleWalletApiKeyUpdate(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }
    if (!argumentsObject.key_id) {
      return errorContent("Missing required field: key_id");
    }

    const { wallet_id, key_id, ...body } = argumentsObject;
    return content(
      await walletManager.request(`/api/agent-wallets/${wallet_id}/api-keys/${key_id}`, {
        method: "PATCH",
        body,
      })
    );
  }

  async function handleWalletApiKeyDelete(argumentsObject = {}) {
    if (!argumentsObject.wallet_id) {
      return errorContent("Missing required field: wallet_id");
    }
    if (!argumentsObject.key_id) {
      return errorContent("Missing required field: key_id");
    }

    return content(
      await walletManager.request(
        `/api/agent-wallets/${argumentsObject.wallet_id}/api-keys/${argumentsObject.key_id}`,
        { method: "DELETE" }
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

    created.configure = await buildConfigurePayload({
      wallet_id: created.wallet.id,
      section: "overview",
      include_qr_data_url: argumentsObject.include_qr_data_url,
    });

    return content(created);
  }

  async function handleConfigure(argumentsObject = {}) {
    return content(await buildConfigurePayload(argumentsObject));
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

  async function callTool(name, argumentsObject = {}) {
    try {
      if (name === "apiosk_help") return await handleHelp(argumentsObject);
      if (name === "apiosk_explore") return await handleExplore(argumentsObject);
      if (name === "apiosk_search") return await handleSearch(argumentsObject);
      if (name === "apiosk_get_api") return await handleGetApi(argumentsObject);
      if (name === "apiosk_execute") return await handleExecute(argumentsObject);

      if (name === "apiosk_wallet_list") return await handleLocalWalletList();
      if (name === "apiosk_wallet_create") return await handleLocalWalletCreate(argumentsObject);
      if (name === "apiosk_configure") return await handleConfigure(argumentsObject);
      if (name === "apiosk_wallet_select") return await handleLocalWalletSelect(argumentsObject);
      if (name === "apiosk_wallet_update") return await handleLocalWalletUpdate(argumentsObject);
      if (name === "apiosk_wallet_delete") return await handleLocalWalletDelete(argumentsObject);
      if (name === "apiosk_wallet_reveal_secret") return await handleLocalWalletReveal(argumentsObject);
      if (name === "apiosk_wallet_save_secret") return await handleLocalWalletSave(argumentsObject);

      if (name === "apiosk_publish_api") return await handlePublishApi(argumentsObject);
      if (name === "apiosk_list_my_apis") return await handleListMyApis(argumentsObject);
      if (name === "apiosk_update_api") return await handleUpdateApi(argumentsObject);
      if (name === "apiosk_delete_api") return await handleDeleteApi(argumentsObject);

      if (name === "apiosk_list_wallets") return await handleWalletList();
      if (name === "apiosk_create_wallet") return await handleWalletCreate(argumentsObject);
      if (name === "apiosk_update_wallet") return await handleWalletUpdate(argumentsObject);
      if (name === "apiosk_delete_wallet") return await handleWalletDelete(argumentsObject);
      if (name === "apiosk_get_wallet_activity") return await handleWalletActivity(argumentsObject);
      if (name === "apiosk_create_wallet_connect_string") return await handleWalletConnectString(argumentsObject);
      if (name === "apiosk_list_wallet_api_keys") return await handleWalletApiKeys(argumentsObject);
      if (name === "apiosk_create_wallet_api_key") return await handleWalletApiKeyCreate(argumentsObject);
      if (name === "apiosk_update_wallet_api_key") return await handleWalletApiKeyUpdate(argumentsObject);
      if (name === "apiosk_delete_wallet_api_key") return await handleWalletApiKeyDelete(argumentsObject);

      const tool = await resolveDynamicTool(name);
      if (!tool) {
        return errorContent(`Unknown Apiosk tool: ${name}`);
      }

      return await handleDynamicExecute(tool, argumentsObject);
    } catch (error) {
      if (error instanceof ApioskPaymentRequiredError) {
        return errorContent({
          error: error.message,
          hint:
            "Configure APIOSK_PRIVATE_KEY, or create/select a local wallet with apiosk_wallet_create and apiosk_wallet_select, to enable automatic x402 settlement.",
          payment_required: error.paymentRequired,
        });
      }

      return errorContent({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    listTools: () => getTools(),
    callTool,
  };
}
