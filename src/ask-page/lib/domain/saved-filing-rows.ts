import { financialStatement } from './financial-statement'
import { formatSourceValue, sourceCurrency } from './source-value-format'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const hasError = (body: RecordValue) => body.success === false || body.status === 'error'
  || typeof body.statusCode === 'number' && body.statusCode >= 400
  || body.error != null && body.error !== false && body.error !== 0 && body.error !== ''
  || Array.isArray(body.errors) && body.errors.length > 0
const amount = (value: unknown) => typeof value === 'number' ? Number.isFinite(value)
  : typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
const financialField = /^(?:(?:Total|Net|Gross))?(?:Assets|Liabilities|Equity|Receivables|Cash|Property|Provisions|ShareCapital|RetainedEarnings|FinancialIncome|Income|Result|Depreciation|EmployeeBenefits|Operating|GrossMargin|Impairment|SumOfExpenses|Revenue|Profit|Turnover|Tax)/i

/** Shared eligibility and display projection for saved KVK annual figures.
 * Filing metadata alone is not a financial result; original data stays intact. */
export function savedFilingRows(provider: unknown, path: unknown, value: unknown): { rows: [string, string][]; currency: string | null } | null {
  const body = record(value)
  const route = String(path ?? '').split(/[?#]/, 1)[0].replace(/\/$/, '')
  if (provider !== 'kvk-dutch-business-register' || route !== '/api/v1/hvds/jaarrekeningen/kvknummer' || hasError(body)) return null
  const statement = financialStatement(body)
  if (!statement?.sections.some(section => section.rows.some(row => financialField.test(row.key) && amount(row.value)))) return null
  const currency = sourceCurrency(body)
  const rows: [string, string][] = []
  let hasVisibleFigure = false
  const walk = (fields: unknown, depth = 0) => {
    if (!Array.isArray(fields) || depth > 12) return
    for (const item of fields.slice(0, 200)) {
      if (rows.length >= 100) break
      const field = record(item)
      const present = typeof field.value === 'string' ? field.value.trim().length > 0
        : typeof field.value === 'number' ? Number.isFinite(field.value) : typeof field.value === 'boolean'
      if (typeof field.key === 'string' && present) {
        rows.push([field.key.replace(/([a-z])([A-Z])/g, '$1 $2'), formatSourceValue(field.value, field.key, sourceCurrency(field) || currency)])
        if (financialField.test(field.key) && amount(field.value)) hasVisibleFigure = true
      }
      if (field.opendataFields) walk(field.opendataFields, depth + 1)
    }
  }
  walk(body.opendataFields)
  return hasVisibleFigure ? { rows, currency } : null
}
