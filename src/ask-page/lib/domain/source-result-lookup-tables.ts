import type { SourceTable } from './source-result-tables'

type Row = Record<string, unknown>
const record = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const scalar = (value: unknown): boolean => text(value) || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter(text) : []
const available = (value: unknown): boolean => scalar(value) || Array.isArray(value) && value.some(scalar)
const bool = (value: unknown) => typeof value === 'boolean' ? value : undefined
const sourceText = (value: unknown) => text(value) && value.trim() !== '---' ? value : undefined
const hasError = (value: Row) => value.success === false || value.status === 'error' || typeof value.statusCode === 'number' && value.statusCode >= 400
  || available(value.error) && value.error !== false && value.error !== 0 || Object.keys(record(value.error)).length > 0 || Array.isArray(value.errors) && value.errors.length > 0

function publicUrl(value: unknown): string | undefined {
  if (!text(value)) return undefined
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : undefined
  } catch { return undefined }
}

// Keep the original cells for source-backing checks; bound only their display.
// The complete saved response stays available through Details.
function bounded(table: SourceTable): SourceTable {
  let shortened = false
  const display = (value: unknown): unknown => {
    if (typeof value === 'string' && value.length > 6000) { shortened = true; return value.slice(0, 6000) + '…' }
    if (Array.isArray(value)) {
      if (value.length > 50) shortened = true
      return value.slice(0, 50).map(display)
    }
    return value
  }
  if (table.rows.length > 50) shortened = true
  const rows = table.rows.slice(0, 50)
  const displayRows = rows.map(row => row.map(display))
  return {...table, rows, displayRows, locale: 'en-US', note: `${table.note}${shortened ? ' Long text or lists are shortened; the full saved response is available in Details.' : ''}`}
}

function fields(title: string, rows: unknown[][], note: string): SourceTable[] {
  const present = rows.filter(row => available(row[1]))
  return present.length ? [bounded({title, columns: ['Field', 'Source value'], rows: present, note})] : []
}

/** Reviewed response shapes only: request metadata or an error body is not a
 * usable result. These views expose saved facts, not a synthesized answer. */
export function lookupSourceTables(provider: unknown, path: unknown, value: unknown): SourceTable[] {
  const body = record(value), data = record(body.data)
  const route = String(path ?? '').split(/[?#]/, 1)[0].replace(/\/$/, '')
  if (hasError(body) || hasError(data)) return []

  if (provider === 'domain-intelligence' && /^\/(domain|dns)\/[^/]+$/.test(route) && text(data.domain)) {
    const dns = route.startsWith('/dns/')
    const rows = dns ? [
      ['DNS exists', bool(data.exists)], ['Accepts mail according to MX', bool(data.accepts_mail)],
      ['DNSSEC validated by resolver', bool(data.dnssec_validated)], ['MX records', strings(data.mx)],
    ] : [
      ['Registered on', sourceText(data.registered_at)], ['Last changed', sourceText(data.last_changed_at)],
      ['Expires on', sourceText(data.expires_at)], ['Registrar', sourceText(data.registrar)],
      ['Registration statuses', strings(data.statuses)], ['Nameservers', strings(data.nameservers)],
    ]
    if (!rows.some(row => available(row[1]))) return []
    return fields(dns ? 'Mail DNS records' : 'Domain registration', [
      ['Domain', data.domain], ...rows, ['Source', publicUrl(body.source_url)],
    ], dns
      ? 'Returned MX records describe mail routing, not ownership or tested delivery. A null MX record means the domain does not accept mail.'
      : 'Returned registry RDAP data. Registration dates and technical records do not establish who controls the domain.')
  }

  if (provider === 'linkup' && route === '/v1/fetch' && text(body.markdown)) {
    return fields('Fetched web page', [['Page content', body.markdown]], 'Saved page content returned by Linkup. Publisher statements are not independently verified facts.')
  }
  if (provider === 'linkup' && route === '/v1/search' && Array.isArray(body.sources)) {
    const sources = body.sources.map(record).filter(source => publicUrl(source.url) && (text(source.name) || text(source.snippet)))
    if (!sources.length) return []
    const response = text(body.answer) ? fields('Web search response', [['Returned answer', body.answer]], 'Saved Linkup response with its returned web sources. This is source content, not the combined analysis.') : []
    return [...response, bounded({
      title: 'Web search sources', columns: ['Source', 'Excerpt', 'URL'],
      rows: sources.map(source => [sourceText(source.name), sourceText(source.snippet), source.url]),
      note: 'Returned web pages may include third-party summaries; a search match does not verify every statement.',
    })]
  }

  if (provider === 'vies' && (/^\/taxation_customs\/vies\/rest-api\/ms\/[^/]+\/vat\/[^/]+$/.test(route) || route === '/taxation_customs/vies/rest-api/check-vat-number')
    && text(data.vat_number) && text(data.country_code) && typeof data.valid === 'boolean') {
    return fields('VAT validation', [
      ['Country code', data.country_code], ['VAT number', data.vat_number], ['Valid according to VIES', data.valid],
      ['Check date', sourceText(data.request_date)], ['Name returned by VIES', sourceText(data.name)],
      ['Address returned by VIES', sourceText(data.address)], ['Source', publicUrl(body.source_url)],
    ], `VIES registration status at the check time. Missing name or address remains unknown; this does not establish a match to a separately supplied company.${record(body.coverage).complete === false && text(record(body.coverage).scope) ? ` Source scope: ${record(body.coverage).scope}.` : ''}`)
  }

  if (provider === 'iban-check' && /^\/iban\/[^/]+$/.test(route) && text(data.iban) && typeof data.valid === 'boolean') {
    const bank = record(data.bank), checks = record(data.checks)
    return fields('IBAN validation', [
      ['IBAN', data.iban], ['Structure and check digits valid', data.valid], ['Country code', sourceText(data.country_code)],
      ['SEPA member country', bool(data.sepa)], ['Bank code', sourceText(data.bank_code)], ['Bank', sourceText(bank.name)], ['BIC', sourceText(bank.bic)],
      ['Country recognized', bool(checks.country_known)], ['Length valid', bool(checks.length)], ['Checksum valid', bool(checks.checksum)],
      ['Source', publicUrl(body.source_url)],
    ], 'Structure, check digits and available bank-directory data. This does not confirm account existence or account ownership.')
  }

  if (provider === 'frankfurter' && /^\/v2\/providers\/ecb\/rate\/[A-Z]{3}\/[^/]+$/.test(route)
    && text(body.base) && text(body.quote) && text(body.date) && typeof body.rate === 'number' && Number.isFinite(body.rate)) {
    return fields('ECB reference exchange rate', [
      ['Base currency', body.base], ['Quote currency', body.quote], ['Rate per unit of base currency', body.rate], ['Observation date', body.date],
    ], 'Daily ECB reference rate via Frankfurter, not an executable bank or trading quote. The observation date can precede the retrieval date.')
  }
  return []
}
