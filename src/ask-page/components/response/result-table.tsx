import type { CSSProperties, Key, ReactNode } from 'react'
import { isLiteralField } from '@/lib/ui/display-text'
import { ResultTableContext } from './result-table-context'

/** One accessible result surface, with labelled records or an aligned comparison matrix. */
export function ResultTable({ label, columns, rows, layout = columns.length > 2 ? 'records' : 'table', rowKeys, onSelectRow, selectedRow }: {
  label: string; columns: string[]; rows: ReactNode[][]; layout?: 'records' | 'table'; rowKeys?: Key[]
  onSelectRow?: (index: number) => void; selectedRow?: number | null
}) {
  const records = layout === 'records'
  // The last column of a matrix ends flush right, under its own heading.
  const alignEnd = (index: number) => !records && index > 0 && index === columns.length - 1 ? 'text-right' : ''
  // Display only: the value, its copy and the CSV keep their own case. Literal
  // fields (ids, codes, emails, URLs, postcodes) are never recased.
  const capitalizeClass = (column: string) => isLiteralField(column) ? '' : 'first-letter:uppercase'
  return <ResultTableContext value={true}>
    <div className={`min-w-0 max-w-full rounded-xl border border-border-2 bg-surface ${records ? '' : 'overflow-x-auto'}`} role="region" aria-label={label} tabIndex={records ? undefined : 0}>
      <table role="table" aria-label={label} className={`w-full text-left text-body ${records ? 'block' : ''}`}>
        <thead role="rowgroup" className={records ? 'sr-only' : 'border-b border-border-2 bg-surface-soft text-tiny text-muted'}><tr role="row">{columns.map((column, index) => <th role="columnheader" key={index} scope="col" className={`px-4 py-3 font-medium ${alignEnd(index)}`}>{column}</th>)}</tr></thead>
        <tbody role="rowgroup" className={records ? 'block divide-y divide-border-2' : 'divide-y divide-border-2'}>
          {rows.map((row, index) => <tr role="row" key={rowKeys?.[index] ?? index}
            onClick={onSelectRow ? event => { if (!(event.target as HTMLElement).closest('a,button,input,select,textarea')) onSelectRow(index) } : undefined}
            className={`${records ? 'grid grid-cols-2 gap-4 p-4 sm:grid-cols-[minmax(0,1.5fr)_repeat(2,minmax(0,1fr))] sm:gap-x-6 sm:p-5' : ''} ${onSelectRow ? 'cursor-pointer hover:bg-hover' : ''} ${selectedRow === index ? 'bg-hover' : ''}`}>
            {columns.map((column, columnIndex) => <td role="cell" key={columnIndex}
              className={records
                ? `min-w-0 [overflow-wrap:anywhere] ${columnIndex === 0 ? `col-span-2 font-medium leading-snug sm:col-span-1 sm:row-span-[var(--result-title-rows)] ${capitalizeClass(column)}` : 'space-y-1 tabular-nums'}`
                : `max-w-64 px-4 py-3 align-top tabular-nums [overflow-wrap:anywhere] ${alignEnd(columnIndex)} ${capitalizeClass(column)}`}
              style={records && columnIndex === 0 ? { '--result-title-rows': Math.max(1, Math.ceil((columns.length - 1) / 2)) } as CSSProperties : undefined}>
              {records && columnIndex > 0 && <span aria-hidden="true" data-label={column} className="block text-tiny font-normal text-muted before:content-[attr(data-label)]" />}
              {columnIndex === 0 && onSelectRow ? <div className="flex items-start gap-2 font-medium"><button type="button" aria-label={`Select row ${index + 1}`} aria-pressed={selectedRow === index} onClick={() => onSelectRow(index)} className="grid min-h-6 min-w-6 shrink-0 place-items-center rounded-full focus-visible:outline-2 focus-visible:outline-accent"><span aria-hidden="true" className="size-3 rounded-full border border-current">{selectedRow === index && <span className="m-0.5 block size-1.5 rounded-full bg-current" />}</span></button><span className={capitalizeClass(column)}>{row[columnIndex] ?? '—'}</span></div>
                : records && columnIndex > 0 ? <div className={capitalizeClass(column)}>{row[columnIndex] ?? <span className="text-muted">—</span>}</div>
                : row[columnIndex] ?? <span className="text-muted">—</span>}
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </div>
  </ResultTableContext>
}
