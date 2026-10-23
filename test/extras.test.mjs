import test from 'node:test';
import assert from 'node:assert/strict';
import { extraTools } from '../src/extras.mjs';
import { GatewayError } from '../src/gateway.mjs';

function fixture(respond) {
  const records = new Map(), calls = [], locks = new Map(); let sequence = 0;
  const store = {
    async create(value) { const saved = { ...structuredClone(value), id: `review-${++sequence}` }; records.set(saved.id, saved); return structuredClone(saved); },
    async get(id) { return structuredClone(records.get(id) ?? null); },
    async save(value) { records.set(value.id, structuredClone(value)); return value; },
    async withLock(id, work) { const previous = locks.get(id) ?? Promise.resolve(); const next = previous.catch(() => {}).then(work); locks.set(id, next); return next; },
  };
  const gateway = { async request(path, options) { calls.push({ path, ...structuredClone(options) }); return respond(path, options, records); } };
  const tools = new Map(extraTools({ gateway, store }).map(tool => [tool.name, tool]));
  return { records, calls, call: (name, args = {}) => tools.get(name).handler(args), tools };
}

const proposal = { action: { slug: 'app.slack.sendMessage', input_schema: { required: ['channel', 'text'] } }, arguments: { channel: 'C123', text: 'Saved result' }, missing: [] };
const order = { id: 'order-1', total: '500', total_per_run: '100', workflow: { fingerprint: 'exact-workflow' }, state: 'draft' };

test('action preparation saves review without executing and execute uses only saved arguments', async () => {
  const f = fixture((path, options, records) => {
    if (path.endsWith('/prepare')) return proposal;
    assert.equal([...records.values()][0].status, 'submitting');
    assert.deepEqual(options.body, { arguments: proposal.arguments });
    return { successful: true };
  });
  const review = await f.call('apiosk_action_prepare', { slug: proposal.action.slug, question: 'Send saved result', results: [{ evidence: true }] });
  assert.equal(f.calls.length, 1); assert.equal(review.status, 'review');
  await assert.rejects(f.call('apiosk_action_execute', { review_id: review.review_id, confirm: false }));
  assert.equal(f.calls.length, 1);
  const results = await Promise.all([1, 2].map(() => f.call('apiosk_action_execute', { review_id: review.review_id, confirm: true })));
  assert.equal(f.calls.length, 2); assert.equal(results[1].replayed, true);
});

test('unknown external write outcomes persist and can never be automatically resent', async () => {
  const f = fixture(path => { if (path.endsWith('/prepare')) return proposal; throw new GatewayError('Lost response', { code: 'gateway_timeout', outcomeUnknown: true }); });
  const review = await f.call('apiosk_action_prepare', { slug: proposal.action.slug, question: 'Send' });
  await assert.rejects(f.call('apiosk_action_execute', { review_id: review.review_id, confirm: true }), GatewayError);
  const result = await f.call('apiosk_action_execute', { review_id: review.review_id, confirm: true });
  assert.equal(result.status, 'outcome_unknown'); assert.equal(f.calls.length, 2);
  assert.equal((await f.call('apiosk_review_read', { review_id: review.review_id })).error_code, 'gateway_timeout');
});

test('a crash after durable intent is never converted into a second attempt', async () => {
  const f = fixture(() => proposal);
  const review = await f.call('apiosk_action_prepare', { slug: proposal.action.slug, question: 'Send' });
  f.records.get(review.review_id).status = 'submitting';
  const result = await f.call('apiosk_action_execute', { review_id: review.review_id, confirm: true });
  assert.equal(result.status, 'submitting'); assert.equal(f.calls.length, 1);
});

test('editing creates a fresh review, missing required inputs prevent execution', async () => {
  const f = fixture(() => ({ ...proposal, arguments: {}, missing: ['channel', 'text'] }));
  const initial = await f.call('apiosk_action_prepare', { slug: proposal.action.slug, question: 'Send' });
  await assert.rejects(f.call('apiosk_action_execute', { review_id: initial.review_id, confirm: true }), /Complete/);
  const edited = await f.call('apiosk_action_edit', { review_id: initial.review_id, arguments: { channel: 'C456', text: 'New explicit content' } });
  assert.notEqual(edited.review_id, initial.review_id);
  assert.deepEqual(edited.proposal.missing, []);
  assert.deepEqual(f.records.get(initial.review_id).proposal.arguments, {});
});

test('native recurring approval uses exact saved total, per-run cap and workflow', async () => {
  const f = fixture(path => path.endsWith('/quote') ? order : { ...order, state: 'active' });
  const review = await f.call('apiosk_recurring_quote', { task_ids: ['task-1'], question: 'Monitor', schedule: { start: '2026-11-01' }, delivery: { toolkit: 'slack' } });
  assert.equal(f.calls[0].path, '/v2/recurring-orders/quote');
  assert.equal(f.calls.length, 1);
  await f.call('apiosk_recurring_approve', { review_id: review.review_id, confirm: true });
  assert.deepEqual(f.calls[1].body, { total: '500', per_run_cap: '100', workflow_hash: 'exact-workflow' });
  await f.call('apiosk_recurring_approve', { review_id: review.review_id, confirm: true });
  assert.equal(f.calls.length, 2);
});

