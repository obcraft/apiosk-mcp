// Display formatting only. Raw source JSON remains unchanged.
export function sourceCurrency(value) {
  const candidate = typeof value === 'string' ? value : value?.currency ?? value?.currencyCode ?? value?.unit;
  if (typeof candidate !== 'string') return null;
  const code = candidate.replace(/^iso4217:/i, '').toUpperCase();
  return /^(EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK)$/.test(code) ? code : null;
}
export function formatSourceValue(value, key = '', currency = null) {
  const raw = String(value ?? '');
  const label = String(key).replace(/[\s_.-]/g, '');
  // Identifiers, calendar years and dates are labels, not amounts.
  if (/year|date|code|identifier|kvk|postcode|postal|phone|iban/i.test(label) || /(?:^id$|Id$|ID$|Number$|Nummer$)/.test(label)) return raw;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return raw;
  const negative = raw.startsWith('-'), unsigned = negative ? raw.slice(1) : raw;
  const [whole, fraction] = unsigned.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (fraction == null ? '' : ',' + fraction);
  const monetary = /^(Assets|Liabilities|Equity|Receivables|Cash|Property|Provisions|Share|RetainedEarnings|FinancialIncome|IncomeTax|Result|Depreciation|EmployeeBenefits|Operating|GrossMargin|Impairment|SumOfExpenses|Revenue|Profit|Turnover|Amount|Balance|Price|Cost|Tax)/i.test(label);
  const code = monetary ? sourceCurrency(currency) : null;
  const symbol = code && ({ EUR: '€', USD: '$', GBP: '£' }[code] || code);
  return (negative ? '-' : '') + (symbol ? symbol + ' ' : '') + grouped;
}
export const V2_SOURCE_VALUE_FORMAT = [sourceCurrency, formatSourceValue].map(fn => fn.toString()).join('\n');
