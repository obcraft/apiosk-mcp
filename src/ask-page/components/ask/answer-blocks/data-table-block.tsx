import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { BlockOf } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { dataTableCsv, filterTableRows, sortTableRows } from '@/lib/domain/answer-blocks-view'
import { FactSourceLink, FactValue } from './fact-value'
import { ResultTable } from '@/components/response/result-table'

const PAGE_SIZE = 20

function DownloadCsv({ csv }: { csv: string }) {
  const link = useRef<HTMLAnchorElement>(null)
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    if (link.current) link.current.href = url
    return () => URL.revokeObjectURL(url)
  }, [csv])
  return <a ref={link} download="data-table.csv" className="inline-flex py-2 text-body underline">Download table (CSV)</a>
}

/**
 * `data_table` (backlog #45). Sorts the complete selected set first, then
 * filters, then pages, so "Show more" never changes what sorting or
 * filtering already decided. Counts distinguish selected, fetched and
 * total available (design 2.2 coverage). The CSV download stays
 * source-faithful: raw values from the filtered set, not the current page.
 */
export function DataTableBlockView({ block, analysis }: { block: BlockOf<'data_table'>; analysis?: GatewayV2Analysis | null }) {
  const [query, setQuery] = useState('')
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(block.columns.filter(c => c.hidden).map(c => c.id)))
  const [shown, setShown] = useState(PAGE_SIZE)
  const sourceIndex = analysis?.source_index ?? []

  const sorted = useMemo(() => sortTableRows(block.columns, block.rows.map((row, index) => ({ ...row, row_index: row.row_index ?? block.collection?.row_indices[index] ?? index })), block.sort), [block.columns, block.rows, block.sort, block.collection])
  const filtered = useMemo(() => filterTableRows(sorted, query), [sorted, query])
  const columns = block.columns.filter(c => !hidden.has(c.id))
  const page = filtered.slice(0, shown)
  const csv = useMemo(() => dataTableCsv({ columns: block.columns, rows: filtered }), [block.columns, filtered])
  // Keep measurements aligned for comparison; descriptive records can wrap
  // into the shared record layout without changing the selected data.
  const hasMeasures = block.columns.some((column, index) =>
    column.role === 'number' || column.role === 'amount'
    || column.role !== 'identifier' && column.role !== 'date'
      && block.rows.some(row => typeof row.cells[index]?.value === 'number'),
  )

  const coverage = block.coverage
  const counts = coverage
    ? `${coverage.selected} selected · ${coverage.fetched} fetched${coverage.total_available !== undefined ? ` · ${coverage.total_available} total available` : ''}`
    : `${block.rows.length} rows`

  return <section aria-label={block.title ?? 'Data table'} className="min-w-0 max-w-full space-y-3">
    {block.title && <h3 className="font-medium">{block.title}</h3>}
    <p className="text-tiny text-muted">{counts}{filtered.length !== block.rows.length ? ` · ${filtered.length} match the filter` : ''}</p>
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-body">
        <span className="sr-only">Filter rows</span>
        <input type="search" value={query} onChange={e => { setQuery(e.target.value); setShown(PAGE_SIZE) }} placeholder="Filter rows" className="rounded border border-border-2 px-2 py-1 text-body" />
      </label>
      <fieldset className="flex flex-wrap gap-3 text-tiny">
        <legend className="sr-only">Columns shown</legend>
        {block.columns.map(column => <label key={column.id} className="inline-flex items-center gap-1.5">
          <input type="checkbox" checked={!hidden.has(column.id)} onChange={() => setHidden(previous => {
            const next = new Set(previous)
            if (next.has(column.id)) next.delete(column.id); else next.add(column.id)
            return next
          })} />
          {column.label}
        </label>)}
      </fieldset>
    </div>
    {columns.length > 0 ? <ResultTable
      label={`${block.title ?? 'Data table'} table`}
      columns={columns.map(column => column.label)}
      layout={hasMeasures ? 'table' : 'records'}
      rowKeys={page.map((row, index) => row.row_index ?? index)}
      rows={page.map((row, ri) => columns.map(column => {
        const index = block.columns.findIndex(c => c.id === column.id)
        const fact = row.cells[index]
        return <>
          <FactValue fact={fact} />
          <FactSourceLink fact={fact} sourceIndex={sourceIndex} collection={block.collection} rowIndex={row.row_index ?? ri} relativePointer={column.pointer} />
        </>
      }))}
    /> : <p className="text-body text-muted">Every column is hidden.</p>}
    {shown < filtered.length && <Button type="button" variant="ghost" size="sm" onClick={() => setShown(n => n + PAGE_SIZE)}>Show more rows ({filtered.length - shown} remaining)</Button>}
    <div><DownloadCsv csv={csv} /></div>
  </section>
}
