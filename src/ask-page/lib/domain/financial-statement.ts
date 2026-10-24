import { isRecord, label, unwrapEnvelope } from '@/lib/ui/answer'
import { formatSourceValue, sourceCurrency } from './source-value-format'

export type FinancialRow = { key: string; label: string; value: string | number | boolean | null; total: boolean }
export type FinancialStatement = {
  year: string | null
  currency: string | null
  metadata: FinancialRow[]
  sections: { key: string; title: string; rows: FinancialRow[] }[]
  highlights: FinancialRow[]
}

const titles: Record<string, string> = {
  BalanceSheet: 'Balance sheet', IncomeStatement: 'Income statement', CashFlowStatement: 'Cash flow statement',
  ConsolidatedBalanceSheet: 'Consolidated balance sheet', ConsolidatedIncomeStatement: 'Consolidated income statement',
  ConsolidatedCashFlowStatement: 'Consolidated cash flow statement',
}
const labels: Record<string, string> = {
  SbiBusinessCode: 'SBI code', DocumentAdoptionDate: 'Accounts adopted', FinancialYear: 'Financial year',
  Assets: 'Total assets', AssetsCurrent: 'Current assets', AssetsNoncurrent: 'Non-current assets',
  PropertyPlantEquipment: 'Property, plant and equipment', EquityAndLiabilities: 'Total equity and liabilities',
  LiabilitiesCurrent: 'Current liabilities', LiabilitiesNoncurrent: 'Non-current liabilities',
  Equity: 'Equity', ResultAfterTax: 'Net result', ResultBeforeTax: 'Result before tax',
  ShareCapitalPaidCalledUp: 'Paid-up share capital', FinancialIncomeExpenses: 'Financial income and expenses',
  DepreciationPropertyPlantEquipmentAmortisationIntangibleAssets: 'Depreciation and amortisation',
  EmployeeBenefitsExpenses: 'Employee benefits', OperatingExpensesOther: 'Other operating expenses',
  SumOfExpenses: 'Total expenses', BalanceSheetBeforeAfterAppropriationResults: 'Result appropriation (source code)',
}
const totals = new Set(['Assets', 'EquityAndLiabilities', 'Equity', 'ResultAfterTax', 'ResultBeforeTax', 'OperatingResult', 'SumOfExpenses'])
type Field = { key: string; value?: FinancialRow['value']; opendataFields?: Field[] }
function fields(value: unknown, depth = 0): value is Field[] {
  return depth < 16 && Array.isArray(value) && value.every(item => isRecord(item)
    && typeof item.key === 'string' && ('value' in item || 'opendataFields' in item)
    && Object.keys(item).every(key => ['key', 'value', 'opendataFields'].includes(key))
    && (!('value' in item) || item.value === null || ['string', 'number', 'boolean'].includes(typeof item.value))
    && (!('opendataFields' in item) || fields(item.opendataFields, depth + 1)))
}

/** A display projection of the saved field tree; no arithmetic, currency guesses or source calls. */
export function financialStatement(value: unknown): FinancialStatement | null {
  const body = unwrapEnvelope(value)
  const items = isRecord(body) ? body.opendataFields : body
  if (!fields(items) || !items.some(item => titles[item.key])) return null
  const metadata: FinancialRow[] = []
  const sections: FinancialStatement['sections'] = []
  const walk = (items: Field[], into: FinancialRow[]) => {
    for (const item of items) {
      if ('value' in item) {
        const row = { key: item.key, label: labels[item.key] ?? label(item.key), value: item.value ?? null, total: totals.has(item.key) }
        // XBRL presentation wrappers do not become headings. Keep their actual
        // non-financial values in filing details, including unknown source codes.
        const target = item.key === 'BalanceSheetBeforeAfterAppropriationResults' ? metadata : into
        target.push(row)
      }
      if (item.opendataFields) walk(item.opendataFields, into)
    }
  }
  for (const item of items) {
    if (titles[item.key] && item.opendataFields) {
      const rows: FinancialRow[] = []
      walk(item.opendataFields, rows)
      if (rows.length) sections.push({ key: item.key, title: titles[item.key], rows })
      if ('value' in item) walk([{ key: item.key, value: item.value }], metadata)
    } else walk([item], metadata)
  }
  if (!sections.length) return null
  const rows = sections.flatMap(section => section.rows)
  // Do not silently choose between duplicate periods or consolidated scopes.
  const highlights = ['Assets', 'Equity', 'ResultAfterTax'].flatMap(key => {
    const matches = rows.filter(row => row.key === key)
    return matches.length === 1 ? matches : []
  })
  const years = metadata.filter(row => row.key === 'FinancialYear')
  return { year: years.length === 1 && years[0].value != null ? String(years[0].value) : null,
    currency: sourceCurrency(value) ?? sourceCurrency(body), metadata, sections, highlights }
}

export function financialValue(row: FinancialRow, locale = 'en-US'): string {
  if (row.value == null || row.value === '') return 'Not provided'
  // Keep identifiers and years literal; format decimal strings without floating-point rounding.
  return formatSourceValue(row.value, row.key, null, undefined, locale)
}
