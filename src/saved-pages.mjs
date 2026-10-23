/** Bounded assembly of existing Gateway result pages. No source or transport calls. */
export const SAVED_RESULT_PAGE_LIMIT = 64;
export const SAVED_RESULT_CHARACTER_LIMIT = 512_000;
const PAGE_CHARACTERS = 8000;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const clone = value => structuredClone(value);
const characters = value => Array.from(value).length;
const payloadKeys = new Set(['data', 'preview_data', 'encoding', 'text', 'next_offset']);
const metadata = value => Object.fromEntries(Object.entries(record(value) ?? {}).filter(([key]) => !payloadKeys.has(key)));
const canonical = value => JSON.stringify(value, (_key, item) => record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

function currentResult(task, ref) {
  const results = Array.isArray(task.view?.context_view?.results) ? task.view.context_view.results : [];
  return results.find(result => result?.result_ref === ref) ?? (task.view?.result?.result_ref === ref ? task.view.result : null);
}

function validateFragment(result, ref, offset) {
  if (!record(result) || result.result_ref !== ref || result.encoding !== 'json_text' || typeof result.text !== 'string') throw new Error('The saved result page does not match this source.');
  const size = characters(result.text), end = offset + size;
  if (!size || size > PAGE_CHARACTERS || end > SAVED_RESULT_CHARACTER_LIMIT || result.next_offset !== null && result.next_offset !== end) throw new Error('The saved result page has an invalid continuation.');
  return end;
}

/**
 * Commit a page only after validating task/result identity, revision, bounds,
 * overlap and any complete JSON envelope. A rejected read never overwrites data.
 * Returns {complete, result_ref, next_offset, pages}; task.view is never replaced.
 */
export function capturePage(task, page, { action_id, offset = 0 } = {}) {
  if (!record(task) || typeof task.id !== 'string' || typeof action_id !== 'string' || !action_id) throw new Error('A saved task and exact read action are required.');
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= SAVED_RESULT_CHARACTER_LIMIT) throw new Error('Invalid saved result offset.');
  if (!record(page) || page.state?.state_ref !== task.id || page.status === 'state_conflict'
    || typeof page.state?.revision === 'number' && typeof task.view?.state?.revision === 'number' && page.state.revision < task.view.state.revision) throw new Error('The saved task changed. Read its current status before loading more data.');
  const result = record(page.result);
  if (!result || result.result_ref !== action_id) throw new Error('The saved result response does not match this read action.');
  const action = task.view?.next_actions?.find(action => action.action_id === action_id);
  if (!action || action.kind !== 'read_result' || action.requires_authorization !== false) throw new Error('This task does not offer the requested read-only result action.');
  const key = `${action_id}:${offset}`, pages = { ...(record(task.pages) ?? {}) };
  let complete = null;
  if (result.encoding !== 'json_text') {
    if (!own(result, 'data') || offset !== 0) throw new Error('This saved result is not a readable complete envelope.');
    complete = clone(result);
  } else {
    const end = validateFragment(result, action_id, offset);
    const existing = pages[key];
    if (existing && canonical(existing.result) !== canonical(result)) throw new Error('A saved page changed. Reopen the task before combining different snapshots.');
    pages[key] = clone(page);
    // The initial compact result is already a saved first page. Reuse it when valid.
    const initial = currentResult(task, action_id);
    if (!pages[`${action_id}:0`] && initial?.encoding === 'json_text') {
      try { validateFragment(initial, action_id, 0); pages[`${action_id}:0`] = { state: clone(task.view.state), result: clone(initial) }; } catch { /* An invalid or middle fragment is not a first page. */ }
    }
    const fragments = Object.entries(pages).filter(([key]) => key.startsWith(`${action_id}:`)).map(([key, page]) => ({ offset: Number(key.slice(action_id.length + 1)), result: page.result })).sort((a, b) => a.offset - b.offset);
    if (fragments.length > SAVED_RESULT_PAGE_LIMIT) throw new Error('The saved result reached the page limit.');
    let priorEnd = 0, terminalSeen = false;
    for (const fragment of fragments) {
      if (terminalSeen) throw new Error('A saved result contains pages after its final fragment.');
      const next = validateFragment(fragment.result, action_id, fragment.offset);
      if (fragment.offset < priorEnd) throw new Error('Saved result pages overlap.');
      priorEnd = next;
      terminalSeen = fragment.result.next_offset === null;
    }
    let cursor = 0, text = '', finished = false;
    for (const fragment of fragments) {
      if (fragment.offset !== cursor) break;
      if (finished) throw new Error('A saved result contains pages after its final fragment.');
      text += fragment.result.text; cursor += characters(fragment.result.text);
      finished = fragment.result.next_offset === null;
    }
    if (finished) {
      try { complete = record(JSON.parse(text)); } catch { /* Do not commit an invalid final read. */ }
      if (!complete || complete.result_ref !== action_id || !own(complete, 'data')) throw new Error('The complete saved result could not be read.');
    }
    if (!complete) {
      task.pages = pages;
      return { complete: false, result_ref: action_id, next_offset: cursor, pages: fragments.length, received_until: end };
    }
  }
  pages[key] = clone(page);
  const saved = { ...(record(task.saved_results) ?? {}), [action_id]: clone(complete) };
  const baselines = { ...(record(task.saved_result_baselines) ?? {}), [action_id]: metadata(currentResult(task, action_id)) };
  task.pages = pages; task.saved_results = saved; task.saved_result_baselines = baselines;
  return { complete: true, result_ref: action_id, next_offset: null, pages: Object.keys(pages).filter(key => key.startsWith(`${action_id}:`)).length };
}

/** Enrich a cloned view with complete saved bodies and current metadata. */
export function resultWithPages(task) {
  const view = clone(task.view);
  const merge = current => {
    const ref = current?.result_ref, saved = task.saved_results?.[ref];
    if (!record(current) || !record(saved) || saved.result_ref !== ref || !own(saved, 'data')) return current;
    if (own(current, 'data') && current.encoding !== 'json_text') return current;
    const baseline = task.saved_result_baselines?.[ref], updated = clone(saved), fresh = metadata(current);
    if (record(baseline)) {
      for (const key of new Set([...Object.keys(baseline), ...Object.keys(fresh)])) {
        if (own(baseline, key) === own(fresh, key) && canonical(baseline[key]) === canonical(fresh[key])) continue;
        if (own(fresh, key)) updated[key] = clone(fresh[key]); else delete updated[key];
      }
    } else Object.assign(updated, fresh);
    delete updated.encoding; delete updated.text; delete updated.next_offset;
    return updated;
  };
  if (Array.isArray(view?.context_view?.results)) view.context_view.results = view.context_view.results.map(merge);
  if (view?.result) view.result = merge(view.result);
  // Some compact task snapshots list only read actions/result_refs. A verified
  // completed read still belongs in their saved result list even without a preview.
  const available = new Set((view?.next_actions ?? []).filter(action => action.kind === 'read_result' && action.requires_authorization === false).map(action => action.action_id));
  const listed = new Set((view?.context_view?.results ?? []).map(result => result?.result_ref));
  for (const [ref, saved] of Object.entries(task.saved_results ?? {})) {
    if (!listed.has(ref) && available.has(ref) && record(saved) && saved.result_ref === ref && own(saved, 'data')) {
      view.context_view ??= {}; view.context_view.results ??= [];
      view.context_view.results.push(clone(saved)); listed.add(ref);
    }
  }
  return view;
}
