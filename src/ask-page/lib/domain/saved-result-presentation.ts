import type { GatewayV2Analysis } from './gateway-v2'
import { blockFacts, isBlocksAnswer } from './answer-blocks-view'
import { legacyAnswerTables } from './answer-presentation'
import { sourceResultTables, type SourceTable } from './source-result-tables'
import { savedFilingRows } from './saved-filing-rows'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const synthesisFailure = 'The analysis could not be generated. Your source results are saved; no additional source purchase was made.'
const present = (value: unknown): boolean => typeof value === 'string' ? value.trim().length > 0 : typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean' || Array.isArray(value) && value.some(present)
const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

function usableTable(table: SourceTable): boolean {
  const fieldValues = table.columns[0] === 'Field' && table.columns[1] === 'Source value'
  return table.rows.some(row => (fieldValues ? row.slice(1) : row).some(present))
}

function literalValues(value: unknown, depth = 0): unknown[] {
  if (depth > 16) return []
  if (Array.isArray(value)) return value.flatMap(item => literalValues(item, depth + 1))
  if (value && typeof value === 'object') return Object.values(value).flatMap(item => literalValues(item, depth + 1))
  return present(value) ? [value] : []
}

function sourceBackedTable(table: SourceTable, data: unknown): boolean {
  const raw = new Set(literalValues(data).map(value => JSON.stringify(value)))
  const fieldValues = table.columns[0] === 'Field' && table.columns[1] === 'Source value'
  return table.rows.some(row => (fieldValues ? row.slice(1) : row).some(value => literalValues(value).some(cell => raw.has(JSON.stringify(cell)))))
}

/** Presentation follows the current saved documents and analysis state. Source
 * cards expose returned data, without claiming that unfinished analysis ran. */
export function savedResultPresentation(question: string, results: unknown[], analysis?: GatewayV2Analysis | null) {
  const counts = new Map<string, number>()
  for (const value of results) {
    const ref = record(value).result_ref
    if (nonblank(ref)) counts.set(ref, (counts.get(ref) ?? 0) + 1)
  }
  const savedRefs = new Set([...counts].filter(([, count]) => count === 1).map(([ref]) => ref))
  const renderable = results.map(record).filter(result => {
    const source = record(result.source)
    const data = result.data ?? result.preview_data
    return savedRefs.has(String(result.result_ref)) && ['source_response', 'partial'].includes(String(result.coverage))
      && nonblank(source.provider) && nonblank(source.path) && nonblank(source.endpoint_id)
      && (sourceResultTables(source.provider, source.path, data, results, record(result.subject).label).some(table => sourceBackedTable(table, data))
        || savedFilingRows(source.provider, source.path, data) !== null)
  })
  const hasAnswer = Boolean(analysis && (
    analysis.observations.some(observation => observation.text.trim().length > 0 && observation.evidence.some(evidence => present(evidence.value) && savedRefs.has(evidence.result_ref)))
    || (isBlocksAnswer(analysis)
      ? analysis.blocks.some(block => (blockFacts(block) ?? []).some(row => present(row.fact?.value) && savedRefs.has(row.fact?.result_ref ?? row.collection?.result_ref ?? '')))
      : analysis.presentation && 'rows' in analysis.presentation
        ? analysis.presentation.rows.some(row => row.some(cell => present(cell?.value) && savedRefs.has(cell?.result_ref ?? '')))
        : legacyAnswerTables(question, results, analysis).some(usableTable))
  ))
  // This server method explicitly delivers one KVK profile. Keep its source
  // identity bound; the user's wording and registration number are variables.
  const boundProfile = analysis?.method === 'saved_kvk_profile' && ['completed', 'partial'].includes(analysis.status)
    && results.length === 1 && renderable.length === 1 && (() => {
      const source = record(renderable[0].source), data = record(renderable[0].data ?? renderable[0].preview_data)
      return source.provider === 'kvk-dutch-business-register' && source.endpoint_id === 'b050c654-284a-49e8-a7ca-0bfca565816e'
        && typeof data.kvkNummer === 'string' && /^\d{8}$/.test(data.kvkNummer)
        && ['/api/v1/basisprofielen', `/api/v1/basisprofielen/${data.kvkNummer}`].includes(String(source.path).replace(/\/$/, ''))
    })()
  const waiting = !hasAnswer && (!analysis || ['unavailable', 'pending', 'queued', 'running', 'partial'].includes(analysis.status))
  const sourceCards = boundProfile || waiting ? renderable : []
  // Once findings replace the initial source preview, keep those same saved
  // tables available as supporting data without suppressing the answer.
  const supportingSourceCards = hasAnswer && !sourceCards.length ? renderable : []
  const displayedAnalysis = analysis ? {
    ...analysis,
    observations: sourceCards.length ? [] : analysis.observations,
    limitations: analysis.status === 'unavailable' && (sourceCards.length > 0 || hasAnswer)
      ? analysis.limitations.filter(text => text !== synthesisFailure) : analysis.limitations,
  } : analysis
  return { sourceCards, supportingSourceCards, displayedAnalysis }
}
