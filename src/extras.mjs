import { randomUUID } from 'node:crypto';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const string = (description, maxLength = 16_000) => ({ type: 'string', description, minLength: 1, maxLength });
const id = string('Exact identifier returned by Apiosk.', 150);
const confirm = { type: 'boolean', const: true, description: 'True only after the user reviewed and explicitly requested this exact action.' };
const arbitrary = { type: 'object', additionalProperties: true };
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const reviewOnly = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const write = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const delivery = object({ toolkit: { enum: ['slack', 'gmail'] }, connected_account_id: id,
  recipient: { enum: ['self', 'conversation'] }, destination: string('Verified Slack channel/group ID for conversation delivery; omit for self.', 100) }, ['toolkit', 'connected_account_id', 'recipient']);
const schedule = object({ start: string('Start date YYYY-MM-DD', 10), time: string('HH:MM:SS', 8),
  timezone: string('IANA timezone', 100), frequency: { enum: ['daily', 'weekly', 'monthly'] },
  interval: { type: 'integer', minimum: 1, maximum: 12 }, weekdays: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 7 }, maxItems: 7 },
  end: string('Inclusive end date YYYY-MM-DD; omit when using count or per-run indefinitely.', 10),
  count: { type: 'integer', minimum: 1, maximum: 366 } }, ['start', 'time', 'timezone', 'frequency', 'interval', 'weekdays']);
const segment = value => {
  if (typeof value !== 'string' || !value.trim() || value.length > 250 || /[\u0000-\u001f]/.test(value)) throw new Error('Invalid Apiosk identifier.');
  return encodeURIComponent(value);
};
const copy = value => structuredClone(value);
const assertConfirmed = value => { if (value !== true) throw new Error('The exact saved review must be approved by the user first.'); };
const missing = (action, args) => (action?.input_schema?.required ?? []).filter(key => args[key] === undefined || args[key] === null || args[key] === '');

