// The Ask page's own steps for a connected chatbot. The chatbot fills in the
// capability object the Ask parser would produce (apiosk_search), then prepares
// one ranked endpoint with the inputs that endpoint declares (apiosk_prepare).
// The gateway ranks, prices and quotes; this module only shapes the calls and
// adds no planner, pricing or balance logic of its own.
import { randomUUID } from "node:crypto";
import schemas from "./gateway-v2-contracts.json" with { type: "json" };

export const ASK_TOOLS = Object.freeze(["apiosk_search", "apiosk_prepare"]);

const SEARCH_NOTICE = "Searching is free and buys nothing. Only candidates with availability \"supported\" can run: fill each required endpoint.inputs field from the person's words or earlier results, ask for anything missing, then call apiosk_prepare with that candidate's endpoint_id, capability and input.";

export function askDefinitions(errorFields, taskOutput) {
  const searchOutput = {
    type: "object", additionalProperties: false,
    properties: {
      protocol_version: { type: "string", const: "2" }, view: { type: "string", const: "source_search" },
      parsed_request: { type: "object" }, matches: { type: "array", items: { type: "object", additionalProperties: true } },
      apiosk_sources_searched: { type: "integer", minimum: 0 }, catalog_version: { type: "string" }, notice: { type: "string" }, ...errorFields,
    },
    anyOf: [{ required: ["protocol_version", "view", "parsed_request", "matches", "notice"] }, { required: ["error_code", "message"] }],
  };
  return [
    { name: "apiosk_search", title: "Search sources for a capability object",
      description: "Search Apiosk's sources the way the Ask page does, with a capability object you fill in yourself (parsed_request, following the host instructions' parser rules). Slugs are English dot paths of letters and digits, such as location.time.current. Returns, per capability, the Ask page's ranked sources; each runnable candidate carries endpoint.inputs: the exact input keys, whether each is required, and its value schema for apiosk_prepare. Free: creates no task and buys nothing.",
      inputSchema: schemas.search, outputSchema: searchOutput, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "apiosk_prepare", title: "Prepare one source",
      description: "Prepare one runnable apiosk_search candidate: pass its endpoint_id, capability and an input object whose keys are that candidate's endpoint.inputs fields, filled only from the person's words or earlier results, never placeholders. Returns the same task, price ceiling and approval card as apiosk_discover; nothing is bought until the person approves. Continue with apiosk_execute and apiosk_status.",
      inputSchema: schemas.prepare, outputSchema: taskOutput, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ];
}

/** The gateway request for an Ask tool: its exact wire body, nothing extra. */
export function askRequest(name, args) {
  if (name === "apiosk_search") {
    // The gateway records who parsed the object; a chatbot parse has no model hash.
    const meta = { model: "connected-chatbot", parsed_at: new Date().toISOString(), text_sha256: "" };
    return { path: "/v2/ask-v2/search", body: { parsed_request: { ...args.parsed_request, meta }, origin: "apiosk" } };
  }
  return { path: "/v2/ask-v2/prepare", body: { request_id: args.request_id || randomUUID(), endpoint_id: args.endpoint_id,
    ...(args.capability && { capability: args.capability }), input: args.input } };
}

/** The card's source search view (`view: "source_search"`). */
export function presentSearch(result, parsed) {
  if (!Array.isArray(result?.matches)) throw new Error("Unexpected protocol");
  return { protocol_version: "2", view: "source_search", parsed_request: parsed, matches: result.matches,
    ...(Number.isInteger(result.apiosk_sources_searched) && { apiosk_sources_searched: result.apiosk_sources_searched }),
    ...(typeof result.catalog_version === "string" && { catalog_version: result.catalog_version }), notice: SEARCH_NOTICE };
}
