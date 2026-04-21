function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cloneJson(value, fallback) {
  if (value === undefined) return fallback;
  return JSON.parse(JSON.stringify(value));
}

function normalizePath(pathValue) {
  const value = String(pathValue || "/").trim();
  if (!value || value === "/") return "/";
  return value.startsWith("/") ? value : `/${value}`;
}

function normalizeTags(tags = []) {
  return Array.from(
    new Set(
      tags
        .map((tag) => String(tag || "").trim().toLowerCase())
        .filter(Boolean)
    )
  );
}

function defaultExecuteInputSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      operation: {
        type: "string",
        description: "Optional operation selector. Accepts an operation id, a path, or a METHOD /path key.",
      },
      input: {
        description: "JSON payload forwarded to the selected operation.",
      },
      query: {
        type: "object",
        additionalProperties: true,
        description: "Optional query parameter override for GET-style operations.",
      },
      path_params: {
        type: "object",
        additionalProperties: true,
        description: "Optional path parameter override for routes that include placeholders.",
      },
    },
  };
}

function defaultExecuteOutputSchema() {
  return {
    type: "object",
    required: ["status", "result", "cost", "latency", "operation", "api", "upstream_status"],
    properties: {
      status: { type: "string", enum: ["success", "error"] },
      result: {},
      cost: { type: "number" },
      latency: { type: "integer" },
      operation: { type: "string" },
      api: { type: "string" },
      upstream_status: { type: "integer" },
    },
  };
}

function defaultOperations(priceUsd) {
  return [
    {
      id: "/",
      key: "GET /",
      method: "GET",
      path: "/",
      price_usd: priceUsd,
      payment_required: true,
      description: "Forward a GET request to the API root.",
    },
    {
      id: "/",
      key: "POST /",
      method: "POST",
      path: "/",
      price_usd: priceUsd,
      payment_required: true,
      description: "Forward a POST request to the API root.",
    },
  ];
}

function normalizeOperation(operation, priceUsd) {
  const method = String(operation?.method || "POST").trim().toUpperCase();
  const path = normalizePath(operation?.path || operation?.id || "/");
  return {
    ...cloneJson(operation, {}),
    id: String(operation?.id || path),
    key: String(operation?.key || `${method} ${path}`),
    method,
    path,
    price_usd:
      typeof operation?.price_usd === "number" && Number.isFinite(operation.price_usd)
        ? operation.price_usd
        : priceUsd,
    payment_required:
      typeof operation?.payment_required === "boolean" ? operation.payment_required : true,
  };
}

function isDiagnosticOperationPath(path = "/") {
  const normalized = normalizePath(path);
  if (normalized === "/") return true;
  return normalized.split("/").filter(Boolean).some((segment) =>
    /^(health|status|metadata|docs?|openapi|swagger|ping|readyz?|livez?)$/i.test(segment)
  );
}

function defaultOperationRank(operation = {}) {
  const path = normalizePath(operation.path || operation.id || "/");
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  const segments = trimmed ? trimmed.split("/").filter(Boolean).length : 0;
  const method = String(operation.method || "POST").trim().toUpperCase();
  const methodRank =
    method === "POST"
      ? 0
      : method === "PUT"
        ? 1
        : method === "PATCH"
          ? 2
          : method === "DELETE"
            ? 3
            : method === "GET"
              ? 4
              : method === "HEAD"
                ? 5
                : 6;
  return [
    isDiagnosticOperationPath(path) ? 1 : 0,
    /batch/i.test(path) ? 1 : 0,
    segments,
    path.length,
    methodRank,
    operation.payment_required === false ? 1 : 0,
    `${method} ${path}`,
  ];
}

function inferDefaultOperation(operations = []) {
  const ranked = [...operations].sort((left, right) => {
    const leftRank = defaultOperationRank(left);
    const rightRank = defaultOperationRank(right);
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] < rightRank[index]) return -1;
      if (leftRank[index] > rightRank[index]) return 1;
    }
    return 0;
  });
  return ranked[0]?.id || operations[0]?.id || "/";
}

function inferReadOnlyHint(operations = [], slug = "", name = "", description = "") {
  const allReadOnly =
    operations.length > 0 &&
    operations.every((operation) => operation.method === "GET" || operation.method === "HEAD");

  if (allReadOnly) return true;

  return /extract|lookup|watch|map|research|digest|diff|monitor|verify|metadata|status/i.test(
    `${slug} ${name} ${description}`
  );
}

