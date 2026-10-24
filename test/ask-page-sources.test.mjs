import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { projectAskSources, groupSourceItems, sourceItemKey, purchaseInputKey, sourceSummary } from '../src/ask-page-sources.mjs';

// Public question + public catalog metadata only. No signed search IDs,
// credentials, task state, purchases or private account data are retained.
const mollie = JSON.parse(await readFile(new URL('./fixtures/ask-page-mollie-public.json', import.meta.url), 'utf8'));
const candidate = (changes = {}) => ({ origin: 'apiosk', name: 'Fixture register', source_slug: 'fixture',
  description: 'Retrieve the registered company profile.', endpoint_id: 'endpoint-a', capability: 'company.profile',
  subject_id: 'company-a', availability: 'supported', price: '0.070000 USD',
  endpoint: { input_values: { 'company.name': 'Alpha' } }, ...changes });
const discovery = (local, external = [], options = []) => ({
  parsed_request: { subjects: [{ id: 'company-a', label: 'Alpha' }] },
  searches: { apiosk: { matches: [{ slug: 'company.profile', subject_id: 'company-a', query: 'Alpha', apiosk: local }] },
    coinbase: { matches: [{ slug: 'company.profile', subject_id: 'company-a', query: 'Alpha', coinbase: external }] } },
  source_options: options,
});

test('exact public Mollie question projects the same nine Ask rows from 25 offered options', () => {
  const before = structuredClone(mollie), sources = projectAskSources(mollie);
  assert.equal(mollie.source_options.length, 25);
  assert.equal(sources.length, 9);
  assert.deepEqual(sources.map(source => source.name), [
    'KVK Business Register', 'KVK Business Register', 'Overheid.io Public Data', 'Overheid.io Public Data',
    'Sirenic', 'Sirenic', 'OpenSanctions', 'CompliancePulse', 'TradePulse',
  ]);
  assert.deepEqual(groupSourceItems(sources).slice(0, 3).map(group => [group.sources[0].name, group.sources.length]),
    [['KVK Business Register', 2], ['Overheid.io Public Data', 2], ['Sirenic', 2]]);
  assert.equal(sources.some(source => /Crunchbase|GLEIF|OpenWeb|StableEnrich|FilingsPulse|ESGPulse|OFAC Sanctions Name Screen/.test(source.name)), false);
  const raw = mollie.searches.apiosk.matches.flatMap(match => match.apiosk);
  assert.deepEqual(sources.map(source => [source.endpoint_id, source.capability, source.subject_id, purchaseInputKey(source), source.price]),
    raw.map(source => [source.endpoint_id, source.capability, source.subject_id, purchaseInputKey(source), source.price]));
  assert.ok(sources.slice(0, 8).every(source => source.logo_url || source.endpoint?.source?.logo_url));
  assert.deepEqual(mollie, before, 'Presentation must not rewrite the signed discovery input');
});

test('App purchase filtering keeps local unverified endpoints but rejects unsupported external discovery', () => {
  const local = [candidate({ endpoint_id: 'unverified', availability: 'unverified' }),
    candidate({ endpoint_id: 'directory', availability: 'discovery_only' }), candidate({ endpoint_id: null })];
  const external = ['supported', 'unverified', 'discovery_only'].map(availability => ({ origin: 'coinbase', name: availability,
    availability, url: 'https://provider.example/data', method: 'GET', price: '0.010000 USD' }));
  external.push({ ...external[0], name: 'credential-bearing', url: 'https://user:secret@provider.example/data' },
    { ...external[0], name: 'insecure', url: 'http://provider.example/data' });
  assert.deepEqual(projectAskSources(discovery(local, external)).map(source => source.name), ['Fixture register', 'supported']);
});

test('App dedup removes equivalent endpoint descriptions while preserving price, subject and inputs', () => {
  const a = candidate(), duplicateInputOrder = candidate({ endpoint: { input_values: { 'company.name': 'Alpha' } } });
  const equivalentEndpoint = candidate({ endpoint_id: 'endpoint-b' });
  const differentInput = candidate({ endpoint: { input_values: { 'company.name': 'Beta' } } });
  const differentSubject = candidate({ subject_id: 'company-b' });
  const differentPrice = candidate({ endpoint_id: 'endpoint-price', price: '0.080000 USD' });
  const rows = projectAskSources(discovery([a, duplicateInputOrder, equivalentEndpoint, differentInput, differentSubject, differentPrice]));
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(sourceItemKey)).size, 4);
  assert.equal(groupSourceItems(rows).length, 1, 'Provider grouping does not discard distinct selections');
});

