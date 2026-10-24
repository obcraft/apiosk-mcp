import type { AnswerBlock, AnswerBlockKind } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { BarChartBlockView } from './bar-chart-block'
import { DataTableBlockView } from './data-table-block'
import { GenericBlockView } from './generic-block'
import { LineChartBlockView } from './line-chart-block'
import { TimelineBlockView } from './timeline-block'
import { ComparisonBlockView } from './comparison-block'

type BlockRenderer = (props: { block: AnswerBlock; analysis?: GatewayV2Analysis | null }) => React.JSX.Element

/**
 * The kind registry (backlog #55): an allowlist keyed by `kind`. Kinds with
 * no dedicated component here, and any kind the App does not recognize yet
 * (forward compatibility, design 4.1.7), fall through to `GenericBlockView`,
 * the permanent accessible fallback. Other lanes register their own kinds
 * here without touching the renderers already present.
 */
const REGISTRY: Partial<Record<AnswerBlockKind, BlockRenderer>> = {
  data_table: DataTableBlockView as BlockRenderer,
  bar_chart: BarChartBlockView as BlockRenderer,
  line_chart: LineChartBlockView as BlockRenderer,
  timeline: TimelineBlockView as BlockRenderer,
  comparison: ComparisonBlockView as BlockRenderer,
}

export function AnswerBlockView({ block, analysis }: { block: AnswerBlock; analysis?: GatewayV2Analysis | null }) {
  const Renderer = REGISTRY[block.kind] ?? GenericBlockView
  return <Renderer block={block} analysis={analysis} />
}

export function AnswerBlocksList({ blocks, analysis }: { blocks: AnswerBlock[]; analysis?: GatewayV2Analysis | null }) {
  if (!blocks.length) return null
  return <div className="min-w-0 max-w-full space-y-4" aria-label="Answer data">
    {blocks.map(block => <AnswerBlockView key={block.id} block={block} analysis={analysis} />)}
  </div>
}
