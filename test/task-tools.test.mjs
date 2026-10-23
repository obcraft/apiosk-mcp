import test from 'node:test';
import assert from 'node:assert/strict';
import { taskTools } from '../src/task-tools.mjs';

const TASK = '11111111-1111-4111-8111-111111111111';
const ENDPOINT = '22222222-2222-4222-8222-222222222222';
const QUOTE = '33333333-3333-4333-8333-333333333333';
const OUTPUT = '44444444-4444-4444-8444-444444444444';
const selection = { version: 1, mode: 'include', sources: [{ endpoint_id: ENDPOINT, capability: 'company.profile', subject_id: 'mollie', input: { 'company.id': '30204462' } }] };
const clone = value => structuredClone(value);
function fixture({ credentialKind = 'session', completed = false, failOnce = false, invalid = false } = {}) {
  let state = { id: 'request1', type: 'ask', status: completed ? 'finished' : 'requires_approval', tasks: [], active_task_ids: [TASK],
    approval: { approval_id: 'old-approval' }, approved_id: completed ? 'old-approval' : null,
    approved_quotes: completed ? { approval_id: 'old-approval', max_total_atomic: '70000' } : null, prepared_fingerprint: 'old' };
  let remote = { protocol_version: '2', state: { state_ref: TASK, revision: 1 }, status: completed ? 'succeeded' : 'ready', errors: [],
    proposal: { quote_ref: completed ? OUTPUT : QUOTE, max_total_atomic: '70000', currency: 'USD' },
    context_view: { worker_active: false, analyzing: false, results: completed ? [{ result_ref: 'evidence', data: [{ value: 0 }] }] : [],
      source_selection: { can_choose: true, options: [{ subject_id: 'mollie', source: { origin: 'apiosk', endpoint_id: ENDPOINT, capability: 'company.profile', availability: 'supported' } }] },
      analysis_upgrade: { can_choose: !completed, output_quotes: completed ? [OUTPUT] : [], models: [{ id: 'offered-model', max_total_atomic: '20000' }] } },
    next_actions: [], billing: completed ? { authorization_active: true, status: 'charged', total_charged: '70000' } : null };
  state.tasks.push({ id: TASK, kind: 'endpoint', view: clone(remote), ...(completed ? { approval_attempt: { id: 'prior-receipt', status: 'response_received' } } : {}) });
  const calls = [], store = { get: async () => clone(state), save: async value => { state = clone(value); }, withLock: async (_id, callback) => callback() };
  let lost = false;
  const gateway = { credentialKind, request: async (path, options) => {
    calls.push({ path, ...clone(options) });
    if (options.method === 'GET') return clone(remote);
    if (invalid) return { status: 'state_conflict', state: null, errors: [{ code: 'changed', message: 'Reload the task.' }] };
    remote = { ...remote, state: { ...remote.state, revision: 2 }, proposal: { ...remote.proposal, quote_ref: '55555555-5555-4555-8555-555555555555' }, status: 'ready', billing: null };
    if (failOnce && !lost) { lost = true; throw Object.assign(new Error('Reply lost'), { code: 'gateway_connection_error' }); }
    return clone(remote);
  } };
  const tools = taskTools({ gateway, store });
  return { invoke: (name, args) => tools.find(tool => tool.name === name).handler(args, {}), calls, get state() { return state; }, setState: fn => fn(state), setRemote: fn => fn(remote) };
}

test('offered source edit posts exact same-task selection, invalidates old approval, never authorizes', async () => {
  const f = fixture();
  const result = await f.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection });
  assert.deepEqual(f.calls.map(call => [call.method, call.path]), [['GET', `/v2/tasks/${TASK}`], ['POST', `/v2/tasks/${TASK}/source-selection`]]);
  assert.deepEqual(f.calls[1].body.selection, selection);
  assert.equal(f.calls[1].body.state.revision, 1);
  assert.equal(result.new_purchase_started, false);
  assert.equal(f.state.approval, null);
  assert.equal(f.state.prepared_fingerprint, null);
  assert.equal(f.state.status, 'review_required');
  assert.equal(f.state.tasks[0].view.state.revision, 2);
});

test('plan edits reject connected credentials, unrelated tasks, unoffered choices and prior approval', async () => {
  const connected = fixture({ credentialKind: 'connection' });
  await assert.rejects(connected.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection }), /personal App session/);
  assert.equal(connected.calls.length, 0);
  const missing = fixture();
  await assert.rejects(missing.invoke('apiosk_source_selection', { request_id: 'request1', task_id: 'missing', selection }), /belonging/);
  assert.equal(missing.calls.length, 0);
  const unoffered = fixture();
  await assert.rejects(unoffered.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection: { ...selection, sources: [{ ...selection.sources[0], subject_id: 'other' }] } }), /exact source/);
  assert.equal(unoffered.calls.filter(call => call.method === 'POST').length, 0);
  const approved = fixture();
  approved.setState(state => { state.tasks[0].approval_attempt = { status: 'dispatching' }; });
  await assert.rejects(approved.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection }), /approval or execution/);
  assert.equal(approved.calls.filter(call => call.method === 'POST').length, 0);
  const imported = fixture();
  imported.setState(state => { state.tasks.push({ id: 'another-task', kind: 'endpoint', view: { status: 'ready', billing: { authorization_active: true } } }); });
  await assert.rejects(imported.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection }), /approval or execution/);
  assert.equal(imported.calls.filter(call => call.method === 'POST').length, 0);
});

