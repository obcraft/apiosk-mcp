import type { LineChartBlock, PeriodQualifier } from './answer-blocks'

/** Calendar coordinates retain the source's precision; no guessed dates. */
export function periodCoordinate(period: PeriodQualifier): { value: number; kind: string } | null {
  const key = period.key ?? period.value ?? period.start ?? ''
  let match: RegExpMatchArray | null
  if ((match = key.match(/^(\d{4})$/))) return { value: Number(match[1]), kind: 'year' }
  if ((match = key.match(/^(\d{4})-Q([1-4])$/))) return { value: Number(match[1]) * 4 + Number(match[2]) - 1, kind: 'quarter' }
  if ((match = key.match(/^(\d{4})-H([12])$/))) return { value: Number(match[1]) * 2 + Number(match[2]) - 1, kind: 'half_year' }
  if ((match = key.match(/^(\d{4})-(0[1-9]|1[0-2])$/))) return { value: Number(match[1]) * 12 + Number(match[2]) - 1, kind: 'month' }
  if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
    const value = Date.parse(`${key}T00:00:00Z`)
    if (Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === key) return { value: value / 86400000, kind: 'day' }
  }
  return null
}

export function lineChartData(block: LineChartBlock) {
  const series = block.series.map(series => ({ ...series, points: series.points.map((point, index) => ({
    ...point, row_index: point.row_index ?? series.collection?.row_indices[index] ?? index,
    coordinate: periodCoordinate(point.period),
  })).sort((a, b) => (a.coordinate?.value ?? Infinity) - (b.coordinate?.value ?? Infinity)) }))
  const points = series.flatMap(series => series.points)
  const kinds = new Set(points.map(point => point.coordinate?.kind))
  const bases = new Set(series.flatMap(series => series.points.filter(point => point.fact?.value != null).map(point => JSON.stringify([
    point.fact?.unit?.value ?? series.unit?.value ?? block.unit?.value ?? null,
    point.fact?.currency?.value ?? series.currency?.value ?? block.currency?.value ?? null,
  ]))))
  const values = points.flatMap(point => typeof point.fact?.value === 'number' && Number.isFinite(point.fact.value) && !point.gap ? [point.fact.value] : [])
  const duplicates = series.some(series => new Set(series.points.map(point => point.coordinate?.value)).size !== series.points.length)
  const compatible = points.length > 0 && kinds.size === 1 && !kinds.has(undefined) && bases.size <= 1 && !duplicates && values.length > 0
  return { series, compatible, min: Math.min(0, ...values), max: Math.max(0, ...values) }
}
