import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectInputs } from '../src/source-inputs.mjs';

const field = (name, schema, required = true) => ({ field: name, required, schema });
const descriptor = inputs => ({ inputs });
const registry = field('company_registry.kvknummer', { type: 'string', pattern: '^[0-9]{8}$' });

test('merges canonical defaults with explicit overrides while preserving false, zero and literal field names', () => {
  const source = { endpoint: { input_values: { enabled: true, count: 12, 'company.name': 'Old' } }, input_values: { count: 4 } };
  const d = descriptor([field('enabled', { type: 'boolean' }), field('count', { type: 'integer' }), field('company.name', { type: 'string' })]);
  const result = inspectInputs(source, d, { enabled: false, count: 0, 'company.name': 'Mollie' });
  assert.deepEqual(result, { input: { enabled: false, count: 0, 'company.name': 'Mollie' }, missing: [], errors: [], ready: true });
  assert.equal(source.endpoint.input_values.enabled, true);
  assert.equal(inspectInputs(source, d).input.count, 4);
});

test('missing input returns the complete published schema without inventing values or using schema defaults', () => {
  const d = descriptor([{ ...registry, title: 'KVK number' }, field('limit', { type: 'integer', default: 10 }, false)]);
  const result = inspectInputs({ name: 'Mollie B.V.' }, d);
  assert.deepEqual(result.input, {});
  assert.deepEqual(result.missing, [d.inputs[0]]);
  assert.equal(result.ready, false);
});

test('valid lookup satisfies exactly the fields it resolves; invalid lookup does not', () => {
  const d = { inputs: [registry, field('country', { const: 'NL' })], lookup: { field: 'company.name', resolves: [registry.field], schema: { type: 'string', minLength: 2 } } };
  const result = inspectInputs({}, d, { 'company.name': 'Mollie', country: 'NL', [registry.field]: '' });
  assert.deepEqual(result.input, { 'company.name': 'Mollie', country: 'NL' });
  assert.equal(result.ready, true);
  const invalid = inspectInputs({}, d, { 'company.name': 12 });
  assert.deepEqual(invalid.missing, d.inputs);
  assert.ok(invalid.errors.some(error => error.field === 'company.name' && error.keyword === 'type'));
});

test('a valid lookup cannot hide an invalid explicitly supplied resolved identifier', () => {
  const d = { inputs: [registry], lookup: { field: 'company.name', resolves: [registry.field], schema: { type: 'string' } } };
  const result = inspectInputs({}, d, { 'company.name': 'Mollie', [registry.field]: 'wrong' });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some(error => error.field === registry.field));
});

test('validates nested objects, arrays, enums, and required properties without coercion', () => {
  const d = descriptor([field('request', { type: 'object', required: ['limit', 'tags'], additionalProperties: false, properties: {
    limit: { type: 'integer', minimum: 0 }, tags: { type: 'array', minItems: 1, items: { enum: ['active'] } },
  } })]);
  assert.equal(inspectInputs({}, d, { request: { limit: 0, tags: ['active'] } }).ready, true);
  const value = { request: { limit: '0', tags: ['inactive'], extra: true } };
  const result = inspectInputs({}, d, value);
  assert.equal(result.ready, false);
  assert.equal(result.errors.length, 3);
  assert.equal(value.request.limit, '0');
  assert.equal(value.request.extra, true);
});

test('blank required values erase defaults and remain missing, while optional nullable values survive', () => {
  const d = descriptor([registry, field('note', { type: ['string', 'null'] }, false)]);
  for (const value of ['', '   ', null, [], undefined]) {
    const result = inspectInputs({ input_values: { [registry.field]: '30204462' } }, d, { [registry.field]: value, note: null });
    assert.deepEqual(result.missing, [registry]);
    assert.deepEqual(result.input, { note: null });
    assert.equal(result.ready, false);
  }
});

test('object overrides replace complete field values instead of resurrecting old nested data', () => {
  const d = descriptor([field('address', { type: 'object', required: ['city', 'country'], properties: { city: { type: 'string' }, country: { type: 'string' } } })]);
  const result = inspectInputs({ input_values: { address: { city: 'Amsterdam', country: 'NL' } } }, d, { address: { city: 'Paris' } });
  assert.deepEqual(result.input.address, { city: 'Paris' });
  assert.equal(result.ready, false);
  assert.ok(result.errors.some(error => error.keyword === 'required'));
});

test('unknown input names are preserved and rejected, including a nested alternative to a dotted field', () => {
  const result = inspectInputs({}, descriptor([registry]), { company_registry: { kvknummer: '30204462' } });
  assert.deepEqual(result.missing, [registry]);
  assert.equal(result.errors[0].code, 'unknown_input');
  assert.equal(result.input.company_registry.kvknummer, '30204462');
});

test('malformed descriptors, schemas, lookup descriptors and explicit maps fail closed', () => {
  for (const d of [undefined, {}, { inputs: [null] }, descriptor([field('x', { type: 'imaginary' })]), descriptor([field('x', undefined)]), { inputs: [], lookup: { field: 'name', resolves: 'id', schema: {} } }]) {
    const result = inspectInputs({}, d, {});
    assert.equal(result.ready, false);
    assert.ok(result.errors.length > 0);
  }
  for (const value of [null, [], 'hello', 0]) {
    assert.equal(inspectInputs({}, descriptor([]), value).ready, false);
  }
});

test('boolean schemas and no-input endpoints remain supported', () => {
  assert.equal(inspectInputs({}, descriptor([])).ready, true);
  assert.equal(inspectInputs({}, descriptor([field('anything', true)]), { anything: false }).ready, true);
  assert.equal(inspectInputs({}, descriptor([field('nothing', false)]), { nothing: 0 }).ready, false);
});

test('literal prototype-like keys cannot mutate the returned object prototype', () => {
  const values = JSON.parse('{"__proto__":"value"}');
  const result = inspectInputs({}, descriptor([field('__proto__', { type: 'string' })]), values);
  assert.equal(result.ready, true);
  assert.equal(Object.getPrototypeOf(result.input), Object.prototype);
  assert.equal(Object.hasOwn(result.input, '__proto__'), true);
  assert.equal(result.input.__proto__, 'value');
});
