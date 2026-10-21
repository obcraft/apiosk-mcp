import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { resolveConnectToken } from './gateway-client.mjs';
import { sourceUsageNotices } from './source-usage-notice.mjs';
import { content } from './tool-result.mjs';
import { attachReportLinks } from './gateway-v2-report-links.mjs';
import { COMPANY_CARD_URI, COMPANY_CHATGPT_CARD_URI } from './company-checks-card.mjs';

const uuid = { type: 'string', format: 'uuid' };
const occurrence = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_.:-]+$' };
const company = { type: 'object', additionalProperties: false, required: ['name', 'kvk_number'], properties: {
  name: { type: 'string', minLength: 1, maxLength: 200 }, kvk_number: { type: 'string', pattern: '^[0-9]{8}$' },
} };
const schema = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const schemes = [{ type: 'oauth2', scopes: ['mcp:tools'] }];
export const COMPANY_CHECK_INSTRUCTIONS = `Monitor one to three Dutch companies for changed KVK data, possible OpenSanctions matches and relevant news. No CSV or invoice balance is required. Resolve company names to verified eight-digit KVK numbers through the existing lookup/choice tools before starting; never invent identifiers or resolve ambiguous names silently. Use apiosk_company_check with a new UUID check_id and stable occurrence key. Save both immediately; reuse them on retries. Follow the existing spending approval and task actions. On completion call apiosk_company_check_result to retain and compare evidence. Missing coverage is unknown; screening matches and news name mentions do not confirm identity. The first KVK result is a baseline, not a change. Only new_signals qualify for an email. For email delivery, verify the user's own recipient address and the host's authorized email connector, then call apiosk_company_check_email with a saved new UUID delivery_id. Send its exact subject/body only when dispatch_allowed is true. No new signals means no email, including no all-clear or empty-update email. After a successful email connector receipt, call apiosk_company_check_acknowledge with delivery_id, provider and provider_message_id. Viewing a card, composing a draft or reading a report is not delivery. On timeout or lost response reconcile that delivery, do not resend or create another delivery_id. For every Monday, create and confirm a host scheduled task with the user's timezone/time and the saved check_id, one occurrence per scheduled date. Verify that the chosen host scheduler can access Apiosk and the email connector and can run under its permissions. A task notification email is not the requested sourced email. If scheduling or email is unavailable explain the missing capability; do not claim success. Apiosk does not create a host schedule or send email. Each paid run requires existing connection authorization or explicit approval. Use apiosk_company_check_read for free history/evidence; never buy again merely to read it.`;

export const companyTools = [
  { name: 'apiosk_company_check', title: 'Monitor companies', description: 'Check one to three Dutch companies using KVK business data, OpenSanctions potential matches and dated news from Exa/Tavily. No CSV or balance needed. Resolve names to exact KVK identities first. On first use supply companies and check_id; later omit companies. Retry with the same occurrence; each authorized fresh run uses a new occurrence. Returns the existing price/approval flow. Scheduling and email belong to the host', inputSchema: schema({ check_id: uuid, occurrence, companies: { type: 'array', minItems: 1, maxItems: 3, items: company } }, ['check_id', 'occurrence']), read: false, world: true },
  { name: 'apiosk_company_check_result', title: 'Compare company check evidence', description: 'Collect the saved result for an existing company check occurrence. Persists immutable source snapshots and compares relevant signals against previous checks and previously acknowledged signals. Never plans, buys, approves, sends or marks signals as reported. If still running or awaiting approval, returns the existing task. Use after apiosk_status or the card reports completion.', inputSchema: schema({ check_id: uuid, occurrence }, ['check_id', 'occurrence']), read: false, world: false },
  { name: 'apiosk_company_check_read', title: 'Read company check history', description: 'Read the saved company list, recent occurrences and latest source-backed company check. Supply occurrence and result_ref together to reopen one original saved source document, including after task expiry. Free and strictly read-only: no discovery, provider calls, purchases, approval, acknowledgement or scheduling.', inputSchema: schema({ check_id: uuid, occurrence, result_ref: uuid }, ['check_id']), read: true, world: false },
  { name: 'apiosk_company_check_email', title: 'Prepare new signals for email', description: 'Create one durable email handoff from saved, unreported company signals. Does not send email. Persist a new delivery_id before calling. Only a fresh response with dispatch_allowed=true permits sending its exact subject/body once via the host email connector to the user. No new signals suppresses email. A repeated or uncertain handoff returns dispatch_allowed=false; reconcile the original send, never resend blindly. Confirm only its successful email receipt with apiosk_company_check_acknowledge.', inputSchema: schema({ check_id: uuid, occurrence, delivery_id: uuid }, ['check_id','occurrence','delivery_id']), read: false, world: false },
  { name: 'apiosk_company_check_acknowledge', title: 'Confirm company signal email receipt', description: 'Record the actual successful email connector receipt for a prepared company-check delivery. Atomically marks only that saved email payload’s signal IDs as reported. Supply the real provider and message ID; never fabricate a receipt or call after merely displaying a card, reading a report or creating a draft. This tool does not send email, purchase data or schedule tasks.', inputSchema: schema({ check_id: uuid, delivery_id: uuid, provider: { type:'string',minLength:1,maxLength:512 }, provider_message_id: { type:'string',minLength:1,maxLength:512 } }, ['check_id','delivery_id','provider','provider_message_id']), read: false, world: false },
].map(({ read, world, ...d }) => ({ ...d, outputSchema: { type: 'object', additionalProperties: true },
  annotations: { readOnlyHint: read, destructiveHint: false, openWorldHint: world, idempotentHint: true }, securitySchemes: schemes,
  _meta: { securitySchemes: schemes, ui: { resourceUri: COMPANY_CARD_URI, visibility: ['model', 'app'] },
    'openai/outputTemplate': COMPANY_CHATGPT_CARD_URI, 'openai/widgetAccessible': true,
    'openai/toolInvocation/invoking': 'Checking saved company evidence…', 'openai/toolInvocation/invoked': 'Company check updated' },
}));

