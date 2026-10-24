import { isEmptyValue, isLinkPlumbing, isNoiseKey, isRecord, label, unwrapEnvelope } from '@/lib/ui/answer'
import { escapeCsvCell } from './answer-presentation'
import { financialStatement } from './financial-statement'
import { resultMedia, resultMediaHints as mediaHints, type ResultMediaHints } from './result-media'

/**
 * A purchased result, sized for the chat. A handful of fields stays inline;
 * anything larger becomes a short preview (what it is, how many, the first
 * few rows) with the whole result one click away and downloadable. A
 * thirty-officer register extract is a document, not a chat message.
 */

/** At most this many values are shown inline; larger results are previewed. */
export const INLINE_FIELDS = 12
const PREVIEW_ROWS = 5
const PREVIEW_CELLS = 12
const PREVIEW_COLUMNS = 3
const PREVIEW_FIELDS = 6
const CELL_TEXT = 80
const CSV_COLUMNS = 120
const GENERIC_LIST_KEYS = new Set(['items', 'results', 'result', 'records', 'data', 'value', 'values', 'entries', 'list', 'hits', 'rows', 'resultaten'])
const NAME_KEYS = ['name', 'title', 'label', 'company_name', 'naam', 'handelsnaam', 'full_name', 'display_name']
/** Own details a named record needs before it counts as one entity rather than a list wrapper. */
const ENTITY_FIELDS = 3

export interface ResultPreview {
  /** Small enough to show whole in the chat. */
  inline: boolean
  /** "30 officers", "42 fields". */
  headline: string
  /** Counts the source reported alongside the records, such as a total. */
  facts: { label: string; value: string }[]
  /** The first rows of the main list, a few columns each. */
  table: { columns: string[]; rows: unknown[][]; mediaHints?: (ResultMediaHints | undefined)[][]; total: number } | null
  /** Or the first fields of a single record. */
  fields: { label: string; value: unknown; mediaHints?: ResultMediaHints }[]
  /** The result is a list of records a spreadsheet can hold. */
  csv: boolean
}

type Records = { key: string | null; records: Record<string, unknown>[] }

/** Carry the chosen record's exact identifiers into an editable follow-up. */
export function recordFollowUp(sourceName: string, record: Record<string, unknown>, question = ''): string {
  const lines: string[] = []
  const visit = (value: unknown, path: string[]) => {
    if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, String(index + 1)]))
    else if (isRecord(value)) Object.entries(value).filter(([key, item]) => !isNoiseKey(key) && !isLinkPlumbing(item)).forEach(([key, item]) => visit(item, [...path, label(key)]))
    else if (value !== null && value !== undefined) lines.push(`${path.join(' / ')}: ${String(value)}`)
  }
  visit(record, [])
  return `Selected record from ${sourceName}:\n${lines.join('\n')}\n\n${question || 'My follow-up: '}`
}

/** A selected record with nothing written after it is not yet a question, and must not be sent. */
export function followUpMissing(text: string): boolean {
  return /^Selected record from [^\n]*:\n[\s\S]*\n\nMy follow-up:\s*$/.test(text)
}

const isScalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value)
const visibleEntries = (record: Record<string, unknown>) => Object.entries(record).filter(([key, value]) => !isNoiseKey(key) && !isEmptyValue(value) && !isLinkPlumbing(value))
const cell = (value: unknown, hints?: ResultMediaHints) => {
  if (resultMedia(value, hints)) return value
  if (!isScalar(value)) return ''
  const text = String(value).replace(/\s+/g, ' ').trim()
  // Link cards need the original destination, including URLs inside prose or
  // Markdown. Their visual clamp belongs in the renderer, not in this value.
  if (/https?:\/\/\S/i.test(text)) return text
  return text.length > CELL_TEXT ? `${text.slice(0, CELL_TEXT - 1)}…` : text
}

/** Values a reader would see, counted up to `limit` (enough to decide what fits). */
export function countValues(value: unknown, limit = INLINE_FIELDS + 1): number {
  let count = 0
  const walk = (node: unknown, depth: number) => {
    if (count >= limit || depth > 12) return
    if (resultMedia(node)) { count++; return }
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return }
    if (isRecord(node)) { for (const [, inner] of visibleEntries(node)) walk(inner, depth + 1); return }
    if (node !== null && node !== undefined) count++
  }
  walk(value, 0)
  return Math.min(count, limit)
}

/** The result's main list of records: the body itself, or its longest list field (one level down at most). */
export function resultRecords(value: unknown): Records | null {
  const body = unwrapEnvelope(value)
  if (resultMedia(body)) return null
  const asRecords = (items: unknown) => Array.isArray(items) && items.length > 0 && items.every(isRecord) ? items as Record<string, unknown>[] : null
  const direct = asRecords(body)
  if (direct) return { key: null, records: direct }
  if (!isRecord(body)) return null
  let best: Records | null = null
  const consider = (key: string, items: unknown) => {
    const records = asRecords(items)
    if (records && (!best || records.length > best.records.length)) best = { key, records }
  }
  for (const [key, inner] of visibleEntries(body)) {
    consider(key, inner)
    if (isRecord(inner)) for (const [innerKey, deeper] of visibleEntries(inner)) consider(innerKey, deeper)
  }
  // A named record with details of its own (a company profile) is the answer;
  // a list inside it, such as its trade names, is one of those details.
  const found = best as Records | null
  if (found?.key && !GENERIC_LIST_KEYS.has(found.key.toLowerCase()) && isEntity(body)) return null
  return found
}

