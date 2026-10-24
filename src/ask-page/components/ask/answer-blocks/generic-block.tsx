import type { AnswerBlock } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { blockFacts } from '@/lib/domain/answer-blocks-view'
import { FactSourceLink, FactValue } from './fact-value'
import { ResultTable } from '@/components/response/result-table'

/**
 * The permanent fallback renderer: any block's facts as an accessible
 * table with evidence links. Used for every kind that has no dedicated
 * component yet, and for kinds the App does not recognize (design 4.1
 * forward compatibility and design 5, "accessible generic fallback").
 */
export function GenericBlockView({ block, analysis }: { block: AnswerBlock; analysis?: GatewayV2Analysis | null }) {
  const rows = blockFacts(block)
  const sourceIndex = analysis?.source_index ?? []
  const title = block.title ?? block.kind.replace('_', ' ')
  return <section aria-label={title} className="min-w-0 max-w-full space-y-2">
    <h3 className="font-medium capitalize">{title}</h3>
    {!rows.length
      ? <p className="text-body text-muted">No details to show for this {block.kind.replace('_', ' ')}.</p>
      : <ResultTable
        label={`${title} facts`}
        columns={['Field', 'Value', 'Source']}
        layout="table"
        rows={rows.map(row => [
          row.label,
          <FactValue fact={row.fact} />,
          <FactSourceLink fact={row.fact} sourceIndex={sourceIndex} collection={row.collection} rowIndex={row.rowIndex} relativePointer={row.relativePointer} />,
        ])}
      />}
  </section>
}
