import { displayData, formatDisplayText, isLiteralField } from "@/lib/ui/display-text"
import type { SourceTable } from "@/lib/domain/source-result-tables"
import { formatSourceValue } from '@/lib/domain/source-value-format'
import { ResponseText } from '@/components/response/response-text'
import { LinkPreviewCard } from '@/components/response/link-preview'
import { extractResponseLinks } from '@/lib/domain/link-preview'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { ResultTable } from '@/components/response/result-table'
import { resultMedia, resultMediaHints, type ResultMediaHints } from '@/lib/domain/result-media'
import { ResultMediaView } from '@/components/response/result-media'
function sourceLink(row: unknown[]): string | null {
  for (const value of row.slice(1)) {
    if (typeof value !== 'string' || !/^https?:\/\/\S+$/i.test(value.trim())) continue
    try { const url = new URL(value); if (!url.username && !url.password) return url.href } catch { /* Not a link. */ }
  }
  return null
}
function cell(value: unknown, key: string, locale = 'nl-NL', formatted = false, hints: ResultMediaHints = { field: key }): React.ReactNode {
  if (value == null || value === "") return "—"
  const media = resultMedia(value, hints)
  if (media) return <ResultMediaView media={media} />
  if (Array.isArray(value)) return <ul className="space-y-1">{value.map((v,i)=><li key={i}>{cell(v, key, locale, formatted, hints)}</li>)}</ul>
  // Presentation cells were formatted using the cited source field. A generic
  // column heading must not reformat a preserved year or registration number.
  if (typeof value === "number" || typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return formatted ? String(value) : formatSourceValue(value, key, null, undefined, locale)
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value !== "string") return <ResponseText text={JSON.stringify(displayData(value, key))} />
  if (/^https?:\/\/\S+$/i.test(value.trim())) {
    try { const url=new URL(value); if (!url.username && !url.password) return <LinkPreviewCard href={url.href} /> } catch { /* Render invalid URLs as text. */ }
  }
  return <ResponseText text={formatDisplayText(value, key)} />
}
export function SourceResultTable({ table, paginate = true, renderCellEvidence }: { table: SourceTable; paginate?: boolean; renderCellEvidence?: (row: number, column: number) => React.ReactNode }) {
  return <SourceResultTableBody key={JSON.stringify([table.columns, table.rows])} table={table} paginate={paginate} renderCellEvidence={renderCellEvidence} />
}

function SourceResultTableBody({ table, paginate, renderCellEvidence }: { table: SourceTable; paginate: boolean; renderCellEvidence?: (row: number, column: number) => React.ReactNode }) {
  const hasMeasures = table.columns.some((column, index) => {
    const words = column.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ')
    const identifierOrDate = isLiteralField(column) || /\b(?:years?|jaar|bouwjaar|dates?|datum|periods?|perioden|huisnummer)\b/i.test(words)
    return !identifierOrDate && table.rows.some(row => typeof row[index] === 'number')
  })
  const layout = table.layout ?? (table.columns.length <= 2 || hasMeasures ? 'table' : 'records')
  const pageSize = layout === 'records' ? 5 : 20
  const [shown, setShown] = useState(pageSize)
  const visible = paginate ? table.rows.slice(0, shown) : table.rows
  return <section className="answer-content min-w-0 max-w-full space-y-4" aria-label={table.title}>
    <header className="space-y-1">
      <h3 className="font-medium">{table.title}</h3>
      <p className="text-tiny text-muted">{visible.length < table.rows.length ? `${visible.length} of ${table.rows.length}` : table.rows.length} rows shown{table.total!==undefined?` · ${new Intl.NumberFormat(table.locale ?? "en-GB").format(table.total)} total source matches`:""}</p>
    </header>
    {table.note && <p className="max-w-prose text-tiny text-muted">{table.note}</p>}
    {visible.length > 0 ? <ResultTable label={`${table.title} table`} layout={layout} columns={table.columns} rows={visible.map((row, i) => {
      const fields = Object.fromEntries(table.columns.map((column, index) => [column, row[index]]))
      const href = typeof row[0] === 'string' && !extractResponseLinks(row[0]).length && !resultMedia(row[0], resultMediaHints(fields, table.columns[0])) ? sourceLink(row) : null
      return row.map((value, column) => {
        const display = table.displayRows?.[i]?.[column]
        const key = table.columns[column] === "Source value" ? String(row[0]) : table.columns[column]
        const hints = resultMediaHints(fields, key)
        const content = cell(resultMedia(value, hints) ? value : display ?? value, key, table.locale, display != null, hints)
        const linked = column === 0 && href ? <a href={href} target="_blank" rel="noopener noreferrer" className="rounded-sm font-medium underline decoration-border-2 underline-offset-4 hover:text-accent focus-visible:outline-2 focus-visible:outline-ring">{content}</a> : content
        return <>{linked}{renderCellEvidence?.(i, column)}</>
      })
    })} /> : <p className="text-body">No records returned.</p>}
    {paginate && table.rows.length > pageSize && <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status" className="text-tiny text-muted">Showing {visible.length} of {table.rows.length} returned rows</p>
      <div className="flex flex-wrap gap-2">
        {shown > pageSize && <Button type="button" variant="ghost" size="sm" onClick={() => setShown(pageSize)}>Show fewer</Button>}
        {shown < table.rows.length && <Button type="button" size="sm" onClick={() => setShown(count => count + pageSize)}>Show {Math.min(pageSize, table.rows.length - shown)} more</Button>}
      </div>
    </div>}
  </section>
}
