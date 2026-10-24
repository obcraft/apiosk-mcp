import test from 'node:test';
import assert from 'node:assert/strict';
import { discoveryCoverage } from '../src/ask-discovery-coverage.mjs';

const cap = (slug, subject_id = 's1', extra = {}) => ({ slug, subject_id, name: slug, description: `Retrieve ${slug}`, source_hint: null, ...extra });
const row = (slug, apiosk = [], coinbase = [], extra = {}) => ({ slug, apiosk, coinbase, coinbase_status: 'ready', ...extra });
const native = (subject_id = 's1') => ({ origin: 'apiosk', name: 'Test source', endpoint_id: 'test-endpoint', availability: 'supported', subject_id });
const found = (capabilities, local, external, errors = []) => ({ parsed_request: { subjects: [{ id: 's1', label: 'Mollie B.V.' }, { id: 's2', label: 'Other B.V.' }], capabilities },
  searches: { apiosk: { matches: local }, coinbase: { matches: external } }, errors });

test('a missing requested registry remains a coverage gap even when related options and sanctions exist', () => {
  const input = found([cap('company.profile.retrieve', 's1', { description: 'Registered company profile', source_hint: 'dutch chamber of commerce' }), cap('compliance.sanctions.screen')],
    [row('company.profile.retrieve'), row('compliance.sanctions.screen', [native()])],
    [row('company.profile.retrieve'), row('compliance.sanctions.screen')]);
  input.source_options = [{ source: { ...native(), name: 'KVK Business Register' } }];
  const before = structuredClone(input), result = discoveryCoverage(input);
  assert.deepEqual(result.gaps.map(gap => [gap.capability, gap.status]), [['company.profile.retrieve', 'unmatched']]);
  assert.equal(result.gaps[0].subject_label, 'Mollie B.V.');
  assert.equal(result.gaps[0].source_hint, 'dutch chamber of commerce');
  assert.equal(result.gaps[0].notice, 'No matching sources found: Registered company profile · Mollie B.V. · requested source: dutch chamber of commerce.');
  assert.equal(result.requirements[1].status, 'matched');
  assert.deepEqual(input, before, 'Coverage never rewrites the parse or injects related options');
});

test('an origin failure or missing search is not reported as a definitive empty match', () => {
  const incomplete = discoveryCoverage(found([cap('company.profile')], [row('company.profile')], [], [{ origin: 'coinbase', code: 'search_unavailable' }]));
  assert.equal(incomplete.gaps[0].status, 'incomplete');
  assert.match(incomplete.gaps[0].notice, /Source search is incomplete/);
  assert.doesNotMatch(incomplete.gaps[0].notice, /No matching sources/);
  const unknown = discoveryCoverage({ parsed_request: { capabilities: [cap('company.profile')] } });
  assert.equal(unknown.requirements[0].status, 'unknown');
  assert.deepEqual(unknown.gaps, []);
  const pending = discoveryCoverage(found([cap('company.profile')], [row('company.profile')], [row('company.profile', [], [], { coinbase_status: 'pending' })]));
  assert.equal(pending.gaps[0].status, 'incomplete');
});

test('external matches count and discovery-only listings are distinguished from selectable sources', () => {
  const candidate = { name: 'External', availability: 'supported', url: 'https://fixture.example/data' };
  const input = found([cap('company.profile')], [row('company.profile')], [row('company.profile', [], [candidate])]);
  assert.equal(discoveryCoverage(input).requirements[0].status, 'matched');
  candidate.availability = 'discovery_only';
  assert.equal(discoveryCoverage(input).gaps[0].status, 'unavailable');
});

test('repeated capability rows retain subject occurrence and collapsed responses remain uncertain', () => {
  const input = found([cap('company.profile'), cap('company.profile', 's2')],
    [row('company.profile', [native()]), row('company.profile')], [row('company.profile'), row('company.profile')]);
  let result = discoveryCoverage(input);
  assert.equal(result.requirements[0].status, 'matched');
  assert.equal(result.gaps[0].subject_label, 'Other B.V.');
  assert.equal(result.gaps[0].status, 'unmatched');
  input.searches.coinbase.matches.pop();
  result = discoveryCoverage(input);
  assert.equal(result.gaps[0].status, 'incomplete');
});

test('answer-only and conversational capabilities are not presented as missing sources', () => {
  const input = found([cap('general.conversation'), cap('answer.compare')],
    [row('answer.compare', [], [], { answer_only: true })], [row('answer.compare', [], [], { answer_only: true })]);
  assert.deepEqual(discoveryCoverage(input).requirements, []);
});
