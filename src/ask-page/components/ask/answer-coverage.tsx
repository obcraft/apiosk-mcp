import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { coverageLabels, coverageReasons, requirementCoverage } from '@/lib/domain/answer-coverage'
import { EvidenceCitation } from './answer-evidence'
import { useAnswerEvidence } from './answer-evidence-context'

export function AnswerCoverage({ analysis }: { analysis?: GatewayV2Analysis | null }) {
  const { locale } = useAnswerEvidence()
  const language = locale === 'nl-NL' ? 1 : 0
  const nl = language === 1
  const requirements = analysis?.completeness?.requirements ?? []
  const missing = analysis?.missing_information ?? []
  if (!requirements.length && !missing.length) return null
  const answered = requirements.filter(item => item.status === 'answered').length
  const applicable = requirements.filter(item => item.status !== 'not_applicable').length
  const gaps = requirements.some(item => !['answered', 'not_applicable'].includes(item.status)) || missing.length > 0
  const summary = applicable ? nl ? `${answered} van ${applicable} onderdelen beantwoord` : `${answered} of ${applicable} items answered`
    : nl ? 'Wat is onderzocht' : 'What was checked'
  const title = nl ? 'Dekking van je vraag' : 'Question coverage'
  const description = (criterion: string) => {
    // Capability keys are internal identifiers, not useful criterion labels.
    const known: Record<string, [string, string]> = {
      'company.financial-statements': ['Financial statements', 'Jaarrekeningen'],
      'company.profile': ['Company profile', 'Bedrijfsprofiel'],
    }
    return known[criterion]?.[language] ?? criterion.replace(/[._-]+/g, ' ')
  }
  return <section aria-label={title} className="min-w-0 border-t border-border-2 pt-4">
    <details open={gaps}>
      <summary className="w-fit cursor-pointer text-body font-medium">{summary}</summary>
      <ul className="mt-3 space-y-3">{requirements.map(item => {
        const status = requirementCoverage(item)
        const related = missing.filter(point => point.requirement_ids.includes(item.id) || item.missing_ids?.includes(point.id))
        return <li key={item.id} className="text-body">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <span>{[item.subject_label, description(item.criterion), item.period].filter(Boolean).join(' · ')}</span>
            <span className={`text-tiny ${status === 'answered' ? 'text-foreground' : 'text-muted'}`}>{coverageLabels[status][language]}</span>
          </div>
          {item.reason && coverageReasons[item.reason] && <p className="mt-1 text-tiny text-muted">{coverageReasons[item.reason][language]}</p>}
          {related.map(point => <p key={point.id} className="mt-1 text-tiny text-muted">{point.description}</p>)}
          {item.evidence?.length ? <EvidenceCitation facts={item.evidence} /> : null}
        </li>
      })}</ul>
      {missing.filter(point => !requirements.some(item => point.requirement_ids.includes(item.id) || item.missing_ids?.includes(point.id))).map(point => <p key={point.id} className="mt-3 text-tiny text-muted">{point.description}</p>)}
    </details>
  </section>
}
