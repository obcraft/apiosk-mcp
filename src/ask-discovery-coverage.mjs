import { purchasableSource } from './ask-page-sources.mjs';

const array = value => Array.isArray(value) ? value : [];
const text = value => typeof value === 'string' ? value.trim() : '';
const humanize = value => text(value).replace(/[._-]+/g, ' ');

function subjectOf(row, origin) {
  if (row.subject_id) return row.subject_id;
  const subjects = new Set(array(row[origin]).map(source => source.subject_id).filter(Boolean));
  return subjects.size === 1 ? [...subjects][0] : null;
}

// The Gateway preserves capability occurrence order. Never assign a collapsed
// row to several subjects, or let one subject cover another of the same kind.
function matchingRow(capability, index, capabilities, rows, origin) {
  const matches = rows.filter(row => row.slug === capability.slug);
  const sameCapability = capabilities.map((capability, index) => ({ capability, index })).filter(item => item.capability.slug === capability.slug);
  const exact = matches.filter(row => capability.subject_id && subjectOf(row, origin) === capability.subject_id);
  if (exact.length) {
    const sameSubject = sameCapability.filter(item => item.capability.subject_id === capability.subject_id);
    return exact.length === sameSubject.length ? exact[sameSubject.findIndex(item => item.index === index)] : null;
  }
  if (matches.length !== sameCapability.length) return null;
  const row = matches[sameCapability.findIndex(item => item.index === index)];
  const subject = subjectOf(row, origin);
  return subject && subject !== capability.subject_id ? null : row;
}

/** Discovery coverage only: a matching source is never a completed check. */
export function discoveryCoverage(found = {}) {
  const capabilities = array(found.parsed_request?.capabilities);
  const requirements = [];
  for (const [index, capability] of capabilities.entries()) {
    if (capability.slug === 'general.conversation') continue;
    const rows = {}, origins = {};
    for (const origin of ['apiosk', 'coinbase']) {
      const search = found.searches?.[origin];
      const row = matchingRow(capability, index, capabilities, array(search?.matches), origin);
      rows[origin] = row;
      const failed = array(found.errors).some(error => error.origin === origin)
        || search?.status === 'unavailable' || search?.status === 'error'
        || origin === 'coinbase' && ['pending', 'unavailable'].includes(row?.coinbase_status);
      const candidates = array(row?.[origin]).filter(source => !capability.subject_id || !source.subject_id || source.subject_id === capability.subject_id);
      origins[origin] = { status: failed ? 'incomplete' : row && Array.isArray(row[origin]) ? 'complete' : 'unknown',
        matched_count: candidates.length, selectable_count: candidates.filter(source => purchasableSource({ ...source, origin })).length };
    }
    const returnedRows = Object.values(rows).filter(Boolean);
    if (returnedRows.length && returnedRows.every(row => row.answer_only === true)) continue;
    const complete = Object.values(origins).every(origin => origin.status === 'complete');
    const unknown = Object.values(origins).every(origin => origin.status === 'unknown');
    const matched = Object.values(origins).reduce((total, origin) => total + origin.matched_count, 0);
    const selectable = Object.values(origins).reduce((total, origin) => total + origin.selectable_count, 0);
    const status = selectable ? 'matched' : unknown ? 'unknown' : !complete ? 'incomplete' : matched ? 'unavailable' : 'unmatched';
    const subject = array(found.parsed_request?.subjects).find(subject => subject.id === capability.subject_id);
    const label = text(capability.description) || text(returnedRows[0]?.query) || text(capability.name) || humanize(capability.slug);
    const scope = [label, text(subject?.label), text(capability.source_hint) && `requested source: ${text(capability.source_hint)}`].filter(Boolean).join(' · ');
    const notice = status === 'unmatched' ? `No matching sources found: ${scope}.`
      : status === 'incomplete' ? `Source search is incomplete: ${scope}. Matching sources could not be confirmed.`
      : status === 'unavailable' ? `Matching sources cannot currently be selected: ${scope}.`
      : null;
    requirements.push({ capability: capability.slug, label, subject_id: capability.subject_id ?? null,
      subject_label: subject?.label ?? null, source_hint: capability.source_hint ?? null,
      status, search_complete: complete, origins, ...(notice ? { notice } : {}) });
  }
  const gaps = requirements.filter(requirement => ['unmatched', 'incomplete', 'unavailable'].includes(requirement.status));
  return { stage: 'source_discovery', requirements, gaps, has_gaps: gaps.length > 0 };
}
