// Keep in sync with App src/lib/ui/company-name.ts.
const companyAbbreviations = new Set([
    "BV", "NV", "VOF", "CV", "LLC", "LLP", "PLC", "AG", "SA", "SAS", "SE", "ASA",
    "IT", "ICT", "AI", "IBM", "ING", "ABN", "AMRO", "ASML", "KPN", "TNO",
]);
/** Make registry names readable without changing source data or mixed-case brands. */
export function formatCompanyName(name) {
    if (name !== name.toLocaleUpperCase("nl-NL"))
        return name;
    return name.replace(/\p{L}[\p{L}\p{M}\d]*(?:['’][\p{L}\p{M}\d]+)*/gu, word => {
        if (companyAbbreviations.has(word))
            return word;
        if (word === 'GMBH')
            return 'GmbH';
        return word.charAt(0) + word.slice(1).toLocaleLowerCase("nl-NL");
    });
}
/** Field names used by registries and annual-account taxonomies, including JSON pointers. */
export function isCompanyNameField(key) {
    const compact = key.replace(/[^a-z]/gi, '').toLowerCase();
    return /(?:companyname|legalname|legalnamename|registeredname|businessname|tradename|statutairenaam|handelsnaam|handelsnamennaam|nameofreportingentityorothermeansofidentification|entitycurrentlegalorregisteredname|denomination|raisonsociale)$/.test(compact);
}
function isCompanyRecord(value) {
    return ['kvkNummer', 'kvk_number', 'company_number', 'companyNumber', 'lei', 'legalName', 'statutaireNaam', 'siren', 'siret'].some(key => key in value);
}
/** Collect names from semantic fields so prose can be formatted without guessing at acronyms. */
export function companyNamesIn(value) {
    const names = new Set();
    function walk(item, path = '', depth = 0) {
        if (depth > 20 || item == null)
            return;
        if (Array.isArray(item)) {
            item.forEach(child => walk(child, path, depth + 1));
            return;
        }
        if (typeof item !== 'object')
            return;
        const record = item;
        const field = record.type ?? record.factType ?? record.key ?? record.field ?? record.pointer;
        if (typeof field === 'string' && isCompanyNameField(field) && typeof record.value === 'string')
            names.add(record.value);
        const company = isCompanyRecord(record) || /(?:supplier|report_subject|candidates)$/.test(path);
        for (const [key, child] of Object.entries(record)) {
            const next = `${path}/${key}`;
            if (typeof child === 'string' && (isCompanyNameField(next) || (company && /^(name|naam|label)$/.test(key))))
                names.add(child);
            walk(child, next, depth + 1);
        }
    }
    walk(value);
    return [...names].filter(name => name && formatCompanyName(name) !== name).sort((a, b) => b.length - a.length);
}
/** Only standalone company labels or names established by the returned evidence are changed. */
export function formatCompanyText(text, context) {
    const names = companyNamesIn(context);
    if (names.length) {
        const pattern = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_/@.])(?:${pattern})(?![\\p{L}\\p{N}_/@]|\\.[\\p{L}\\p{N}])`, 'gu'), formatCompanyName);
    }
    if (text.length <= 160 && !/[@:/\n]/.test(text) && /\p{L}.*\s(?:B\.?V\.?|N\.?V\.?|VOF|CV|LLC|LLP|PLC|LTD|LIMITED|GMBH|AG|SA|SAS|SE)$/u.test(text))
        return formatCompanyName(text);
    return text;
}
/** A display copy for generic result readers; source objects and exported JSON stay intact. */
export function companyDisplayData(value, path = '', depth = 0) {
    if (depth > 20 || value == null)
        return value;
    if (Array.isArray(value))
        return value.map(child => companyDisplayData(child, path, depth + 1));
    if (typeof value !== 'object')
        return value;
    const record = value;
    const company = isCompanyRecord(record) || /(?:supplier|report_subject|candidates)$/.test(path);
    const field = record.type ?? record.factType ?? record.key ?? record.field ?? record.pointer;
    return Object.fromEntries(Object.entries(record).map(([key, child]) => {
        const next = `${path}/${key}`;
        const name = isCompanyNameField(next) || (company && /^(name|naam|label)$/.test(key)) || (key === 'value' && typeof field === 'string' && isCompanyNameField(field));
        return [key, typeof child === 'string' && name ? formatCompanyName(child) : companyDisplayData(child, next, depth + 1)];
    }));
}

export const COMPANY_NAME_DISPLAY = ['const companyAbbreviations = new Set(' + JSON.stringify([...companyAbbreviations]) + ');', formatCompanyName, isCompanyNameField, isCompanyRecord, companyNamesIn, formatCompanyText, companyDisplayData].map(value => typeof value === 'function' ? value.toString() : value).join('\n');
