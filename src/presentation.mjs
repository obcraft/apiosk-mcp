/** Read-only adapters. This module has no transport, model, or payment dependency. */
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];
const own = (value, key) => Object.prototype.hasOwnProperty.call(record(value), key);
const string = value => typeof value === 'string' ? value : '';
const factValue = value => own(value, 'value') ? value.value : value;
const display = value => value == null ? 'Unknown' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const unique = values => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];

function unwrap(value) {
  const input = record(value);
  if (input.schema_version === 'apiosk.ask.presentation.v1' && own(input, 'raw')) return input.raw;
  if (record(input.structuredContent).schema_version === 'apiosk.ask.presentation.v1') return input.structuredContent.raw;
  return value;
}

function taskResponse(value) {
  const item = record(value);
  for (const candidate of [item.response, item.task, item.view, item.gateway, item]) {
    const next = record(candidate);
    if (next.protocol_version === '2' || own(next, 'context_view') || own(next, 'next_actions')) return next;
    if (record(next.view).protocol_version === '2') return next.view;
  }
  return item;
}

export function savedResults(value) {
  const input = unwrap(value), task = taskResponse(input), context = record(task.context_view);
  const taskViews = array(record(input).tasks).filter(task => record(task).view != null);
  if (taskViews.length) return taskViews.flatMap(task => savedResults(task.view));
  if (Array.isArray(context.results)) return context.results;
  if (Array.isArray(task.results)) return task.results;
  if (own(task, 'result') && task.result != null) return [task.result];
  if (own(task, 'result_ref') || own(task, 'data') || own(task, 'preview_data') || task.encoding === 'json_text') return [task];
  if (Array.isArray(input)) return [{ data: input }];
  return [];
}

function analysisOf(value) {
  const task = taskResponse(value);
  return record(task.context_view).analysis ?? task.analysis ?? null;
}

function discoveryRows(value) {
  const input = record(value);
  const direct = Array.isArray(input.sources) ? input.sources : Array.isArray(input.rows) ? input.rows : null;
  if (direct) return direct.map((row, index) => ({ ...record(row), key: row.key ?? row.id ?? `source-${index + 1}`, source: record(row).source ?? row }));
  const message = array(input.messages).filter(message => message.role === 'results').at(-1);
  if (message) return array(message.rows);
  const snapshots = Array.isArray(input.searches) ? input.searches : Object.values(record(input.searches));
  const matches = [...array(input.matches), ...array(record(input.discovery).matches), ...snapshots.flatMap(snapshot => array(record(snapshot.data ?? snapshot).matches))];
  return unique(matches.flatMap(match => [...array(match.apiosk), ...array(match.coinbase)].map(source => ({
    source: { ...source, subject_id: source.subject_id ?? match.subject_id, discovery_query: source.discovery_query ?? match.query },
  })))).map((row, index) => ({ key: `source-${index + 1}`, ...row }));
}

function groupSources(rows) {
  const groups = new Map();
  for (const row of rows) {
    const source = record(row.source), key = `${source.origin ?? ''}:${source.source_slug ?? source.provider ?? source.name ?? ''}`;
    if (!groups.has(key)) groups.set(key, { key, name: source.name ?? source.source_slug ?? source.provider ?? 'Source', logo_url: source.logo_url ?? null, rows: [] });
    // A presentation group never merges endpoint, subject, or input identity.
    groups.get(key).rows.push(row);
  }
  return [...groups.values()];
}

function evidenceOf(analysis) {
  const found = [], visit = (value, depth = 0) => {
    if (depth > 24 || value == null) return;
    if (Array.isArray(value)) { value.forEach(item => visit(item, depth + 1)); return; }
    if (typeof value !== 'object') return;
    if ((typeof value.result_ref === 'string' && typeof value.pointer === 'string' || typeof value.derivation_id === 'string') && own(value, 'value')) found.push(value);
    Object.values(value).forEach(item => visit(item, depth + 1));
  };
  visit(analysis);
  return unique(found);
}

