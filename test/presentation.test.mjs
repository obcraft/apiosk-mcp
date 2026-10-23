import test from 'node:test';
import assert from 'node:assert/strict';
import { coverageLabel, presentAsk, presentResult, renderAppHtml, savedTables, viewSavedData } from '../src/presentation.mjs';
import { csvCell, exportResult } from '../src/exports.mjs';

const source = { name: 'Example register', provider: 'register', endpoint_id: 'endpoint-1', retrieved_at: '2026-10-23T10:00:00Z', url: 'https://register.example/company/123' };
const saved = { result_ref: 'result-1', coverage: 'source_response', source, data: [{ name: 'Alpha', revenue: 0, active: false }, { name: 'Beta', revenue: 10, active: true }], charged_atomic: '70000' };
const task = {
  protocol_version: '2', status: 'partial', state: { state_ref: 'task-1' }, result: saved,
  context_view: { results: [saved], analysis: {
    status: 'partial', observations: [{ text: 'The register reports revenue of zero.', evidence: [{ result_ref: 'result-1', pointer: '/0/revenue', value: 0, source: { name: source.name } }] }],
    limitations: ['Sanctions screening has not run.'], missing_information: [{ id: 'gap-1', description: 'Sanctions check missing.', requirement_ids: ['sanctions'] }],
    completeness: { complete: false, requirements: [{ id: 'profile', criterion: 'company.profile', status: 'answered' }, { id: 'sanctions', criterion: 'sanctions', status: 'missing', reason: 'not_fetched' }] },
    blocks: [{ id: 'sales', kind: 'data_table', title: 'Revenue', columns: [{ id: 'name', label: 'Name' }, { id: 'revenue', label: 'Revenue' }], rows: [{ cells: [{ value: 'Alpha', result_ref: 'result-1', pointer: '/0/name' }, { value: 0, result_ref: 'result-1', pointer: '/0/revenue' }] }, { cells: [{ value: 'Beta', result_ref: 'result-1', pointer: '/1/name' }, { value: 10, result_ref: 'result-1', pointer: '/1/revenue' }] }] }],
  }, report: { format: 'pdf', filename: 'report.pdf', download_path: '/v2/tasks/task-1/reports/report-1/report.pdf?signature=x', evidence_download_path: '/v2/tasks/task-1/reports/report-1/evidence.zip?signature=y', expires_at: 12345 } },
  billing: { currency: 'USD', unit: 'micro_usd', total_charged: '70000', status: 'charged' },
  next_actions: [{ action_id: 'read-1', kind: 'read_result', label: 'Read saved result', requires_authorization: false }], errors: [],
};

test('Gateway results retain exact facts, evidence, partial status and gaps', () => {
  const result = presentResult(task);
  assert.equal(result.structuredContent.raw, task);
  assert.equal(result.structuredContent.results[0].data[0].active, false);
  assert.equal(result.structuredContent.evidence[0].value, 0);
  assert.match(result.text, /Partial answer/);
  assert.match(result.text, /Sanctions screening has not run/);
  assert.match(result.text, /Not yet investigated/);
  assert.equal(result.structuredContent.status, 'partial');
  assert.deepEqual(result.structuredContent.next_actions, task.next_actions);
  assert.equal(result.structuredContent.artifacts[0].url, task.context_view.report.download_path);
});

test('source grouping retains endpoints, subjects, inputs and original selection IDs', () => {
  const first = { id: 'choice-a', name: 'Register', source_slug: 'register', endpoint_id: 'same', subject_id: 'a', origin: 'apiosk', price: '0.070000 USD', endpoint: { input_values: { id: '123' } } };
  const second = { ...first, id: 'choice-b', subject_id: 'b', endpoint: { input_values: { id: '456' } } };
  const state = { id: 'chat', question: 'Compare companies', status: 'sources_ready', sources: [first, second], selected: [{ source_id: 'choice-b', input: { id: '456' } }] };
  const result = presentAsk(state);
  assert.equal(result.structuredContent.source_groups.length, 1);
  assert.deepEqual(result.structuredContent.source_groups[0].rows.map(row => row.key), ['choice-a', 'choice-b']);
  assert.equal(result.structuredContent.source_groups[0].rows[1].source.endpoint.input_values.id, '456');
  assert.deepEqual(result.structuredContent.selected, state.selected);
  assert.match(result.text, /discovery, not purchased results/);
});

test('orchestrator task wrappers preserve separate answers and tables', () => {
  const state = { question: 'Check company', status: 'partial', tasks: [{ id: 'one', kind: 'endpoint', view: task }, { id: 'two', kind: 'external', view: { status: 'succeeded', result: { answer: false }, quote: { max_total_atomic: '1000', currency: 'USD' }, billing: { charged_micro_usd: 500 } } }], approval: { approval_id: 'review', max_total_atomic: '71000', currency: 'USD', quotes: [] } };
  const result = presentAsk(state);
  assert.equal(result.structuredContent.task_presentations.length, 2);
  assert.equal(result.structuredContent.results.length, 2);
  assert.ok(result.structuredContent.tables.some(table => table.id.startsWith('task:one/')));
  assert.ok(result.structuredContent.tables.some(table => table.id.startsWith('task:two/')));
  assert.match(result.text, /Quoted maximum: 0.071 USD/);
  assert.match(result.text, /Task two \(external\)/);
  assert.equal(result.structuredContent.raw, state);
});

