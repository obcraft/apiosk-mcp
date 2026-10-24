import { useState } from 'react'
import { Button } from '@/components/ui/button'
import type { BlockOf } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { barScale, rankingScopeLabel } from '@/lib/domain/answer-blocks-view'
import { FactSourceLink, FactValue } from './fact-value'

const PAGE_SIZE = 10

/**
 * `bar_chart` (backlog #49). The scale is fixed over every selected bar
 * (`barScale`, design 3.3), never over the bars currently shown, so
 * "Show more" only reveals more bars and never rescales the ones already
 * on screen. A bar with no numeric value draws no bar and reads Unknown.
 */
export function BarChartBlockView({ block, analysis }: { block: BlockOf<'bar_chart'>; analysis?: GatewayV2Analysis | null }) {
  const [shown, setShown] = useState(PAGE_SIZE)
  const scale = barScale(block)
  const range = (scale.max - scale.min) || 1
  const zero = (0 - scale.min) / range * 100
  const bars = block.bars.slice(0, shown)
  const sourceIndex = analysis?.source_index ?? []

  return <figure aria-label={block.title ?? block.value_label} className="min-w-0 max-w-full space-y-3 rounded-lg border border-border-2 bg-surface p-3">
    <figcaption className="answer-section-title">
      {block.title ?? block.value_label}
      {block.ranking && <span className="mt-0.5 block text-tiny font-normal text-muted">
        {block.ranking.direction === 'desc' ? 'Highest first, ' : 'Lowest first, '}{rankingScopeLabel(block.ranking.scope)}.
      </span>}
    </figcaption>
    {bars.map((bar, i) => {
      const value = typeof bar.fact?.value === 'number' ? bar.fact.value : null
      const end = value == null ? zero : (value - scale.min) / range * 100
      const label = bar.label ?? (bar.label_fact?.value != null ? String(bar.label_fact.value) : `Bar ${i + 1}`)
      return <div key={bar.id} className="space-y-1 text-body" data-build>
        <div className="flex justify-between gap-3">
          <span className="break-words">{bar.rank != null ? `#${bar.rank} ` : ''}{label}</span>
          <span className="shrink-0 tabular-nums"><FactValue fact={bar.fact} /></span>
        </div>
        <div className="relative h-3 rounded bg-[color:var(--accent-wash)]" aria-hidden="true">
          <span className="absolute inset-y-0 w-px bg-muted" style={{ left: `${zero}%` }} />
          {value != null && <span className="absolute inset-y-0 rounded bg-[color:var(--accent)]" style={{ left: `${Math.min(zero, end)}%`, width: `${Math.abs(end - zero)}%` }} />}
        </div>
        <FactSourceLink fact={bar.fact} sourceIndex={sourceIndex} collection={block.collection} rowIndex={bar.row_index ?? block.collection?.row_indices[i] ?? i} relativePointer={block.value_pointer} />
      </div>
    })}
    {shown < block.bars.length && <Button type="button" variant="ghost" size="sm" onClick={() => setShown(n => n + PAGE_SIZE)}>Show more bars ({block.bars.length - shown} remaining)</Button>}
  </figure>
}