/** A failed or absent check must never become a negative finding. */
export function coverageLabel(requirement) {
  if (requirement.status === 'answered') return 'Answered';
  if (requirement.status === 'not_applicable') return 'Not applicable';
  if (requirement.status === 'pending' || requirement.reason === 'source_pending') return 'Still being investigated';
  if (requirement.reason === 'source_failed') return 'Source unavailable';
  if (['not_fetched', 'not_addressed'].includes(requirement.reason)) return 'Not yet investigated';
  if (['not_in_source', 'period_unavailable'].includes(requirement.reason)) return 'Not found in checked sources';
  return 'Not established';
}

function safeLink(path, baseUrl) {
  if (typeof path !== 'string') return null;
  try {
    if (path.startsWith('/v2/') && !baseUrl) return path;
    const url = baseUrl ? new URL(path, baseUrl) : new URL(path);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function artifactsOf(task, results, baseUrl) {
  const artifacts = [];
  for (const value of [task, record(task.context_view), ...results]) {
    const owner = record(value), report = record(owner.report);
    for (const [key, format] of [['download_path', 'pdf'], ['evidence_download_path', 'zip']]) {
      const url = safeLink(report[key], baseUrl);
      if (url) artifacts.push({ result_ref: owner.result_ref ?? null, format, filename: key === 'download_path' ? report.filename ?? null : null, url, expires_at: report.expires_at ?? null });
    }
    for (const asset of array(record(owner.report_assets).assets)) {
      const url = safeLink(asset.download_path, baseUrl);
      if (url) artifacts.push({ result_ref: owner.result_ref ?? null, ...asset, url });
    }
  }
  return unique(artifacts);
}

function tableFromRows(id, title, rows, metadata = {}) {
  const keys = [...new Set(rows.flatMap(row => Object.keys(record(row))))];
  return { id, title, kind: 'data_table', columns: keys.map(key => ({ id: key, label: key })), rows: rows.map(row => keys.map(key => own(row, key) ? row[key] : null)), ...metadata };
}

// Matches Ask's calendar precision and compatibility gate. A view never guesses dates.
function periodCoordinate(period = {}) {
  const key = period.key ?? period.value ?? period.start ?? '';
  let match;
  if ((match = /^(\d{4})$/.exec(key))) return { value: Number(match[1]), kind: 'year' };
  if ((match = /^(\d{4})-Q([1-4])$/.exec(key))) return { value: Number(match[1]) * 4 + Number(match[2]) - 1, kind: 'quarter' };
  if ((match = /^(\d{4})-H([12])$/.exec(key))) return { value: Number(match[1]) * 2 + Number(match[2]) - 1, kind: 'half_year' };
  if ((match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key))) return { value: Number(match[1]) * 12 + Number(match[2]) - 1, kind: 'month' };
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const value = Date.parse(`${key}T00:00:00Z`);
    if (Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === key) return { value: value / 86400000, kind: 'day' };
  }
  return null;
}

function lineCompatible(block) {
  const series = array(block.series), points = series.flatMap(item => array(item.points)), coordinates = points.map(point => periodCoordinate(point.period));
  const kinds = new Set(coordinates.map(coordinate => coordinate?.kind));
  const bases = new Set(series.flatMap(item => array(item.points).filter(point => point.fact?.value != null).map(point => JSON.stringify([
    point.fact?.unit?.value ?? item.unit?.value ?? block.unit?.value ?? null,
    point.fact?.currency?.value ?? item.currency?.value ?? block.currency?.value ?? null,
  ]))));
  const duplicates = series.some(item => new Set(array(item.points).map(point => periodCoordinate(point.period)?.value)).size !== array(item.points).length);
  return points.length > 0 && kinds.size === 1 && !kinds.has(undefined) && bases.size <= 1 && !duplicates
    && points.some(point => !point.gap && typeof point.fact?.value === 'number' && Number.isFinite(point.fact.value));
}

