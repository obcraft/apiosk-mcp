import type { GatewayV2Analysis } from './gateway-v2'
import { safeSourceUrl } from './ask-v2-chats'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const numeric = (value: unknown, max: number): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null
const normalized = (value: unknown) => typeof value === 'string' ? value.trim().normalize('NFKC').toLocaleLowerCase('en-US') : ''

export const employerCategories = [
  ['diversity_and_inclusion_rating', 'Diversity & inclusion', 'Diversiteit en inclusie'],
  ['compensation_and_benefits_rating', 'Compensation & benefits', 'Beloning en arbeidsvoorwaarden'],
  ['career_opportunities_rating', 'Career opportunities', 'Loopbaanmogelijkheden'],
  ['culture_and_values_rating', 'Culture & values', 'Cultuur en waarden'],
  ['work_life_balance_rating', 'Work–life balance', 'Werk-privébalans'],
  ['senior_management_rating', 'Senior management', 'Senior management'],
] as const

export const employerIndicators = [
  ['recommend_to_friend_rating', 'Recommend to a friend', 'Zou het aanbevelen'],
  ['ceo_rating', 'CEO approval', 'Waardering voor de CEO'],
  ['business_outlook_rating', 'Positive business outlook', 'Positieve bedrijfsvooruitzichten'],
] as const

/** Expand only the exact employer already selected in the saved answer.
 * A matching search name alone cannot select an employer or merge candidates.
 * Read the saved body rather than stale citation values; never fetch anything.
 */
export function savedEmployerRatings(results: unknown[], analysis?: GatewayV2Analysis | null) {
  if (!analysis || !['completed', 'partial'].includes(analysis.status)) return []
  const evidence = analysis.observations.flatMap(observation => observation.evidence)
  const references = results.map(value => record(value).result_ref)
  return results.flatMap(value => {
    const result = record(value), source = record(result.source), body = record(result.data ?? result.preview_data)
    const ref = result.result_ref
    if (typeof ref !== 'string' || references.filter(candidate => candidate === ref).length !== 1
      || result.coverage !== 'source_response' || source.provider !== 'openwebninja'
      || source.path !== '/realtime-glassdoor-data/company-search'
      || source.endpoint_id !== '22c6c829-3354-5999-a55d-64ac65128077'
      || body.status !== 'OK' || !Array.isArray(body.data)) return []
    const rows = body.data
    const cited = new Set(evidence.filter(item => item.result_ref === ref).flatMap(item => {
      const match = /^\/data\/data\/(0|[1-9]\d*)\/([^/]+)$/.exec(item.pointer)
      if (!match) return []
      const index = Number(match[1]), row = record(rows[index])
      return Object.is(row[match[2]], item.value) ? [index] : []
    }))
    if (cited.size !== 1) return []
    const index = [...cited][0], company = record(rows[index])
    const name = typeof company.name === 'string' ? company.name.trim() : ''
    if (!name || normalized(record(result.subject).label) !== normalized(name)) return []
    const namesakes = rows.filter(row => normalized(record(row).name) === normalized(name))
    // Search can return different employers with the same name. Only expand
    // one when the saved answer also cites a distinguishing identity field.
    if (namesakes.length > 1 && !evidence.some(item => {
      if (item.result_ref !== ref || !item.pointer.startsWith(`/data/data/${index}/`)) return false
      const field = item.pointer.slice(`/data/data/${index}/`.length)
      return ['company_id', 'company_link', 'headquarters_location', 'stock', 'website'].includes(field)
        && item.value !== '' && item.value != null && Object.is(company[field], item.value)
        && namesakes.filter(row => Object.is(record(row)[field], item.value)).length === 1
    })) return []
    const categories = employerCategories.flatMap(([field, en, nl]) => {
      const score = numeric(company[field], 5)
      return score === null ? [] : [{ field, en, nl, score }]
    })
    const indicators = employerIndicators.flatMap(([field, en, nl]) => {
      const fraction = numeric(company[field], 1)
      return fraction === null ? [] : [{ field, en, nl, fraction }]
    })
    const count = numeric(company.review_count, Number.MAX_SAFE_INTEGER)
    const reviewCount = count !== null && Number.isInteger(count) ? count : null
    if (!categories.length && !indicators.length && reviewCount === null) return []
    const url = (field: string) => safeSourceUrl(typeof company[field] === 'string' ? company[field] : undefined)
    return [{ resultRef: ref, name, index, rating: numeric(company.rating, 5), reviewCount, categories, indicators,
      profileUrl: url('company_link'), reviewsUrl: url('reviews_link'), retrievedAt: typeof source.retrieved_at === 'string' ? source.retrieved_at : null }]
  })
}

export type SavedEmployerRatings = ReturnType<typeof savedEmployerRatings>[number]