function inferIdempotentHint(operations = []) {
  return (
    operations.length > 0 &&
    operations.every((operation) => operation.method === "GET" || operation.method === "HEAD")
  );
}

function normalizeListingGroup(listingGroup) {
  const value = String(listingGroup || "").trim().toLowerCase();
  return value || null;
}

export function resolveCategory(category, listingGroup) {
  const explicit = String(category || "").trim().toLowerCase();
  if (explicit) return explicit;

  const normalizedGroup = normalizeListingGroup(listingGroup);
  if (normalizedGroup === "datasets") return "dataset";
  if (normalizedGroup === "compute") return "compute";
  return "data";
}

function resolveProviderListingType(category, listingGroup, baseProvider = null) {
  const explicit = String(baseProvider?.listing_type || "").trim().toLowerCase();
  if (explicit) return explicit;

  const normalizedGroup = normalizeListingGroup(listingGroup);
  if (normalizedGroup === "datasets" || category === "dataset") return "dataset";
  if (["service", "connector", "skill", "product"].includes(normalizedGroup || "")) {
    return normalizedGroup;
  }

  return "api";
}

export function buildListingMetadata({
  name,
  slug,
  description,
  endpoint_url,
  price_usd,
  category,
  listing_group,
  listing_metadata = {},
} = {}) {
  const safeSlug = String(slug || "").trim();
  const safeName = String(name || safeSlug || "Apiosk API").trim();
  const safeDescription = String(description || "").trim();
  const safeEndpointUrl = String(endpoint_url || "").trim();
  const safePrice = Number(price_usd);
  const normalizedCategory = resolveCategory(category, listing_group);
  const base = isObject(listing_metadata) ? cloneJson(listing_metadata, {}) : {};
  const operationsInput = Array.isArray(base.operations) ? base.operations : defaultOperations(safePrice);
  const operations = operationsInput.map((operation) => normalizeOperation(operation, safePrice));
  const inputSchema = cloneJson(
    base.input_schema || base.mcp_tool?.inputSchema,
    defaultExecuteInputSchema()
  );
  const outputSchema = cloneJson(
    base.output_schema || base.mcp_tool?.outputSchema,
    defaultExecuteOutputSchema()
  );
  const provider = {
    type: "http_api",
    origin_url: safeEndpointUrl,
    ...cloneJson(base.provider, {}),
    origin_url: safeEndpointUrl,
    listing_type: resolveProviderListingType(normalizedCategory, listing_group, base.provider),
  };
  const mergedTags = normalizeTags([
    ...(Array.isArray(base.tags) ? base.tags : []),
    normalizedCategory,
    "api",
    "agent-ready",
    "mcp-native",
  ]);
  const defaultOperation = String(base.default_operation || inferDefaultOperation(operations));
  const readOnlyHint =
    typeof base.mcp_tool?.annotations?.readOnlyHint === "boolean"
      ? base.mcp_tool.annotations.readOnlyHint
      : inferReadOnlyHint(operations, safeSlug, safeName, safeDescription);
  const idempotentHint =
    typeof base.mcp_tool?.annotations?.idempotentHint === "boolean"
      ? base.mcp_tool.annotations.idempotentHint
      : inferIdempotentHint(operations);

  return {
    ...base,
    agent_native: true,
    mcp_native: true,
    metadata_path: String(base.metadata_path || "/metadata"),
    execute_path: String(base.execute_path || "/execute"),
    default_operation: defaultOperation,
    cost_per_call: safePrice,
    input_schema: inputSchema,
    output_schema: outputSchema,
    operations,
    provider,
    tags: mergedTags,
    mcp_tool: {
      ...cloneJson(base.mcp_tool, {}),
      name: String(base.mcp_tool?.name || safeSlug),
      title: String(base.mcp_tool?.title || safeName),
      description: String(base.mcp_tool?.description || safeDescription || safeName),
      inputSchema: inputSchema,
      outputSchema: outputSchema,
      annotations: {
        readOnlyHint,
        idempotentHint,
        destructiveHint: false,
        openWorldHint: false,
        ...cloneJson(base.mcp_tool?.annotations, {}),
      },
    },
  };
}
