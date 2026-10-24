import type { GatewayV2Analysis } from './gateway-v2'
import type { SourceTable } from './source-result-tables'
import { answerValueContext } from './answer-format'
import { formatSourceValue, sourceCurrency } from './source-value-format'

export interface AnswerCell { value: string | number | boolean; result_ref?: string; pointer?: string; source?: string }
export type AnswerPresentation = { kind: 'text' | 'document' } | {
  kind: 'table' | 'comparison' | 'chart'
  title: string
  columns: AnswerCell[]
  rows: (AnswerCell | null)[][]
  returned_count?: number
}

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
function putEvidence(row: Map<string, unknown>, field: string, value: unknown) {
  if (!row.has(field)) { row.set(field, value); return }
  const previous = row.get(field)
  if (previous !== value) row.set(field, [...new Set([...(Array.isArray(previous) ? previous : [previous]), value])])
}

/** Saved analyses already contain validated evidence. Never fall back to dumping
 * a provider's raw rows: project only the cited records and cited fields. */
export function legacyAnswerTables(question: string, results: unknown[], analysis?: GatewayV2Analysis | null): SourceTable[] {
  if (analysis?.presentation || !analysis?.observations.length || !/\b(overzicht|tabel|table|overview|list|lijst|welke|which|vergelijk|compare|comparison)\b/i.test(question)) return []
  type Group = {name: string; columns: string[]; rows: Map<string, Map<string, unknown>>}
  const groups = new Map<string, Group>()
  for (const evidence of analysis.observations.flatMap(o => o.evidence)) {
    const doc = results.map(record).find(d => d.result_ref === evidence.result_ref)
    if (!doc || !evidence.pointer.startsWith('/data/')) continue
    const parts = evidence.pointer.split('/').slice(1).map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'))
    let node: unknown = {...doc, data: doc.data ?? doc.preview_data}, groupPath = '', rowPath = '', field = parts.slice(1).join(' / '), rowRecord: Record<string, unknown> = {}
    // First containing array identifies the cited record; repeated names or
    // amounts in other records/sources do not establish that they are relevant.
    for (let i = 0; i < parts.length; i++) {
      if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(parts[i])) {
        groupPath = JSON.stringify(parts.slice(0,i))
        rowPath = JSON.stringify(parts.slice(0,i+1))
        field = parts.slice(i+1).join(' / ')
        rowRecord = record(node[Number(parts[i])])
        break
      }
      node = record(node)[parts[i]]
    }
    // Scalar profile facts use a single field/value table, scoped to this result.
    const key = JSON.stringify([evidence.result_ref, groupPath])
    let group = groups.get(key)
    if (!group) {
      const source = record(doc.source), subject = record(doc.subject)
      group = {name: String(subject.label ?? source.name ?? source.provider ?? 'Answer'), columns: [], rows: new Map()}
      groups.set(key, group)
    }
    if (!rowPath) {
      group.columns = ['Field', 'Source value']
      const row = group.rows.get(evidence.pointer) ?? new Map<string, unknown>([['Field', field]])
      putEvidence(row, 'Source value', evidence.value)
      group.rows.set(evidence.pointer, row)
      continue
    }
    let row = group.rows.get(rowPath)
    if (!row) { row = new Map(); group.rows.set(rowPath, row) }
    if (!group.columns.includes(field)) group.columns.push(field)
    putEvidence(row, field, evidence.value)
    // A direct link from this same cited record stays useful without copying
    // its other fields. No guessed URLs or unrelated records are introduced.
    const link = rowRecord.url ?? record(rowRecord.link).href ?? record(record(rowRecord._links).self).href
    if (typeof link === 'string' && /^https?:\/\//i.test(link)) {
      if (!group.columns.includes('Source')) group.columns.push('Source')
      row.set('Source', link)
    }
  }
  const humanize = (label: string) => label.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ')
  const tables = [...groups.values()].map(g => ({title: g.name, columns: g.columns.map(humanize), rows: [...g.rows.values()].map(r => g.columns.map(c => r.get(c))), note: 'Only records and fields cited in this saved answer. Full source data is available in Details.'}))
  if (/\b(vergelijk|compare|comparison)\b/i.test(question) && tables.length > 1 && tables.every(t => t.columns[0] === 'Field') && new Set(tables.map(t => t.title)).size === tables.length) {
    const fields = [...new Set(tables.flatMap(t => t.rows.map(r => String(r[0]))))]
    return [{title: 'Comparison', layout: 'table', columns: ['Feature', ...tables.map(t => t.title)], rows: fields.map(f => [humanize(f), ...tables.map(t => t.rows.find(r => r[0] === f)?.[1])]), note: 'Only facts cited in the saved answer. Missing values are unknown; retain differences in units and reporting periods.'}]
  }
  return tables
}

export function presentationTable(p: Extract<AnswerPresentation, {title: string}>, results: unknown[] = [], locale = 'en-US'): SourceTable {
  return {title: p.title, layout: p.kind === 'comparison' || p.kind === 'chart' ? 'table' : undefined, columns: p.columns.map(c => String(c.value)), rows: p.rows.map(r => r.map(c => c?.value)),
    locale,
    displayRows: p.rows.map(row => row.map((cell, i) => {
      if (!cell || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(cell.value))) return cell?.value
      const context = cell.result_ref && cell.pointer ? answerValueContext({result_ref: cell.result_ref, pointer: cell.pointer}, results) : null
      const currencyColumn = p.columns.findIndex(c => /^(currency|valuta)$/i.test(String(c.value)))
      const currency = context?.currency ?? sourceCurrency(row[currencyColumn]?.value)
      return formatSourceValue(cell.value, context?.field || String(p.columns[i]?.value), currency, undefined, locale)
    })),
    note: p.returned_count !== undefined ? `${p.rows.length} selected from ${p.returned_count} returned records. This is not necessarily the complete search.` : 'Based on saved source data. Missing values are unknown.'}
}

/** Escape spreadsheet formula prefixes as well as ordinary CSV delimiters. */
export function escapeCsvCell(v: unknown): string {
  const raw = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)
  const safe = typeof v === 'string' && /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw
  return `"${safe.replaceAll('"', '""')}"`
}

export function tableCsv(table: SourceTable): string {
  return '\uFEFF' + [table.columns, ...table.rows].map(r => r.map(escapeCsvCell).join(',')).join('\r\n')
}
