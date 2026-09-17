// Keep in sync with App src/lib/ui/display-text.ts.
const displayAbbreviations = new Set([
    'BV', 'NV', 'VOF', 'CV', 'LLC', 'LLP', 'PLC', 'AG', 'SA', 'SAS', 'SE', 'ASA',
    'IT', 'ICT', 'AI', 'IBM', 'ING', 'ABN', 'AMRO', 'ASML', 'KPN', 'TNO',
    'EU', 'UK', 'US', 'USA', 'NL', 'EUR', 'USD', 'GBP', 'VAT', 'KVK', 'API', 'HTTP', 'HTTPS',
]);
/** Technical values stay literal regardless of the response's source or shape. */
export function isLiteralField(key) {
    const words = key.replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-zA-Z]+/).filter(Boolean);
    return words.some(word => /^(?:id|ids|code|codes|ref|refs|reference|identifier|identifiers|token|key|hash|signature|url|uri|path|pointer|email|domain|postcode|postal|zip|iban|bic|phone|number|nummer|currency|unit|symbol|method)$/i.test(word));
}
/** Shared display rule for human-readable labels and values, independent of answer type. */
export function formatDisplayText(text, key = '') {
    if (isLiteralField(key) || text.length > 160 || text !== text.toLocaleUpperCase('nl-NL') || !/\p{L}/u.test(text))
        return text;
    if (/[@:/_\n]|\p{L}\d|\d\p{L}/u.test(text) || /^\S+\.[A-Z]{2,}$/u.test(text))
        return text;
    if (!/\s/u.test(text) && text.length <= 4)
        return text;
    return text.replace(/\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu, word => {
        if (displayAbbreviations.has(word))
            return word;
        if (word === 'GMBH')
            return 'GmbH';
        return word.charAt(0) + word.slice(1).toLocaleLowerCase('nl-NL');
    });
}
/** A display copy for any nested JSON response. Never modifies the source or its keys. */
export function displayData(value, key = '', depth = 0) {
    if (depth > 20 || value == null || isLiteralField(key))
        return value;
    if (typeof value === 'string')
        return formatDisplayText(value, key);
    if (Array.isArray(value))
        return value.map(child => displayData(child, key, depth + 1));
    if (typeof value !== 'object')
        return value;
    const record = value;
    const field = record.key ?? record.field ?? record.type ?? record.factType ?? record.pointer;
    return Object.fromEntries(Object.entries(record).map(([name, child]) => [name,
        displayData(child, name === 'value' && typeof field === 'string' ? field : name, depth + 1),
    ]));
}
/** Use the same spelling in prose as in the displayed source values. */
export function formatDisplayNarrative(text, context) {
    const replacements = new Map();
    function collect(raw, shown, depth = 0) {
        if (depth > 20 || raw == null || shown == null)
            return;
        if (typeof raw === 'string' && typeof shown === 'string' && raw !== shown)
            replacements.set(raw, shown);
        else if (Array.isArray(raw) && Array.isArray(shown))
            raw.forEach((value, i) => collect(value, shown[i], depth + 1));
        else if (typeof raw === 'object' && typeof shown === 'object') {
            for (const [key, value] of Object.entries(raw))
                collect(value, shown[key], depth + 1);
        }
    }
    collect(context, displayData(context));
    if (replacements.size) {
        const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
        text = text.replace(new RegExp(`(?<![\\p{L}\\p{N}_/@.])(?:${pattern})(?![\\p{L}\\p{N}_/@]|\\.[\\p{L}\\p{N}])`, 'gu'), value => replacements.get(value));
    }
    return formatDisplayText(text);
}

export const DISPLAY_TEXT = ['const displayAbbreviations = new Set(' + JSON.stringify([...displayAbbreviations]) + ');', isLiteralField, formatDisplayText, displayData, formatDisplayNarrative].map(value => typeof value === 'function' ? value.toString() : value).join('\n');
