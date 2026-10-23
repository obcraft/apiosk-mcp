import { createHash, randomUUID } from 'node:crypto';
import schemas from './compat-contracts.json' with { type: 'json' };
import { askRequest, presentSearch, presentConversation } from './ask-ui/gateway-v2-ask.mjs';
import { decorateTaskView } from './card-adapter.mjs';

const uuid = { type: 'string', format: 'uuid' };
const atomic = { type: 'string', pattern: '^[0-9]+$', maxLength: 20 };
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function planningRetryId(body) {
  const hex = createHash('sha256').update('apiosk-discover-conflict-v1:' + JSON.stringify(stable(body))).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
const reply = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
const failure = (code, message, status) => ({ ...reply({ error_code: code, message, error: { code, message, ...(status ? { status } : {}) } }), isError: true });
const externalSchema = object({ action: { enum: ['source', 'prepare', 'status'] }, api_id: { type: 'string', pattern: '^bazaar:', maxLength: 8192 },
  input: { type: 'object', maxProperties: 64 }, request_id: uuid, purchase_id: uuid }, ['action']);
externalSchema.oneOf = [
  { properties: { action: { const: 'source' } }, required: ['api_id'], not: { anyOf: ['input', 'request_id', 'purchase_id'].map(key => ({ required: [key] })) } },
  { properties: { action: { const: 'prepare' } }, required: ['api_id', 'input'], not: { required: ['purchase_id'] } },
  { properties: { action: { const: 'status' } }, required: ['purchase_id'], not: { anyOf: ['api_id', 'input', 'request_id'].map(key => ({ required: [key] })) } },
];

function wire(name, args) {
  if (name === 'apiosk_ask') return { ...askRequest(name, args), method: 'POST' };
  if (name === 'apiosk_status' || name === 'apiosk_execute' && args.recover_task_ref) {
    if (name === 'apiosk_execute' && Object.keys(args).some(key => !['recover_task_ref', 'request_id'].includes(key))) throw new Error('Recover with only recover_task_ref and an optional request_id.');
    return { path: `/v2/tasks/${args.task_ref || args.recover_task_ref}`, method: 'GET' };
  }
  if (name === 'apiosk_external_approve') return { path: `/v2/ask/external/${args.purchase_id}/authorize`, method: 'POST',
    body: { quote_ref: args.quote_ref, max_total_atomic: args.max_total_atomic }, external: true };
  if (name === 'apiosk_external') {
    if (args.action === 'status') return { path: `/v2/ask/external/${args.purchase_id}`, method: 'GET', external: true };
    return { path: `/v2/ask/external/${args.action}`, method: 'POST', external: true, source: args.action === 'source',
      body: args.action === 'source' ? { api_id: args.api_id } : { request_id: args.request_id || randomUUID(), api_id: args.api_id, input: args.input } };
  }
  return { path: { apiosk_discover: '/v2/discover', apiosk_execute: '/v2/execute', apiosk_approve: '/v2/approve', apiosk_requote: '/v2/ask/requote' }[name], method: 'POST',
    body: { ...args, request_id: args.request_id || randomUUID(), ...(name === 'apiosk_execute' ? { idempotency_key: args.idempotency_key || args.action_id } : {}) } };
}

/** Exact MCP1 contracts accepted for existing cards, never advertised as a new catalog or competing default. */
export function withLegacyCompatibility(service, { gateway, store }) {
  const definitions = [
    ['apiosk_ask', schemas.ask], ['apiosk_discover', { ...schemas.discover, properties: { ...schemas.discover.properties, state: schemas.state } }],
    ['apiosk_execute', { ...schemas.execute, properties: { ...schemas.execute.properties, state: schemas.state } }],
    ['apiosk_status', object({ task_ref: uuid }, ['task_ref'])],
    ['apiosk_approve', object({ state: schemas.state, quote_ref: uuid, max_total_atomic: atomic, request_id: uuid }, ['state', 'quote_ref', 'max_total_atomic'])],
    ['apiosk_requote', object({ state: schemas.state, quote_ref: uuid, request_id: uuid }, ['state', 'quote_ref'])],
    ['apiosk_external', externalSchema], ['apiosk_external_approve', object({ purchase_id: uuid, quote_ref: uuid, max_total_atomic: atomic }, ['purchase_id', 'quote_ref', 'max_total_atomic'])],
  ];
  async function approveKnownTask(name, args, context) {
    const taskId = args.state?.state_ref || args.purchase_id;
    let state = (await store.list()).find(record => record.type === 'ask' && record.tasks.some(task => task.id === taskId));
    if (!state) {
      const raw = await gateway.request(name === 'apiosk_external_approve' ? `/v2/ask/external/${taskId}` : `/v2/tasks/${taskId}`, { method: 'GET', signal: context.signal });
      if (name === 'apiosk_external_approve' ? raw.purchase_id !== taskId : raw.state?.state_ref !== taskId) throw new Error('Gateway returned a different saved task.');
      state = await store.get(await service.adoptCompatibilityResult(raw));
    }
    const task = state.tasks.find(task => task.id === taskId);
    const approved = state.approved_quotes?.quotes?.find(quote => quote.task_id === taskId);
    const quote = approved || task.view.quote || task.view.proposal;
    if (quote?.quote_ref !== args.quote_ref || quote?.max_total_atomic !== args.max_total_atomic) throw new Error('The displayed quote changed. Read the task and review the current price.');
    const invoke = async (name, args) => {
      const response = await service.tools.find(tool => tool.name === name).handler(args, context);
      if (response?.isError) throw new Error(response.structuredContent?.error?.message || 'The saved approval could not be confirmed.');
    };
    if (task.approval_attempt || task.view.billing?.authorization_active) await invoke('apiosk_status', { request_id: state.id });
    else {
      if (state.active_task_ids.length !== 1 || state.approval?.quotes?.length !== 1) throw new Error('Review and approve the complete combined total in the current card.');
      await invoke('apiosk_approve', { request_id: state.id, ...Object.fromEntries(['approval_id', 'currency', 'max_total_atomic'].map(key => [key, state.approval[key]])), confirm: true });
    }
    const updated = await store.get(state.id);
    const updatedTask = updated.tasks.find(task => task.id === taskId);
    if (['dispatching', 'outcome_unknown'].includes(updatedTask.approval_attempt?.status)
      && !updatedTask.view.billing?.authorization_active && !['succeeded', 'failed', 'cancelled', 'partial'].includes(updatedTask.view.status)) {
      throw new Error('The approval outcome is uncertain. Read the same saved task or purchase status before continuing; do not authorize again.');
    }
    return { requestId: state.id, raw: updatedTask.view };
  }
  async function dispatch(name, args, context) {
    const request = wire(name, args);
    if (!request.path) throw new Error('Unsupported compatibility operation.');
    // MCP1 discovery and legacy single-endpoint preparation can apply an
    // existing standing mandate. Journal them as well as explicit approval and
    // execution before dispatch; an uncertain response is never blind-retried.
    const maySpend = ['apiosk_discover', 'apiosk_approve', 'apiosk_external_approve'].includes(name)
      || name === 'apiosk_execute' && request.method === 'POST' || name === 'apiosk_ask' && !!args.endpoint_id;
    const perform = () => gateway.request(request.path, { method: request.method, ...(request.body ? { body: request.body } : {}), signal: context.signal });
    let raw, adoptedRequest;
    if (['apiosk_approve', 'apiosk_external_approve'].includes(name)) {
      const approved = await approveKnownTask(name, args, context);
      raw = approved.raw; adoptedRequest = approved.requestId;
    } else if (!maySpend) raw = await perform();
    else {
      const identity = [name, args.state?.state_ref || args.purchase_id || '', args.quote_ref || args.action_id || args.request_id || hash(args)];
      const key = `compat_${hash(identity)}`;
      const fingerprint = hash(Object.fromEntries(Object.entries(args).filter(([key]) => !['request_id', 'idempotency_key'].includes(key))));
      raw = await store.withLock(key, async () => {
        const saved = await store.get(key);
        if (saved) {
          if (saved.fingerprint !== fingerprint) throw new Error('This saved action has different inputs. Recover its task before continuing.');
          if (saved.status === 'completed') return saved.response;
          throw new Error('The previous operation has an uncertain outcome. Read the same task or purchase status; do not authorize again.');
        }
        const intent = { id: key, type: 'compatibility_intent', created_at: new Date().toISOString(), name, fingerprint,
          status: 'dispatching', task_ref: args.state?.state_ref || args.purchase_id || null, request_id: request.body?.request_id };
        await store.save(intent);
        try {
          let response;
          const canRetryConflict = name === 'apiosk_discover' && !!args.request_id;
          try { response = await perform(); }
          catch (error) { if (!canRetryConflict || error.code !== 'request_conflict') throw error; response = { errors: [{ code: 'request_conflict' }] }; }
          if (canRetryConflict && response?.errors?.some(error => error.code === 'request_conflict')) {
            request.body.request_id = planningRetryId(request.body);
            intent.request_id = request.body.request_id;
            await store.save(intent);
            response = await perform();
          }
          await store.save({ ...intent, status: 'completed', response }); return response;
        }
        catch (error) { await store.save({ ...intent, status: 'outcome_unknown' }); throw error; }
      });
    }
    if (request.source) {
      if (typeof raw?.resource !== 'string' || !Array.isArray(raw.inputs) || !Number.isSafeInteger(raw.total_atomic)) throw new Error('Invalid external source response.');
      return reply({ protocol_version: '2', view: 'external_source', api_id: args.api_id, source: raw,
        notice: 'Inspecting source inputs does not purchase data. Review the exact quote before approval.' });
    }
    if (request.path === '/v2/ask/conversation') return reply(presentConversation(raw, args));
    const discovery = ['/v2/ask', '/v2/ask/search'].includes(request.path);
    if (!discovery && (request.external ? raw?.purchase_id !== (args.purchase_id || request.body?.request_id)
      : raw?.protocol_version !== '2' || !raw.state?.state_ref || !Array.isArray(raw.next_actions))) throw new Error('Gateway returned an invalid saved task.');
    let value = discovery ? presentSearch(raw, args.question) : request.external
      ? { ...raw, protocol_version: '2', view: 'external_purchase', result_present: raw.result_present ?? raw.result != null }
      : decorateTaskView(raw, gateway.baseUrl);
    const requestId = adoptedRequest || await service.adoptCompatibilityResult(raw, { question: args.question, discovery,
      authorized: ['apiosk_approve', 'apiosk_external_approve'].includes(name) });
    const open = service.tools.find(tool => tool.name === 'apiosk_chats');
    const decorated = await open.handler({ action: 'open', request_id: requestId }, context);
    return { ...reply(value), _meta: decorated._meta };
  }
  const compatibilityTools = definitions.map(([name, inputSchema]) => ({ name, inputSchema,
    async handler(args, context = {}) {
      try { return await dispatch(name, args, context); }
      catch (error) { return failure(error.code || 'compatibility_request_failed', error.message || 'Recover the saved request before retrying.', error.status); }
    } }));
  // Cards can still invoke the old operation names. They remain app-only so
  // model tool lists keep the new Ask entry point and its explicit workflow.
  const names = new Set(service.tools.map(tool => tool.name));
  const cardAliases = compatibilityTools.filter(tool => !names.has(tool.name)).map(tool => ({ ...tool,
    title: 'Continue an existing Apiosk card', description: 'Compatibility operation for an existing Apiosk card. Use the current Ask workflow for new questions.',
    annotations: { readOnlyHint: false, destructiveHint: tool.name.endsWith('_approve'), openWorldHint: true },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
  }));
  return { ...service, tools: [...service.tools, ...cardAliases], compatibilityTools };
}
