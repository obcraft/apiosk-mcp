// Source browsing contract: grouped providers and the /v2/sources output schema.
//
// A grouped provider is ONE directory source whose listings are its services.
// The gateway groups by the stored owner handle (gateway/src/sources.rs
// GROUPED_PROVIDERS); this copy only words the chatbot contract so a host never
// counts those services as separate sources. Keep the three copies identical:
// gateway/src/sources.rs, app/src/lib/domain/source-directory.ts and this file.
export const GROUPED_PROVIDERS = Object.freeze([
  Object.freeze({ handle: "pulsenetwork", name: "Pulse Network", description: "Data services published by Pulse Network.", category: "intelligence" }),
  Object.freeze({ handle: "coinbase-bazaar", name: "Coinbase Bazaar", description: "Third-party pay-per-call services listed in the Coinbase x402 Bazaar. Apiosk buys each call for you from your balance.", category: "marketplace" }),
]);

const groupedNames = (() => {
  const names = GROUPED_PROVIDERS.map(provider => provider.name);
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
})();

/** Tool-description sentence: each grouped provider is one source. */
export const GROUPED_SOURCES_TOOL_TEXT = `${groupedNames} are each one source with nested services; never count or list those services as separate sources in an overview.`;
/** Notice sentence carried on every browse result. */
export const GROUPED_SOURCES_NOTICE = `${groupedNames} are each one source; their nested services are not additional sources.`;

const capabilitySource = {
  type: "object", additionalProperties: false, required: ["slug", "name"],
  properties: { slug: { type: "string" }, name: { type: "string" } },
};
const capabilityGroup = {
  type: "object", additionalProperties: false,
  required: ["slug", "name", "primary_sources", "supplementary_sources"],
  properties: {
    slug: { type: "string" }, name: { type: "string" },
    primary_sources: { type: "array", items: capabilitySource },
    supplementary_sources: { type: "array", items: capabilitySource },
  },
};
const sourceOutput = {
  type: "object", additionalProperties: false,
  properties: {
    slug: { type: "string" }, provider_slug: { type: ["string", "null"] }, logo_url: { type: ["string", "null"] },
    name: { type: "string" }, description: { type: "string" }, category: { type: "string" },
    categories: { type: "array", items: { type: "string" } },
    service_count: { type: "integer", minimum: 1, description: "Services within this one source; do not count them as separate sources." },
    matching_service_count: { type: "integer", minimum: 1 },
    services: { type: "array", items: { type: "object", additionalProperties: false, properties: { slug: { type: "string" }, name: { type: "string" }, description: { type: "string" }, category: { type: "string" } } } },
    readiness: { type: "object", additionalProperties: true },
    tags: { type: "array", items: { type: "string" } }, sectors: { type: "array", items: { type: "string" } },
    endpoint_count: { type: "integer", minimum: 0, description: "Published endpoints in this source, not chatbot tools." },
    capabilities: { type: "array", items: { type: "string" } }, input_types: { type: "array", items: { type: "string" } },
    executable_capabilities: { type: "array", items: { type: "string" } },
    capability_roles: { type: "object", additionalProperties: { type: "string", enum: ["primary", "supplementary"] } },
  },
};

/** Output schema of apiosk_sources; `errorFields` are the shared failure fields. */
export function sourcesOutputSchema(errorFields) {
  return {
    type: "object", additionalProperties: false,
    properties: {
      protocol_version: { type: "string", const: "2" }, sources: { type: "array", items: sourceOutput },
      total: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
      next_offset: { type: ["integer", "null"], minimum: 0 }, categories: { type: "array", items: { type: "string" } },
      tags: { type: "array", items: { type: "string" } }, sectors: { type: "array", items: { type: "string" } },
      capabilities: { type: "array", items: { type: "string" } }, notice: { type: "string" }, ...errorFields,
      capability_groups: { type: "array", items: capabilityGroup },
      selected_capability: { anyOf: [capabilityGroup, { type: "null" }] },
    },
    anyOf: [{ required: ["protocol_version", "sources", "total", "offset", "categories", "tags", "sectors", "capabilities", "notice"] }, { required: ["error_code", "message"] }],
  };
}

/** A browse result as the chatbot sees it: no internal readiness fields and the public notice. */
// A grouped provider lists every member's capabilities: Pulse Network alone
// carries hundreds. Hosts and models need a readable page, not the index.
const LISTED_CAPABILITIES = 12;
const FACET_LIMIT = 200;
const facet = values => Array.isArray(values) ? values.filter(value => !String(value).startsWith("operation.")).slice(0, FACET_LIMIT) : [];

export function presentSources(result) {
  const { catalog_total: _catalogTotal, ...publicResult } = result;
  return { ...publicResult, tags: facet(result.tags), capabilities: facet(result.capabilities),
    sources: result.sources.map(({ available_in_v2: _available, can_answer_questions: _canAnswer, executable_capabilities: _executable, input_types: _inputs, readiness, capabilities, services, tags, categories, ...source }) => ({ ...source,
      ...(readiness && { readiness: { contracts: readiness.contracts } }),
      ...(Array.isArray(capabilities) && { capabilities: facet(capabilities).slice(0, LISTED_CAPABILITIES) }),
      // A grouped provider carries every member's tags: tens of KB per row.
      ...(Array.isArray(tags) && { tags: tags.slice(0, LISTED_CAPABILITIES) }),
      ...(Array.isArray(categories) && { categories: categories.slice(0, LISTED_CAPABILITIES) }),
      ...(Array.isArray(services) && { services: services.map(service => typeof service.description === "string" ? { ...service, description: service.description.slice(0, 120) } : service) }),
    })),
    notice: `Browsing is free. Published sources may have execution or coverage restrictions. Capability groups list primary sources; supplementary sources are optional enrichment. Each source is counted once. ${GROUPED_SOURCES_NOTICE} Apiosk checks the exact question and price before any purchase.`,
  };
}
