import { presentSearch } from './ask-ui/gateway-v2-ask.mjs';
import { resultWithPages } from './saved-pages.mjs';
import { visibleAskSources, sameSource } from './ask-source-view.mjs';
import { suggestSourceInputs } from './source-input-suggestions.mjs';
import { discoveryCoverage } from './ask-discovery-coverage.mjs';
import { CARD_READ_TOOL, CARD_APPROVE_TOOL, CURRENT_CARD_COMPATIBILITY_URIS, cardToolMeta, cardResources, legacyCardResources, createCardHtml, createLegacyCardHtml } from './card-ui.mjs';

const cardNames = new Set(['apiosk_ask', 'apiosk_sources', 'apiosk_prepare', 'apiosk_approve', 'apiosk_status', 'apiosk_requote', 'apiosk_continue', 'apiosk_result', 'apiosk_follow_up', 'apiosk_retry_search', 'apiosk_chats', 'apiosk_source_selection', 'apiosk_analysis_quote']);
const readOperations = ['apiosk_ask', 'apiosk_sources', 'apiosk_external', 'apiosk_status', 'apiosk_execute', 'apiosk_requote', 'apiosk_discover', 'prepare_basket', 'status_basket', 'requote_basket', 'retry_preparation', 'read_result_page', 'new_purchase', 'inspect_source'];
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const reference = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,100}$' };
const arbitrary = { type: 'object', maxProperties: 64, additionalProperties: true };
const fail = message => { throw new Error(message); };
const error = message => ({ isError: true, structuredContent: { error: { code: 'card_request_refused', message } }, content: [{ type: 'text', text: message }] });
const string = value => typeof value === 'string' ? value : '';
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);

function compact(state, card) {
  const tasks = (state.tasks || []).map(task => ({ task_id: task.id, kind: task.kind, status: task.view?.status,
    message: task.view?.message || null, errors: task.view?.errors || [],
    next_actions: (task.view?.next_actions || []).map(action => ({ action_id: action.action_id, kind: action.kind, label: action.label,
      requires_authorization: action.requires_authorization, input_schema: action.input_schema })),
    result_available: task.view?.result != null || !!task.view?.context_view?.results?.length }));
  const visible = visibleAskSources(state);
  const sources = visible.slice(0, 100).map(source => ({ source_id: source.id, name: source.name,
    description: string(source.description || source.endpoint?.description).slice(0, 600), origin: source.origin,
    availability: source.availability, subject_id: source.subject_id, subject_label: source.subject_label,
    capability: source.capability || source.requested_capability, price: source.price || source.endpoint?.price,
    input_values: source.input_values, missing_inputs: source.endpoint?.missing_inputs }));
  return { request_id: state.id, question: state.question, status: state.status, view: card.view || 'task', sources,
    source_count: visible.length, company_context: card.company_context || state.discovery?.company_context || [],
    discovery_coverage: discoveryCoverage(state.discovery || {}),
    money_display: card.context_view?.money_display || null, approval: state.approval || null, tasks,
    input_requirements: (state.input_requirements || []).map(item => ({ source_id: item.source_id, source: item.source,
      missing: item.missing, errors: item.errors })), errors: state.preparation_response?.errors?.length && state.pending_prepare ? state.preparation_response.errors : state.error ? [state.error] : state.discovery?.errors || [],
    plan_ready: Boolean(state.approval),
    next_step: state.approval ? 'Review this exact total. Only explicit user approval permits execution.'
      : sources.length && !tasks.length ? 'Wait for the user to choose sources in the displayed card. Do not call sources, prepare or status automatically; the card already displays the options. Nothing has been purchased.'
      : state.status === 'review_required' ? 'No approval quote is available. Do not say the plan is ready or ask for approval. Explain the task errors or missing requirements, then wait for the user.'
      : 'Use the saved request ID to inspect status, result or evidence when needed. Do not repeat a purchase.',
    data_access: 'The embedded card contains the full source forms and saved response. Use apiosk_result and apiosk_evidence for exact saved values; source options are not purchased findings.' };
}

function identity(source, candidate) {
  return (source.endpoint_id || source.endpoint?.endpoint_id) === (candidate.endpoint_id || candidate.endpoint?.endpoint_id)
    && (source.capability || source.requested_capability || source.endpoint?.capability) === (candidate.capability || candidate.endpoint?.capability)
    && (source.subject_id || null) === (candidate.subject_id || null);
}

