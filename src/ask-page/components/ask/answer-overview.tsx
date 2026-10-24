import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import type { AnswerOverviewModel } from '@/lib/domain/answer-overview'
import { useAnswerEvidence } from './answer-evidence-context'
import { AnswerCoverage } from './answer-coverage'
import { StreamingReply } from './streaming-reply'

export function AnswerOverview({ overview, analysis }: { overview: AnswerOverviewModel; analysis?: GatewayV2Analysis | null }) {
  const { locale, results } = useAnswerEvidence()
  const nl = locale === 'nl-NL'
  const context = { results, analysis }
  const leadTitle = nl ? 'Kort antwoord' : 'Answer in brief'
  const findingsTitle = nl ? 'Belangrijkste bevindingen' : 'Key findings'
  const notesTitle = nl ? 'Open punten en beperkingen' : 'Open points and limitations'
  return <div className="min-w-0 space-y-5">
    <section aria-label={leadTitle} className="space-y-2">
      <h3 className="text-body font-medium">{leadTitle}</h3>
      <StreamingReply text={overview.lead.text} evidence={[overview.lead]} nameContext={context} />
      {overview.partial && <p className="text-tiny text-muted">{nl ? 'Gedeeltelijk antwoord op basis van de beschikbare gegevens.' : 'Partial answer based on the available information.'}</p>}
    </section>
    {overview.findings && <section aria-label={findingsTitle} className="space-y-2">
      <h3 className="text-body font-medium">{findingsTitle}</h3>
      <StreamingReply text={overview.findings} evidence={overview.evidence} nameContext={context} />
    </section>}
    {(overview.notes || overview.hasGaps) && <section aria-label={notesTitle} className="space-y-2">
      <h3 className="text-body font-medium">{notesTitle}</h3>
      {overview.notes && <StreamingReply text={overview.notes} nameContext={context} className="text-body text-muted" />}
      {overview.hasGaps && <AnswerCoverage analysis={analysis} />}
    </section>}
    {!overview.hasGaps && <AnswerCoverage analysis={analysis} />}
  </div>
}
