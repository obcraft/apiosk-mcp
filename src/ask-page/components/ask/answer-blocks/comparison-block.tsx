import type { BlockOf } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { ResultTable } from '@/components/response/result-table'
import { FactSourceLink, FactValue } from './fact-value'
import { useAnswerEvidence } from '../answer-evidence-context'

export function ComparisonBlockView({ block, analysis }: { block: BlockOf<'comparison'>; analysis?: GatewayV2Analysis | null }) {
  const { locale } = useAnswerEvidence()
  const nl = locale === 'nl-NL'
  const title = block.title ?? (nl ? 'Vergelijking' : 'Comparison')
  return <section aria-label={title} className="min-w-0 max-w-full space-y-3">
    <h3 className="font-medium">{title}</h3>
    <ResultTable label={title} layout="table" columns={[nl ? 'Kenmerk' : 'Feature', ...block.entities.map(entity => entity.label)]} rows={block.rows.map(row => [
      <>{row.label}{row.basis?.comparable === false && <span className="mt-1 block text-tiny text-muted">{nl ? 'Niet rechtstreeks vergelijkbaar' : 'Not directly comparable'}</span>}</>,
      ...row.cells.map(fact => <><FactValue fact={fact} locale={locale} />{(fact?.period?.value ?? fact?.period?.key) && <span className="block text-tiny text-muted">{fact?.period?.value ?? fact?.period?.key}</span>}{fact?.unit?.value && <span className="block text-tiny text-muted">{fact.unit.value}</span>}<FactSourceLink fact={fact} sourceIndex={analysis?.source_index} /></>),
    ])} />
  </section>
}
