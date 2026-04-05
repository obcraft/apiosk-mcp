import { ApioskClient, ApioskPaymentRequiredError } from "@apiosk/sdk";

const DEFAULT_LIMIT = 25;
const CACHE_TTL_MS = 60_000;

const DISCOVERY_TOOLS = [
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

function createClientFromEnv(env = process.env) {
  return new ApioskClient({
    baseUrl: env.APIOSK_GATEWAY || "https://gateway.apiosk.com",
    connectToken: env.APIOSK_CONNECT_TOKEN,
    connectHeaderName: env.APIOSK_CONNECT_HEADER_NAME,
    authorization: env.APIOSK_CONNECT_AUTHORIZATION,
    walletAddress: env.APIOSK_WALLET_ADDRESS,
    xPayment: env.APIOSK_X_PAYMENT,
    privateKey: env.APIOSK_PRIVATE_KEY,
  });
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
    price_usd: api.price_usd ?? api.listing_metadata?.cost_per_call ?? null,
    docs_url: api.docs_url ?? api.listing_metadata?.provider?.docs_url ?? null,
    tool_name: toolName,
    default_operation: api.listing_metadata?.default_operation ?? null,
    tags: api.listing_metadata?.tags ?? [],
    mcp_native: api.listing_metadata?.mcp_native ?? false,
  };
}

function buildDynamicTools(catalog) {
  const tools = [];
  const toolIndex = new Map();
  const usedNames = new Set(DISCOVERY_TOOLS.map((tool) => tool.name));

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

export function createApioskMcpRuntime(options = {}) {
  const client = options.client || createClientFromEnv(options.env);
  const cache = {
    catalog: null,
    expiresAt: 0,
    tools: null,
    toolIndex: new Map(),
    toolNamesBySlug: new Map(),
  };

  async function getCatalog(force = false) {
    if (!force && cache.catalog && Date.now() < cache.expiresAt) {
      return cache.catalog;
    }

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
    const { tools, toolIndex } = buildDynamicTools(catalog);

    cache.tools = [...DISCOVERY_TOOLS, ...tools];
    cache.toolIndex = toolIndex;
    cache.toolNamesBySlug = new Map(
      Array.from(toolIndex.values()).map((entry) => [entry.api.slug, entry.toolName])
    );

    return cache.tools;
  }

  async function resolveDynamicTool(name) {
    await getTools();
    if (cache.toolIndex.has(name)) {
      return cache.toolIndex.get(name);
    }

    await getTools(true);
    return cache.toolIndex.get(name) || null;
  }

  async function handleSearch(argumentsObject = {}) {
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
      apis: catalog.map((api) => {
        return buildCatalogEntry(api, cache.toolNamesBySlug.get(api.slug) || null);
      }),
      meta: response.meta,
      next_steps: "Call apiosk_get_api for full metadata, or use the API-specific tool directly when tool_name is present.",
    });
  }

  async function handleGetApi(argumentsObject = {}) {
    if (!argumentsObject.slug) {
      return errorContent("Missing required field: slug");
    }

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

    const result = await client.execute(argumentsObject.slug, argumentsObject.input, {
      operation: argumentsObject.operation,
      query: argumentsObject.query,
      pathParams: argumentsObject.path_params,
    });

    return content(result);
  }

  function hasExecuteEnvelope(argumentsObject) {
    return Boolean(
      argumentsObject &&
      typeof argumentsObject === "object" &&
      (
        "operation" in argumentsObject ||
        "input" in argumentsObject ||
        "query" in argumentsObject ||
        "path_params" in argumentsObject
      )
    );
  }

  async function handleDynamicExecute(tool, argumentsObject = {}) {
    const result = hasExecuteEnvelope(argumentsObject)
      ? await client.execute(tool.api.slug, argumentsObject.input, {
          operation: argumentsObject.operation,
          query: argumentsObject.query,
          pathParams: argumentsObject.path_params,
        })
      : await client.execute(tool.api.slug, argumentsObject);
    return content(result);
  }

  async function callTool(name, argumentsObject = {}) {
    try {
      if (name === "apiosk_search") return await handleSearch(argumentsObject);
      if (name === "apiosk_get_api") return await handleGetApi(argumentsObject);
      if (name === "apiosk_execute") return await handleExecute(argumentsObject);

      const tool = await resolveDynamicTool(name);
      if (!tool) {
        return errorContent(`Unknown Apiosk tool: ${name}`);
      }

      return await handleDynamicExecute(tool, argumentsObject);
    } catch (error) {
      if (error instanceof ApioskPaymentRequiredError) {
        return errorContent({
          error: error.message,
          hint: "Configure APIOSK_PRIVATE_KEY for automatic x402 settlement, or provide a connect token / x-payment proof explicitly.",
          payment_required: error.paymentRequired,
        });
      }

      return errorContent({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    client,
    listTools: () => getTools(),
    callTool,
  };
}
