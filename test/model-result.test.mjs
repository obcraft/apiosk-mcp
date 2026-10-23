import test from 'node:test';
import assert from 'node:assert/strict';
import { modelResult, MAX_MODEL_RESULT_BYTES } from '../dev/model-result.mjs';
import { completion } from '../dev/model.mjs';

test('large discovery schemas stay in the UI while exact source and approval identity reach the model', () => {
  const approval = { approval_id: 'approval-exact', currency: 'USD', max_total_atomic: '21739', expires_at: '2099-01-01T00:00:00Z',
    quotes: [{ task_id: 'task-exact', quote_ref: 'quote-exact', max_total_atomic: '21739', currency: 'USD' }] };
  const source = { id: 'source-exact', key: 'source-exact', origin: 'apiosk', name: 'Official register', availability: 'supported',
    buyer_price: { currency: 'USD', total_atomic: '21739' }, input_values: { enabled: false, offset: 0 }, missing_inputs: ['company_id'],
    endpoint: { schema: 'duplicate-schema'.repeat(10000) }, source: { nested: 'duplicate-schema'.repeat(10000) } };
  const structuredContent = { schema_version: 'apiosk.ask.presentation.v1', request_id: 'request-exact', status: 'requires_approval', approval,
    sources: [source], source_groups: [{ sources: [source] }], raw: { signed_state: 'do-not-forward', sources: [source] }, searches: { duplicate: source },
    coverage: { checked: 0, complete: false }, errors: [], next_step: 'Review this total.' };
  const full = { structuredContent, _meta: { apiosk_card_data: structuredContent, secret: 'host-only' } };
  const before = JSON.stringify(full), text = modelResult(full), projected = JSON.parse(text).structuredContent;
  assert.ok(Buffer.byteLength(text) < 6000);
  assert.deepEqual(projected.approval, approval);
  assert.equal(projected.request_id, 'request-exact');
  assert.equal(projected.sources[0].id, 'source-exact');
  assert.deepEqual(projected.sources[0].input_values, { enabled: false, offset: 0 });
  assert.deepEqual(projected.sources[0].missing_inputs, ['company_id']);
  assert.deepEqual(projected.coverage, { checked: 0, complete: false });
  assert.doesNotMatch(text, /duplicate-schema|signed_state|do-not-forward|host-only|apiosk_card_data/);
  assert.equal(JSON.stringify(full), before, 'projection never modifies full UI or saved evidence');
});

test('oversized saved values are visibly incomplete and stay within the model budget', () => {
  const full = { structuredContent: { request_id: 'saved-request', status: 'finished',
    results: Array.from({ length: 300 }, (_, index) => ({ index, value: 'x'.repeat(10000) })),
    evidence: [{ result_ref: 'result-1', pointer: '/items/0/value', value: 0 }], errors: [] } };
  const text = modelResult(full), view = JSON.parse(text);
  assert.ok(Buffer.byteLength(text) <= MAX_MODEL_RESULT_BYTES);
  assert.equal(view.structuredContent.request_id, 'saved-request');
  assert.equal(view.structuredContent.evidence[0].value, 0);
  assert.equal(view.model_context.incomplete_view, true);
  assert.match(view.model_context.note, /Do not infer facts from omitted values/);
  assert.equal(full.structuredContent.results.length, 300);
});

test('binary resources are not pasted into model context', () => {
  const text = modelResult({ content: [{ type: 'resource', resource: { uri: 'apiosk://artifacts/saved', mimeType: 'application/pdf', blob: 'SECRETBASE64'.repeat(10000) } }] });
  assert.match(text, /apiosk:\/\/artifacts\/saved/);
  assert.doesNotMatch(text, /SECRETBASE64/);
  assert.equal(JSON.parse(text).model_context.incomplete_view, true);
});

test('context overflow is classified without exposing the upstream error body', async () => {
  await assert.rejects(completion({ key: 'private-key', model: 'fixture', messages: [], tools: [],
    fetchImpl: async () => Response.json({ error: { message: 'Maximum context length is 131072 tokens. private-key sensitive payload' } }, { status: 400 }),
  }), error => /context limit reached \(HTTP 400\)/.test(error.message) && !error.message.includes('private-key') && !error.message.includes('sensitive payload'));
});

test('other request errors do not falsely blame balance and do not leak provider details', async () => {
  await assert.rejects(completion({ key: 'private-key', model: 'fixture', messages: [], tools: [],
    fetchImpl: async () => Response.json({ error: { message: 'Bad tools: private-key raw body' } }, { status: 400 }),
  }), error => /request format/.test(error.message) && !/balance|private-key|raw body/.test(error.message));
});
