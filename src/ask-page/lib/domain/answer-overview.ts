import type { GatewayV2Analysis } from './gateway-v2'
import type { BlockOf, Fact } from './answer-blocks'
import { isBlocksAnswer } from './answer-blocks-view'
import { answerLocale, formatAnswerFacts, formatAnswerObservation } from './answer-format'
import { answerText, answerNotes } from './gateway-v2-answer'

/** Reorder saved prose only. No synthesis, new source calls or calculated claims. */
export function answerOverview(analysis: GatewayV2Analysis | null | undefined, results: unknown[], question: string) {
  if (!analysis) return null
  const locale = answerLocale(question, analysis)
  const summary = isBlocksAnswer(analysis) && !analysis.provisional
    ? analysis.blocks.find((block): block is BlockOf<'summary'> => block.kind === 'summary' && !block.provisional && Boolean(block.conclusion?.text.trim())) : undefined
  const observations = analysis.observations.filter(item => item.text.trim())
  const observationEvidence = observations.map(item => ({
    text: formatAnswerObservation(item, results, locale),
    facts: item.evidence.map(fact => ({ ...fact, source: fact.source?.name })) as Fact[],
  }))
  const lead = summary?.conclusion
    ? { text: formatAnswerFacts(summary.conclusion.text, summary.conclusion.facts, results, locale), facts: [...summary.conclusion.facts] }
    : observationEvidence[0]
  if (!lead) return null
  const sameText = (text: string) => text.replace(/\s+/g, ' ').trim() === lead.text.replace(/\s+/g, ' ').trim()
  const findings = observations.filter((_, index) => !sameText(observationEvidence[index].text))
  if (summary) lead.facts.push(...observationEvidence.filter(item => sameText(item.text)).flatMap(item => item.facts))
  const findingText = answerText({ ...analysis, observations: findings, limitations: [], follow_up_question: null }, { results, question, compact: true })
  const notes = [...new Set([...answerNotes(analysis), ...(summary?.notes ?? [])].filter(text => text.trim()))].join('\n\n')
  return {
    lead, findings: findingText, evidence: observationEvidence, notes, summaryId: summary?.id,
    partial: analysis.provisional || analysis.status === 'partial' || analysis.completeness?.complete === false || summary?.conclusion?.scope === 'partial',
    hasGaps: Boolean(analysis.missing_information?.length || analysis.completeness?.requirements.some(item => !['answered', 'not_applicable'].includes(item.status))),
  }
}

export type AnswerOverviewModel = NonNullable<ReturnType<typeof answerOverview>>
