import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePage, resultWithPages, SAVED_RESULT_CHARACTER_LIMIT } from '../src/saved-pages.mjs';
import { exportResult } from '../src/exports.mjs';

const ref = 'saved-company';
const envelope = { result_ref: ref, coverage: 'source_response', source: { provider: 'register', name: 'Register', retrieved_at: '2026-10-23T10:00:00Z' }, data: [{ name: '😀 Lee', count: 0, active: false }], charged_atomic: '70000' };
const fragment = (text, next_offset) => ({ result_ref: ref, encoding: 'json_text', text, next_offset });
const page = result => ({ state: { state_ref: 'task', revision: 2 }, status: 'succeeded', errors: [], result });
const freshTask = initial => ({ id: 'task', kind: 'endpoint', view: { state: { state_ref: 'task', revision: 2 }, status: 'succeeded', context_view: { results: initial ? [initial] : [] }, result: initial ?? null, next_actions: [{ action_id: ref, kind: 'read_result', requires_authorization: false }] } });
const chars = text => Array.from(text).length;
function split() {
  const text = JSON.stringify(envelope), pivot = text.indexOf('😀') + 2;
  return [text.slice(0, pivot), text.slice(pivot)];
}

test('Unicode character offsets assemble a matching saved envelope without changing the Gateway view', () => {
  const [first, last] = split(), task = freshTask(), original = structuredClone(task.view);
  assert.equal(chars(first), first.length - 1);
  assert.deepEqual(capturePage(task, page(fragment(first, chars(first))), { action_id: ref }), { complete: false, result_ref: ref, next_offset: chars(first), pages: 1, received_until: chars(first) });
  assert.equal(task.saved_results, undefined);
  const result = capturePage(task, page(fragment(last, null)), { action_id: ref, offset: chars(first) });
  assert.equal(result.complete, true);
  assert.deepEqual(task.saved_results[ref], envelope);
  assert.deepEqual(task.view, original);
  assert.deepEqual(resultWithPages(task).context_view.results[0], envelope);
});

test('the already saved first fragment is reused for the next read', () => {
  const [first, last] = split(), initial = { ...fragment(first, chars(first)), source: envelope.source, coverage: 'source_response' }, task = freshTask(initial);
  capturePage(task, page(fragment(last, null)), { action_id: ref, offset: chars(first) });
  const view = resultWithPages(task);
  assert.deepEqual(view.context_view.results[0], envelope);
  assert.deepEqual(view.result, envelope);
  assert.equal(task.view.result.encoding, 'json_text');
  const csv = exportResult(view, { format: 'csv' });
  assert.match(csv.text, /😀 Lee,0,false/);
});

test('invalid identity, conflict, stale revision and invalid final JSON never mutate prior pages', () => {
  const task = freshTask();
  capturePage(task, page(fragment('{', 1)), { action_id: ref });
  const before = structuredClone(task);
  const cases = [
    { ...page(fragment('x', 2)), state: { state_ref: 'other', revision: 2 } },
    { ...page(fragment('x', 2)), status: 'state_conflict' },
    { ...page(fragment('x', 2)), state: { state_ref: 'task', revision: 1 } },
    page({ ...fragment('x', 2), result_ref: 'unrelated' }),
    page(fragment('}', null)),
    { ...page(null), errors: [{ code: 'read_failed' }] },
  ];
  for (const response of cases) {
    assert.throws(() => capturePage(task, response, { action_id: ref, offset: 1 }));
    assert.deepEqual(task, before);
  }
});

test('valid matching pages retain independent sibling task errors', () => {
  const task = freshTask();
  task.view.errors = [{ code: 'sibling_source_failed', message: 'Another source failed.' }];
  capturePage(task, { ...page(fragment(JSON.stringify(envelope), null)), status: 'partial', errors: task.view.errors }, { action_id: ref });
  assert.deepEqual(task.saved_results[ref], envelope);
  assert.equal(task.view.errors[0].code, 'sibling_source_failed');
});