export function sourceCard(state) {
  const discovery = state.discovery || {};
  const rows = visibleAskSources(state);
  const fallbackMatches = () => {
    const groups = new Map();
    for (const source of rows) {
      const slug = source.requested_capability || source.capability || 'requested_sources', key = JSON.stringify([slug, source.subject_id]);
      if (!groups.has(key)) groups.set(key, { slug, ...(source.subject_id ? { subject_id: source.subject_id } : {}), apiosk: [], coinbase: [], coinbase_status: 'complete' });
      groups.get(key)[source.origin === 'apiosk' ? 'apiosk' : 'coinbase'].push(source);
    }
    return [...groups.values()];
  };
  let view;
  try { view = presentSearch(discovery, state.question); }
  catch {
    view = { protocol_version: '2', view: 'source_search', question: state.question, search_id: discovery.search_id,
      parsed_request: discovery.parsed_request || {}, ...(Array.isArray(discovery.source_options) ? { source_options: discovery.source_options } : {}), matches: fallbackMatches(),
      company_context: discovery.company_context || [], message: state.error?.message };
  }
  if (Array.isArray(discovery.apis) && rows.length && !(view.matches || []).some(match => match.apiosk?.length || match.coinbase?.length)) {
    view.matches = fallbackMatches(); delete view.message;
  }
  // Render the exact Ask-page projection, including for requests saved by the
  // older MCP. Offered descriptors may enrich a match, never add extra rows.
  view.source_rows = rows.map(source => Array.isArray(source.endpoint?.inputs)
    ? { ...source, endpoint: { ...source.endpoint, input_values: suggestSourceInputs(source, source.endpoint, discovery.parsed_request) } }
    : source);
  view.discovery_coverage = discoveryCoverage(discovery);
  view.matches = fallbackMatches();
  view.source_options = (view.source_options || []).filter(option => rows.some(source => sameSource(source, {
    ...option.source, endpoint_id: option.source?.endpoint_id || option.endpoint?.endpoint_id,
    subject_id: option.subject_id || option.source?.subject_id,
  }))).map(option => ({ ...option, source: { ...option.source,
    ...(option.source?.logo_url || option.endpoint?.source?.logo_url
      ? { logo_url: option.source?.logo_url || option.endpoint.source.logo_url } : {}) } }));
  view.context_view = { ...discovery.context_view, companies: view.company_context || discovery.company_context || [] };
  view.selected_sources = (state.selected || []).flatMap(selection => {
    const source = state.sources.find(row => row.id === selection.source_id && row.origin === 'apiosk');
    return source ? [{ endpoint_id: source.endpoint_id, capability: source.capability || source.requested_capability,
      ...(source.subject_id ? { subject_id: source.subject_id } : {}),
      input: { ...suggestSourceInputs(source, source.endpoint, discovery.parsed_request), ...selection.input } }] : [];
  });
  view.selected_external_sources = (state.selected || []).flatMap(selection => {
    const source = state.sources.find(row => row.id === selection.source_id && row.origin !== 'apiosk');
    return source ? [{ api_id: source.api_id, source: state.input_requirements?.find(item => item.source_id === source.id)?.descriptor || source,
      input: selection.input }] : [];
  });
  if (state.input_requirements?.length) view.message = state.input_requirements.map(item =>
    `${item.source}: ${(item.errors || []).map(error => error.message).concat((item.missing || []).map(field => `Provide ${field.field}`)).join('; ')}`).join('\n');
  else if (state.error?.message) view.message = state.error.message;
  return view;
}