test('offered metadata enriches only the exact endpoint, capability, subject and input identity', () => {
  const alpha = candidate({ endpoint: { input_values: { 'company.name': 'Alpha' } } });
  const beta = candidate({ endpoint: { input_values: { 'company.name': 'Beta' } } });
  const options = [beta, alpha].map(source => ({ source: { ...source, endpoint: undefined }, subject_id: source.subject_id,
    input_values: source.endpoint.input_values,
    endpoint: { endpoint_id: source.endpoint_id, source: { logo_url: `https://provider.example/${source.endpoint.input_values['company.name']}.png` },
      inputs: [{ field: 'company.name', schema: { type: 'string' } }] } }));
  const rows = projectAskSources(discovery([alpha, beta], [], options));
  assert.deepEqual(rows.map(source => source.logo_url), ['https://provider.example/Alpha.png', 'https://provider.example/Beta.png']);
  assert.deepEqual(rows.map(purchaseInputKey), [purchaseInputKey(alpha), purchaseInputKey(beta)]);
  assert.ok(rows.every(source => source.endpoint.inputs[0].field === 'company.name'));
  const mismatched = projectAskSources(discovery([alpha], [], [options[0]]));
  assert.equal(mismatched[0].logo_url, undefined, 'A different input selection cannot supply this row’s metadata');
});

test('empty authoritative matches stay empty even with flattened APIs or related offered options', () => {
  const result = discovery([], [], [{ source: candidate(), endpoint: { endpoint_id: 'endpoint-a' } }]);
  result.apis = [candidate()];
  assert.deepEqual(projectAskSources(result), []);
  assert.equal(projectAskSources({ apis: [candidate()] }).length, 1, 'Older payloads without a matches field keep their flattened matched candidates');
});

test('row descriptions use the App first-clause, acronym and 90-character rules', () => {
  assert.equal(sourceSummary(candidate({ description: 'Retrieve the profile. Includes other fields.' })), 'Retrieve the profile');
  assert.equal(sourceSummary(candidate({ description: 'Fixture register', capability: 'area.cbs-neighbourhood-2025' })), 'CBS neighbourhood 2025');
  const summary = sourceSummary(candidate({ description: 'Retrieve the complete official registration record for one company, including names and registered identifiers across all current locations' }));
  assert.ok(summary.length <= 91); assert.ok(summary.endsWith('…'));
});
test('legacy top-level input values cannot be enriched with another offered input identity', () => {
  const source = { origin: 'apiosk', name: 'Register', source_slug: 'register', endpoint_id: 'profile', capability: 'company.profile',
    subject_id: 'company', availability: 'supported', input_values: { company: 'Alpha' }, endpoint: {} };
  const option = { source: { endpoint_id: 'profile', capability: 'company.profile' }, subject_id: 'company',
    input_values: { company: 'Beta' }, endpoint: { source: { logo_url: 'https://example.test/other.png' },
      inputs: [{ field: 'company', required: true, schema: { type: 'string' } }] } };
  const found = { apis: [source], source_options: [option] };
  const before = structuredClone(found);
  const [mismatched] = projectAskSources(found);
  assert.deepEqual(mismatched.input_values, { company: 'Alpha' });
  assert.equal(mismatched.endpoint.input_values, undefined);
  assert.equal(mismatched.logo_url, undefined, 'Do not borrow descriptor metadata from a different input identity');
  assert.deepEqual(found, before);
  option.input_values = { company: 'Alpha' };
  const [matched] = projectAskSources(found);
  assert.deepEqual(matched.endpoint.input_values, { company: 'Alpha' });
  assert.deepEqual(matched.input_values, matched.endpoint.input_values);
  assert.equal(matched.endpoint.inputs[0].field, 'company');
});
