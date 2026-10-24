import type { GatewayV2Analysis } from './gateway-v2'
import { answerLocale, formatAnswerObservation, observationPeriod } from './answer-format'

const genericLimitations = new Set([
  'Some requested source calls did not return usable data. This analysis is incomplete.',
  'Some source information is unavailable. The answer uses the available results.',
  'The returned source response contains no usable records for this question. No finding can be supported from it.',
])

/** Missing source fields are already explained in the answer. A useful partial
 * answer does not need another question asking the person to fill that gap.
 * Keep real clarification questions and legacy answers without coverage data.
 */
export function answerFollowUp(analysis: GatewayV2Analysis): string | null | undefined {
  const requirements = analysis.completeness?.requirements
  const unknown = Array.isArray(requirements) ? requirements.filter(item => item.status === 'unknown') : []
  if (analysis.observations.some(item => item.evidence.length > 0)
    && unknown.length > 0 && unknown.every(item => item.reason === 'not_in_source')) return null
  return analysis.follow_up_question
}

export function answerNotes(analysis: GatewayV2Analysis): string[] {
  return [...analysis.limitations.filter(text => text.trim() && !genericLimitations.has(text)), ...(answerFollowUp(analysis) ? [answerFollowUp(analysis)!] : [])]
}

/** Keep specific coverage caveats in the answer; show execution detail in the drawer. */
export function answerText(analysis?: GatewayV2Analysis | null, context?: {results: unknown[]; question: string; compact?: boolean}): string {
  if (!analysis) return ''
  if (context) {
    const locale = answerLocale(context.question, analysis), nl = locale === 'nl-NL'
    const observations = analysis.observations.filter(o => o.text.trim())
    const limitations = analysis.limitations.filter(text => text.trim() && !genericLimitations.has(text))
    const structured = observations.length > 1 && !/\b(one sentence|single sentence|één zin|een zin)\b/i.test(context.question)
    const blocks: string[] = []
    let previousHeading: string | null = null
    for (const observation of observations) {
      if (structured) {
        const period = observationPeriod(observation, context.results)
        const heading = period ? `${nl ? 'Verslagperiode' : 'Reporting period'} ${period}` : nl ? 'Belangrijkste bevindingen' : 'Key findings'
        // Keep a scope change after a dated group explicit; an undated finding
        // must not look as if it belongs to the preceding reporting period.
        if (heading !== previousHeading && (period || !context.compact || previousHeading !== null)) blocks.push(`## ${heading}`)
        previousHeading = heading
      }
      blocks.push(formatAnswerObservation(observation, context.results, locale))
    }
    if (limitations.length) {
      if (observations.length && !context.compact) blocks.push(`## ${nl ? 'Bronnen en beperkingen' : 'Source notes'}`)
      blocks.push(...new Set(limitations))
    }
    const next = answerFollowUp(analysis)
    if (next) blocks.push(next)
    return blocks.length ? blocks.join('\n\n') : [...new Set(analysis.limitations)].join('\n\n')
  }
  const specific = [
    ...analysis.observations.map(observation => observation.text),
    ...analysis.limitations.filter(text => !genericLimitations.has(text)),
    ...(answerFollowUp(analysis) ? [answerFollowUp(analysis)!] : []),
  ].filter(text => text.trim())
  return [...new Set(specific.length ? specific : analysis.limitations)].join('\n\n')
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** Explain saved calls made before postcode-area search was corrected, without rewriting data. */
export function postcodeSearchIssue(results: unknown[]): { text: string; question: string } | null {
  if (results.length !== 1) return null
  const result = record(results[0])
  const source = record(result.source)
  const data = record(result.data ?? result.preview_data)
  if (source.provider !== 'overheid-io' || source.path !== '/bag' || data.totalItemCount !== 0) return null
  const href = record(record(data._links).self).href
  if (typeof href !== 'string') return null
  let url: URL
  try { url = new URL(href, 'https://api.overheid.io') } catch { return null }
  const postcode = url.searchParams.get('filters[postcode]')
  if (!postcode || !/^[1-9][0-9]{3}$/.test(postcode) || url.searchParams.has('query')) return null
  return {
    text: `This search treated ${postcode} as a full postcode, so Overheid.io returned no matches. Search the postcode area to find its addresses.`,
    question: `Find addresses in postcode area ${postcode} using Overheid.io.`,
  }
}