test('recurring delivery review freezes the current workflow and new destination', async () => {
  const destination = { toolkit: 'slack', connected_account_id: 'owned-account', recipient: 'conversation', destination: 'C789' };
  const f = fixture(() => order);
  const review = await f.call('apiosk_recurring_change_review', { order_id: 'order-1', operation: 'delivery', delivery: destination });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  await f.call('apiosk_recurring_change_apply', { review_id: review.review_id, confirm: true });
  assert.equal(f.calls[1].path, '/v2/recurring-orders/order-1/delivery');
  assert.deepEqual(f.calls[1].body, { expected_workflow_hash: 'exact-workflow', delivery: destination });
});

test('backend app-only refusals are preserved and host handoff never schedules anything', async () => {
  const f = fixture(() => { throw new GatewayError('Manage recurring in app.', { code: 'app_only', status: 403 }); });
  await assert.rejects(f.call('apiosk_recurring_access'), error => error.code === 'app_only');
  const before = f.calls.length;
  const handoff = await f.call('apiosk_schedule_handoff', { question: 'Monitor company', schedule: { timezone: 'Europe/Amsterdam' } });
  assert.equal(handoff.schedule_created, false); assert.equal(handoff.recurring_payment_authorized, false);
  assert.equal(handoff.scheduler, 'host'); assert.equal(f.calls.length, before);
});

test('read tools cannot accept another review type or invoke an arbitrary route', async () => {
  const f = fixture(() => proposal);
  const review = await f.call('apiosk_action_prepare', { slug: proposal.action.slug, question: 'Send' });
  await assert.rejects(f.call('apiosk_recurring_approve', { review_id: review.review_id, confirm: true }), /unavailable/);
  assert.equal(f.calls.length, 1);
  for (const entry of f.tools.values()) assert.equal(entry.inputSchema.additionalProperties, false);
});

test('Slack channel review freezes account, exact name and visibility without creating anything', async () => {
  const request = { connected_account_id: 'owned-slack-account', name: 'company-checks', is_private: false };
  const destination = { id: 'C123456', label: 'company-checks', kind: 'channel' };
  const f = fixture((path, options, records) => {
    assert.equal(path, '/v2/recurring-orders/channels');
    assert.deepEqual(options.body, request);
    assert.equal([...records.values()][0].status, 'submitting');
    return destination;
  });
  const review = await f.call('apiosk_recurring_channel_review', request);
  assert.equal(f.calls.length, 0);
  assert.equal(review.operation, 'create_slack_channel');
  assert.deepEqual(review.request, request);
  const saved = await f.call('apiosk_review_read', { review_id: review.review_id });
  assert.equal(saved.type, 'recurring_channel');
  assert.deepEqual(saved.request, request);
  await assert.rejects(f.call('apiosk_recurring_channel_create', { review_id: review.review_id, confirm: false }));
  assert.equal(f.calls.length, 0);
  const results = await Promise.all([1, 2].map(() => f.call('apiosk_recurring_channel_create', { review_id: review.review_id, confirm: true })));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(results[0].result, destination);
  assert.equal(results[1].replayed, true);
});

test('Slack channel names and visibility must be explicit and match the Gateway validation', async () => {
  const f = fixture(() => assert.fail('Review must not call Gateway.'));
  for (const name of ['', 'Not Reviewed', '#channel', '-__', 'équipe', 'a'.repeat(81)]) {
    await assert.rejects(f.call('apiosk_recurring_channel_review', { connected_account_id: 'owned-account', name, is_private: true }));
  }
  await assert.rejects(f.call('apiosk_recurring_channel_review', { connected_account_id: 'owned-account', name: 'channel' }));
  const reviewed = await f.call('apiosk_recurring_channel_review', { connected_account_id: 'owned-account', name: 'private-checks', is_private: true });
  assert.equal(reviewed.request.is_private, true);
  assert.equal(f.records.size, 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(Object.keys(f.tools.get('apiosk_recurring_channel_create').inputSchema.properties), ['review_id', 'confirm']);
});

test('uncertain Slack channel creation is durable and cannot be submitted again', async () => {
  const f = fixture(() => { throw new GatewayError('Response lost.', { code: 'gateway_timeout', outcomeUnknown: true }); });
  const review = await f.call('apiosk_recurring_channel_review', { connected_account_id: 'owned-account', name: 'company-checks', is_private: true });
  await assert.rejects(f.call('apiosk_recurring_channel_create', { review_id: review.review_id, confirm: true }), GatewayError);
  const retry = await f.call('apiosk_recurring_channel_create', { review_id: review.review_id, confirm: true });
  assert.equal(retry.status, 'outcome_unknown');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.call('apiosk_review_read', { review_id: review.review_id })).error_code, 'gateway_timeout');
});

test('Slack channel creation preserves backend session restrictions and rejects unrelated review types', async () => {
  const f = fixture(() => { throw new GatewayError('App session required.', { code: 'app_only', status: 403, outcomeUnknown: false }); });
  const review = await f.call('apiosk_recurring_channel_review', { connected_account_id: 'owned-account', name: 'company-checks', is_private: true });
  await assert.rejects(f.call('apiosk_action_execute', { review_id: review.review_id, confirm: true }), /unavailable/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.call('apiosk_recurring_channel_create', { review_id: review.review_id, confirm: true }), error => error.code === 'app_only');
  assert.equal((await f.call('apiosk_recurring_channel_create', { review_id: review.review_id, confirm: true })).status, 'rejected');
  assert.equal(f.calls.length, 1);
});
