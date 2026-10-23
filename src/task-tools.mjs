import { createHash, randomUUID } from 'node:crypto';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const identifier = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,100}$' };
const text = { type: 'string', minLength: 1, maxLength: 500 };
const uuid = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const selectedSource = object({ endpoint_id: uuid, capability: text, subject_id: text,
  input: { type: 'object', maxProperties: 16, additionalProperties: true } }, ['endpoint_id', 'capability', 'subject_id']);
const selectionSchema = object({ version: { const: 1, type: 'integer' }, mode: { const: 'include', type: 'string' },
  sources: { type: 'array', maxItems: 10, items: selectedSource } }, ['version', 'mode', 'sources']);
const readonly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const prepare = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const settled = view => ['succeeded', 'partial', 'failed', 'unsupported', 'cancelled'].includes(view.status)
  && !view.context_view?.worker_active && !view.context_view?.analyzing;
const active = view => view.context_view?.worker_active || view.context_view?.analyzing || view.status === 'running';
const ambiguous = task => ['dispatching', 'outcome_unknown'].includes(task.approval_attempt?.status);

/** Free task editing only. Gateway owns all models, sources, prices and eligibility. */
export function taskTools({ gateway, store, tool = (name, description, inputSchema, handler, annotations) => ({ name, description, inputSchema, handler, annotations }) }) {
  async function load(requestId, taskId) {
    const request = await store.get(requestId);
    if (!request || request.type !== 'ask') fail('request_unavailable', 'This request is not saved in the current credential and workspace.');
    const task = request.tasks?.find(task => task.id === taskId && task.kind === 'endpoint');
    if (!task) fail('task_unavailable', 'Choose an endpoint task belonging to this saved request.');
    return { request, task };
  }
  function sessionOnly() {
    if (gateway.credentialKind !== 'session') fail('app_only', 'Changing a saved plan or its analysis model requires a personal App session. Connected agents can prepare a new selection with apiosk_prepare.');
  }
  function validateView(next, task) {
    return next?.state?.state_ref === task.id && Number.isSafeInteger(next.state.revision)
      && next.state.revision >= (Number.isSafeInteger(task.view?.state?.revision) ? task.view.state.revision : 0);
  }
  async function fresh(request, task, signal) {
    const next = await gateway.request(`/v2/tasks/${encodeURIComponent(task.id)}`, { method: 'GET', signal });
    if (!validateView(next, task)) fail('invalid_saved_task', 'Gateway did not return the current saved task. Previous evidence is preserved.');
    task.view = next;
    await store.save(request);
    return next;
  }
  function noStartedPlan(request, task) {
    if (request.approved_id || request.tasks.some(other => other.approval_attempt
      || other.view.billing?.authorization_active || active(other.view))) {
      fail('plan_already_started', 'This request already has approval or execution activity. Read its saved status; do not change its approved plan.');
    }
  }
  function offeredSelection(view, selection) {
    const context = view.context_view?.source_selection;
    if (!context?.can_choose) fail('source_selection_unavailable', 'This task does not offer editable source choices.');
    const seen = new Set();
    for (const choice of selection.sources) {
      const key = JSON.stringify([choice.endpoint_id, choice.capability, choice.subject_id]);
      if (seen.has(key)) fail('duplicate_source', 'Choose each endpoint/capability once for each subject.');
      seen.add(key);
      const option = context.options?.find(option => option.subject_id === choice.subject_id
        && option.source?.endpoint_id === choice.endpoint_id && option.source?.capability === choice.capability);
      if (!option || option.source.origin !== 'apiosk' || option.source.availability !== 'supported') {
        fail('unoffered_source', 'Use only the exact source and subject identities offered by this saved task.');
      }
    }
  }
  function upgradeAllowed(request, task, args) {
    const upgrade = task.view.context_view?.analysis_upgrade;
    if (!upgrade) fail('analysis_upgrade_unavailable', 'Extended analysis is unavailable for this task.');
    if (args.model_id && !upgrade.models?.some(model => model.id === args.model_id)) fail('unknown_analysis_model', 'Choose a model_id offered by this saved task.');
    if (args.output_quote_ref) {
      if (!args.enabled || !upgrade.output_quotes?.includes(args.output_quote_ref)) fail('saved_output_unavailable', 'Choose an offered output_quote_ref and enable analysis to quote a saved output.');
      const currentTasks = request.tasks.filter(other => (request.active_task_ids || []).includes(other.id));
      if (!settled(task.view) || ambiguous(task) || currentTasks.some(other => !settled(other.view) || ambiguous(other))) {
        fail('analysis_not_settled', 'Recover and finish the existing execution before quoting analysis of its saved output.');
      }
      return;
    }
    noStartedPlan(request, task);
    if (!upgrade.can_choose) fail('analysis_upgrade_unavailable', 'This unapproved plan does not offer an analysis choice.');
  }
  async function edit(args, operation, signal) {
    sessionOnly();
    return store.withLock(args.request_id, async () => {
      const { request, task } = await load(args.request_id, args.task_id);
      if (!(request.active_task_ids || []).includes(task.id)
        && !(operation === 'analysis-upgrade' && args.output_quote_ref)) {
        fail('inactive_task', 'This task belongs to an earlier plan. Edit an active task; saved completed outputs can be quoted separately for analysis.');
      }
      const parameters = operation === 'source-selection' ? { selection: args.selection }
        : { enabled: args.enabled, model_id: args.model_id ?? null, output_quote_ref: args.output_quote_ref ?? null };
      const fingerprint = digest([operation, parameters]);
      const pending = task.pending_update;
      const recovering = pending && ['dispatching', 'outcome_unknown'].includes(pending.status);
      if (recovering && pending.fingerprint !== fingerprint) fail('update_recovery_required', 'Repeat the same saved plan edit to recover its quote before requesting a different edit.');
      if (!recovering) {
        await fresh(request, task, signal);
        if (operation === 'source-selection') { noStartedPlan(request, task); offeredSelection(task.view, args.selection); }
        else upgradeAllowed(request, task, args);
        task.pending_update = {
          fingerprint, operation, status: 'dispatching',
          path: `/v2/tasks/${encodeURIComponent(task.id)}/${operation}`,
          body: { request_id: randomUUID(), state: structuredClone(task.view.state), ...parameters },
          previous_quote: task.view.proposal?.quote_ref ?? null,
          ...(parameters.output_quote_ref ? { previous_view: structuredClone(task.view),
            previous_approval_attempt: task.approval_attempt ?? null,
            previous_approved_quotes: request.approved_quotes ?? null } : {}),
        };
        // Remove old approval before repricing; interrupted requests cannot
        // accidentally approve a quote whose replacement has already saved.
        request.approval = null;
        await store.save(request);
      }
      const update = task.pending_update;
      let next;
      try { next = await gateway.request(update.path, { method: 'POST', body: update.body, signal }); }
      catch (error) {
        update.status = 'outcome_unknown';
        update.error = { code: typeof error.code === 'string' ? error.code : 'task_update_failed', message: 'The quote update could not be confirmed. Repeat this same edit to recover it.' };
        request.status = 'review_required'; await store.save(request); throw error;
      }
      if (!validateView(next, task) || next.errors?.length || next.status === 'state_conflict') {
        if (validateView(next, task)) task.view = next;
        update.status = 'rejected';
        update.errors = Array.isArray(next?.errors) ? next.errors : [{ code: 'invalid_task_response', message: 'Gateway returned no matching saved task.' }];
        task.update_errors = update.errors;
        request.status = 'review_required'; request.approval = null;
        await store.save(request);
        return { request_id: request.id, task_id: task.id, status: 'review_required', errors: update.errors,
          view: task.view, new_purchase_started: false, next_step: 'Use apiosk_status to recover current state before preparing another edit.' };
      }
      // A completed output upgrade starts a new approval cycle on the same
      // Gateway task. Preserve its previous receipt and exact approved cap.
      if (operation === 'analysis-upgrade' && parameters.output_quote_ref) {
        task.approval_history ??= [];
        task.approval_history.push({ output_quote_ref: parameters.output_quote_ref,
          approval_attempt: update.previous_approval_attempt, view: update.previous_view });
        delete task.approval_attempt;
        request.approval_history ??= [];
        if (update.previous_approved_quotes) request.approval_history.push(update.previous_approved_quotes);
        request.active_task_ids = [task.id];
      }
      task.view = next; task.update_errors = []; update.status = 'completed';
      request.approval = null; request.approved_id = null; request.approved_quotes = null;
      request.prepared_fingerprint = null; request.status = 'review_required';
      await store.save(request);
      return { request_id: request.id, task_id: task.id, status: 'review_required', view: next, new_purchase_started: false,
        next_step: 'Call apiosk_status to assemble the new exact total. Show it and obtain explicit user approval before apiosk_approve.' };
    });
  }
  return [
    tool('apiosk_task_options', 'Read a saved task’s offered source-selection and extended-analysis choices, models and saved-output references. No replan or purchase.',
      object({ request_id: identifier, task_id: identifier }, ['request_id', 'task_id']), async (args, { signal } = {}) => store.withLock(args.request_id, async () => {
        const { request, task } = await load(args.request_id, args.task_id);
        const view = await fresh(request, task, signal);
        return { request_id: request.id, task_id: task.id, source_selection: view.context_view?.source_selection ?? null,
          analysis_upgrade: view.context_view?.analysis_upgrade ?? null, session_required_for_edits: true,
          editable_with_current_credential: gateway.credentialKind === 'session', status: view.status };
      }), readonly),
    tool('apiosk_source_selection', 'Reprice an unapproved saved research plan with exact offered source and subject choices. Requires a personal App session. This route cannot authorize or run sources; review the new total afterward.',
      object({ request_id: identifier, task_id: identifier, selection: selectionSchema }, ['request_id', 'task_id', 'selection']),
      (args, { signal } = {}) => edit(args, 'source-selection', signal), prepare),
    tool('apiosk_analysis_quote', 'Quote an offered extended-analysis model, enable/disable it on an unapproved plan, or quote analysis of an offered completed saved output. Requires a personal App session. Reuses evidence and never approves or executes; a new price needs explicit approval.',
      object({ request_id: identifier, task_id: identifier, enabled: { type: 'boolean' }, model_id: text, output_quote_ref: uuid }, ['request_id', 'task_id', 'enabled']),
      (args, { signal } = {}) => edit(args, 'analysis-upgrade', signal), prepare),
  ];
}
