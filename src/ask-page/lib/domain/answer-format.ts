import type { GatewayV2Analysis } from './gateway-v2'
import type { Fact } from './answer-blocks'
import { formatSourceValue, sourceCurrency } from './source-value-format'

type Evidence = GatewayV2Analysis['observations'][number]['evidence'][number]
type Observation = GatewayV2Analysis['observations'][number]
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const periodKeys = ['fiscal_year', 'financial_year', 'year', 'fiscalYear', 'financialYear', 'period_end', 'periodEnd', 'fiscal_year_end', 'financialYearEnd', 'reporting_year', 'date_fin_exercice']

export function answerLocale(question: string, analysis?: GatewayV2Analysis | null): string {
  // Source names, activity descriptions and quotations keep their original
  // language. They must not decide the headings or number format of the answer.
  const narrative = analysis?.observations.map(observation => {
    const sourceText = observation.evidence.map(e => e.value)
      .filter((value): value is string => typeof value === 'string' && value.length >= 3)
      .sort((a, b) => b.length - a.length)
    return sourceText.reduce((text, value) => text.replaceAll(value, ' '), observation.text)
  }).join(' ') || analysis?.blocks?.flatMap(block => block.kind === 'summary' && !block.provisional ? [block.conclusion?.text ?? ''] : []).join(' ') || ''
  const detect = (text: string): string | null => {
    const prose = text.replace(/https?:\/\/\S+|"[^"\n]*"|“[^”\n]*”/g, ' ')
    const dutch = new Set(prose.match(/\b(de|het|een|zijn|voor|van|heeft|bedraagt|volgens|toont|werden|en|is|dit|deze|wordt|met|geen|niet|kan|kun|welke|geef)\b/gi)?.map(word => word.toLowerCase()))
    const english = new Set(prose.match(/\b(the|a|an|are|for|of|has|have|according|shows|were|and|is|this|these|with|no|not|can|could|which|what|show|get)\b/gi)?.map(word => word.toLowerCase()))
    if (dutch.size >= 2 && dutch.size > english.size) return 'nl-NL'
    if (english.size >= 2 && english.size > dutch.size) return 'en-US'
    return null
  }
  return detect(narrative) ?? detect(question) ?? 'en-US'
}

/** Resolve units next to the exact cited field, never from another result or year.
 * The source and the saved scalar remain untouched, including large decimal strings. */
export function answerValueContext(evidence: Pick<Evidence, 'result_ref' | 'pointer'>, results: unknown[]) {
  const doc = results.map(record).find(d => d.result_ref === evidence.result_ref)
  const parents: Record<string, unknown>[] = []
  let node: unknown = doc && {...doc, data: doc.data ?? doc.preview_data}
  for (const part of evidence.pointer.split('/').slice(1)) {
    if (!Array.isArray(node)) parents.unshift(record(node))
    node = node != null && typeof node === 'object' ? (node as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined
  }
  // The saved envelope currency prices the API call, not the source's data.
  // A source value may inherit units only from within that returned data.
  const sourceParents = /^\/(?:data|preview_data)(?:\/|$)/.test(evidence.pointer) ? parents.slice(0, -1) : parents
  const currencyOwner = sourceParents.find(p => p.currency != null || p.currencyCode != null || p.unit != null)
  const period = parents.flatMap(p => periodKeys.map(k => p[k])).find(v => /^(?:19|20)\d{2}(?:-\d{2}-\d{2})?$/.test(String(v)))
  return {currency: sourceCurrency(currencyOwner), period: period == null ? null : String(period), field: String(parents[0]?.key ?? evidence.pointer.split('/').at(-1) ?? '')}
}

export function formatAnswerObservation(observation: Observation, results: unknown[], locale: string): string {
  return formatAnswerFacts(observation.text, observation.evidence.map(evidence => {
    const context = answerValueContext(evidence, results)
    const parent = evidence.pointer.slice(0, evidence.pointer.lastIndexOf('/'))
    const currency = context.currency ?? sourceCurrency(observation.evidence.find(e => e.result_ref === evidence.result_ref && e.pointer === `${parent}/currency`)?.value)
    return { ...evidence, source: evidence.source?.name, field: evidence.field ?? context.field, currency: currency ? { value: currency } : undefined }
  }), results, locale)
}

/** Format only the exact saved scalars cited by a conclusion, including derived facts. */
export function formatAnswerFacts(text: string, facts: Fact[], results: unknown[], locale: string): string {
  const values = new Map<string, {display: string; field: string; currency: string | null} | null>()
  for (const fact of facts) {
    const raw = String(fact.value)
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) continue
    const context = fact.result_ref && fact.pointer ? answerValueContext({ result_ref: fact.result_ref, pointer: fact.pointer }, results) : null
    const currency = fact.currency?.value ?? context?.currency ?? null
    const field = fact.field ?? context?.field ?? (currency ? 'Amount' : '')
    const display = formatSourceValue(fact.value, field, currency, undefined, locale)
    // Equal scalars can mean different things (a year, amount, or identifier).
    // With no original template, an ambiguous occurrence stays literal.
    const previous = values.get(raw)
    values.set(raw, values.has(raw) && previous?.display !== display ? null : {display, field, currency})
  }
  const codes = 'EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK'
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_/@.:$€£+\\-])(?:(${codes}|[$€£])\\s*)?(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?)(?:\\s*(${codes})(?!\\p{L}))?(?![\\p{L}\\p{N}_/@]|[.:,\\-]\\d)`, 'gu')
  return text.replace(pattern, (match, prefix: string | undefined, raw: string, suffix: string | undefined) => {
    const value = values.get(raw)
    if (!value) return match
    const explicit = prefix ?? suffix
    if (explicit) {
      const code = ({'$': 'USD', '€': 'EUR', '£': 'GBP'} as Record<string, string>)[explicit] ?? explicit
      if (value.currency && value.currency !== code) return match
      return formatSourceValue(raw, 'Amount', code, undefined, locale)
    }
    return value.display
  })
}

/** A heading may describe only a period actually cited by this observation. */
export function observationPeriod(observation: Observation, results: unknown[]): string | null {
  const periods = observation.evidence.flatMap(e => {
    const key = (e.field ?? e.pointer).split('/').at(-1) ?? ''
    if (periodKeys.some(k => k.toLowerCase() === key.toLowerCase()) && /^(?:19|20)\d{2}(?:-\d{2}-\d{2})?$/.test(String(e.value))) return [String(e.value)]
    const context = answerValueContext(e, results)
    return context.period ? [context.period] : []
  })
  const unique = [...new Set(periods)]
  return unique.length === 1 ? unique[0] : null
}
