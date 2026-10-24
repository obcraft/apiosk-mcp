import type { Requirement } from './answer-blocks'

export type CoverageStatus = 'answered' | 'not_found' | 'not_checked' | 'pending' | 'failed' | 'uncertain' | 'not_applicable'

/** A failed or unperformed lookup is never reported as a negative finding. */
export function requirementCoverage(requirement: Requirement): CoverageStatus {
  if (requirement.status === 'answered') return 'answered'
  if (requirement.status === 'not_applicable') return 'not_applicable'
  if (requirement.status === 'pending' || requirement.reason === 'source_pending') return 'pending'
  if (requirement.reason === 'source_failed') return 'failed'
  if (['not_fetched', 'not_addressed'].includes(requirement.reason ?? '')) return 'not_checked'
  if (['not_in_source', 'period_unavailable'].includes(requirement.reason ?? '')) return 'not_found'
  return 'uncertain'
}

export const coverageLabels: Record<CoverageStatus, [string, string]> = {
  answered: ['Answered', 'Beantwoord'],
  not_found: ['Not found in checked sources', 'Niet gevonden in onderzochte bronnen'],
  not_checked: ['Not yet investigated', 'Nog niet onderzocht'],
  pending: ['Still being investigated', 'Onderzoek loopt nog'],
  failed: ['Source unavailable', 'Bron niet beschikbaar'],
  uncertain: ['Not established', 'Niet vastgesteld'],
  not_applicable: ['Not applicable', 'Niet van toepassing'],
}

export const coverageReasons: Record<string, [string, string]> = {
  not_in_source: ['The checked source does not contain this information.', 'De onderzochte bron bevat deze informatie niet.'],
  period_unavailable: ['The requested period was not available in the checked source.', 'De gevraagde periode was niet beschikbaar in de onderzochte bron.'],
  source_failed: ['The source could not be checked successfully; no conclusion can be drawn.', 'De bron kon niet succesvol worden onderzocht; hierover is geen conclusie mogelijk.'],
  not_fetched: ['The required source data has not been retrieved.', 'De benodigde brongegevens zijn nog niet opgehaald.'],
  not_addressed: ['This part of your question has not been assessed.', 'Dit onderdeel van je vraag is nog niet onderzocht.'],
  source_pending: ['Waiting for the source result.', 'Het bronresultaat is nog niet binnen.'],
  ambiguous_identity: ['The subject could not be identified with certainty.', 'Het onderwerp kon niet met zekerheid worden geïdentificeerd.'],
  entity_mismatch: ['The available data refers to a different subject.', 'De beschikbare gegevens gaan over een ander onderwerp.'],
  period_mismatch: ['The available data covers a different period.', 'De beschikbare gegevens gaan over een andere periode.'],
  outside_coverage: ['The available source does not cover this question.', 'De beschikbare bron dekt dit onderdeel van de vraag niet.'],
}
