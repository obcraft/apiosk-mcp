// The Ask page for a connected chatbot, as one tool. With only a question,
// Apiosk reads it and ranks its sources (POST /v2/ask: the App's parser and
// source search, no task). With a chosen candidate's endpoint_id and input,
// the same tool prepares that one source (POST /v2/ask-v2/prepare). The
// gateway parses, ranks, prices and quotes; this module only shapes the calls
// and adds no planner, pricing or balance logic of its own.
import { randomUUID } from "node:crypto";
import schemas from "./gateway-v2-contracts.json" with { type: "json" };

export const ASK_TOOLS = Object.freeze(["apiosk_ask"]);
export const NO_RESULTS = "We couldn’t find any results for you. Try a different question.";

const SEARCH_NOTICE = "Asking is free and buys nothing. Each candidate covers its listed capability, not necessarily the complete request. Only candidates with availability \"supported\" can run: call apiosk_ask again with the same question, that candidate's endpoint_id and capability, and input starting from its endpoint.input_values; fill a field listed in endpoint.missing_inputs only from the person's words or earlier results, and ask for anything missing. For a request combining several checks, call apiosk_discover once with the complete question to get one plan and total price ceiling; do not prepare and approve separate purchases as if they were one dossier.";

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
    { name: "apiosk_ask", title: "Ask one source",
      description: "Ask Apiosk a question that one source answers, in the person's own words: Apiosk reads the question the way its Ask page does and returns, per piece of data it found, up to three ranked sources. Each runnable candidate (availability \"supported\") carries endpoint.inputs, the values Apiosk already read from the question (endpoint.input_values), the required fields still missing (endpoint.missing_inputs) and its price. Free: creates no task and buys nothing. To run one candidate, call again with the same question plus its endpoint_id, capability and input (its input_values, completed only from the person's words or earlier results, never placeholders): that returns the same task, price ceiling and approval card as apiosk_discover, and nothing is bought until the person approves. For several sources, a combined dossier or an analysis, use apiosk_discover instead.",
      inputSchema: schemas.ask, outputSchema: { type: "object", anyOf: [searchOutput, taskOutput] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ];
}

/** The gateway request for apiosk_ask: its exact wire body, nothing extra. */
export function askRequest(name, args) {
  if (!args.endpoint_id) return { path: "/v2/ask", body: { question: args.question } };
  return { path: "/v2/ask-v2/prepare", body: { request_id: args.request_id || randomUUID(), endpoint_id: args.endpoint_id,
    ...(args.capability && { capability: args.capability }), input: args.input || {}, question: args.question } };
}

/** The card's source search view (`view: "source_search"`) from a /v2/ask answer. */
export function presentSearch(answer) {
  // An origin outage must never read as "no results": no Apiosk search, no view.
  const result = answer?.searches?.apiosk, parsed = answer?.parsed_request;
  if (!Array.isArray(result?.matches)) {
    if (!answer?.errors?.some?.(error => error?.origin === "apiosk")) throw new Error("Unexpected protocol");
    return { protocol_version: "2", view: "source_search", parsed_request: parsed || {}, matches: [], message: "Some sources could not be searched. Try again shortly.", notice: SEARCH_NOTICE };
  }
  // A missing match is still a requested requirement. Keep it visible so a
  // source returned for one check cannot make the whole dossier look covered.
  const matchesCapability = (match, capability) => match.slug === capability.slug && (match.subject_id !== undefined
    ? match.subject_id === capability.subject_id : (parsed?.subjects?.length || 0) <= 1 || !capability.subject_id);
  const missing = (parsed?.capabilities || []).filter(capability => !result.matches.some(match => matchesCapability(match, capability)))
    .map(capability => ({ slug: capability.slug, query: capability.name, ...(capability.subject_id ? { subject_id: capability.subject_id } : {}), apiosk: [], coinbase: [], coinbase_status: "complete" }));
  const matches = [...result.matches, ...missing];
  const hasSources = matches.some(match => (match.apiosk?.length || 0) + (match.coinbase?.length || 0) > 0);
  const incomplete = matches.some(match => ['pending', 'unavailable'].includes(match.coinbase_status));
  return { protocol_version: "2", view: "source_search", parsed_request: parsed, matches,
    ...(!hasSources && { message: incomplete ? "Some sources could not be searched. Try again shortly." : NO_RESULTS }),
    ...(Number.isInteger(result.apiosk_sources_searched) && { apiosk_sources_searched: result.apiosk_sources_searched }),
    ...(typeof result.catalog_version === "string" && { catalog_version: result.catalog_version }), notice: SEARCH_NOTICE };
}
