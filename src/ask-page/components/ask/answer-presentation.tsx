import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { legacyAnswerTables, presentationTable, tableCsv, type AnswerCell } from '@/lib/domain/answer-presentation'
import type { SourceTable } from '@/lib/domain/source-result-tables'
import { SourceResultTable } from './source-result-table'
import { answerLocale } from '@/lib/domain/answer-format'
import { EvidenceCitation } from './answer-evidence'
import { Link2 } from 'lucide-react'

function DownloadTable({table}: {table: SourceTable}) {
  const link = useRef<HTMLAnchorElement>(null)
  const csv = tableCsv(table)
  useEffect(() => {
    if (typeof URL.createObjectURL !== 'function') return
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'}))
    if (link.current) link.current.href = url
    return () => URL.revokeObjectURL(url)
  }, [csv])
  return <a ref={link} download="results.csv" className="inline-flex py-2 text-body underline">Download table (CSV)</a>
}

const chartPoints = (table: SourceTable) => table.rows.filter((r): r is [string, number] => typeof r[0] === 'string' && typeof r[1] === 'number' && Number.isFinite(r[1]))

/** `scale` is every selected row, so revealing more rows never rescales the bars already shown. */
function AnswerChart({table, scale = table}: {table: SourceTable; scale?: SourceTable}) {
  const points = chartPoints(table)
  if (!points.length || points.length !== table.rows.length) return null
  const all = chartPoints(scale).map(r => r[1])
  const min = Math.min(0, ...all), max = Math.max(0, ...all)
  const range = max - min || 1, zero = (0 - min) / range * 100
  return <figure aria-label={`${table.title} chart`} className="space-y-3 rounded-lg border border-border-2 bg-surface p-3">
    <figcaption className="answer-section-title">{table.title} · {table.columns[1]}</figcaption>
    {points.map(([label,value], i) => {
      const end = (value - min) / range * 100
      return <div key={i} className="space-y-1 text-body">
        <div className="flex justify-between gap-3"><span className="break-words">{label}</span><span className="shrink-0 tabular-nums">{String(table.displayRows?.[i]?.[1] ?? new Intl.NumberFormat(table.locale ?? 'nl-NL', {maximumFractionDigits: 10}).format(value))}</span></div>
        <div className="relative h-3 rounded bg-[color:var(--accent-wash)]" aria-hidden="true">
          <span className="absolute inset-y-0 w-px bg-muted" style={{left: `${zero}%`}} />
          <span className="absolute inset-y-0 rounded bg-[color:var(--accent)]" style={{left: `${Math.min(zero,end)}%`, width: `${Math.abs(end-zero)}%`}} />
        </div>
      </div>
    })}
  </figure>
}

function SelectedTable({table, chart, evidence}: {table: SourceTable; chart: boolean; evidence?: (AnswerCell | null)[][]}) {
  const [shown, setShown] = useState(10)
  const visible = {...table, rows: table.rows.slice(0, shown)}
  return <div className="min-w-0 max-w-full">
    {chart && <AnswerChart table={visible} scale={table} />}
    <SourceResultTable table={visible} paginate={false} renderCellEvidence={evidence ? (row, column) => {
      const fact = evidence[row]?.[column]
      return fact?.result_ref && fact.pointer != null ? <EvidenceCitation facts={[fact]} inline label={<Link2 aria-hidden="true" className="size-3.5" />} /> : null
    } : undefined} />
    {shown < table.rows.length && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setShown(n => n + 10)}>Show more selected rows ({table.rows.length - shown} remaining)</Button>}
    {shown > 10 && <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setShown(10)}>Show fewer rows</Button>}
    <div><DownloadTable table={table} /></div>
  </div>
}

export function AnswerPresentation({question, results, analysis}: {question: string; results: unknown[]; analysis?: GatewayV2Analysis | null}) {
  const presentation = analysis?.presentation
  const tables = presentation && 'title' in presentation ? [presentationTable(presentation, results, answerLocale(question, analysis))] : legacyAnswerTables(question, results, analysis)
  if (!tables.length) return null
  return <div className="min-w-0 max-w-full space-y-4" aria-label="Answer data">
    {tables.map((table,i) => <SelectedTable key={`${question}:${i}:${table.title}`} table={table} chart={presentation?.kind === 'chart'} evidence={presentation && 'rows' in presentation ? presentation.rows : undefined} />)}
  </div>
}
