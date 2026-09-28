import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerText, answerDocumentRequested } from '../src/gateway-v2-card-answer-text.mjs';
import { unwrapEnvelope, pairsToRecord, withoutPlumbing, readBlocks, isNoiseKey } from '../src/gateway-v2-card-body.mjs';
import { presentationTable } from '../src/gateway-v2-card-presentation.mjs';
import { sortTableRows, filterTableRows, blockFacts, isBlocksAnswer } from '../src/gateway-v2-card-blocks.mjs';

// Same rules as the App's Ask view: app/src/lib/domain/gateway-v2-answer.ts,
// app/src/lib/ui/answer.ts, answer-presentation.ts and answer-blocks-view.ts.

test('answer text keeps every observation under period headings, then source notes and the follow-up', () => {
  const results = [
    { result_ref: 'a', data: { fiscal_year: '2023', revenue: '1250000', currency: 'EUR' } },
    { result_ref: 'b', data: { fiscal_year: '2024', revenue: '1500000', currency: 'EUR' } },
  ];
  const analysis = {
    status: 'completed', follow_up_question: 'Compare with 2022?',
    limitations: ['Some source information is unavailable. The answer uses the available results.', 'Filed accounts are unaudited.'],
    observations: [
      { text: 'Revenue was 1250000 EUR.', evidence: [{ result_ref: 'a', pointer: '/data/revenue', value: '1250000' }] },
      { text: 'Revenue rose to 1500000 EUR.', evidence: [{ result_ref: 'b', pointer: '/data/revenue', value: '1500000' }] },
      { text: 'The filing is on time.', evidence: [] },
    ],
  };
  assert.equal(answerText(analysis, { results, question: 'How did revenue develop?' }), [
    '## Reporting period 2023', 'Revenue was € 1,250,000.', '## Reporting period 2024', 'Revenue rose to € 1,500,000.',
    '## Key findings', 'The filing is on time.', '## Source notes', 'Filed accounts are unaudited.', 'Compare with 2022?',
  ].join('\n\n'));
  assert.equal(answerText({ ...analysis, observations: analysis.observations.slice(0, 2) }, { results, question: 'Answer in one sentence.' }).startsWith('Revenue was'), true);
});

test('answer text falls back to the limitations when nothing specific remains', () => {
  const generic = 'The returned source response contains no usable records for this question. No finding can be supported from it.';
  assert.equal(answerText({ status: 'unavailable', observations: [], limitations: [generic] }, { results: [], question: '' }), generic);
  assert.equal(answerText(null, { results: [], question: '' }), '');
});

test('a report joins the answer only when a document was asked for', () => {
  assert.equal(answerDocumentRequested(null, 'Download the PDF dossier'), true);
  assert.equal(answerDocumentRequested({ presentation: { kind: 'document' } }, ''), true);
  assert.equal(answerDocumentRequested({}, 'Is the supplier active?'), false);
});

test('the reader peels envelopes, reads key/value pairs as records and hides plumbing', () => {
  assert.deepEqual(unwrapEnvelope({ requestId: 'x', data: { items: [1, 2] } }), [1, 2]);
  assert.deepEqual(unwrapEnvelope({ data: [1], meta: { total: 1 } }), { data: [1], meta: { total: 1 } });
  assert.deepEqual(pairsToRecord([{ key: 'FinancialYear', value: '2024' }, { key: 'BalanceSheet', opendataFields: [{ key: 'Assets', value: 5 }] }]), { FinancialYear: '2024', BalanceSheet: { Assets: 5 } });
  assert.equal(pairsToRecord([{ name: 'Ada', id: 1 }]), null);
  assert.deepEqual(withoutPlumbing({ id: 'x', user_id: 'y', name: 'Ada', links: { self: { href: 'https://api.example/x' } }, valid: true }), { name: 'Ada', valid: true });
  assert.deepEqual(withoutPlumbing({ id: 'x', uuid: 'y' }), { id: 'x', uuid: 'y' }, 'a record of only identifiers is drawn whole');
  assert.equal(isNoiseKey('valid'), false);
  assert.deepEqual(readBlocks('## Findings\n\nOne line\nsecond line\n- a\n- b\n1. c'), [
    { kind: 'heading', text: 'Findings', level: 2 }, { kind: 'paragraph', text: 'One line\nsecond line' },
    { kind: 'bullets', items: ['a', 'b'] }, { kind: 'numbers', items: ['c'] },
  ]);
});

test('presentation tables format cited values in the answer locale and blocks sort nulls last', () => {
  const table = presentationTable({ kind: 'table', title: 'Omzet', columns: [{ value: 'Year' }, { value: 'Omzet' }, { value: 'Valuta' }], rows: [[{ value: 2024 }, { value: '1250000', result_ref: 'a', pointer: '/data/omzet' }, { value: 'EUR' }]], returned_count: 4 }, [{ result_ref: 'a', data: { omzet: '1250000' } }], 'nl-NL');
  assert.deepEqual(table.displayRows, [['2024', '€ 1.250.000', 'EUR']]);
  assert.equal(table.note, '1 selected from 4 returned records. This is not necessarily the complete search.');
  const columns = [{ id: 'n' }, { id: 'v' }], rows = [{ cells: [{ value: 'b' }, { value: null }] }, { cells: [{ value: 'a' }, { value: 3 }] }, { cells: [{ value: 'c' }, { value: 7 }] }];
  assert.deepEqual(sortTableRows(columns, rows, { column_id: 'v', direction: 'asc' }).map(r => r.cells[0].value), ['a', 'c', 'b']);
  assert.deepEqual(filterTableRows(rows, ' C ').map(r => r.cells[0].value), ['c']);
  assert.deepEqual(blockFacts({ kind: 'future_kind' }), []);
  assert.equal(isBlocksAnswer({ answer_schema_version: 2, blocks: [] }), true);
  assert.equal(isBlocksAnswer({ blocks: [] }), false);
});