function isEntity(record: Record<string, unknown>): boolean {
  const own = visibleEntries(record).filter(([key, value]) => isScalar(value) && !/count|total|number_of|aantal|page|offset|limit/i.test(key))
  return own.length >= ENTITY_FIELDS && own.some(([key]) => NAME_KEYS.includes(key.toLowerCase()))
}

function noun(value: unknown, found: Records): string {
  const kind = isRecord(value) ? [value.kind, value.type].find(item => typeof item === 'string') as string | undefined : undefined
  const fromKind = kind?.match(/^([a-z]+)[-_ ]?list$/i)?.[1]
  const key = found.key && !GENERIC_LIST_KEYS.has(found.key.toLowerCase()) ? label(found.key).toLowerCase() : fromKind ? `${fromKind.toLowerCase()}s` : 'records'
  if (found.records.length !== 1) return key
  return key.endsWith('ies') ? `${key.slice(0, -3)}y` : key.endsWith('s') ? key.slice(0, -1) : key
}

/** How a result is shown in the chat: inline when small, else a preview. */
export function previewResult(value: unknown): ResultPreview {
  const body = unwrapEnvelope(value)
  const found = resultRecords(value)
  const size = countValues(body)
  const inline = size <= INLINE_FIELDS && (!found || found.records.length <= PREVIEW_ROWS)
  const facts = isRecord(body)
    ? visibleEntries(body).filter(([key, inner]) => typeof inner === 'number' && /count|total|number|aantal/i.test(key)).slice(0, 4).map(([key, inner]) => ({ label: label(key), value: String(inner) }))
    : []
  if (found) {
    const first = found.records[0]
    const scalarKeys = visibleEntries(first).filter(([key, inner]) => isScalar(inner) || resultMedia(inner, mediaHints(first, key))).map(([key]) => key)
    const named = scalarKeys.filter(key => NAME_KEYS.includes(key.toLowerCase()))
    const columns = [...named, ...scalarKeys.filter(key => !named.includes(key))].slice(0, PREVIEW_COLUMNS)
    const selected = columns.length ? found.records.slice(0, Math.min(PREVIEW_ROWS, Math.floor(PREVIEW_CELLS / columns.length))) : []
    const hints = selected.map(record => columns.map(key => resultMedia(record[key], mediaHints(record, key)) ? mediaHints(record, key) : undefined))
    const rows = selected.map((record, index) => columns.map((key, column) => cell(record[key], hints[index][column])))
    return {
      inline, headline: `${found.records.length} ${noun(body, found)}`, facts,
      table: rows.length ? { columns: columns.map(label), rows, ...(hints.some(row => row.some(Boolean)) ? { mediaHints: hints } : {}), total: found.records.length } : null,
      fields: [], csv: resultCsv(value) !== null,
    }
  }
  const fields = isRecord(body) ? visibleEntries(body).filter(([key, inner]) => isScalar(inner) || resultMedia(inner, mediaHints(body, key))).slice(0, PREVIEW_FIELDS).map(([key, inner]) => {
    const hints = mediaHints(body, key)
    const media = resultMedia(inner, hints)
    return { label: label(key), value: cell(inner, hints), ...(media ? { mediaHints: hints } : {}) }
  }) : []
  const total = countValues(body, 10_000)
  return { inline, headline: `${total} ${total === 1 ? 'field' : 'fields'}`, facts, table: null, fields, csv: false }
}

/** Nested records become dotted columns; lists of plain values are joined. */
function flatten(record: Record<string, unknown>, prefix = '', depth = 0, into: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [key, value] of Object.entries(record)) {
    const name = prefix ? `${prefix}.${key}` : key
    if (isRecord(value) && depth < 2) flatten(value, name, depth + 1, into)
    else if (Array.isArray(value) && value.every(item => item === null || isScalar(item))) into[name] = value.join('; ')
    else into[name] = value
  }
  return into
}

/** The main list as CSV (source values, spreadsheet-safe), or null when the result is not a list of records. */
export function resultCsv(value: unknown): string | null {
  const financial = financialStatement(value)
  if (financial) {
    const rows = [...financial.metadata.map(row => ['Filing details', row.label, row.value]),
      ...financial.sections.flatMap(section => section.rows.map(row => [section.title, row.label, row.value]))]
    return '\uFEFF' + [['Statement', 'Field', 'Source value'], ...rows].map(line => line.map(escapeCsvCell).join(',')).join('\r\n')
  }
  const found = resultRecords(value)
  if (!found) return null
  const rows = found.records.map(record => flatten(record))
  const columns: string[] = []
  const seen = new Set<string>()
  for (const row of rows) for (const key of Object.keys(row)) if (!seen.has(key)) { seen.add(key); columns.push(key) }
  if (!columns.length || columns.length > CSV_COLUMNS) return null
  return '\uFEFF' + [columns, ...rows.map(row => columns.map(key => row[key]))].map(line => line.map(escapeCsvCell).join(',')).join('\r\n')
}

/** The full saved result, as it was returned. */
export function resultJson(value: unknown): string {
  try { return JSON.stringify(value, null, 2) ?? 'null' } catch { return 'null' }
}

/** `Companies House officers` → `companies-house-officers-result.json`. */
export function resultFileName(name: string, extension: 'json' | 'csv'): string {
  const slug = name.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_-]+/g, '-').slice(0, 60).replace(/-+$/, '')
  return `${slug || 'apiosk'}-result.${extension}`
}