function blockTable(block) {
  const base = { id: `block:${block.id}`, title: block.title ?? block.kind, kind: block.kind, coverage: block.coverage ?? null, collection: block.collection ?? null, block_id: block.id };
  if (block.kind === 'data_table') return { ...base, columns: array(block.columns), rows: array(block.rows).map(row => array(row.cells).map(factValue)), evidence_rows: array(block.rows).map(row => array(row.cells)), row_indices: array(block.rows).map((row, index) => row.row_index ?? block.collection?.row_indices?.[index] ?? index), sort: block.sort ?? null };
  if (block.kind === 'comparison') return { ...base, columns: [{ id: 'feature', label: 'Feature' }, ...array(block.entities).map(entity => ({ id: entity.id, label: entity.label }))], rows: array(block.rows).map(row => [row.label, ...array(row.cells).map(factValue)]), evidence_rows: array(block.rows).map(row => [null, ...array(row.cells)]), row_basis: array(block.rows).map(row => row.basis ?? null) };
  if (block.kind === 'bar_chart') return { ...base, columns: [{ id: 'label', label: 'Label' }, { id: 'value', label: block.value_label ?? 'Value' }], rows: array(block.bars).map(bar => [bar.label ?? factValue(bar.label_fact) ?? bar.id, factValue(bar.fact) ?? null]), evidence_rows: array(block.bars).map(bar => [bar.label_fact ?? null, bar.fact ?? null]), ranking: block.ranking ?? null };
  if (block.kind === 'line_chart') return { ...base, columns: [{ id: 'series', label: 'Series' }, { id: 'period', label: 'Period' }, { id: 'value', label: block.value_label ?? 'Value' }, { id: 'gap', label: 'Gap' }], rows: array(block.series).flatMap(series => array(series.points).map(point => [series.label, point.period?.value ?? point.period?.key ?? null, factValue(point.fact) ?? null, point.gap ?? null])), evidence_rows: array(block.series).flatMap(series => array(series.points).map(point => [null, point.period ?? null, point.fact ?? null, null])), series: array(block.series), unit: block.unit ?? null, currency: block.currency ?? null, chart_compatible: lineCompatible(block) };
  if (block.kind === 'timeline') return { ...base, columns: [{ id: 'date', label: 'Date' }, { id: 'event', label: 'Event' }, { id: 'kind', label: 'Date kind' }], rows: array(block.events).map(event => [factValue(event.date) ?? null, event.label ?? factValue(event.label_fact) ?? null, event.date_kind ?? null]), evidence_rows: array(block.events).map(event => [event.date ?? null, event.label_fact ?? null, null]) };
  return null;
}

/** Exact saved values only; no synthesis, derived claims, or provider calls. */
export function savedTables(value) {
  const input = unwrap(value), analysis = record(analysisOf(input));
  const taskViews = array(record(input).tasks).filter(task => record(task).view != null);
  if (taskViews.length) return taskViews.flatMap((task, index) => savedTables(task.view).map(table => ({ ...table, id: `task:${task.id ?? index}/${table.id}`, task_id: task.id ?? null, task_kind: task.kind ?? null })));
  const tables = array(analysis.blocks).map(blockTable).filter(Boolean);
  const legacy = record(analysis.presentation);
  if (Array.isArray(legacy.columns) && Array.isArray(legacy.rows)) tables.push({ id: 'presentation', title: legacy.title ?? 'Answer data', kind: legacy.kind ?? 'data_table', columns: legacy.columns.map((column, index) => typeof column === 'string' ? { id: String(index), label: column } : column), rows: legacy.rows.map(row => array(row).map(factValue)), evidence_rows: legacy.rows });
  for (const [index, result] of savedResults(input).entries()) {
    const envelope = record(result), data = own(envelope, 'data') ? envelope.data : own(envelope, 'preview_data') ? envelope.preview_data : result;
    const id = `result:${envelope.result_ref ?? index}`, title = envelope.subject?.label ?? envelope.source?.name ?? 'Saved result';
    if (envelope.encoding === 'json_text') continue;
    if (Array.isArray(data)) {
      tables.push(data.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)) ? tableFromRows(id, title, data, { result_ref: envelope.result_ref ?? null }) : { id, title, kind: 'data_table', columns: [{ id: 'value', label: 'Value' }], rows: data.map(item => [item]), result_ref: envelope.result_ref ?? null });
    } else if (data !== null && typeof data === 'object') {
      const entries = Object.entries(data);
      const fields = entries.filter(([, value]) => !Array.isArray(value));
      if (fields.length) tables.push({ id, title, kind: 'data_table', columns: [{ id: 'field', label: 'Field' }, { id: 'value', label: 'Source value' }], rows: fields, result_ref: envelope.result_ref ?? null });
      for (const [key, rows] of entries.filter(([, value]) => Array.isArray(value))) {
        tables.push(rows.every(item => item !== null && typeof item === 'object' && !Array.isArray(item)) ? tableFromRows(`${id}/${key}`, `${title} · ${key}`, rows, { result_ref: envelope.result_ref ?? null }) : { id: `${id}/${key}`, title: `${title} · ${key}`, kind: 'data_table', columns: [{ id: 'value', label: 'Value' }], rows: rows.map(item => [item]), result_ref: envelope.result_ref ?? null });
      }
    } else if (data !== undefined) tables.push({ id, title, kind: 'data_table', columns: [{ id: 'value', label: 'Value' }], rows: [[data]], result_ref: envelope.result_ref ?? null });
  }
  return tables;
}