test('repeated identical pages are idempotent but changed or overlapping pages are rejected', () => {
  const task = freshTask(), response = page(fragment('{"result_ref":', 14));
  capturePage(task, response, { action_id: ref });
  const before = structuredClone(task);
  capturePage(task, response, { action_id: ref });
  assert.deepEqual(task, before);
  assert.throws(() => capturePage(task, page(fragment('another-source', 14)), { action_id: ref }), /changed/);
  assert.throws(() => capturePage(task, page(fragment('x', 2)), { action_id: ref, offset: 1 }), /overlap/);
  assert.deepEqual(task, before);
});

test('bounded noncontiguous pages wait for the missing prefix before exposing data', () => {
  const [first, last] = split(), task = freshTask();
  const missing = capturePage(task, page(fragment(last, null)), { action_id: ref, offset: chars(first) });
  assert.equal(missing.complete, false);
  assert.equal(missing.next_offset, 0);
  assert.equal(task.saved_results, undefined);
  capturePage(task, page(fragment(first, chars(first))), { action_id: ref });
  assert.deepEqual(task.saved_results[ref], envelope);
});

test('page size, offsets, incomplete JSON and unauthorized actions are rejected', () => {
  for (const [result, offset] of [[fragment('x'.repeat(8001), 8001), 0], [fragment('x', 2), 0], [fragment('', null), 0], [fragment('x', null), SAVED_RESULT_CHARACTER_LIMIT], [fragment('{}', null), 0]]) {
    const task = freshTask(); assert.throws(() => capturePage(task, page(result), { action_id: ref, offset })); assert.equal(task.pages, undefined);
  }
  const task = freshTask(); task.view.next_actions[0].requires_authorization = true;
  assert.throws(() => capturePage(task, page(envelope), { action_id: ref }), /read-only/);
});

test('page-count limit and data after a final fragment do not overwrite saved data', () => {
  const task = freshTask();
  for (let index = 0; index < 64; index++) capturePage(task, page(fragment('x', index + 1)), { action_id: ref, offset: index });
  const before = structuredClone(task);
  assert.throws(() => capturePage(task, page(fragment('x', 65)), { action_id: ref, offset: 64 }), /page limit/);
  assert.deepEqual(task, before);
  const complete = freshTask(), text = JSON.stringify(envelope);
  capturePage(complete, page(fragment(text, null)), { action_id: ref });
  const original = structuredClone(complete);
  assert.throws(() => capturePage(complete, page(fragment('x', chars(text) + 11)), { action_id: ref, offset: chars(text) + 10 }), /final fragment/);
  assert.deepEqual(complete, original);
});

test('complete small results can be read, but a foreign ref cannot overwrite them', () => {
  const task = freshTask({ result_ref: ref, coverage: 'partial' });
  capturePage(task, page(envelope), { action_id: ref });
  const before = structuredClone(task.saved_results);
  assert.throws(() => capturePage(task, page({ ...envelope, result_ref: 'foreign' }), { action_id: ref }));
  assert.deepEqual(task.saved_results, before);
  assert.deepEqual(resultWithPages(task).result.data, envelope.data);
});

test('fresh metadata updates coverage without losing the fully read body or richer provenance', () => {
  const initial = { result_ref: ref, coverage: 'partial', source: { provider: 'register' } }, task = freshTask(initial);
  capturePage(task, page(envelope), { action_id: ref });
  assert.equal(resultWithPages(task).result.source.retrieved_at, envelope.source.retrieved_at);
  task.view.result.coverage = 'source_response';
  task.view.context_view.results[0].coverage = 'source_response';
  task.view.result.missing_fields = ['financials'];
  const view = resultWithPages(task);
  assert.equal(view.result.coverage, 'source_response');
  assert.deepEqual(view.result.missing_fields, ['financials']);
  assert.deepEqual(view.result.data, envelope.data);
  assert.equal(view.result.source.retrieved_at, envelope.source.retrieved_at);
});
