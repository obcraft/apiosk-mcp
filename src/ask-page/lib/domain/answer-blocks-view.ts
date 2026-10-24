/**
 * Pure helpers for rendering the versioned blocks[] answer (backlog #55).
 * No JSX and no React state here: components own presentation, these
 * functions own selection, sorting, filtering, scale and CSV.
 */
import type { GatewayV2Analysis } from './gateway-v2'
import { escapeCsvCell } from './answer-presentation'
import type {
  AnswerBlock, BarChartBlock, Collection, DataTableBlock, Fact, RankingScope, Scale,
  SortSpec, TableColumn, TableRow,
} from './answer-blocks'

/** `(analysis.answer_schema_version ?? 1) >= 2 && Array.isArray(analysis.blocks)`, per the compatibility rule in design 4.1. */
export function isBlocksAnswer(analysis?: GatewayV2Analysis | null): analysis is GatewayV2Analysis & { blocks: AnswerBlock[] } {
  return Boolean(analysis) && (analysis!.answer_schema_version ?? 1) >= 2 && Array.isArray(analysis!.blocks)
}

export interface FactOrigin { result_ref: string; pointer: string }

/**
 * A Fact's evidence origin. Explicit mode carries its own `result_ref` and
 * `pointer`; collection mode omits both and the origin is implied by
 * `collection.result_ref` + `{rows_pointer}/{row_index}{relative pointer}`
 * (design 2.2). A derivation-only Fact has no source document to link to.
 */
export function factOrigin(fact: Fact | null | undefined, collection?: Collection, rowIndex?: number, relativePointer?: string): FactOrigin | null {
  if (fact?.result_ref && fact.pointer != null) return { result_ref: fact.result_ref, pointer: fact.pointer }
  if (collection && rowIndex != null && relativePointer) return { result_ref: collection.result_ref, pointer: `${collection.rows_pointer}/${rowIndex}${relativePointer}` }
  return null
}

/** Sorts the complete selected set of rows, nulls always last regardless of direction, before any paging happens. */
export function sortTableRows(columns: TableColumn[], rows: TableRow[], sort?: SortSpec): TableRow[] {
  if (!sort) return rows
  const index = columns.findIndex(c => c.id === sort.column_id)
  if (index < 0) return rows
  const direction = sort.direction === 'asc' ? 1 : -1
  const key = (row: TableRow) => row.cells[index]?.value ?? null
  return [...rows].sort((a, b) => {
    const av = key(a), bv = key(b)
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction
    return String(av).localeCompare(String(bv)) * direction
  })
}

/** A simple text filter over every visible cell's raw value. */
export function filterTableRows(rows: TableRow[], query: string): TableRow[] {
  const q = query.trim().toLowerCase()
  if (!q) return rows
  return rows.filter(row => row.cells.some(cell => cell?.value != null && String(cell.value).toLowerCase().includes(q)))
}

/**
 * Source-faithful CSV of a data_table block: raw `value`s (never a display
 * string), hidden columns excluded, null cells empty. Reuses the legacy
 * table's escaping so both exports treat formula prefixes the same way.
 */
export function dataTableCsv(block: Pick<DataTableBlock, 'columns' | 'rows'>): string {
  const visible = block.columns.map((column, index) => ({ column, index })).filter(c => !c.column.hidden)
  const header = visible.map(c => c.column.label)
  const rows = block.rows.map(row => visible.map(c => row.cells[c.index]?.value ?? ''))
  return '﻿' + [header, ...rows].map(r => r.map(escapeCsvCell).join(',')).join('\r\n')
}

/**
 * The bar chart's scale, fixed over every bar the server selected (design
 * 3.3): `{min: min(0, values), max: max(0, values)}`. Revealing more bars
 * with "Show more" never touches this, because it is never recomputed from
 * a visible slice.
 */
export function barScale(block: BarChartBlock): Scale {
  if (block.scale) return block.scale
  const values = block.bars.map(bar => typeof bar.fact?.value === 'number' ? bar.fact.value : null).filter((v): v is number => v != null)
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) }
}