test('missing response status is not promoted to success', () => {
  assert.equal(presentResult(saved).structuredContent.status, null);
  assert.doesNotMatch(presentResult(saved).text, /succeeded|completed/);
});

test('coverage distinguishes failure, absence and an unperformed lookup', () => {
  assert.equal(coverageLabel({ status: 'missing', reason: 'source_failed' }), 'Source unavailable');
  assert.equal(coverageLabel({ status: 'missing', reason: 'not_in_source' }), 'Not found in checked sources');
  assert.equal(coverageLabel({ status: 'missing', reason: 'ambiguous_identity' }), 'Not established');
  assert.equal(coverageLabel({ status: 'pending' }), 'Still being investigated');
});

test('saved view filters and sorts without mutating data or evidence', () => {
  const before = JSON.stringify(task);
  const view = viewSavedData(task, { table_id: 'block:sales', filter: 'Beta', columns: ['revenue', 'name'], sort: { column_id: 'revenue', direction: 'desc' } });
  assert.deepEqual(view.rows, [[10, 'Beta']]);
  assert.equal(view.evidence_rows[0][0].pointer, '/1/revenue');
  assert.deepEqual(view.row_indices, [1]);
  assert.deepEqual(view.counts, { saved: 2, matched: 1, shown: 1, offset: 0 });
  assert.equal(JSON.stringify(task), before);
  assert.throws(() => viewSavedData(task, { table_id: 'missing' }), /not found/);
  assert.throws(() => viewSavedData(task, { table_id: 'block:sales', columns: ['unknown'] }), /not found/);
});

test('chart mode requires chartable saved values and leaves values unchanged', () => {
  const view = viewSavedData(task, { table_id: 'block:sales', view: 'chart' });
  assert.equal(view.view, 'chart');
  assert.deepEqual(view.rows, [['Alpha', 0], ['Beta', 10]]);
  const fallback = viewSavedData({ data: [{ name: 'Alpha', code: '001' }] }, { view: 'chart' });
  assert.equal(fallback.view, 'table');
  assert.match(fallback.view_notice, /preserves the data/);
});

test('line chart refuses mixed periods, units, duplicate dates and invalid calendars', () => {
  const point = (period, value, unit) => ({ period: { key: period }, fact: { value, ...(unit ? { unit: { value: unit } } : {}) } });
  const raw = points => ({ analysis: { blocks: [{ id: 'trend', kind: 'line_chart', value_label: 'Value', series: [{ id: 'one', label: 'One', points }] }] } });
  for (const points of [
    [point('2024', 1), point('2024-Q1', 2)],
    [point('2024', 1, 'kg'), point('2025', 2, 'm')],
    [point('2024', 1), point('2024', 2)],
    [point('2024-02-31', 1), point('2024-03-01', 2)],
  ]) assert.equal(viewSavedData(raw(points), { view: 'chart' }).view, 'table');
  assert.equal(viewSavedData(raw([point('2024', 0), point('2025', 2)]), { view: 'chart' }).view, 'chart');
});

test('wrapper discovery preserves background context and origin errors', () => {
  const context = [{ company: 'Alpha', pages: [{ description: 'Background only.', url: 'https://example.test' }] }];
  const result = presentAsk({ discovery: { company_context: context, errors: [{ origin: 'coinbase', code: 'search_unavailable' }] } });
  assert.deepEqual(result.structuredContent.company_context, context);
  assert.match(result.text, /search_unavailable/);
});

test('CSV exports exact selected rows, safe formula strings, zeros and booleans', () => {
  const raw = { data: [{ name: '=SUM(1,2)', zero: 0, negative: -12, active: false, note: 'two\nlines' }, { name: '  +CMD', zero: null, negative: '-12', active: true, note: '"quoted"' }] };
  const csv = exportResult(raw, { format: 'csv' });
  assert.equal(csv.rowCount, 2);
  assert.match(csv.text, /"'=SUM\(1,2\)",0,-12,false/);
  assert.match(csv.text, /'  \+CMD,,'-12,true/);
  assert.match(csv.text, /"two\nlines"/);
  assert.match(csv.text, /""quoted""/);
  assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(csvCell(0), '0');
  assert.equal(csvCell(false), 'false');
  assert.equal(JSON.parse(exportResult(raw).text).data[0].name, '=SUM(1,2)');
});

test('CSV requires a table choice when the result contains distinct datasets', () => {
  assert.throws(() => exportResult(task, { format: 'csv' }), /Choose table_id/);
  const csv = exportResult(task, { format: 'csv', table_id: 'block:sales', filter: 'Alpha' });
  assert.equal(csv.rowCount, 1);
  assert.match(csv.text, /Alpha,0/);
});

test('large saved JSON fragments are not presented as a complete table', () => {
  const raw = { encoding: 'json_text', result_ref: 'large', text: '{"data":', next_offset: 8 };
  assert.deepEqual(savedTables(raw), []);
  assert.equal(presentResult(raw).structuredContent.raw.next_offset, 8);
});

test('presentation, views and exports do not contact the network', () => {
  const fetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Unexpected network request'); };
  try { presentAsk(task); presentResult(saved); viewSavedData(task); exportResult(saved, { format: 'csv' }); renderAppHtml(task); }
  finally { globalThis.fetch = fetch; }
});

test('HTML export escapes untrusted content and has no execution controls', () => {
  const html = renderAppHtml({ status: 'partial', result: { data: [{ name: '<script>alert(1)</script>' }] } });
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script|onclick=|<form|<button/);
  assert.match(html, /default-src 'none'/);
});
