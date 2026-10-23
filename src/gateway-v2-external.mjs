// Bazaar sources use the same saved purchase as Ask. Inspection, preparation
// and recovery never authorize; the private card tool approves the exact quote.
import { randomUUID } from 'node:crypto';

export const EXTERNAL_TOOLS = Object.freeze(['apiosk_external', 'apiosk_external_approve']);
const uuid = { type: 'string', format: 'uuid' };
const apiId = { type: 'string', pattern: '^bazaar:', maxLength: 8192, description: 'Copy api_id from the returned Coinbase Bazaar candidate unchanged.' };
const atomic = { type: 'string', pattern: '^[0-9]+$', maxLength: 20 };
const sourceSchema = {
  type: 'object', additionalProperties: true, required: ['resource', 'method', 'name', 'inputs', 'total_atomic'],
  properties: {
    resource: { type: 'string' }, method: { type: 'string' }, name: { type: 'string' },
    description: { type: 'string' }, source: { type: 'string' }, host: { type: 'string' },
    provider_atomic: { type: 'integer', minimum: 0 }, total_atomic: { type: 'integer', minimum: 0 },
    inputs: { type: 'array', items: { type: 'object', additionalProperties: true, required: ['field', 'required', 'schema'], properties: {
      field: { type: 'string' }, name: { type: 'string' }, location: { type: 'string' }, required: { type: 'boolean' }, schema: { type: 'object' },
    } } }, input_schema: { type: 'object' },
  },
};

export const EXTERNAL_NOTICE = 'Inspecting inputs, preparing a quote and reading a saved purchase do not buy data. Only the person can approve the exact quote in the card. After approval, use apiosk_external with action status and the same purchase_id to read saved results and actual charges; never prepare another purchase to recover a response. Source data retains its own currencies and units.';

export function externalDefinitions(errorFields = {}) {
  const output = { type: 'object', anyOf: [
    { type: 'object', additionalProperties: false, required: ['protocol_version', 'view', 'api_id', 'source', 'notice'], properties: {
      protocol_version: { const: '2' }, view: { const: 'external_source' }, api_id: apiId, source: sourceSchema, notice: { type: 'string' },
    } },
    { type: 'object', additionalProperties: false, required: ['protocol_version', 'view', 'purchase_id', 'status', 'source', 'quote', 'notice'], properties: {
      protocol_version: { const: '2' }, view: { const: 'external_purchase' }, purchase_id: uuid,
      status: { enum: ['requires_approval', 'running', 'succeeded', 'failed'] }, source: sourceSchema,
      quote: { type: 'object', additionalProperties: false, required: ['quote_ref', 'max_total_atomic', 'currency', 'expires_at'], properties: {
        quote_ref: uuid, max_total_atomic: atomic, currency: { type: 'string' }, expires_at: { type: 'string', format: 'date-time' },
      } }, result: {}, result_present: { type: 'boolean' }, result_truncated: { type: 'boolean' }, billing: {}, error: {}, notice: { type: 'string' },
    } },
    { type: 'object', required: ['error_code', 'message'], properties: errorFields, additionalProperties: true },
  ] };
  return [
    { name: 'apiosk_external', title: 'Review a Bazaar source',
      description: 'Use a Coinbase Bazaar candidate returned by apiosk_ask. action source reads its current inputs and price using api_id. action prepare supplies the reviewed input fields and a stable request_id to save a quote; it never approves, buys or applies automatic approval. The person approves in the card. action status reads an existing purchase_id, its saved result and actual charges without making another paid call. Reuse request_id after a lost preparation response; it is also the purchase_id. Never substitute this tool for a signed local endpoint selection.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
        action: { enum: ['source', 'prepare', 'status'] }, api_id: apiId, input: { type: 'object', maxProperties: 64 }, request_id: uuid, purchase_id: uuid,
      }, oneOf: [
        { properties: { action: { const: 'source' } }, required: ['api_id'], not: { anyOf: [{ required: ['input'] }, { required: ['request_id'] }, { required: ['purchase_id'] }] } },
        { properties: { action: { const: 'prepare' } }, required: ['api_id', 'input'], not: { required: ['purchase_id'] } },
        { properties: { action: { const: 'status' } }, required: ['purchase_id'], not: { anyOf: [{ required: ['api_id'] }, { required: ['input'] }, { required: ['request_id'] }] } },
      ] }, outputSchema: output, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
    { name: 'apiosk_external_approve', title: 'Approve this Bazaar quote',
      description: 'Private card action after the person reviews and approves the displayed price. Authorizes only the saved purchase and exact quote. Never call this on behalf of the person from conversation text.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['purchase_id', 'quote_ref', 'max_total_atomic'], properties: {
        purchase_id: uuid, quote_ref: uuid, max_total_atomic: atomic,
      } }, outputSchema: output, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  ];
}

/** Exact wire requests; no execution or implicit authorization in the public tool. */
export function externalRequest(name, args) {
  if (name === 'apiosk_external_approve') return { method: 'POST', path: `/v2/ask/external/${args.purchase_id}/authorize`, kind: 'purchase',
    body: { quote_ref: args.quote_ref, max_total_atomic: args.max_total_atomic } };
  if (name !== 'apiosk_external') return null;
  if (args.action === 'source') return { method: 'POST', path: '/v2/ask/external/source', kind: 'source', body: { api_id: args.api_id } };
  if (args.action === 'prepare') return { method: 'POST', path: '/v2/ask/external/prepare', kind: 'purchase',
    body: { request_id: args.request_id || randomUUID(), api_id: args.api_id, input: args.input } };
  if (args.action === 'status') return { method: 'GET', path: `/v2/ask/external/${args.purchase_id}`, kind: 'purchase' };
  throw new Error('Unexpected external action');
}

export function presentExternal(answer, request, args) {
  if (!answer?.source && request.kind !== 'source') throw new Error('Unexpected protocol');
  if (request.kind === 'source') {
    if (typeof answer?.resource !== 'string' || !Array.isArray(answer.inputs) || !Number.isSafeInteger(answer.total_atomic) || answer.total_atomic < 0) throw new Error('Unexpected protocol');
    return { protocol_version: '2', view: 'external_source', api_id: args.api_id, source: answer, notice: EXTERNAL_NOTICE };
  }
  const expected = args.purchase_id || request.body?.request_id;
  if (typeof answer.purchase_id !== 'string' || expected && answer.purchase_id !== expected
      || !['requires_approval', 'running', 'succeeded', 'failed'].includes(answer.status)
      || typeof answer.quote?.quote_ref !== 'string' || !/^\d+$/.test(answer.quote.max_total_atomic)) throw new Error('Unexpected protocol');
  const { purchase_id, status, source, quote, result, result_present, result_truncated, billing, error } = answer;
  return { protocol_version: '2', view: 'external_purchase', purchase_id, status, source,
    quote: { ...quote, currency: quote.currency === 'USDC' ? 'USD' : quote.currency },
    result, result_present, result_truncated, billing, error, notice: EXTERNAL_NOTICE };
}