test('stateless conflict preserves saved task evidence and records update errors', async () => {
  const f = fixture({ invalid: true });
  const before = clone(f.state.tasks[0].view);
  const result = await f.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection });
  assert.deepEqual(f.state.tasks[0].view, before);
  assert.equal(result.errors[0].code, 'changed');
  assert.equal(f.state.approval, null);
});

test('lost free-reprice response reuses exact durable request ID and signed state on retry', async () => {
  const f = fixture({ failOnce: true });
  const args = { request_id: 'request1', task_id: TASK, selection };
  await assert.rejects(f.invoke('apiosk_source_selection', args), /Reply lost/);
  assert.equal(f.state.tasks[0].pending_update.status, 'outcome_unknown');
  await f.invoke('apiosk_source_selection', args);
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, posts[1].body);
  assert.equal(f.state.tasks[0].pending_update.status, 'completed');
});

test('analysis plan quote uses only offered models and does not execute compute', async () => {
  const f = fixture();
  const args = { request_id: 'request1', task_id: TASK, enabled: true, model_id: 'offered-model' };
  await f.invoke('apiosk_analysis_quote', args);
  assert.equal(f.calls[1].path, `/v2/tasks/${TASK}/analysis-upgrade`);
  assert.deepEqual(Object.keys(f.calls[1].body).sort(), ['enabled', 'model_id', 'output_quote_ref', 'request_id', 'state']);
  assert.equal(f.calls[1].body.output_quote_ref, null);
  const invalid = fixture();
  await assert.rejects(invalid.invoke('apiosk_analysis_quote', { ...args, model_id: 'invented-model' }), /offered/);
  assert.equal(invalid.calls.filter(call => call.method === 'POST').length, 0);
});

test('completed output upgrade retains its paid receipt and evidence, then requires a fresh approval', async () => {
  const f = fixture({ completed: true });
  const before = clone(f.state.tasks[0].view);
  await f.invoke('apiosk_analysis_quote', { request_id: 'request1', task_id: TASK, enabled: true, model_id: 'offered-model', output_quote_ref: OUTPUT });
  assert.equal(f.state.tasks[0].approval_attempt, undefined);
  assert.equal(f.state.tasks[0].approval_history[0].approval_attempt.id, 'prior-receipt');
  assert.deepEqual(f.state.tasks[0].approval_history[0].view, before);
  assert.equal(f.state.approved_id, null);
  assert.equal(f.state.approved_quotes, null);
  assert.equal(f.state.approval_history[0].approval_id, 'old-approval');
  assert.equal(f.state.status, 'review_required');
  assert.ok(f.calls.every(call => !/authorize|execute/.test(call.path)));
});

test('saved-output analysis refuses uncertain previous approval and still-running workers', async () => {
  const args = { request_id: 'request1', task_id: TASK, enabled: true, model_id: 'offered-model', output_quote_ref: OUTPUT };
  const uncertain = fixture({ completed: true });
  uncertain.setState(state => { state.tasks[0].approval_attempt.status = 'outcome_unknown'; });
  await assert.rejects(uncertain.invoke('apiosk_analysis_quote', args), /Recover and finish/);
  const running = fixture({ completed: true });
  running.setRemote(remote => { remote.context_view.worker_active = true; });
  await assert.rejects(running.invoke('apiosk_analysis_quote', args), /Recover and finish/);
  const unfinishedGroup = fixture({ completed: true });
  unfinishedGroup.setState(state => {
    state.active_task_ids.push('another-task');
    state.tasks.push({ id: 'another-task', kind: 'endpoint', view: { status: 'ready' } });
  });
  await assert.rejects(unfinishedGroup.invoke('apiosk_analysis_quote', args), /Recover and finish/);
});

test('saved-output upgrade recovery preserves the prior receipt after an intervening status read', async () => {
  const f = fixture({ completed: true, failOnce: true });
  const before = clone(f.state.tasks[0].view);
  const args = { request_id: 'request1', task_id: TASK, enabled: true, model_id: 'offered-model', output_quote_ref: OUTPUT };
  await assert.rejects(f.invoke('apiosk_analysis_quote', args), /Reply lost/);
  await f.invoke('apiosk_task_options', { request_id: 'request1', task_id: TASK });
  assert.equal(f.state.tasks[0].view.state.revision, 2);
  await f.invoke('apiosk_analysis_quote', args);
  assert.deepEqual(f.state.tasks[0].approval_history[0].view, before);
  assert.equal(f.state.tasks[0].approval_history[0].approval_attempt.id, 'prior-receipt');
  const posts = f.calls.filter(call => call.method === 'POST');
  assert.deepEqual(posts[0].body, posts[1].body);
});

test('inactive prior plans remain readable but cannot replace an active selection implicitly', async () => {
  const f = fixture();
  f.setState(state => { state.active_task_ids = ['another-task']; });
  await assert.rejects(f.invoke('apiosk_source_selection', { request_id: 'request1', task_id: TASK, selection }), /earlier plan/);
  await assert.rejects(f.invoke('apiosk_analysis_quote', { request_id: 'request1', task_id: TASK, enabled: true, model_id: 'offered-model' }), /earlier plan/);
  assert.equal(f.calls.length, 0);
  await f.invoke('apiosk_task_options', { request_id: 'request1', task_id: TASK });
  assert.equal(f.calls.length, 1);
  const completed = fixture({ completed: true });
  completed.setState(state => { state.active_task_ids = []; });
  await completed.invoke('apiosk_analysis_quote', { request_id: 'request1', task_id: TASK, enabled: true, model_id: 'offered-model', output_quote_ref: OUTPUT });
  assert.deepEqual(completed.state.active_task_ids, [TASK]);
});
