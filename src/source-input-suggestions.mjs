import Ajv from 'ajv';

const ajv = new Ajv({ strict: false, validateFormats: false, ownProperties: true });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim() !== '';
const semanticField = field => field.replace(/^source[._]input[._][a-f0-9]{16,64}[._]/i, '').replace(/^(path|query|body)\./, '');
const companyTypes = new Set(['company', 'organization', 'organisation']);
const companyNames = new Set(['company.name', 'company.registered_name', 'company.legal_name', 'organization.name', 'organisation.name', 'company_name', 'organization_name', 'organisation_name']);
const personNames = new Set(['person.name', 'person.full_name', 'person_name', 'full_name']);
const entityNames = new Set(['entity.name', 'entity_name']);
const literalKeys = new Set(['kvknummer', 'kvk_number', 'lei', 'isin', 'vat_number', 'postal_code', 'postcode']);
const identifierAliases = new Map([['company_registry.kvknummer', new Set(['company_registry.kvknummer', 'kvknummer', 'kvk_number'])]]);

/** Reuse only descriptor-accepted literals for the selected subject. No lookup,
 * provider call, identifier inference, or mutation of the saved discovery. */
export function suggestSourceInputs(source, descriptor, parsedRequest) {
  const fields = [...(Array.isArray(descriptor?.inputs) ? descriptor.inputs : []),
    ...(record(descriptor?.lookup) && typeof descriptor.lookup.field === 'string' ? [descriptor.lookup] : [])]
    .filter(field => record(field) && typeof field.field === 'string');
  const canonical = { ...(record(source?.endpoint?.input_values) ? source.endpoint.input_values : {}),
    ...(record(source?.input_values) ? source.input_values : {}) };
  const accepted = new Set(fields.map(field => field.field));
  const values = Object.fromEntries(Object.entries(canonical).filter(([field]) => accepted.has(field)));
  const subjects = Array.isArray(parsedRequest?.subjects) ? parsedRequest.subjects : [];
  const matches = source?.subject_id ? subjects.filter(subject => subject?.id === source.subject_id) : subjects;
  const subject = matches.length === 1 && record(matches[0]) ? matches[0] : null;
  if (!subject) return values;
  const identifiers = record(subject.identifiers) ? subject.identifiers : {};
  const type = typeof subject.type === 'string' ? subject.type.toLowerCase() : '';
  const company = companyTypes.has(type), person = type === 'person';
  const knownName = [...(company ? companyNames : person ? personNames : [])]
    .map(field => canonical[field]).find(text) ?? (text(subject.label) ? subject.label : undefined);
  for (const definition of fields) {
    const field = definition.field;
    // A saved canonical blank remains an intentional unanswered field.
    if (Object.hasOwn(values, field)) continue;
    const semantic = semanticField(field);
    const aliases = identifierAliases.get(semantic);
    const literals = Object.entries(identifiers).filter(([key]) => key === field || aliases?.has(key)
      || (key.includes('.') || literalKeys.has(key)) && (key === semantic || semantic.endsWith(`.${key}`)));
    let value = literals.length === 1 ? literals[0][1] : undefined;
    if (value === undefined && knownName && (company && companyNames.has(semantic)
      || person && personNames.has(semantic) || (company || person) && (entityNames.has(semantic)
        || semantic === 'entity' && /\bname\b/i.test(`${definition.schema?.title || ''} ${definition.schema?.description || ''}`)))) value = knownName;
    if (value === undefined || value === null || value === '') continue;
    // Identifier formats are still checked by the Gateway. Here the published
    // type, pattern and enum prevent names being placed in structured inputs.
    try { if (!ajv.validate(definition.schema, value)) continue; } catch { continue; }
    Object.defineProperty(values, field, { value, enumerable: true, writable: true, configurable: true });
  }
  return values;
}