const failed = value => ({ ...content(value), isError: true });
export function withCompanyChecks(runtime, options) {
  const env = options.env, base = new URL(env.APIOSK_GATEWAY_V2_URL);
  const validator = new AjvJsonSchemaValidator();
  const validations = new Map(companyTools.map(t => [t.name, validator.getValidator(t.inputSchema)]));
  return {
    listTools: async () => [...await runtime.listTools(), ...structuredClone(companyTools)],
    isToolProtected: async name => validations.has(name) || runtime.isToolProtected(name),
    async callTool(name, args = {}, authInfo = null) {
      if (!validations.has(name)) return runtime.callTool(name, args, authInfo);
      const token = resolveConnectToken(authInfo, options.hostedAuthEnabled ? {} : env);
      if (!token) return runtime.callTool('apiosk_status', {}, authInfo);
      if (!validations.get(name)(args).valid) return failed({ error_code: 'invalid_arguments', message: 'Use the company-check schema and preserve the saved identifiers and company identities.' });
      const root = `/v2/company-checks/${args.check_id}`;
      const path = name === 'apiosk_company_check' ? '/v2/company-checks' : name.endsWith('_result') ? `${root}/collect` : name.endsWith('_acknowledge') ? `${root}/acknowledge` : name.endsWith('_email') ? `${root}/email` : root;
      const read = name.endsWith('_read');
      if (read && Boolean(args.occurrence) !== Boolean(args.result_ref)) return failed({ error_code: 'invalid_arguments', message: 'Supply occurrence and result_ref together to read saved source evidence.' });
      const { check_id, ...rest } = args;
      try {
        const url = new URL(path, base);
        if (read && args.result_ref) { url.searchParams.set('occurrence', args.occurrence); url.searchParams.set('result_ref', args.result_ref); }
        const response = await (options.fetchImpl || fetch)(url, {
          method: read ? 'GET' : 'POST', redirect: 'error', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: read ? undefined : JSON.stringify(name === 'apiosk_company_check' ? args : rest), signal: AbortSignal.timeout(80_000),
        });
        if (response.status === 401) {
          await response.body?.cancel();
          const metadata = new URL('/.well-known/oauth-protected-resource/mcp', env.APIOSK_MCP_PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`).href;
          return { ...failed({ error_code: 'unauthorized', message: 'Reconnect Apiosk, then recover the same company check.' }), _meta: { 'mcp/www_authenticate': [`Bearer resource_metadata="${metadata}", error="invalid_token", scope="mcp:tools"`] } };
        }
        if ([404, 405].includes(response.status) && !response.headers.get('content-type')?.includes('application/json')) {
          await response.body?.cancel();
          return failed({ error_code: 'company_check_route_unavailable', message: 'This Gateway has not loaded the company-monitoring routes. Restart or deploy the updated Gateway, then recover the same check and occurrence.', check_id, occurrence: args.occurrence, delivery_id: args.delivery_id });
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('empty');
        const chunks = []; let bytes = 0;
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > (read && args.result_ref ? 4 : 2) * 1024 * 1024) { await reader.cancel(); throw new Error('size'); } chunks.push(value); }
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!response.ok) return failed({ error_code: value.errors?.[0]?.code || 'company_check_unavailable', message: value.errors?.[0]?.message || 'Recover the same company check before retrying.', check_id, occurrence: args.occurrence, delivery_id: args.delivery_id });
        if (!value || typeof value !== 'object' || Array.isArray(value) || !(value.protocol_version === '2' || ['company_check', 'company_check_pending', 'company_check_history', 'company_check_evidence', 'company_check_acknowledgement', 'company_check_delivery'].includes(value.view))) throw new Error('protocol');
        const events = value.context_view?.events_path;
        if (events?.startsWith(`/v2/tasks/${value.state?.state_ref}/events?`)) value.context_view.events_url = new URL(events, base).href;
        attachReportLinks(value, base);
        const reply = content(value);
        const sources = value.sources?.map(s => s.source) || (value.source?.document?.source ? [value.source.document.source] : []);
        for (const notice of sourceUsageNotices(sources)) reply.content.push({ type:'text',text:notice.text+(notice.url ? ` ${notice.label}: ${notice.url}` : '') });
        reply.content.push({ type: 'text', text: COMPANY_CHECK_INSTRUCTIONS });
        return reply;
      } catch {
        // A timeout may follow a successful durable write or approval rule.
        // Never retry automatically or replace the occurrence/request identity.
        return failed({ error_code: 'company_check_unconfirmed', message: 'The response could not be confirmed. Recover using the same check_id, occurrence and delivery_id. Never create another purchase or resend an uncertain email.', check_id, occurrence: args.occurrence, delivery_id: args.delivery_id });
      }
    },
  };
}
