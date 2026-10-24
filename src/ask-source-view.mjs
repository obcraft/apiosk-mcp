import { projectAskSources } from './ask-page-sources.mjs';

const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const values = source => stable(source.input_values ?? source.endpoint?.input_values ?? {});
export function sameSource(left, right) {
  return left.origin === right.origin
    && (left.origin === 'apiosk'
      ? left.endpoint_id === right.endpoint_id
      : left.url && right.url ? left.url === right.url && left.method === right.method : left.api_id === right.api_id)
    && (left.capability || null) === (right.capability || null)
    && (left.subject_id || null) === (right.subject_id || null);
}

// Old saved requests can contain extra catalog options. Project their visible
// choices without deleting the journal or changing any saved selection IDs.
export function visibleAskSources(state) {
  if (!state.discovery?.searches && !Array.isArray(state.discovery?.apis)) return state.sources || [];
  return projectAskSources(state.discovery).map(source => {
    const candidates = (state.sources || []).filter(saved => sameSource(saved, source));
    const saved = candidates.find(candidate => values(candidate) === values(source)) || (candidates.length === 1 ? candidates[0] : null);
    return { ...source, ...(saved?.id ? { id: saved.id } : {}), ...(saved?.api_id ? { api_id: saved.api_id } : {}) };
  });
}
