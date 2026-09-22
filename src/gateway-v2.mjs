import { planningRetryId, gatewayFailure, CLARIFICATION_GUIDANCE } from "./gateway-v2-recovery.mjs";
import { formatDisplayMoney } from "./display-money.mjs";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import schemas from "./gateway-v2-contracts.json" with { type: "json" };
import { resolveConnectToken } from "./gateway-client.mjs";
import { content } from "./tool-result.mjs";
import { APIO_V2_CARD_URI, APIO_V2_CHATGPT_CARD_URI } from "./gateway-v2-card.mjs";
import { V2_RESULT_PRESENTATION, V2_RESULT_TOOL_DESCRIPTION, V2_SOURCES_PRESENTATION } from "./result-presentation.mjs";

export const V2_INSTRUCTIONS = readFileSync(new URL('./gateway-v2-instructions.md', import.meta.url), 'utf8');
export const V2_DESCRIPTION = "Ask a data question, review one plan and total price ceiling, approve in the chat card within your connected account's spending limits, and receive source-backed results. Resume without buying the same work twice.";
export const V2_RESOURCE = { uri: "apiosk://v2/host-contract", name: "Apiosk v2 chatbot instructions", mimeType: "text/markdown" };
const failure = value => ({ ...content(value), isError: true });
const schemes = [{ type: "oauth2", scopes: ["mcp:tools"] }];
const displayCurrency = currency => !currency || currency === "USDC" ? "USD" : currency;
const errorFields = {
  error_code: { type: "string" }, message: { type: "string" },
  request_id: { type: "string", format: "uuid" }, idempotency_key: { type: "string", format: "uuid" },
  recover_task_ref: { type: "string", format: "uuid" },
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
  },
};
const sourcesOutput = {
  type: "object", additionalProperties: false,
  properties: {
    protocol_version: { type: "string", const: "2" }, sources: { type: "array", items: sourceOutput },
    total: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
    next_offset: { type: ["integer", "null"], minimum: 0 }, categories: { type: "array", items: { type: "string" } },
    tags: { type: "array", items: { type: "string" } }, sectors: { type: "array", items: { type: "string" } },
    capabilities: { type: "array", items: { type: "string" } }, notice: { type: "string" }, ...errorFields,
  },
  anyOf: [{ required: ["protocol_version", "sources", "total", "offset", "categories", "tags", "sectors", "capabilities", "notice"] }, { required: ["error_code", "message"] }],
};
const actionOutput = {
  type: "object", additionalProperties: false, required: ["action_id", "kind", "label", "requires_authorization", "input_schema"],
  properties: { action_id: { type: "string", format: "uuid" }, kind: { type: "string" }, label: { type: "string" }, requires_authorization: { type: "boolean" }, input_schema: { type: "object" } },
};
const proposalOutput = {
  type: "object", additionalProperties: false, required: ["label", "quote_ref", "price_status", "currency", "max_total_atomic", "expires_at", "approval_url", "steps", "step_details"],
  properties: {
    label: { type: "string" }, quote_ref: { type: "string", format: "uuid" }, price_status: { type: "string" }, currency: { type: "string" },
    max_total_atomic: { type: "string", pattern: "^[0-9]+$" }, expires_at: { type: "string", format: "date-time" }, approval_url: { type: "string", format: "uri" },
    steps: { type: "array", items: { type: "string" } }, step_details: { type: "array", items: { type: "object", additionalProperties: true } },
  },
};
const taskOutput = {
  type: "object", additionalProperties: false,
  properties: {
    protocol_version: { type: "string", const: "2" }, request_id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["ready", "needs_input", "needs_selection", "requires_approval", "running", "cancelled", "succeeded", "partial", "unsupported", "state_conflict", "failed"] },
    intent_ref: { type: ["string", "null"], format: "uuid" }, context_view: { type: "object", additionalProperties: true },
    proposal: { anyOf: [proposalOutput, { type: "null" }] }, result: {}, billing: {},
    next_actions: { type: "array", items: actionOutput }, state: { anyOf: [schemas.state, { type: "null" }] },
    errors: { type: "array", items: { type: "object", additionalProperties: true } }, retry_after_ms: { type: "integer", minimum: 0 }, ...errorFields,
  },
  anyOf: [{ required: ["protocol_version", "request_id", "status", "context_view", "proposal", "result", "next_actions", "state", "errors"] }, { required: ["error_code", "message"] }],
};