/** Changing a view is a deterministic operation on this snapshot alone. */
export function viewSavedData(raw, options = {}) {
  const tables = savedTables(raw), id = options.table_id ?? options.tableId ?? (options.block_id ? `block:${options.block_id}` : undefined);
  const table = id ? tables.find(table => table.id === id) : tables[0];
  if (!table) throw new Error(id ? `Saved table not found: ${id}` : 'No saved table is available.');
  const requested = options.columns;
  if (requested !== undefined && (!Array.isArray(requested) || requested.some(id => typeof id !== 'string'))) throw new TypeError('columns must be an array of saved column IDs.');
  const indices = requested ? requested.map(id => { const index = table.columns.findIndex(column => column.id === id); if (index < 0) throw new Error(`Saved column not found: ${id}`); return index; }) : table.columns.map((_, index) => index);
  const filter = options.filter ?? '';
  if (typeof filter !== 'string') throw new TypeError('filter must be text.');
  let rows = table.rows.map((cells, index) => ({ cells, index }));
  const sort = options.sort ?? table.sort;
  if (sort) {
    const columnId = sort.column_id ?? sort.column;
    const column = table.columns.findIndex(item => item.id === columnId);
    if (column < 0 || !['asc', 'desc'].includes(sort.direction)) throw new Error('Sort needs a saved column_id and asc or desc direction.');
    rows.sort((a, b) => {
      const left = a.cells[column], right = b.cells[column];
      if (left == null || right == null) return left == null && right == null ? a.index - b.index : left == null ? 1 : -1;
      const result = typeof left === 'number' && typeof right === 'number' ? left - right : display(left).localeCompare(display(right), 'en');
      return (sort.direction === 'desc' ? -result : result) || a.index - b.index;
    });
  }
  if (filter) { const needle = filter.toLocaleLowerCase('en'); rows = rows.filter(row => row.cells.some(cell => display(cell).toLocaleLowerCase('en').includes(needle))); }
  const matched = rows.length, offset = options.offset ?? 0, limit = options.limit ?? matched;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new TypeError('offset and limit must be non-negative integers.');
  const selected = rows.slice(offset, offset + limit), view = options.view ?? 'table';
  if (!['table', 'chart'].includes(view)) throw new TypeError('view must be table or chart.');
  const columns = indices.map(index => table.columns[index]), visibleRows = selected.map(row => indices.map(index => row.cells[index]));
  const chartable = table.kind === 'line_chart' ? table.chart_compatible && ['series', 'period', 'value'].every(id => columns.some(column => column.id === id))
    : table.kind === 'bar_chart' ? ['label', 'value'].every(id => columns.some(column => column.id === id)) && table.rows.some(row => typeof row[1] === 'number' && Number.isFinite(row[1]))
      : columns.length === 2 && visibleRows.length > 0 && visibleRows.every(row => typeof row[0] === 'string' && typeof row[1] === 'number' && Number.isFinite(row[1]));
  return { ...table, columns, rows: visibleRows, evidence_rows: table.evidence_rows ? selected.map(row => indices.map(index => table.evidence_rows[row.index]?.[index] ?? null)) : undefined,
    row_indices: selected.map(row => table.row_indices?.[row.index] ?? row.index), ...(table.row_basis ? { row_basis: selected.map(row => table.row_basis[row.index]) } : {}),
    view: view === 'chart' && chartable ? 'chart' : 'table', requested_view: view, ...(view === 'chart' && !chartable ? { view_notice: 'These saved values do not provide a supported numeric chart; the table preserves the data.' } : {}), counts: { saved: table.rows.length, matched, shown: selected.length, offset }, local_only: true };
}

