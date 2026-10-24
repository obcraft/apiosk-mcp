// The Ask page's source projection, kept independent from transport and cards.
// Discovery matches are visible choices. Offered options enrich those choices;
// they do not expand the user's request into additional related sources.
const acronyms = new Set(['api', 'bag', 'cbs', 'de', 'eu', 'fr', 'gb', 'iban', 'id', 'kvk', 'lei', 'nl', 'pdok', 'ted', 'uk', 'us', 'vat', 'xbrl']);
const trailing = /[\s.,;:!?…—–-]+$/;
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort((left, right) => left.localeCompare(right)).map(key => [key, stable(value[key])])) : value;
const inputKey = value => value === undefined ? '' : JSON.stringify(stable(value));

export function purchaseInputKey(source) { return inputKey(source.endpoint?.input_values); }

export function capabilityWords(slug) {
  const segments = (slug ?? '').toLowerCase().split('.').filter(Boolean);
  const words = list => list.flatMap(segment => segment.split(/[-_\s]+/)).filter(Boolean);
  const detail = words(segments.slice(1));
  const chosen = segments.length === 2 && detail.length > 1 ? detail : words(segments);
  return chosen.map((word, index) => acronyms.has(word) ? word.toUpperCase() : index === 0 ? word[0].toUpperCase() + word.slice(1) : word).join(' ');
}

export function sourceSummary(source) {
  const flat = (source.description ?? '').replace(/\s+/g, ' ').trim();
  let line = flat.split(/ [—–] |;|\.\s+(?=[A-Z0-9])/)[0].replace(trailing, '');
  if (line.length > 90) {
    const cut = line.slice(0, 90);
    line = `${(cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(trailing, '')}…`;
  }
  const says = line.split(' ').length > 1 && line.toLowerCase() !== source.name.trim().toLowerCase();
  return says ? line : capabilityWords(source.capability) || line || source.name;
}

function safeUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}

export function sourceItemKey(source) {
  const provider = (source.source_slug || source.name).trim().toLowerCase();
  const url = safeUrl(source.url);
  const resource = source.endpoint_id ? `${provider}:endpoint:${source.endpoint_id}` : url ? `${provider}:url:${url}` : `${provider}:operation:${source.name}`;
  return `${resource}:${source.capability ?? source.method}:${source.subject_id ?? ''}:${purchaseInputKey(source)}`;
}

export function purchasableSource(source) {
  if (source.origin === 'apiosk') return Boolean(source.endpoint_id) && ['supported', 'unverified'].includes(source.availability);
  const url = safeUrl(source.url);
  return source.availability === 'supported' && Boolean(url?.startsWith('https:'));
}

/** Provider groups retain every distinct endpoint, subject and input choice. */
export function groupSourceItems(sources) {
  const groups = new Map();
  for (const source of sources) {
    const key = `${source.origin}:${source.source_slug?.trim().toLowerCase() || source.name.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, { key, sources: [] });
    groups.get(key).sources.push(source);
  }
  return [...groups.values()];
}

function enrich(source, options) {
  if (source.origin !== 'apiosk') return source;
  const offered = options.filter(option => {
    const candidate = option.source || {};
    return (candidate.endpoint_id || option.endpoint?.endpoint_id) === source.endpoint_id
      && (candidate.capability || option.endpoint?.capability) === source.capability
      && (option.subject_id ?? candidate.subject_id ?? null) === (source.subject_id ?? null);
  });
  const originalValues = source.endpoint?.input_values ?? source.input_values;
  const valuesOf = option => option.input_values ?? option.endpoint?.input_values ?? option.source?.endpoint?.input_values;
  const exact = originalValues === undefined ? offered.length === 1 ? offered[0] : null
    : offered.find(option => inputKey(valuesOf(option)) === inputKey(originalValues));
  if (!exact) {
    const logo = source.logo_url || source.endpoint?.source?.logo_url;
    return logo ? { ...source, logo_url: logo } : source;
  }
  const values = originalValues ?? valuesOf(exact);
  const endpoint = { ...exact.endpoint, ...source.endpoint,
    source: { ...exact.endpoint?.source, ...source.endpoint?.source },
    ...(values !== undefined ? { input_values: values } : {}) };
  const logo = source.logo_url || endpoint.source?.logo_url || exact.source?.logo_url;
  return { ...source, endpoint, ...(logo ? { logo_url: logo } : {}),
    ...(source.input_values === undefined && values !== undefined ? { input_values: values } : {}) };
}

/** Mirrors App sourceRows -> availableSourcesFirst -> distinctSources. */
export function projectAskSources(found) {
  const hasMatches = ['apiosk', 'coinbase'].some(origin => Array.isArray(found.searches?.[origin]?.matches));
  const candidates = hasMatches ? ['apiosk', 'coinbase'].flatMap(origin => (found.searches?.[origin]?.matches || []).flatMap(match =>
    (match[origin] || []).map(candidate => ({ ...candidate, discovery_query: match.query,
      ...(candidate.subject_id ?? match.subject_id ? { subject_id: candidate.subject_id ?? match.subject_id } : {}) })))) : (found.apis || []).map(source => ({ ...source }));
  const rows = candidates.map(source => {
    const subject = found.parsed_request?.subjects?.find(subject => subject.id === source.subject_id);
    return subject ? { ...source, subject_label: subject.label } : source;
  }).sort((left, right) => {
    const rank = source => purchasableSource(source) ? source.origin === 'apiosk' ? 0 : 1 : 2;
    return rank(left) - rank(right);
  });
  const keys = new Set(), descriptions = new Set();
  const options = found.source_options || found.searches?.apiosk?.source_options || [];
  return rows.filter(source => {
    if (!purchasableSource(source)) return false;
    const key = sourceItemKey(source);
    if (keys.has(key)) return false;
    keys.add(key);
    const description = JSON.stringify([source.origin, source.source_slug ?? source.name, sourceSummary(source), source.price, source.capability, source.subject_id, purchaseInputKey(source)]);
    if (descriptions.has(description)) return false;
    descriptions.add(description);
    return true;
  }).map(source => enrich(source, options));
}