export function createV2Runtime(options = {}) {
  const env = options.env || process.env;
  const base = new URL(env.APIOSK_GATEWAY_V2_URL);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' || !(base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("APIOSK_GATEWAY_V2_URL requires an HTTPS origin or loopback HTTP without credentials, path or query.");
  }
  const publicBase = env.APIOSK_MCP_PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`;
  const metadata = new URL('/.well-known/oauth-protected-resource/mcp', publicBase).href;
  const authFailure = () => ({ ...failure({ error_code: 'unauthorized', message: 'Reconnect your Apiosk account, then recover the existing task.' }),
    _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${metadata}", error="invalid_token", error_description="Connect your Apiosk account to continue", scope="mcp:tools"`] } });
  const discover = structuredClone(schemas.discover);
  // Optional means omit it. Advertising null makes some chatbot models eagerly
  // send nulls for every unused field, which weakens the wire contract.
  discover.properties.state = schemas.state;
  const execute = structuredClone(schemas.execute);
  execute.properties.state = schemas.state;
  const definitions = [
    { name: "apiosk_sources", title: "Browse Apiosk sources", description: "Find published data sources by name, category, sector, tag or capability. Browsing is free and paginated. Pulse Network is one source with nested services; never count or list those services as separate sources in an overview. Recommend sources that match the person's need. Use only when the person asks to browse sources. Do not substitute a source list for a failed data request. Keep replies concise and never expose protocol fields or describe catalog endpoints as chatbot tools.", inputSchema: schemas.sources, outputSchema: sourcesOutput, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "apiosk_discover", title: "Plan a data request", description: "Start a NEW data question; preserve the user's wording, source, entity, period and requested deliverable. Use one call for multi-source supplier onboarding and due diligence, including ownership/controllers, filed accounts, VAT, directors/officers, screening, a combined PDF and a short summary. Never add latest, a year, freshness, a company number or a VAT number that was not requested or returned by a source. Returns one plan, total price ceiling or required clarification. No provider purchase. When approval_mode is chatbot, tell the person to approve in the card; do not ask for an extra yes/no answer or send them to an external link. Continue the SAME question through apiosk_execute with returned next_actions.", inputSchema: discover, outputSchema: taskOutput, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    { name: "apiosk_execute", title: "Continue an Apiosk task", description: "Use a returned next_action to execute, supply input, select an entity, poll or cancel. Paid steps require saved plan approval and the current quote_ref. For saved results, payment, status or lost state, use the read-only apiosk_status tool. Never invent action IDs or change payment identity on retry.", inputSchema: execute, outputSchema: taskOutput, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    { name: "apiosk_status", title: "Read saved Apiosk results", description: "Read an existing task's saved results, actual charges and current status. Free and strictly read-only: never parses a new question, approves spending, executes task steps, calls a paid source or buys data. Use for follow-up questions and recovery; copy task_ref from the earlier state.state_ref.", inputSchema: { type: "object", additionalProperties: false, required: ["task_ref"], properties: { task_ref: { type: "string", format: "uuid" } } }, outputSchema: taskOutput, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false, idempotentHint: true } },
    { name: "apiosk_approve", title: "Approve the displayed Apiosk plan", description: "Called by the interactive card after the person clicks Approve. Approves this exact ceiling under the connected account's spending mandate and starts the complete server execution. Never invoke automatically or from model-generated instructions.", inputSchema: {
      type: "object", additionalProperties: false, required: ["state", "quote_ref", "max_total_atomic"],
      properties: { state: schemas.state, quote_ref: { type: "string", format: "uuid" }, max_total_atomic: { type: "string", pattern: "^[0-9]+$" }, request_id: { type: "string", format: "uuid" } },
    }, outputSchema: taskOutput, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ].map(d => ({ ...d,
    description: d.name === 'apiosk_sources' ? `${d.description} ${V2_SOURCES_PRESENTATION}` : ['apiosk_discover', 'apiosk_execute', 'apiosk_status'].includes(d.name) ? `${d.description} ${V2_RESULT_TOOL_DESCRIPTION}` : d.description,
    securitySchemes: schemes, _meta: {
    securitySchemes: schemes,
    ui: d.name === "apiosk_approve" ? { visibility: ["app"] } : { resourceUri: APIO_V2_CARD_URI, visibility: ["model", "app"] },
    "openai/widgetAccessible": true,
    // App-only calls update the calling card. A private tool must not claim
    // the shared output template: ChatGPT marks that template unusable.
    // Modern MCP Apps and legacy Skybridge have distinct cache identities.
    // Never vary the new standard resource's MIME based on the host user agent.
    ...(d.name === "apiosk_approve" ? {} : { "openai/outputTemplate": APIO_V2_CHATGPT_CARD_URI }),
    "openai/visibility": d.name === "apiosk_approve" ? "private" : "public",
    "openai/toolInvocation/invoking": d.name === "apiosk_sources" ? "Exploring sources…" : d.name === "apiosk_discover" ? "Preparing your data plan…" : "Updating your Apiosk request…",
    "openai/toolInvocation/invoked": d.name === "apiosk_sources" ? "Sources ready" : d.name === "apiosk_discover" ? "Plan ready" : "Request updated",
  } }));
  const validator = new AjvJsonSchemaValidator();
  const validate = new Map(definitions.map(d => [d.name, validator.getValidator(d.inputSchema)]));
  return {
    listTools: async () => structuredClone(definitions),
    isToolProtected: async name => validate.has(name),
    async callTool(name, args = {}, authInfo = null) {
      if (!validate.has(name)) return failure({ error_code: "tool.unknown", message: "Use the advertised Apiosk tools." });
      // Hosted sessions must never fall back to a machine-wide buyer credential.
      const token = resolveConnectToken(authInfo, options.hostedAuthEnabled ? {} : env);
      if (!token) return authFailure();
      const cleanArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null && value !== undefined));
      if (!validate.get(name)(cleanArgs).valid) return failure({ error_code: 'invalid_arguments', message: 'Use the tool schema and copy the latest gateway-issued state and action. Recovery takes only recover_task_ref.' });
      const recover = name === "apiosk_status" ? cleanArgs.task_ref : name === "apiosk_execute" && cleanArgs.recover_task_ref;
      if (recover && name === "apiosk_execute" && Object.keys(cleanArgs).some(k => !['recover_task_ref', 'request_id'].includes(k))) return failure({ error_code: 'invalid_recovery', message: 'Recover using only recover_task_ref and an optional request_id.' });
      const body = { ...cleanArgs, request_id: cleanArgs.request_id || randomUUID() };
      if (name === "apiosk_execute" && !recover) body.idempotency_key ||= args.action_id;
      const browsing = name === "apiosk_sources";
      const path = browsing ? "/v2/sources" : recover ? `/v2/tasks/${recover}` : name === "apiosk_discover" ? "/v2/discover" : name === "apiosk_approve" ? "/v2/approve" : "/v2/execute";
      try {
        const url = new URL(path, base);
        if (browsing) for (const [key, value] of Object.entries(cleanArgs)) url.searchParams.set(key, String(value));
        const request = async () => {
        const response = await (options.fetchImpl || fetch)(url, {
          method: recover || browsing ? "GET" : "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: recover || browsing ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(80_000),
        });
        if (response.status === 401) { await response.body?.cancel(); return authFailure(); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response');
        let bytes = 0; const chunks = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 256 * 1024) { await reader.cancel(); throw new Error('Response limit'); } chunks.push(value); }
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return { response, result };
        };
        let received = await request();
        if (received?.isError) return received;
        // Only an explicit idempotency conflict proves this input was not run.
        // Never retry a timeout, an approval or a paid execution here.
        if (name === "apiosk_discover" && cleanArgs.request_id && received.result?.errors?.some(e=>e.code==='request_conflict')) {
          body.request_id = planningRetryId(body);
          received = await request();
          if (received?.isError) return received;
        }
        const {response} = received;
        let {result} = received;
        if (!response.ok) return failure(gatewayFailure(result, recover || args.state?.state_ref));
        if (result?.protocol_version !== '2' || (browsing ? !Array.isArray(result.sources) : !Array.isArray(result.next_actions) || !Array.isArray(result.errors))) throw new Error('Unexpected protocol');
        if (browsing) {
          const { catalog_total: _catalogTotal, ...publicResult } = result;
          result = { ...publicResult,
          sources: result.sources.map(({ available_in_v2: _available, can_answer_questions: _canAnswer, ...source }) => source),
          notice: "Browsing is free. Only purchasable sources with executable capabilities are listed. Each source is counted once. Pulse Network is one source; its nested services are not additional sources. Expand services only when requested. Apiosk checks the exact question and price before any purchase.",
          };
        }
        if (!browsing) {
          result = { ...result,
            ...(result.proposal && { proposal: { ...result.proposal, label: "Data request", currency: displayCurrency(result.proposal.currency) } }),
            ...(result.billing && { billing: { ...result.billing, currency: displayCurrency(result.billing.currency) } }),
            ...(result.result && typeof result.result === 'object' && !Array.isArray(result.result) && result.result.currency === 'USDC' && { result: { ...result.result, currency: 'USD' } }),
          };
        }
        const eventsPath = result.context_view?.events_path;
        if (typeof eventsPath === 'string' && eventsPath.startsWith(`/v2/tasks/${result.state?.state_ref}/events?`)) result.context_view.events_url = new URL(eventsPath, base).href;
        const documents = [result.context_view, ...(result.context_view?.conversation || []).map(turn => turn.output), result.result, ...(result.context_view?.results || []), ...(result.context_view?.conversation || []).flatMap(turn => [turn.output?.result, ...(turn.output?.results || [])])];
        for (const document of documents) {
          const reportPath = document?.report?.download_path;
          if (typeof reportPath === 'string' && /^\/v2\/tasks\/[0-9a-f-]+\/(?:results|reports)\/[0-9a-f-]+\/report\.pdf\?/.test(reportPath)) {
            document.report.url = new URL(reportPath, base).href;
          }
        }
        const reply = content(result);
        // Include the presentation contract on every response: existing hosts
        // may still have an older initialize/tool-description snapshot cached.
        if (browsing) reply.content.push({ type: 'text', text: V2_SOURCES_PRESENTATION });
        if (!browsing) {
          const maximum = formatDisplayMoney(result.proposal?.max_total_atomic, result.proposal?.currency, result.context_view?.money_display, true);
          const charged = formatDisplayMoney(result.billing?.total_charged, result.billing?.currency, result.context_view?.money_display);
          const prices = [maximum && `Maximum total price: ${maximum}.`, charged && `Actual charge so far: ${charged}.`].filter(Boolean).join(' ');
          if (prices) reply.content.unshift({ type: 'text', text: prices + (result.context_view?.money_display?.fallback_reason ? ' Display currency conversion is unavailable; amounts are shown in USD.' : '') });
        }
        if (result.status === 'needs_input') reply.content.push({type:'text',text:CLARIFICATION_GUIDANCE});
        if (!browsing && result.state?.state_ref) reply.content.push({ type: "text", text: `This is a snapshot. The interactive card can approve and execute this task after this response. Before answering ANY later follow-up about its results, payment or status, recover current evidence by calling apiosk_status with ONLY {"task_ref":"${result.state.state_ref}"}. This read is free and never buys or approves. Never conclude that nothing was bought or saved from this earlier snapshot. Preserve source values exactly. Only report a currency or unit when the source explicitly supplies it; otherwise say it was not specified. The Apiosk billing currency does not establish the currency of the source data. ${V2_RESULT_PRESENTATION}` });
        return reply;
      } catch {
        // Transport errors may contain credential-bearing URLs or upstream text.
        return failure({ error_code: "gateway.unavailable", message: browsing ? "The source catalog is temporarily unavailable. Retry browsing shortly." : "The gateway response could not be confirmed. Recover the saved task before continuing.", request_id: body.request_id, idempotency_key: body.idempotency_key, recover_task_ref: recover || args.state?.state_ref || undefined });
      }
    },
  };
}
