import { useEffect, useRef, useState } from 'react'
import type { BlockOf } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { lineChartData } from '@/lib/domain/answer-chart'
import { ResultTable } from '@/components/response/result-table'
import { FactSourceLink, FactValue } from './fact-value'
import { useAnswerEvidence } from '../answer-evidence-context'

const colors = ['var(--accent)', 'var(--foreground)', 'var(--muted)']

export function LineChartBlockView({ block, analysis }: { block: BlockOf<'line_chart'>; analysis?: GatewayV2Analysis | null }) {
  const { locale } = useAnswerEvidence()
  const nl = locale === 'nl-NL'
  const [view, setView] = useState<'chart' | 'table'>('chart')
  const [selected, setSelected] = useState<string | null>(null)
  const data = lineChartData(block)
  const chartRef = useRef<SVGSVGElement>(null)
  const [chartWidth, setChartWidth] = useState(620)
  const showChart = data.compatible && view === 'chart'
  // Size the coordinate system to the available space so axis text and point
  // targets keep their readable size on a narrow result panel.
  useEffect(() => {
    if (!showChart || !chartRef.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width
      if (width) setChartWidth(Math.max(240, Math.round(width)))
    })
    observer.observe(chartRef.current)
    return () => observer.disconnect()
  }, [showChart])
  const points = data.series.flatMap(series => series.points.map(point => ({ series, point, key: `${series.id}:${point.period.key ?? point.period.value ?? point.row_index}` })))
  const title = block.title ?? block.value_label
  const current = points.find(item => item.key === selected)
  const coordinates = points.flatMap(({ point }) => point.coordinate ? [point.coordinate.value] : [])
  const first = Math.min(...coordinates), last = Math.max(...coordinates)
  const right = chartWidth - 20
  const x = (value: number) => first === last ? (54 + right) / 2 : 54 + (value - first) / (last - first) * (right - 54)
  const y = (value: number) => 180 - (value - data.min) / (data.max - data.min || 1) * 155
  const periods = [...new Map(points.filter(item => item.point.coordinate).map(item => [item.point.coordinate!.value, item.point])).values()].sort((a, b) => a.coordinate!.value - b.coordinate!.value)
  const tickCount = Math.min(chartWidth < 480 ? 3 : 4, periods.length)
  const tickIndices = new Set(Array.from({ length: tickCount }, (_, index) => Math.round(index * (periods.length - 1) / Math.max(1, tickCount - 1))))
  const source = ({ series, point }: typeof points[number]) => <FactSourceLink fact={point.fact ? { ...point.fact, period: point.fact.period ?? point.period, unit: point.fact.unit ?? series.unit ?? block.unit, currency: point.fact.currency ?? series.currency ?? block.currency } : undefined} sourceIndex={analysis?.source_index} collection={series.collection} rowIndex={point.row_index} relativePointer={series.value_pointer} />
  const value = ({ series, point }: typeof points[number]) => <FactValue locale={locale} fact={point.fact ? { ...point.fact, unit: point.fact.unit ?? series.unit ?? block.unit, currency: point.fact.currency ?? series.currency ?? block.currency } : undefined} />
  const gapLabel = (gap?: string) => gap === 'source_pending' ? (nl ? 'Bronresultaat volgt nog' : 'Source result pending') : gap === 'source_failed' ? (nl ? 'Bron niet beschikbaar' : 'Source unavailable') : nl ? 'Niet beschikbaar in de bron' : 'Unavailable in source'
  return <section aria-label={title} className="min-w-0 max-w-full space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h3 className="font-medium">{title}</h3>
      {data.compatible && <div role="group" aria-label={nl ? 'Resultaatweergave' : 'Result view'} className="inline-flex rounded-lg border border-border-2 p-0.5">
        {(['chart', 'table'] as const).map(option => <button key={option} type="button" aria-pressed={view === option} onClick={() => setView(option)} className={`min-h-8 rounded-md px-3 text-tiny focus-visible:outline-2 focus-visible:outline-ring ${view === option ? 'bg-hover text-foreground' : 'text-muted'}`}>{option === 'chart' ? nl ? 'Grafiek' : 'Chart' : nl ? 'Tabel' : 'Table'}</button>)}
      </div>}
    </div>
    <p className="text-tiny text-muted">{[block.value_label, block.currency?.value, block.unit?.value].filter(Boolean).join(' · ')}</p>
    {showChart ? <>
      <figure aria-label={`${title} · ${nl ? 'lijngrafiek' : 'line chart'}`} className="rounded-xl border border-border-2 bg-surface p-3">
        <svg ref={chartRef} viewBox={`0 0 ${chartWidth} 225`} className="block w-full" role="group" aria-label={nl ? 'Selecteer een meetpunt voor de bron' : 'Select a data point for its source'}>
          {[data.min, data.max].map((tick, index) => <g key={index}><line x1="54" x2={right} y1={y(tick)} y2={y(tick)} stroke="var(--border-2)" /><text x="46" y={y(tick) + 4} textAnchor="end" fontSize="12" fill="var(--muted)">{new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 1 }).format(tick)}</text></g>)}
          {periods.map((point, index) => tickIndices.has(index) && <text key={index} x={x(point.coordinate!.value)} y="210" textAnchor={index === 0 ? 'start' : index === periods.length - 1 ? 'end' : 'middle'} fontSize="12" fill="var(--muted)">{point.period.value ?? point.period.key}</text>)}
          {data.series.map((series, si) => {
            let previous: number | null = null
            const commands = series.points.map(point => {
              const coordinate = point.coordinate!.value
              if (point.gap || typeof point.fact?.value !== 'number' || !Number.isFinite(point.fact.value)) { previous = null; return '' }
              const command = previous != null && coordinate - previous === 1 ? 'L' : 'M'
              previous = coordinate
              return `${command}${x(coordinate)},${y(point.fact.value)}`
            }).join(' ')
            return <path key={series.id} data-series={series.id} d={commands} fill="none" stroke={colors[si % colors.length]} strokeWidth="2" strokeDasharray={si >= colors.length ? '5 4' : undefined} />
          })}
          {points.map(item => {
            const { point, series, key } = item
            if (point.gap || typeof point.fact?.value !== 'number' || !Number.isFinite(point.fact.value)) return null
            const label = `${series.label} · ${point.period.value ?? point.period.key}: ${point.fact.value}`
            return <g key={key} role="button" tabIndex={0} aria-label={label} aria-pressed={selected === key} onFocus={() => setSelected(key)} onClick={() => setSelected(key)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(key) } }} className="cursor-pointer focus:outline-none">
              <circle cx={x(point.coordinate!.value)} cy={y(point.fact.value)} r="12" fill="transparent" />
              <circle cx={x(point.coordinate!.value)} cy={y(point.fact.value)} r={selected === key ? '6' : '4'} fill={colors[data.series.indexOf(series) % colors.length]} stroke="var(--background)" strokeWidth="2" />
              <title>{label}</title>
            </g>
          })}
        </svg>
        <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-tiny text-muted">{data.series.map((series, index) => <span key={series.id} className="inline-flex items-center gap-1.5"><span aria-hidden="true" className="size-2 rounded-full" style={{ background: colors[index % colors.length] }} />{series.label}</span>)}</figcaption>
      </figure>
      <p className="text-tiny text-muted">{nl ? 'Selecteer een meetpunt voor waarde en bron. Ontbrekende perioden worden niet doorverbonden.' : 'Select a point for its value and source. Missing periods are not connected.'}</p>
      {current && <div aria-live="polite" className="border-l-2 border-accent pl-3 text-body"><p className="text-tiny text-muted">{current.series.label} · {current.point.period.value ?? current.point.period.key}</p>{value(current)}{source(current)}</div>}
    </> : <>
      {!data.compatible && <p className="text-tiny text-muted">{nl ? 'De beschikbare perioden of waarden kunnen niet betrouwbaar op één grafiek worden vergeleken. De brongegevens staan hieronder.' : 'The available periods or values cannot be reliably compared on one chart. The source data is shown below.'}</p>}
      <ResultTable label={`${title} ${nl ? 'tabel' : 'table'}`} layout="table" columns={nl ? ['Reeks', 'Periode', block.value_label] : ['Series', 'Period', block.value_label]} rows={points.map(item => [item.series.label, item.point.period.value ?? item.point.period.key ?? (nl ? 'Onbekend' : 'Unknown'), <>{item.point.gap ? <span className="text-muted">{gapLabel(item.point.gap)}</span> : value(item)}{source(item)}</>])} />
    </>}
  </section>
}
