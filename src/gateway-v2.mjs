import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import schemas from "./gateway-v2-contracts.json" with { type: "json" };
import { resolveConnectToken } from "./gateway-client.mjs";
import { content } from "./tool-result.mjs";

export const V2_INSTRUCTIONS = readFileSync(new URL('./gateway-v2-instructions.md', import.meta.url), 'utf8');
export const V2_DESCRIPTION = "Ask a data question, review one plan and total price ceiling, approve in Apiosk, and receive source-backed results. Resume through the same two tools without buying the same work twice.";
export const V2_RESOURCE = { uri: "apiosk://v2/host-contract", name: "Apiosk v2 chatbot instructions", mimeType: "text/markdown" };
const failure = value => ({ ...content(value), isError: true });
const schemes = [{ type: "oauth2", scopes: ["mcp:tools"] }];

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
  discover.properties.state = { anyOf: [schemas.state, { type: "null" }] };
  const execute = structuredClone(schemas.execute);
  execute.properties.state = schemas.state;
  const definitions = [
    { name: "apiosk_discover", title: "Plan a data request", description: "Start a NEW data question; preserve source, entity and period requirements. Returns one plan, total price ceiling or required clarification. No provider purchase. Continue the SAME question through apiosk_execute with returned next_actions.", inputSchema: discover, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    { name: "apiosk_execute", title: "Continue an Apiosk task", description: "Use a returned next_action to execute, supply input, select an entity, poll, cancel or read a result. Paid steps require saved App consent and the current quote_ref. For lost state, pass ONLY recover_task_ref. Never invent action IDs or change payment identity on retry.", inputSchema: execute, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
  ].map(d => ({ ...d, securitySchemes: schemes, _meta: { securitySchemes: schemes } }));
  const validator = new AjvJsonSchemaValidator();
  const validate = new Map(definitions.map(d => [d.name, validator.getValidator(d.inputSchema)]));
  return {
    listTools: async () => structuredClone(definitions),
    isToolProtected: async name => validate.has(name),
    async callTool(name, args = {}, authInfo = null) {
      if (!validate.has(name)) return failure({ error_code: "tool.unknown", message: "Gateway v2 exposes only apiosk_discover and apiosk_execute." });
      // Hosted sessions must never fall back to a machine-wide buyer credential.
      const token = resolveConnectToken(authInfo, options.hostedAuthEnabled ? {} : env);
      if (!token) return authFailure();
      if (!validate.get(name)(args).valid) return failure({ error_code: 'invalid_arguments', message: 'Use the tool schema and copy the latest gateway-issued state and action. Recovery takes only recover_task_ref.' });
      const recover = name === "apiosk_execute" && args.recover_task_ref;
      if (recover && Object.keys(args).some(k => !['recover_task_ref', 'request_id'].includes(k))) return failure({ error_code: 'invalid_recovery', message: 'Recover using only recover_task_ref and an optional request_id.' });
      const body = { ...args, request_id: args.request_id || randomUUID() };
      if (name === "apiosk_execute" && !recover) body.idempotency_key ||= args.action_id;
      const path = recover ? `/v2/tasks/${recover}` : name === "apiosk_discover" ? "/v2/discover" : "/v2/execute";
      try {
        const response = await (options.fetchImpl || fetch)(new URL(path, base), {
          method: recover ? "GET" : "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: recover ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(80_000),
        });
        if (response.status === 401) { await response.body?.cancel(); return authFailure(); }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response');
        let bytes = 0; const chunks = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 256 * 1024) { await reader.cancel(); throw new Error('Response limit'); } chunks.push(value); }
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!response.ok) return failure(result);
        if (result?.protocol_version !== '2' || !Array.isArray(result.next_actions) || !Array.isArray(result.errors)) throw new Error('Unexpected protocol');
        return content(result);
      } catch {
        // Transport errors may contain credential-bearing URLs or upstream text.
        return failure({ error_code: "gateway.unavailable", message: "The gateway response could not be confirmed. Recover the saved task before continuing.", request_id: body.request_id, idempotency_key: body.idempotency_key, recover_task_ref: recover || args.state?.state_ref || undefined });
      }
    },
  };
}