function atomic(value, currency) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return value == null ? '' : `${value} atomic ${currency ?? ''}`.trim();
  const amount = BigInt(value), whole = amount / 1_000_000n, fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} ${currency ?? 'USD'}`;
}

export function presentAsk(raw, options = {}) {
  const input = record(unwrap(raw)), task = taskResponse(input), context = record(task.context_view), discovery = record(input.discovery), parsed = record(input.parsed ?? input.parse ?? discovery.parsed ?? discovery.parse ?? discovery.raw);
  const analysis = analysisOf(input), model = record(analysis), results = savedResults(input), rows = discoveryRows(input);
  const taskViews = array(input.tasks).filter(task => record(task).view != null);
  const taskPresentations = taskViews.map(task => ({ id: task.id ?? null, kind: task.kind ?? null, ...presentResult(task.view, { baseUrl: options.baseUrl ?? options.gatewayUrl }) }));
  const requirements = array(record(model.completeness).requirements), missing = array(model.missing_information);
  const structuredContent = {
    schema_version: 'apiosk.ask.presentation.v1',
    question: input.question ?? context.source_selection?.question ?? null,
    status: input.status ?? task.status ?? null,
    message: input.message ?? parsed.planning_message ?? task.message ?? null,
    sources: rows, source_groups: groupSources(rows),
    company_context: input.company_context ?? parsed.company_context ?? discovery.company_context ?? model.company_context ?? [],
    searches: input.searches ?? discovery.searches ?? record(discovery.raw).searches ?? null,
    proposal: input.approval ?? task.proposal ?? task.quote ?? null,
    selected: input.selected ?? [],
    task_presentations: taskPresentations,
    billing: task.billing ?? null,
    next_actions: array(task.next_actions),
    analysis, blocks: array(model.blocks), evidence: unique([...evidenceOf(analysis), ...taskPresentations.flatMap(item => item.structuredContent.evidence)]),
    coverage: { completeness: model.completeness ?? null, requirements: requirements.map(requirement => ({ ...requirement, display_label: coverageLabel(requirement) })), missing_information: missing, notices: array(context.coverage_notices) },
    limitations: array(model.limitations), source_index: array(model.source_index),
    results, tables: savedTables(input), artifacts: unique([...artifactsOf(task, results, options.baseUrl ?? options.gatewayUrl), ...taskPresentations.flatMap(item => item.structuredContent.artifacts)]),
    errors: [...array(task.errors ?? discovery.errors), ...(input.error ? [input.error] : [])], raw: unwrap(raw),
  };
  if (options.view || options.table_id || options.tableId || options.block_id || options.columns || options.filter) structuredContent.selected_view = viewSavedData(input, options);
  const lines = [];
  if (structuredContent.question) lines.push(String(structuredContent.question));
  if (structuredContent.status) lines.push(`Status: ${structuredContent.status}`);
  if (structuredContent.message) lines.push(String(structuredContent.message));
  const conclusion = array(model.blocks).find(block => block.kind === 'summary' && block.conclusion?.text)?.conclusion;
  if (conclusion) lines.push(conclusion.text);
  for (const observation of array(model.observations).slice(0, 8)) if (observation.text && observation.text !== conclusion?.text) lines.push(observation.text);
  if (array(model.observations).length > 8) lines.push(`${model.observations.length - 8} further findings are retained in structuredContent.analysis.`);
  if (model.provisional === true || model.status === 'partial' || model.completeness?.complete === false) lines.push('Partial answer based on the available information.');
  if (rows.length) {
    lines.push(`${rows.length} source choices (discovery, not purchased results):`);
    for (const row of rows.slice(0, 12)) { const source = record(row.source); lines.push(`- ${row.key ?? ''} · ${source.name ?? source.source_slug ?? 'Source'}${source.description ? ` · ${source.description}` : ''}${source.price != null ? ` · ${source.price}` : ''}${source.availability ? ` · ${source.availability}` : ''}`); }
    if (rows.length > 12) lines.push(`${rows.length - 12} more source choices are retained in structuredContent.sources.`);
  }
  for (const answer of taskPresentations) lines.push(`Task ${answer.id ?? ''}${answer.kind ? ` (${answer.kind})` : ''}\n${answer.text}`);
  const proposal = record(structuredContent.proposal);
  if (proposal.max_total_atomic != null) lines.push(`Quoted maximum: ${atomic(proposal.max_total_atomic, proposal.currency)}${proposal.expires_at ? ` · expires ${proposal.expires_at}` : ''}`);
  const billing = record(structuredContent.billing);
  if (billing.total_charged != null) lines.push(`Charged: ${billing.total_charged}${billing.currency ? ` ${billing.currency}` : ''}${billing.unit ? ` (${billing.unit})` : ''}`);
  if (results.length) {
    lines.push(`${results.length} saved source result${results.length === 1 ? '' : 's'}.`);
    if (!taskPresentations.length && !conclusion && !array(model.observations).length) for (const table of structuredContent.tables.slice(0, 2)) {
      lines.push(table.title);
      for (const row of table.rows.slice(0, 4)) lines.push(`- ${row.map(display).join(' · ')}`);
    }
  }
  for (const requirement of structuredContent.coverage.requirements) lines.push(`${[requirement.subject_label, requirement.criterion, requirement.period].filter(Boolean).join(' · ') || requirement.id}: ${requirement.display_label}`);
  for (const point of missing) if (point.description) lines.push(`Missing information: ${point.description}`);
  for (const limitation of structuredContent.limitations) lines.push(`Limitation: ${limitation}`);
  for (const error of structuredContent.errors) lines.push(`${error.code ?? 'Error'}: ${error.message ?? ''}`);
  if (structuredContent.next_actions.length) lines.push(`Available actions: ${structuredContent.next_actions.map(action => `${action.label ?? action.kind} [${action.action_id ?? action.kind}]`).join('; ')}`);
  return { text: lines.join('\n\n') || 'Saved response is available in structuredContent.raw.', structuredContent };
}

export function presentResult(raw, options = {}) { return presentAsk(raw, options); }

/** Portable read-only HTML export; no script, remote asset, or action handler. */
export function renderAppHtml(raw = {}, options = {}) {
  const { text, structuredContent } = presentAsk(raw, options);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const tables = structuredContent.selected_view ? [structuredContent.selected_view] : structuredContent.tables;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Apiosk saved answer</title><style>:root{color-scheme:light dark;font:15px/1.55 system-ui}body{max-width:1000px;margin:auto;padding:24px}pre{white-space:pre-wrap;overflow-wrap:anywhere}section,details{margin:20px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid #8885;vertical-align:top;overflow-wrap:anywhere}summary{cursor:pointer;font-weight:600}.table{overflow:auto;border:1px solid #8885;border-radius:12px}h1{font-size:22px}</style><body><h1>Apiosk</h1><pre>${escape(text)}</pre>${tables.map(table => `<section><h2>${escape(table.title)}</h2><div class="table"><table><thead><tr>${table.columns.map(column => `<th>${escape(column.label)}</th>`).join('')}</tr></thead><tbody>${table.rows.slice(0, 100).map(row => `<tr>${row.map(cell => `<td>${escape(display(cell))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>${table.rows.length > 100 ? '<p>First 100 rows shown. All saved rows remain in the source data.</p>' : ''}</section>`).join('')}<details><summary>Sources and evidence</summary><pre>${escape(JSON.stringify({ sources: structuredContent.sources, source_index: structuredContent.source_index, evidence: structuredContent.evidence, coverage: structuredContent.coverage }, null, 2))}</pre></details><details><summary>Full saved data</summary><pre>${escape(JSON.stringify(structuredContent.raw, null, 2))}</pre></details></body></html>`;
}
