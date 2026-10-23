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

const SEARCH_NOTICE = "Searching and selecting sources are free. Choose one or more available sources in the card, review one combined price, then approve once. Each candidate covers its listed capability, not necessarily the complete request. Only candidates marked supported can run. Select only the exact endpoint, capability and subject combinations in source_options; a supported discovery match alone is not an offered selection. Keep missing checks explicit. To prepare a chosen set through the tool, copy the returned question and send input.apiosk_source_selection_v1 containing the returned parsed_request, search_id and selections; each selection has the option's source.endpoint_id, source.capability, subject_id and input_values as input. Omit top-level endpoint_id and capability. Top-level parsed_request, search_id and selections are also supported by current hosts. Fill missing inputs only from the person's words or earlier evidence. Preparation of selections never approves or buys. To plan the complete displayed question, call apiosk_ask with the unchanged question and research containing parsed_request, search_id and discovery_id when returned. This reuses the displayed search, requires manual approval, and never buys. Use apiosk_discover with the complete question only for a new automatic request. For a follow-up on bought data, send question and task_refs to reuse saved evidence first.";

export function askDefinitions(errorFields, taskOutput) {
  const searchOutput = {
    type: "object", additionalProperties: false,
    properties: {
      protocol_version: { type: "string", const: "2" }, view: { type: "string", const: "source_search" },
      question: { type: "string" }, search_id: { type: "string" },
      discovery_id: { type: "string" }, complete_plan_available: { type: "boolean" },
      planning_message: { type: "string" }, company_context: { type: "array", items: { type: "object", additionalProperties: true } },
      context_status: { type: "string" },
      parsed_request: { type: "object" }, matches: { type: "array", items: { type: "object", additionalProperties: true } },
      source_options: { type: "array", items: {
        type: "object", additionalProperties: true, required: ["source", "subject_id", "requirement"],
        properties: {
          source: { type: "object", additionalProperties: true }, subject_id: { type: "string" },
          endpoint: { type: "object", additionalProperties: true },
          requirement: { type: "object", additionalProperties: true }, input_values: { type: "object", additionalProperties: true },
          missing_inputs: { type: "array", items: { type: "string" } }, reason: { type: "string" },
        },
      } },
      apiosk_sources_searched: { type: "integer", minimum: 0 }, catalog_version: { type: "string" }, notice: { type: "string" }, ...errorFields,
    },
    anyOf: [{ required: ["protocol_version", "view", "parsed_request", "matches", "notice"] }, { required: ["error_code", "message"] }],
  };
  const conversationOutput = {
    type: "object", additionalProperties: false,
    required: ["protocol_version", "view", "question", "kind", "notice"],
    properties: {
      protocol_version: { const: "2", type: "string" }, view: { const: "conversation", type: "string" },
      question: { type: "string" }, kind: { type: "string", enum: ["saved_answer", "search", "clarification"] },
      task_refs: { type: "array", items: { type: "string", format: "uuid" } },
      message: { type: "string" }, notice: { type: "string" },
    },
  };
  return [
    { name: "apiosk_ask", title: "Find and choose sources",
      description: "Ask Apiosk a question in the person's own words to find matching sources. Searching without selections or endpoint_id is free: it creates no task and buys nothing. Every offered source in source_options carries an endpoint descriptor with inputs, input_values, missing_inputs and price, including related sources absent from matches. Its source supplies the exact endpoint_id and capability; subject_id identifies the subject. Only the exact source.endpoint_id, source.capability and subject_id combinations in source_options are eligible for selection; supported matches alone are not selectable. The card lets the person freely select one or multiple sources and complete missing fields. To prepare that exact set, call again with the unchanged question, returned parsed_request and search_id, and selections (1 to 10 items with endpoint_id, capability, subject_id when present, and input). For hosts with cached schemas, send those three fields inside input.apiosk_source_selection_v1 instead, without top-level endpoint_id or capability. Both formats use the same signed selection route. This prepares one combined price and never auto-approves, even with an automatic-approval rule. The person approves once in the card. Preserve missing coverage; a selected source does not necessarily answer the whole question. Legacy single endpoint_id preparation can still apply the connection's standing automatic-approval rule; prefer selections for explicit source choice. To plan the full question from this displayed search, send research containing parsed_request, search_id and discovery_id when returned; this reuses the interpretation and still requires manual approval. For follow-ups to bought data, send question and task_refs (saved state.state_ref values) to let the gateway route saved evidence, new data or clarification without buying. Questions support up to 16000 characters. Use apiosk_discover for a new automatic request without a displayed search.",
      inputSchema: schemas.ask, outputSchema: { type: "object", anyOf: [searchOutput, taskOutput, conversationOutput] },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ];
}

/** The gateway request for apiosk_ask: its exact wire body, nothing extra. */
export function askRequest(name, args) {
  if (args.refresh) return { path: "/v2/ask/search", body: { question: args.question, ...args.refresh } };
  if (args.task_refs) return { path: "/v2/ask/conversation", body: { request_id: args.request_id || randomUUID(), question: args.question, task_refs: args.task_refs } };
  if (args.research) return { path: "/v2/ask/research", body: { request_id: args.request_id || randomUUID(), question: args.question, ...args.research } };
  const selection = args.input?.apiosk_source_selection_v1 || args;
  if (selection.selections) return { path: "/v2/ask/prepare", body: { request_id: args.request_id || randomUUID(),
    question: args.question, parsed_request: selection.parsed_request, search_id: selection.search_id, selections: selection.selections } };
  if (!args.endpoint_id) return { path: "/v2/ask", body: { question: args.question } };
  return { path: "/v2/ask-v2/prepare", body: { request_id: args.request_id || randomUUID(), endpoint_id: args.endpoint_id,
    ...(args.capability && { capability: args.capability }), input: args.input || {}, question: args.question } };
}

export function presentConversation(answer, args) {
  const notice = {
    saved_answer: "The gateway is answering from saved evidence. Read every returned task_ref with apiosk_status to obtain the saved answer and its sources. Do not search, prepare or purchase again for this follow-up.",
    search: "This follow-up needs new data. Call apiosk_ask with this question to search sources, then review a new price before approval. Nothing has been purchased by this continuation.",
    clarification: "Show the returned clarification and wait for the person's reply. Continue with the same task_refs and include the original follow-up and the clarification answer in question. Do not purchase or guess the answer.",
  }[answer?.kind];
  if (!notice) throw new Error("Unexpected protocol");
  if (answer.kind === "saved_answer" && (!Array.isArray(answer.task_refs) || !answer.task_refs.length
      || answer.task_refs.some(ref => !args.task_refs.includes(ref)))) throw new Error("Unexpected protocol");
  if (answer.kind === "clarification" && (typeof answer.message !== "string" || !answer.message.trim())) throw new Error("Unexpected protocol");
  return { protocol_version: "2", view: "conversation", question: args.question, kind: answer.kind,
    ...(answer.kind === "saved_answer" ? { task_refs: [...new Set(answer.task_refs)] } : { task_refs: args.task_refs }),
    ...(answer.kind === "clarification" && { message: answer.message }), notice };
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
  const usedLocal = new Set();
  const missing = (parsed?.capabilities || []).filter(capability => {
    const index = result.matches.findIndex((match, index) => !usedLocal.has(index) && matchesCapability(match, capability));
    if (index < 0) return true;
    usedLocal.add(index); return false;
  })
    .map(capability => ({ slug: capability.slug, query: capability.name, ...(capability.subject_id ? { subject_id: capability.subject_id } : {}), apiosk: [], coinbase: [], coinbase_status: "complete" }));
  // /v2/ask waits for both independent origins. Its Apiosk rows still carry
  // the pre-search Bazaar placeholder; merge the completed external rows by
  // capability AND subject instead of dropping their candidates and status.
  const external = answer?.searches?.coinbase;
  const externalFailed = answer?.errors?.some?.(error => error?.origin === "coinbase");
  const sameRequirement = (left, right) => left.slug === right.slug
    && (left.subject_id === right.subject_id || ((parsed?.subjects?.length || 0) <= 1
      && (left.subject_id == null || right.subject_id == null)));
  const local = [...result.matches, ...missing], usedExternal = new Set();
  const matches = local.map(match => {
    if (match.answer_only) return { ...match, coinbase: [], coinbase_status: "ready" };
    const candidates = (external?.matches || []).map((row, index) => ({ row, index })).filter(({ row }) => sameRequirement(match, row));
    // A collapsed response cannot assign one scope to several occurrences of
    // the same capability. Keep that gap explicit rather than reusing a row.
    const occurrences = local.filter(row => sameRequirement(match, row) && !row.answer_only).length;
    const next = candidates.length === occurrences ? candidates.find(({ index }) => !usedExternal.has(index)) : undefined;
    const completed = next?.row;
    if (next) usedExternal.add(next.index);
    if (completed) return { ...match, coinbase: completed.coinbase || [], coinbase_status: completed.coinbase_status };
    if (externalFailed || Array.isArray(external?.matches)) return { ...match, coinbase: [], coinbase_status: "unavailable" };
    return match;
  });
  const hasSources = matches.some(match => (match.apiosk?.length || 0) + (match.coinbase?.length || 0) > 0) || (answer.source_options?.length || 0) > 0;
  const incomplete = apioskFailed || externalFailed || matches.some(match => ['pending', 'unavailable'].includes(match.coinbase_status));
  return { protocol_version: "2", view: "source_search", ...(typeof question === 'string' && { question }),
    ...(typeof answer.search_id === 'string' && { search_id: answer.search_id }), parsed_request: parsed || {}, matches,
    ...(typeof answer.discovery_id === 'string' && { discovery_id: answer.discovery_id }),
    ...(typeof answer.complete_plan_available === 'boolean' && { complete_plan_available: answer.complete_plan_available }),
    ...(typeof answer.planning_message === 'string' && { planning_message: answer.planning_message }),
    ...(Array.isArray(answer.company_context) && { company_context: answer.company_context }),
    ...(typeof answer.context_status === 'string' && { context_status: answer.context_status }),
    ...(Array.isArray(answer.source_options) && { source_options: answer.source_options }),
    ...(incomplete ? { message: "Some sources could not be searched. Try again shortly." } : !hasSources ? { message: answer.planning_message || NO_RESULTS } : {}),
    ...(Number.isInteger(result.apiosk_sources_searched) && { apiosk_sources_searched: result.apiosk_sources_searched }),
    ...(typeof result.catalog_version === "string" && { catalog_version: result.catalog_version }), notice: SEARCH_NOTICE };
}
