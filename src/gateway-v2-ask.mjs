// The Ask page for a connected chatbot, as one tool. With only a question,
// Apiosk reads it and ranks its sources (POST /v2/ask: the App's parser and
// source search, no task). A signed set of choices prepares one manual-only
// combined quote (POST /v2/ask/prepare); endpoint_id retains the legacy path. The
// gateway parses, ranks, prices and quotes; this module only shapes the calls
// and adds no planner, pricing or balance logic of its own.
import { randomUUID } from "node:crypto";
import schemas from "./gateway-v2-contracts.json" with { type: "json" };

export const ASK_TOOLS = Object.freeze(["apiosk_ask"]);
export const NO_RESULTS = "We couldn’t find any results for you. Try a different question.";

const SEARCH_NOTICE = "Searching and selecting sources are free. Choose one or more available sources in the card, review one combined price, then approve once. Each candidate covers its listed capability, not necessarily the complete request. Only candidates marked supported can run. Keep missing checks explicit. To prepare a chosen set through the tool, copy the returned question, parsed_request and search_id with selections containing each candidate's endpoint_id, capability, subject_id and input_values. Fill missing inputs only from the person's words or earlier evidence. Preparation of selections never approves or buys. For automatic planning across sources, use apiosk_discover with the complete question.";

export function askDefinitions(errorFields, taskOutput) {
  const searchOutput = {
    type: "object", additionalProperties: false,
    properties: {
      protocol_version: { type: "string", const: "2" }, view: { type: "string", const: "source_search" },
      question: { type: "string" }, search_id: { type: "string" },
      parsed_request: { type: "object" }, matches: { type: "array", items: { type: "object", additionalProperties: true } },
      apiosk_sources_searched: { type: "integer", minimum: 0 }, catalog_version: { type: "string" }, notice: { type: "string" }, ...errorFields,
    },
    anyOf: [{ required: ["protocol_version", "view", "parsed_request", "matches", "notice"] }, { required: ["error_code", "message"] }],
  };
  return [
    { name: "apiosk_ask", title: "Find and choose sources",
      description: "Ask Apiosk a question in the person's own words to find matching sources. Searching without selections or endpoint_id is free: it creates no task and buys nothing. Available candidates carry endpoint.inputs, endpoint.input_values, endpoint.missing_inputs, a price, and their exact capability and subject_id. The card lets the person freely select one or multiple sources and complete missing fields. To prepare that exact set, call again with the unchanged question, returned parsed_request and search_id, and selections (1 to 10 items with endpoint_id, capability, subject_id when present, and input). This prepares one combined price and never auto-approves, even with an automatic-approval rule. The person approves once in the card. Preserve missing coverage; a selected source does not necessarily answer the whole question. Legacy single endpoint_id preparation can still apply the connection's standing automatic-approval rule; prefer selections for explicit source choice. For a question whose sources Apiosk should plan automatically, use apiosk_discover.",
      inputSchema: schemas.ask, outputSchema: { type: "object", anyOf: [searchOutput, taskOutput] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ];
}

/** The gateway request for apiosk_ask: its exact wire body, nothing extra. */
export function askRequest(name, args) {
  if (args.selections) return { path: "/v2/ask/prepare", body: { request_id: args.request_id || randomUUID(),
    question: args.question, parsed_request: args.parsed_request, search_id: args.search_id, selections: args.selections } };
  if (!args.endpoint_id) return { path: "/v2/ask", body: { question: args.question } };
  return { path: "/v2/ask-v2/prepare", body: { request_id: args.request_id || randomUUID(), endpoint_id: args.endpoint_id,
    ...(args.capability && { capability: args.capability }), input: args.input || {}, question: args.question } };
}

/** The card's source search view (`view: "source_search"`) from a /v2/ask answer. */
export function presentSearch(answer, question) {
  // Preserve successful origin results while making an outage explicit.
  let result = answer?.searches?.apiosk;
  const parsed = answer?.parsed_request;
  const apioskFailed = answer?.errors?.some?.(error => error?.origin === "apiosk");
  if (!Array.isArray(result?.matches)) {
    if (!apioskFailed) throw new Error("Unexpected protocol");
    result = { matches: [] };
  }
  // A missing match is still a requested requirement. Keep it visible so a
  // source returned for one check cannot make the whole dossier look covered.
  const matchesCapability = (match, capability) => match.slug === capability.slug && (match.subject_id !== undefined
    ? match.subject_id === capability.subject_id : (parsed?.subjects?.length || 0) <= 1 || !capability.subject_id);
  const missing = (parsed?.capabilities || []).filter(capability => !result.matches.some(match => matchesCapability(match, capability)))
    .map(capability => ({ slug: capability.slug, query: capability.name, ...(capability.subject_id ? { subject_id: capability.subject_id } : {}), apiosk: [], coinbase: [], coinbase_status: "complete" }));
  // /v2/ask waits for both independent origins. Its Apiosk rows still carry
  // the pre-search Bazaar placeholder; merge the completed external rows by
  // capability AND subject instead of dropping their candidates and status.
  const external = answer?.searches?.coinbase;
  const externalFailed = answer?.errors?.some?.(error => error?.origin === "coinbase");
  const sameRequirement = (left, right) => left.slug === right.slug
    && (left.subject_id === right.subject_id || ((parsed?.subjects?.length || 0) <= 1
      && (left.subject_id == null || right.subject_id == null)));
  const matches = [...result.matches, ...missing].map(match => {
    if (match.answer_only) return { ...match, coinbase: [], coinbase_status: "ready" };
    const completed = external?.matches?.find(row => sameRequirement(match, row));
    if (completed) return { ...match, coinbase: completed.coinbase || [], coinbase_status: completed.coinbase_status };
    if (externalFailed || Array.isArray(external?.matches)) return { ...match, coinbase: [], coinbase_status: "unavailable" };
    return match;
  });
  const hasSources = matches.some(match => (match.apiosk?.length || 0) + (match.coinbase?.length || 0) > 0);
  const incomplete = apioskFailed || externalFailed || matches.some(match => ['pending', 'unavailable'].includes(match.coinbase_status));
  return { protocol_version: "2", view: "source_search", ...(typeof question === 'string' && { question }),
    ...(typeof answer.search_id === 'string' && { search_id: answer.search_id }), parsed_request: parsed || {}, matches,
    ...(incomplete ? { message: "Some sources could not be searched. Try again shortly." } : !hasSources ? { message: NO_RESULTS } : {}),
    ...(Number.isInteger(result.apiosk_sources_searched) && { apiosk_sources_searched: result.apiosk_sources_searched }),
    ...(typeof result.catalog_version === "string" && { catalog_version: result.catalog_version }), notice: SEARCH_NOTICE };
}