export function rankingScopeLabel(scope: RankingScope): string {
  if (scope === 'total_available') return 'ranked across every available result'
  if (scope === 'fetched') return 'ranked across every fetched result'
  return 'ranked across the selected results'
}

/** One fact the generic block fallback can show as a labeled table row. */
export interface BlockFactRow { label: string; fact: Fact | null; collection?: Collection; rowIndex?: number; relativePointer?: string }

function labelOf(label: string | undefined, fact: Fact | undefined, id: string): string {
  if (label) return label
  if (fact?.value != null) return String(fact.value)
  return id
}

/**
 * Every kind's facts, flattened to `{label, fact}` rows with enough of the
 * originating collection to resolve evidence, so the generic fallback (and
 * unknown future kinds) can always render a block as a table (design 5,
 * "accessible generic fallback").
 */
export function blockFacts(block: AnswerBlock): BlockFactRow[] {
  switch (block.kind) {
    case 'narrative':
      return []
    case 'summary':
      return (block.conclusion?.facts ?? []).map((fact, i) => ({ label: `Fact ${i + 1}`, fact }))
    case 'data_table':
      return block.rows.flatMap((row, ri) => block.columns.map((column, ci) => ({
        label: column.label, fact: row.cells[ci], collection: block.collection, rowIndex: row.row_index ?? block.collection?.row_indices[ri] ?? ri, relativePointer: column.pointer,
      })))
    case 'comparison':
      return block.rows.flatMap(row => row.cells.map((fact, i) => ({ label: `${row.label} — ${block.entities[i]?.label ?? ''}`, fact })))
    case 'kpi':
      return block.cards.flatMap(card => [
        { label: card.label, fact: card.fact },
        ...(card.change ? [{ label: `${card.label} (baseline)`, fact: card.change.baseline }] : []),
      ])
    case 'line_chart':
      return block.series.flatMap(series => series.points.map((point, pi) => ({
        label: `${series.label} — ${point.period.key ?? point.period.value ?? ''}`, fact: point.fact ?? null,
        collection: series.collection, rowIndex: point.row_index ?? series.collection?.row_indices[pi] ?? pi, relativePointer: series.value_pointer,
      })))
    case 'bar_chart':
      return block.bars.map((bar, bi) => ({
        label: labelOf(bar.label, bar.label_fact, `Bar ${bi + 1}`), fact: bar.fact ?? null,
        collection: block.collection, rowIndex: bar.row_index ?? block.collection?.row_indices[bi] ?? bi, relativePointer: block.value_pointer,
      }))
    case 'map':
      return block.features.flatMap(feature => feature.facts.map(lf => ({
        label: `${labelOf(feature.label, feature.label_fact, feature.id)} — ${lf.label}`, fact: lf.fact ?? null,
        collection: block.collection, rowIndex: feature.row_index,
      })))
    case 'timeline':
      return block.events.flatMap(event => [
        { label: `${labelOf(event.label, event.label_fact, event.id)} — date`, fact: event.date ?? null, collection: block.collection, rowIndex: event.row_index, relativePointer: block.date_pointer },
        ...event.facts.map(lf => ({ label: `${labelOf(event.label, event.label_fact, event.id)} — ${lf.label}`, fact: lf.fact ?? null, collection: block.collection, rowIndex: event.row_index })),
      ])
    case 'profile':
      return [
        ...(block.name ? [{ label: 'Name', fact: block.name }] : []),
        ...block.identifiers.map(lf => ({ label: lf.label, fact: lf.fact ?? null })),
        ...(block.status ? [{ label: block.status.label, fact: block.status.fact ?? null }] : []),
        ...block.attributes.map(lf => ({ label: lf.label, fact: lf.fact ?? null })),
      ]
    case 'relationship':
      return block.edges.flatMap(edge => edge.evidence.map((fact, i) => ({ label: `${edge.label} (${i + 1})`, fact })))
  }
}
