import Ajv from 'ajv';

// Match the published field schemas without filling defaults, coercing types,
// or deleting properties. The Gateway remains authoritative for formats.
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false, ownProperties: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hasValue = value => value !== undefined && value !== null
  && !(typeof value === 'string' && value.trim() === '')
  && !(Array.isArray(value) && !value.some(hasValue));
const owns = (value, key) => Object.hasOwn(value, key);

/**
 * Inspect selected source input before a quote is prepared. Field names are
 * literal semantic keys: `company.name` never becomes `{company: {name: ...}}`.
 * Missing fields retain their complete descriptor, including the JSON schema.
 */
export function inspectInputs(source, descriptor, explicitInput) {
  const input = {};
  const missing = [];
  const errors = [];
  for (const [label, values] of [
    ['endpoint.input_values', source?.endpoint?.input_values],
    ['input_values', source?.input_values],
    ['explicitInput', explicitInput],
  ]) {
    if (values === undefined || (values === null && label !== 'explicitInput')) continue;
    if (!object(values)) {
      errors.push({ field: null, code: 'invalid_input', message: `${label} must be an object.` });
      continue;
    }
    for (const [key, value] of Object.entries(values)) {
      Object.defineProperty(input, key, { value, enumerable: true, writable: true, configurable: true });
    }
  }
  if (!object(descriptor) || !Array.isArray(descriptor.inputs)) {
    errors.push({ field: null, code: 'invalid_descriptor', message: 'The source descriptor must include an inputs array.' });
    return { input, missing, errors, ready: false };
  }

  const fields = new Map();
  for (const field of descriptor.inputs) {
    if (!object(field) || typeof field.field !== 'string' || field.field.length === 0 || fields.has(field.field)) {
      errors.push({ field: field?.field ?? null, code: 'invalid_descriptor', message: 'Input field names must be nonempty and unique.' });
      continue;
    }
    fields.set(field.field, field);
  }
  const lookup = descriptor.lookup;
  const validLookup = lookup == null || (object(lookup) && typeof lookup.field === 'string' && lookup.field.length > 0
    && Array.isArray(lookup.resolves) && lookup.resolves.every(field => typeof field === 'string'));
  if (!validLookup) errors.push({ field: null, code: 'invalid_descriptor', message: 'The source lookup descriptor is invalid.' });

  function validate(field, schema) {
    if (!(object(schema) || typeof schema === 'boolean')) {
      errors.push({ field, code: 'invalid_schema', message: 'The field descriptor must include a JSON schema.' });
      return false;
    }
    let validator;
    try { validator = ajv.compile(schema); }
    catch {
      errors.push({ field, code: 'invalid_schema', message: 'The field JSON schema cannot be validated.' });
      return false;
    }
    if (!owns(input, field)) return true;
    if (validator(input[field])) return true;
    for (const error of validator.errors ?? []) errors.push({
      field, code: 'invalid_value', message: error.message ?? 'The value does not match the field schema.',
      instancePath: error.instancePath, keyword: error.keyword,
    });
    return false;
  }

  // Empty required fields represent an unanswered form field. Removing them
  // also lets an explicitly supplied valid lookup replace a blank identifier.
  for (const field of fields.values()) {
    if (field.required && !hasValue(input[field.field])) delete input[field.field];
  }
  if (validLookup && lookup && !hasValue(input[lookup.field])) delete input[lookup.field];
  let resolved = new Set();
  if (validLookup && lookup) {
    const valid = validate(lookup.field, lookup.schema);
    if (valid && hasValue(input[lookup.field])) resolved = new Set(lookup.resolves);
  }
  for (const field of fields.values()) {
    validate(field.field, field.schema);
    if (field.required && !hasValue(input[field.field]) && !resolved.has(field.field)) missing.push({ ...field });
  }
  for (const field of Object.keys(input)) {
    if (!fields.has(field) && !(validLookup && lookup?.field === field)) {
      errors.push({ field, code: 'unknown_input', message: 'The source descriptor does not accept this input field.' });
    }
  }
  return { input, missing, errors, ready: missing.length === 0 && errors.length === 0 };
}