/** Optional account tools. Gateway retains its existing session/connection guards. */
export function extraTools({ gateway, store, tool = (name, description, inputSchema, handler, annotations) => ({ name, description, inputSchema, handler, annotations }) }) {
  const get = path => gateway.request(path, { method: 'GET' });
  const post = (path, body) => gateway.request(path, { method: 'POST', body });
  const saveReview = async value => {
    const saved = await store.create({ ...copy(value), status: 'review' });
    return { review_id: saved.id, status: saved.status, ...('proposal' in saved ? { proposal: saved.proposal } : {}),
      ...('order' in saved ? { order: saved.order } : {}), ...('operation' in saved ? { operation: saved.operation, request: saved.body } : {}),
      instruction: 'Review the exact details. Nothing has been executed or reserved.' };
  };
  const readReview = async (reviewId, type) => {
    const saved = await store.get(reviewId);
    if (!saved || saved.type !== type) throw new Error('This review is unavailable in the current account and workspace.');
    return saved;
  };
  const executeReview = async (reviewId, type, confirmed) => {
    assertConfirmed(confirmed);
    return store.withLock(reviewId, async () => {
      const saved = await readReview(reviewId, type);
      if (saved.status === 'completed') return { review_id: saved.id, status: saved.status, result: saved.result, replayed: true };
      if (saved.status !== 'review') return { review_id: saved.id, status: saved.status,
        instruction: 'This write was already attempted. Read the external app or saved order to reconcile it; do not submit it again.',
        ...(saved.order_id ? { order_id: saved.order_id } : {}) };
      if (type === 'action' && (saved.proposal.proposal_unavailable || saved.proposal.missing?.length)) throw new Error('Complete the action arguments and create a new review before executing.');
      // Persist intent before the network call: crashes and lost replies cannot
      // turn a retry into another message or another financial mandate.
      saved.status = 'submitting';
      saved.attempted_at = new Date().toISOString();
      await store.save(saved);
      try {
        const result = await post(saved.path, saved.body);
        saved.status = 'completed'; saved.result = copy(result);
        await store.save(saved);
        return { review_id: saved.id, status: saved.status, result };
      } catch (error) {
        saved.status = error.outcomeUnknown === false ? 'rejected' : 'outcome_unknown';
        // Keep only the transport's stable category. Never persist raw errors,
        // arbitrary upstream response bodies or credentials in a local journal.
        saved.error_code = /^[a-z0-9_:-]{1,100}$/i.test(error.code ?? '') ? error.code : 'write_failed';
        await store.save(saved);
        throw error;
      }
    });
  };

  return [
    tool('apiosk_integrations', 'Read connected integration accounts and their availability.', object({}), () => get('/v2/integrations'), readOnly),
    tool('apiosk_integration_connect', 'Start a requested integration connection and return its hosted consent URL. The user completes sign-in in their browser.',
      object({ toolkit: string('Toolkit slug from integrations.', 80), alias: string('Optional account label.', 200) }, ['toolkit']),
      args => post(`/v2/integrations/${segment(args.toolkit)}/connect`, args.alias ? { alias: args.alias } : {}), reviewOnly),
    tool('apiosk_actions', 'List action schemas for connected apps; an optional toolkit limits the list.', object({ toolkit: string('Toolkit slug.', 80) }),
      args => get(args.toolkit ? `/v2/integrations/${segment(args.toolkit)}/actions` : '/v2/integrations/actions'), readOnly),
    tool('apiosk_action_prepare', 'Prepare and save exact app-action arguments from the question and saved source results. Requires a personal App session; sends no message and runs no action.',
      object({ slug: string('Action slug from apiosk_actions.', 200), question: string('User instruction for the action.'), results: { description: 'Previously purchased evidence to include; never new paid retrieval.' } }, ['slug', 'question']),
      async args => {
        const encoded = JSON.stringify(args.results ?? null);
        if (Buffer.byteLength(encoded) > 48_000) throw new Error('Limit action evidence to 48 KB of relevant saved results.');
        const proposal = await post(`/v2/integrations/actions/${segment(args.slug)}/prepare`, { question: args.question, results: args.results ?? null });
        if (!proposal?.action || !proposal.arguments || Array.isArray(proposal.arguments)) throw new Error('The Gateway did not return a reviewable action.');
        return saveReview({ type: 'action', slug: args.slug, proposal,
          path: `/v2/integrations/actions/${segment(args.slug)}/execute`, body: { arguments: proposal.arguments } });
      }, reviewOnly),
    tool('apiosk_action_edit', 'Create a new review with explicitly edited action arguments. Original reviewed or attempted actions remain unchanged.',
      object({ review_id: id, arguments: arbitrary }, ['review_id', 'arguments']), async args => {
        const saved = await readReview(args.review_id, 'action');
        if (saved.status !== 'review') throw new Error('An attempted action cannot be edited. Prepare a new action.');
        if (Buffer.byteLength(JSON.stringify(args.arguments)) > 64_000) throw new Error('Action arguments exceed 64 KB.');
        const proposal = { ...saved.proposal, arguments: args.arguments, missing: missing(saved.proposal.action, args.arguments), proposal_unavailable: false };
        return saveReview({ type: 'action', slug: saved.slug, proposal, path: saved.path, body: { arguments: args.arguments } });
      }, reviewOnly),
    tool('apiosk_action_execute', 'Execute exactly the saved action only after the user requests sending/writing and approves its displayed destination/content. Never repeat after an unknown outcome.',
      object({ review_id: id, confirm }, ['review_id', 'confirm']), args => executeReview(args.review_id, 'action', args.confirm), write),
    tool('apiosk_recurring_access', 'Check whether native recurring orders are enabled. Gateway currently requires a personal App session.', object({}), () => get('/v2/recurring-orders/access'), readOnly),
    tool('apiosk_recurring_list', 'Read native Apiosk recurring orders for the current account/workspace.', object({}), () => get('/v2/recurring-orders'), readOnly),
    tool('apiosk_recurring_read', 'Read a saved native recurring order or one saved occurrence. This does not run sources or retry delivery.',
      object({ order_id: id, run_id: id }, ['order_id']), args => get(`/v2/recurring-orders/${segment(args.order_id)}${args.run_id ? `/runs/${segment(args.run_id)}` : ''}`), readOnly),
    tool('apiosk_recurring_destinations', 'Read available Slack delivery conversations for an owned connected account.',
      object({ connected_account_id: id, cursor: string('Pagination cursor.', 1000) }, ['connected_account_id']),
      args => post('/v2/recurring-orders/destinations', { connected_account_id: args.connected_account_id, cursor: args.cursor ?? null }), readOnly),
    tool('apiosk_recurring_channel_review', 'Save the exact Slack account, channel name and visibility for review. Creates no channel, sends no message and changes no recurring order. Channel creation requires a personal App session and native recurring availability.',
      object({ connected_account_id: id, name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[a-z0-9_-]*[a-z0-9][a-z0-9_-]*$', description: 'Exact Slack channel name using lowercase letters, numbers, hyphens or underscores.' },
        is_private: { type: 'boolean', description: 'Explicit visibility: true for invited people only; false for everyone in the Slack workspace.' } }, ['connected_account_id', 'name', 'is_private']),
      async args => {
        segment(args.connected_account_id);
        if (typeof args.name !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(args.name) || !/[a-z0-9]/.test(args.name) || typeof args.is_private !== 'boolean') {
          throw new Error('Choose a valid exact Slack channel name and an explicit visibility before reviewing.');
        }
        return saveReview({ type: 'recurring_channel', operation: 'create_slack_channel', path: '/v2/recurring-orders/channels',
          body: { connected_account_id: args.connected_account_id, name: args.name, is_private: args.is_private } });
      }, reviewOnly),
    tool('apiosk_recurring_channel_create', 'Create only the reviewed Slack channel after the user explicitly approves its account, name and visibility. Returns the destination ID for a separate recurring quote or delivery review. Sends no message and never retries an uncertain creation.',
      object({ review_id: id, confirm }, ['review_id', 'confirm']), args => executeReview(args.review_id, 'recurring_channel', args.confirm), write),
    tool('apiosk_recurring_quote', 'Price a native recurring order from saved completed tasks. Saves a review, reserves nothing, starts nothing. Requires personal App session and native recurring availability; prefer host-owned scheduling for agents.',
      object({ task_ids: { type: 'array', items: id, minItems: 1, maxItems: 20 }, question: string('Original recurring instruction.'), schedule, delivery,
        billing_mode: { enum: ['prepaid', 'per_run'] }, change_only: { type: 'boolean' },
        date_overrides: { type: 'array', maxItems: 64, items: object({ selection_id: id, pointer: string('JSON pointer', 500), offset_seconds: { type: ['integer', 'null'] } }, ['selection_id', 'pointer', 'offset_seconds']) } },
      ['task_ids', 'question', 'schedule', 'delivery']), async args => {
        const request = { ...args, request_id: randomUUID(), date_overrides: args.date_overrides ?? [], billing_mode: args.billing_mode ?? 'prepaid', change_only: args.change_only ?? false };
        const order = await post('/v2/recurring-orders/quote', request);
        if (!order?.id || !/^\d+$/.test(order.total) || !/^\d+$/.test(order.total_per_run) || !order.workflow?.fingerprint) throw new Error('The Gateway did not return a complete recurring price and workflow.');
        return saveReview({ type: 'recurring_approval', order, order_id: order.id,
          path: `/v2/recurring-orders/${segment(order.id)}/approve`, body: { total: order.total, per_run_cap: order.total_per_run, workflow_hash: order.workflow.fingerprint } });
      }, reviewOnly),
    tool('apiosk_recurring_approve', 'Approve exactly the displayed recurring price, cap, workflow, schedule and destination. This reserves funds or enables per-run charges; requires explicit user approval.',
      object({ review_id: id, confirm }, ['review_id', 'confirm']), args => executeReview(args.review_id, 'recurring_approval', args.confirm), write),
    tool('apiosk_recurring_change_review', 'Read the current order and prepare a review to pause/resume/cancel it or change its delivery. Changes nothing until the saved review is applied.',
      object({ order_id: id, operation: { enum: ['control', 'delivery'] }, state: { enum: ['active', 'paused', 'cancelled'] }, delivery }, ['order_id', 'operation']), async args => {
        const order = await get(`/v2/recurring-orders/${segment(args.order_id)}`);
        let body;
        if (args.operation === 'control') {
          if (!['active', 'paused', 'cancelled'].includes(args.state)) throw new Error('Choose active, paused or cancelled.');
          body = { state: args.state };
        } else {
          if (!args.delivery || !order?.workflow?.fingerprint) throw new Error('Delivery and the current workflow fingerprint are required.');
          body = { expected_workflow_hash: order.workflow.fingerprint, delivery: args.delivery };
        }
        return saveReview({ type: 'recurring_change', order, order_id: args.order_id, operation: args.operation,
          path: `/v2/recurring-orders/${segment(args.order_id)}/${args.operation}`, body });
      }, reviewOnly),
    tool('apiosk_recurring_change_apply', 'Apply the exact saved recurring change after the user reviews it. Never resends an attempted change with an unknown outcome.',
      object({ review_id: id, confirm }, ['review_id', 'confirm']), args => executeReview(args.review_id, 'recurring_change', args.confirm), write),
    tool('apiosk_review_read', 'Read a locally saved app-action or recurring review and its attempt status. This never executes or retries a write.',
      object({ review_id: id }, ['review_id']), async args => {
        const saved = await store.get(args.review_id);
        if (!saved || !['action', 'recurring_approval', 'recurring_change', 'recurring_channel'].includes(saved.type)) throw new Error('Review not found.');
        return { review_id: saved.id, type: saved.type, status: saved.status, proposal: saved.proposal, order: saved.order,
          operation: saved.operation, request: saved.body, result: saved.result, error_code: saved.error_code };
      }, readOnly),
    tool('apiosk_schedule_handoff', 'Return an inspectable recipe for the host AI scheduler. Does not create a schedule, authorize payments, execute sources or send messages.',
      object({ question: string('What each future check should answer.'), schedule, task_refs: { type: 'array', items: id, maxItems: 20 },
        max_total_atomic: string('Explicit proposed per-run cap in micro USD; this is a proposal, not approval.', 30), delivery: arbitrary }, ['question', 'schedule']), args => ({
        scheduler: 'host', status: 'handoff_only', schedule_created: false, recurring_payment_authorized: false,
        question: args.question, schedule: args.schedule, saved_task_refs: args.task_refs ?? [],
        proposed_max_total_atomic: args.max_total_atomic ?? null, delivery: args.delivery ?? null,
        instructions: ['The host creates and manages a schedule only when the user requests it.',
          'Each occurrence discovers or prepares the required sources and shows the exact current cap before a paid execution unless an applicable user mandate already authorizes it.',
          'Reuse saved results when the question can be answered from existing evidence. New freshness checks may incur source costs.',
          'Record source references, retrieval dates, coverage gaps and continuation state. Recover saved requests after interruptions; never repeat uncertain purchases or deliveries.'],
      }), readOnly),
  ];
}