export function decorateTaskView(view, gatewayUrl) {
  const raw = structuredClone(view);
  if (gatewayUrl) {
    const eventsPath = raw.context_view?.events_path;
    if (typeof eventsPath === 'string' && eventsPath.startsWith(`/v2/tasks/${raw.state?.state_ref}/events?`)) raw.context_view.events_url = new URL(eventsPath, gatewayUrl).href;
    // Same saved-download decoration as the original runtime. The signed
    // paths stay within Gateway; this is presentation, never a new fetch.
    const documents = [raw.context_view, ...(raw.context_view?.conversation || []).map(turn => turn.output), raw.result,
      ...(raw.context_view?.results || []), ...(raw.context_view?.conversation || []).flatMap(turn => [turn.output?.result, ...(turn.output?.results || [])])];
    for (const document of documents) {
      const report = document?.report;
      if (typeof report?.download_path === 'string' && /^\/v2\/tasks\/[0-9a-f-]+\/(?:results|reports)\/[0-9a-f-]+\/report\.pdf\?/.test(report.download_path)) report.url = new URL(report.download_path, gatewayUrl).href;
      if (typeof report?.evidence_download_path === 'string' && /^\/v2\/tasks\/[0-9a-f-]+\/reports\/[0-9a-f-]+\/evidence\.zip\?/.test(report.evidence_download_path)) report.evidence_url = new URL(report.evidence_download_path, gatewayUrl).href;
    }
  }
  for (const key of ['proposal', 'billing']) if (raw[key]?.currency === 'USDC') raw[key].currency = 'USD';
  if (raw.result?.currency === 'USDC') raw.result.currency = 'USD';
  return raw;
}

function taskCard(state, task, gatewayUrl) {
  const raw = decorateTaskView(resultWithPages(task), gatewayUrl);
  raw.context_view = { ...raw.context_view, ...(raw.context_view?.money_display || !state.discovery?.context_view?.money_display
    ? {} : { money_display: state.discovery.context_view.money_display }),
    approval_outcome_unconfirmed: Boolean(raw.context_view?.approval_outcome_unconfirmed
      || ['dispatching', 'outcome_unknown'].includes(task.approval_attempt?.status)) };
  // An automatic plan can fail before any source was selected. Preserve the
  // original discovery so that its available sources do not become an empty
  // result card and the user can still review them without a new search.
  const selection = state.discovery ? sourceCard(state) : null;
  if (task.kind === 'external') return { ...raw, protocol_version: '2', view: 'external_purchase',
    ...(selection ? { basket_search: selection } : {}), result_present: raw.result_present ?? raw.result != null };
  // The exact Gateway task stays authoritative. Explicit card approval is
  // mapped to MCP 2, and execution continuations only resume prior consent.
  return { ...raw, protocol_version: '2', ...(raw.proposal && !state.approval && !task.approval_attempt
    ? { proposal: { ...raw.proposal, approval_url: null } } : {}),
    context_view: { ...raw.context_view, ...(selection ? { source_selection: {
      can_choose: !task.approval_attempt, question: state.question, search_id: selection.search_id, parsed_request: selection.parsed_request,
      options: selection.source_options, original_intake: selection, selections: selection.selected_sources,
    }, selected_sources: selection.selected_sources } : {}), approval_mode: 'chatbot', execution_mode: 'server' } };
}

export function presentCard(state, preferredTaskId, gatewayUrl) {
  const marker = { request_id: state.id, approval: state.approval || null };
  const selected = preferredTaskId ? state.tasks.find(task => task.id === preferredTaskId) : null;
  if (preferredTaskId && !selected) fail('The task is not part of this saved Ask request.');
  if (!selected && state.follow_up_clarification) {
    const task = state.tasks.find(task => task.kind === 'endpoint');
    if (task) {
      const current = taskCard(state, task, gatewayUrl), clarification = state.follow_up_clarification;
      return { ...current, request_id: state.id, _mcp2: marker, status: 'needs_input', next_actions: [], proposal: null,
        context_view: { ...current.context_view, clarification: { message: clarification.message },
          conversation: [...(current.context_view?.conversation || []), { question: clarification.question, reply: clarification.message }] } };
    }
    return { protocol_version: '2', view: 'conversation', kind: 'clarification', question: state.follow_up_clarification.question,
      message: state.follow_up_clarification.message, _mcp2: marker };
  }
  const active = state.tasks.filter(task => state.active_task_ids.includes(task.id));
  const visible = selected ? [selected] : active;
  const incomplete = !selected && !!state.pending_prepare;
  if (visible.length === 1 && !incomplete) return { ...taskCard(state, visible[0], gatewayUrl), request_id: state.id, _mcp2: marker };
  if (visible.length > 1 || incomplete) return { protocol_version: '2', view: 'source_basket', request_id: state.id,
    question: state.question, search: { ...sourceCard(state), _mcp2: marker }, _mcp2: marker,
    entries: [...visible.map(task => ({ kind: task.kind === 'external' ? 'external' : 'local',
      label: task.view?.source?.name || task.view?.context_view?.question || (task.kind === 'external' ? 'External source' : 'Selected sources'),
      request_id: task.id, response: { ...taskCard(state, task, gatewayUrl), _mcp2: marker },
      approval_submitted: !!task.approval_attempt, uncertain: ['dispatching', 'outcome_unknown'].includes(task.approval_attempt?.status),
      error: task.approval_attempt?.error?.message })), ...(incomplete ? [{ kind: 'local', label: 'Remaining source prices',
      request_id: state.pending_prepare.request_id, error: (state.preparation_response?.errors || []).map(error => error.message).filter(Boolean).join('\n') || state.error?.message || 'Price preparation is incomplete. Retry the saved selection.' }] : [])] };
  return { ...sourceCard(state), request_id: state.id, _mcp2: marker };
}

