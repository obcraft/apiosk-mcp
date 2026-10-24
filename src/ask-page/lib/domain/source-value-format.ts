import { formatDisplayText, formatDisplayNarrative, isLiteralField } from "@/lib/ui/display-text"
// Display formatting only. Raw source JSON remains unchanged.
export function sourceCurrency(value: unknown): string | null {
  const item = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const candidate = typeof value === 'string' ? value : item.currency ?? item.currencyCode ?? item.unit;
  if (typeof candidate !== 'string') return null;
  const code = candidate.replace(/^iso4217:/i, '').toUpperCase();
  return /^(EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK)$/.test(code) ? code : null;
}
export function formatSourceValue(value: unknown, key = '', currency: string | null = null, nameContext?: unknown, locale = 'en-US'): string {
  const raw = String(value ?? '');
  if (isLiteralField(key)) return raw;
  if (typeof value === 'string') value = formatDisplayText(value, key);
  const label = String(key).split('/').at(-1)!.replace(/[\s_.-]/g, '');
  // Identifiers, calendar years and dates are labels, not amounts.
  if (/year|date|datum|code|identifier|kvk|postcode|postal|phone|iban|^(?:bouwjaar|jaar|rsin)$/i.test(label) || /(?:^id$|Id$|ID$|Number$|Nummer$)/.test(label)) return raw;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return formatDisplayNarrative(String(value ?? ''), nameContext);
  const negative = raw.startsWith('-'), unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction] = unsigned.split('.');
  const dutch = locale.startsWith('nl');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, dutch ? '.' : ',') + (fraction == null ? '' : (dutch ? ',' : '.') + fraction);
  const monetary = /^(?:(?:total|net|gross))?(Assets|Liabilities|Equity|Receivables|Cash|Property|Provisions|Share|RetainedEarnings|FinancialIncome|Income|Result|Depreciation|EmployeeBenefits|Operating|GrossMargin|Impairment|SumOfExpenses|Revenue|Profit|Turnover|Amount|Balance|Price|Cost|Tax|Bedrag|Omzet|Winst|Kosten)/i.test(label) && !/ratio|percent|rate|count|margin|sharesoutstanding|sharesissued|records|items|matches|^(?:total)?results?$/i.test(label);
  const code = monetary ? sourceCurrency(currency) : null;
  const symbol = code && (({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[code] || code);
  return (negative ? '-' : '') + (symbol ? symbol + ' ' : '') + grouped;
}