/** The original components run against the new service, never its old runtime. */
export function withEmbeddedCards(service, { store, gateway, legacyUiMime = false }) {
  const core = new Map(service.tools.map(tool => [tool.name, tool]));
  const load = async requestId => {
    const state = await store.get(requestId);
    if (!state || state.type !== 'ask') fail('This saved request does not belong to the current connection.');
    return state;
  };
  const invoke = async (name, args, context) => {
    const target = core.get(name);
    if (!target) fail('This operation is unavailable in MCP 2.');
    const result = await target.handler(args, context);
    if (result?.isError) throw Object.assign(new Error(result.structuredContent?.error?.message || 'The request could not be completed.'), {
      gatewayError: result.structuredContent?.error, resultMeta: result._meta,
    });
    return result;
  };
  const decorate = async (response, requestId, preferredTaskId) => {
    if (response?.isError || !requestId) return response;
    const state = await load(requestId);
    if (!state.tasks?.length && typeof gateway.displayContext === 'function') {
      const display = await gateway.displayContext().catch(() => null);
      if (display?.money_display) state.discovery = { ...state.discovery, context_view: { ...state.discovery?.context_view, money_display: display.money_display } };
    }
    const card = presentCard(state, preferredTaskId, gateway.baseUrl);
    const summary = compact(state, card);
    return { ...response, structuredContent: summary, _meta: { ...response?._meta, apiosk_card_data: card },
      content: [{ type: 'text', text: state.approval
        ? `Review ${state.approval.max_total_atomic} atomic ${state.approval.currency} for the selected sources in the Ask card. Nothing runs until you approve. Saved request: ${state.id}.`
        : `${state.question}\n${summary.source_count} matching source options. Status: ${state.status}. ${summary.next_step}${summary.discovery_coverage.gaps.map(gap => `\n${gap.notice}`).join('')}${summary.tasks.flatMap(task => [task.message, ...task.errors.map(error => error.message || error.code)].filter(Boolean)).map(message => `\n${message}`).join('')} Saved request: ${state.id}.` }] };
  };
  const selectedSources = (state, selections = [], external = []) => [
    ...selections.map(selection => {
      if (!visibleAskSources(state).some(source => source.origin === 'apiosk' && identity(source, selection))) fail('Select a matching source from this saved question.');
      let matches = state.sources.filter(source => source.origin === 'apiosk' && identity(source, selection));
      if (matches.length > 1) matches = matches.filter(source => canonical(source.input_values || source.endpoint?.input_values || {}) === canonical(selection.input || {}));
      if (matches.length !== 1) fail('Select an exact source and subject from this saved question.');
      return { source_id: matches[0].id, input: selection.input || {} };
    }),
    ...external.map(selection => {
      if (!visibleAskSources(state).some(source => source.origin !== 'apiosk' && source.api_id === selection.api_id)) fail('Select a matching external source from this saved question.');
      const matches = state.sources.filter(source => source.origin !== 'apiosk' && source.api_id === selection.api_id);
      if (matches.length !== 1) fail('Select the exact external source offered for this saved question.');
      return { source_id: matches[0].id, input: selection.input || {} };
    }),
  ];
  const responseRequest = (response, fallback) => response?.structuredContent?.request_id || response?.structuredContent?.raw?.id || fallback;
  async function cardOperation({ request_id, operation, args = {}, approval }, context, canApprove) {
    try {
      const state = await load(request_id);
      let response, preferredTaskId;
      if (canApprove) {
        if (!['apiosk_approve', 'apiosk_external_approve', 'approve_basket'].includes(operation)) fail('Unknown approval action.');
        if (!approval || !state.approval && !state.approved_quotes) fail('Review the current total before approving.');
        if (operation !== 'approve_basket') {
          const taskId = args.state?.state_ref || args.purchase_id;
          const task = state.tasks.find(task => task.id === taskId);
          if (!task || state.active_task_ids.length !== 1) fail('Approve all selected sources using the combined total.');
          const quote = task.kind === 'external' ? task.view.quote : task.view.proposal;
          if (quote?.quote_ref !== args.quote_ref || quote?.max_total_atomic !== args.max_total_atomic) fail('This price changed. Review it again.');
          preferredTaskId = taskId;
        }
        response = await invoke('apiosk_approve', { request_id, approval_id: approval.approval_id,
          currency: approval.currency, max_total_atomic: approval.max_total_atomic, confirm: true }, context);
      } else if (operation === 'new_purchase') {
        if (!['repeat', 'sources'].includes(args.mode)) fail('Choose a new price review or a new source selection.');
        const active = state.tasks.filter(task => state.active_task_ids.includes(task.id));
        if (!active.length || active.some(task => !['succeeded', 'partial', 'failed', 'cancelled', 'unsupported'].includes(task.view?.status)
          || task.view?.context_view?.worker_active || task.view?.context_view?.analyzing
          || ['dispatching', 'outcome_unknown'].includes(task.approval_attempt?.status)
          || ['dispatching', 'outcome_unknown'].includes(task.pending_update?.status)
          || task.view?.billing?.status === 'pending_reconciliation')) fail('Wait for the current request to finish before starting a new purchase.');
        const freshResponse = await invoke('apiosk_ask', { question: state.question, mode: 'sources' }, context);
        const freshId = responseRequest(freshResponse);
        if (!freshId || freshId === request_id) fail('A new price review requires a new saved request.');
        const fresh = await load(freshId);
        if (args.mode === 'sources') return decorate(freshResponse, freshId);
        if (state.mode === 'automatic') return decorate(await invoke('apiosk_prepare', { request_id: freshId, mode: 'automatic', selections: [] }, context), freshId);
        const rows = visibleAskSources(fresh);
        const selections = (state.selected || []).map(selection => {
          const prior = state.sources.find(source => source.id === selection.source_id);
          const matches = prior ? rows.filter(source => sameSource(source, prior)) : [];
          return matches.length === 1 ? { source_id: matches[0].id, input: selection.input || {} } : null;
        });
        // Availability or subject identity may have changed. Show the fresh
        // choices instead of substituting a provider or reusing an old quote.
        if (!selections.length || selections.some(selection => !selection)) return decorate(freshResponse, freshId);
        return decorate(await invoke('apiosk_prepare', { request_id: freshId, mode: 'sources', selections }, context), freshId);
      } else if (operation === 'prepare_basket') {
        response = await invoke('apiosk_prepare', { request_id, mode: 'sources', selections: selectedSources(state, args.selections, args.external) }, context);
      } else if (operation === 'retry_preparation') {
        if (!state.pending_prepare && !state.pending_input_review) fail('There is no interrupted price preparation to retry.');
        response = await invoke('apiosk_prepare', { request_id, mode: state.pending_prepare?.calls?.automatic ? 'automatic' : state.mode || 'sources',
          selections: state.requested_selection || state.selected || [] }, context);
      } else if (operation === 'apiosk_ask') {
        if (args.question && args.question !== state.question) fail('Reopen the matching Ask question before changing its sources.');
        const selection = args.input?.apiosk_source_selection_v1 || args;
        response = args.research
          ? await invoke('apiosk_prepare', { request_id, mode: 'automatic', selections: [] }, context)
          : Array.isArray(selection.selections)
            ? await invoke('apiosk_prepare', { request_id, mode: 'sources', selections: selectedSources(state, selection.selections) }, context)
            : await invoke('apiosk_retry_search', { request_id }, context);
      } else if (operation === 'apiosk_status' || operation === 'status_basket') {
        preferredTaskId = args.task_ref;
        if (preferredTaskId && !state.tasks.some(task => task.id === preferredTaskId)) fail('Task does not belong to this saved request.');
        response = await invoke('apiosk_status', { request_id }, context);
      } else if (operation === 'apiosk_requote' || operation === 'requote_basket') {
        if (operation === 'apiosk_requote') {
          preferredTaskId = args.state?.state_ref;
          if (!state.tasks.some(task => task.id === preferredTaskId)) fail('Task does not belong to this saved request.');
        }
        response = await invoke('apiosk_requote', { request_id }, context);
      } else if (operation === 'apiosk_external') {
        const source = state.sources.find(source => source.api_id === args.api_id && source.origin !== 'apiosk');
        if (args.action === 'source') {
          if (!source) fail('External source does not belong to this saved question.');
          const inspected = await invoke('apiosk_sources', { request_id, source_id: source.id }, context);
          return { content: [{ type: 'text', text: 'Review the external source inputs in the Ask card.' }],
            structuredContent: { request_id, source_id: source.id, source_name: source.name, charged: false },
            _meta: { apiosk_card_data: { protocol_version: '2', view: 'external_source', api_id: source.api_id,
              source: { ...inspected.structuredContent.descriptor, input_values: inspected.structuredContent.suggested_input || {} }, _mcp2: { request_id, approval: state.approval || null } } } };
        }
        if (args.action === 'prepare') {
          if (!source) fail('External source does not belong to this saved question.');
          response = await invoke('apiosk_prepare', { request_id, selections: [{ source_id: source.id, input: args.input || {} }] }, context);
        } else if (args.action === 'status') {
          preferredTaskId = args.purchase_id;
          if (!state.tasks.some(task => task.kind === 'external' && task.id === preferredTaskId)) fail('Saved purchase does not belong to this request.');
          response = await invoke('apiosk_status', { request_id }, context);
        } else fail('Unknown external source action.');
      } else if (operation === 'inspect_source') {
        if (!visibleAskSources(state).some(source => source.id === args.source_id)) fail('Select a matching source from this saved question.');
        const inspected = await invoke('apiosk_sources', { request_id, source_id: args.source_id }, context);
        const value = { view: 'source_metadata', descriptor: inspected.structuredContent?.descriptor, suggested_input: inspected.structuredContent?.suggested_input || {} };
        return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else if (operation === 'read_result_page') {
        const task = state.tasks.find(task => task.id === args.task_ref && task.kind === 'endpoint');
        const action = task?.view.next_actions?.find(action => action.action_id === args.result_ref && action.kind === 'read_result' && action.requires_authorization === false);
        if (!action) fail('Choose a saved result from this request.');
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) fail('Invalid saved result offset.');
        const savedPage = await invoke('apiosk_result_page', { request_id, task_id: task.id, action_id: action.action_id, offset }, context);
        const page = savedPage.structuredContent?.page;
        if (!page || page.result_ref !== args.result_ref) fail('The saved result page did not match this source.');
        const value = { view: 'saved_result_page', page };
        return { structuredContent: value, content: [{ type: 'text', text: JSON.stringify(value) }] };
      } else if (operation === 'apiosk_execute') {
        const taskId = args.state?.state_ref, task = state.tasks.find(task => task.id === taskId && task.kind === 'endpoint');
        if (!task) fail('Task does not belong to this saved request.');
        const action = task.view.next_actions?.find(action => action.action_id === args.action_id);
        if (!action) fail('Refresh the saved task before using this action.');
        preferredTaskId = taskId;
        if (['execute_quoted_step', 'poll'].includes(action.kind)) {
          if (!task.approval_attempt && !task.view.billing?.authorization_active) fail('This request has not been approved.');
          response = await invoke('apiosk_status', { request_id, recover: true }, context);
        } else if (action.kind === 'read_result') {
          response = await invoke('apiosk_result_page', { request_id, task_id: taskId, action_id: action.action_id, offset: args.input?.offset || 0 }, context);
        } else response = await invoke('apiosk_continue', { request_id, task_id: taskId, action_id: action.action_id, input: args.input ?? null }, context);
      } else if (operation === 'apiosk_sources') {
        response = await invoke('apiosk_sources', { request_id }, context);
      } else if (operation === 'apiosk_discover') {
        const prefix = state.follow_up_clarification && `${state.follow_up_clarification.question}\n\nUser clarification: `;
        const question = prefix && args.question?.startsWith(prefix) ? args.question.slice(prefix.length) : args.question;
        response = await invoke('apiosk_follow_up', { request_id, question }, context);
      } else fail('This card action is not available in the Ask workflow.');
      return decorate(response, responseRequest(response, request_id), preferredTaskId);
    } catch (cause) {
      const response = error(cause.message || 'This card action could not be completed.');
      if (cause.gatewayError?.code) response.structuredContent.error.code = cause.gatewayError.code;
      if (Number.isInteger(cause.gatewayError?.status)) response.structuredContent.error.status = cause.gatewayError.status;
      if (cause.resultMeta) response._meta = cause.resultMeta;
      return response;
    }
  }
  const tools = service.tools.map(tool => !cardNames.has(tool.name) ? tool : ({ ...tool, _meta: { ...tool._meta, ...cardToolMeta },
    async handler(args, context) {
      const response = await tool.handler(args, context);
      if (response?.isError || tool.name === 'apiosk_result' && args.format && args.format !== 'view'
        || tool.name === 'apiosk_sources' && args.source_id || tool.name === 'apiosk_chats' && args.action === 'list') return response;
      const decorated = await decorate(response, responseRequest(response, args.request_id), tool.name === 'apiosk_result' ? args.task_id : undefined);
      if (tool.name === 'apiosk_result') {
        // A model asking to read purchased results needs the actual saved data.
        // Remove repeated state trees, while retaining analysis, evidence,
        // tables, coverage, source records and any requested filtered view.
        const { raw, task_presentations, searches, source_groups, ...savedResult } = response.structuredContent || {};
        decorated.structuredContent = { ...decorated.structuredContent, ...savedResult, request_id: args.request_id };
        decorated.content = response.content;
      }
      return decorated;
    },
  }));
  tools.push({ name: CARD_READ_TOOL, title: 'Update this Ask card', description: 'Private embedded Ask UI operation. Uses only the card’s saved request. Never authorizes a purchase.',
    inputSchema: object({ request_id: reference, operation: { enum: readOperations }, args: arbitrary }, ['request_id', 'operation', 'args']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    handler: (args, context) => cardOperation(args, context, false) });
  tools.push({ name: CARD_APPROVE_TOOL, title: 'Approve the displayed Ask total', description: 'Private embedded UI action. The person must click the exact displayed approval. It never accepts consent inferred from a data question.',
    inputSchema: object({ request_id: reference, operation: { enum: ['apiosk_approve', 'apiosk_external_approve', 'approve_basket'] }, args: arbitrary,
      approval: object({ approval_id: { type: 'string' }, currency: { type: 'string' }, max_total_atomic: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
        expires_at: { type: 'string' }, quotes: { type: 'array' }, notice: { type: 'string' } }, ['approval_id', 'currency', 'max_total_atomic']) }, ['request_id', 'operation', 'args', 'approval']),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private', 'openai/widgetAccessible': true },
    handler: (args, context) => cardOperation(args, context, true) });
  const resources = cardResources(gateway.baseUrl), aliases = legacyCardResources(gateway.baseUrl, { legacyUiMime });
  const guide = { uri: 'apiosk://v2/host-contract', name: 'Apiosk Ask chatbot instructions', mimeType: 'text/markdown' };
  return { ...service, tools,
    async listResources() { return [...resources, guide, ...await service.listResources()]; },
    async readResource(uri, context) {
      if (uri === guide.uri) return { contents: [{ ...guide, text: service.instructions || 'Use apiosk_ask for a new question. Review sources and the exact total before explicit approval.' }] };
      const resource = [...resources, ...aliases].find(resource => resource.uri === uri);
      if (!resource) return service.readResource(uri, context);
      return { contents: [{ ...resource, text: resources.includes(resource) || CURRENT_CARD_COMPATIBILITY_URIS.includes(uri)
        ? createCardHtml(gateway.baseUrl) : createLegacyCardHtml(gateway.baseUrl) }] };
    },
  };
}
