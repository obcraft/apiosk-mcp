import { answerSources } from '@/lib/domain/answer-sources'
import { formatDisplayNarrative } from "@/lib/ui/display-text"
import { config } from "@/lib/platform/config"
import { useEffect, useState } from "react"
import { ChevronRight, Database } from "lucide-react"
import { StreamingReply } from "./streaming-reply"
import { SavedSourceResult } from './saved-source-result'
import type { ReadSavedResultPage } from '@/lib/domain/saved-result-pages'
import { Button } from "@/components/ui/button"
import type { GatewayV2Analysis, GatewayV2Report } from "@/lib/domain/gateway-v2"
import { formatSourceValue } from "@/lib/domain/source-value-format"
import { answerFollowUp, answerText, postcodeSearchIssue } from "@/lib/domain/gateway-v2-answer"
import { SupplierVerdictCard } from "./supplier-verdict"
import { AnswerPresentation } from './answer-presentation'
import { AnswerBlocksList } from './answer-blocks/answer-blocks'
import { isBlocksAnswer } from '@/lib/domain/answer-blocks-view'
import { BuildIn } from './build-in'
import { ResponseText } from '@/components/response/response-text'
import { SourceUsageNotices } from './source-usage-notices'
import { quoteBreakdownOffsets } from '@/lib/ui/source-price'
import { savedResultPresentation } from '@/lib/domain/saved-result-presentation'
import { GatewayV2Result } from './gateway-v2-result'
import { AnswerSourceLogos } from './answer-source-logos'
import { SupportingNews } from './supporting-news'
import { ResultMediaGallery } from '@/components/response/result-media'
import { legacyAnswerTables, presentationTable } from '@/lib/domain/answer-presentation'
import { savedEmployerRatings } from '@/lib/domain/saved-employer-ratings'
import { answerLocale, formatAnswerObservation } from '@/lib/domain/answer-format'
import { AnswerEvidenceContext } from './answer-evidence-context'
import { AnswerCoverage } from './answer-coverage'
import { AnswerOverview } from './answer-overview'
import { answerOverview } from '@/lib/domain/answer-overview'
import { EmployerRatings } from './employer-ratings'
import { AnswerLayout, SubjectWebContext } from './answer-layout'

export interface GatewayV2DetailSelection {
  result: unknown
  related: unknown[]
  analysis?: GatewayV2Analysis | null
  report?: GatewayV2Report | null
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function reportUrl(report?: GatewayV2Report | null): string | null {
  const path = report?.format === "pdf" && /^\/v2\/tasks\/[0-9a-f-]+\/reports\/[0-9a-f-]+\/report\.pdf\?/.test(report.download_path)
    ? report.download_path
    : null
  return path && config.gatewayV2Url ? new URL(path, config.gatewayV2Url).href : null
}

function sourceSummary(values: unknown[]): string {
  const names = [...new Set(values.map(value => {
    const source = record(record(value).source)
    return typeof source.name === "string"
      ? source.name
      : typeof source.provider === "string"
        ? source.provider
        : null
  }).filter((value): value is string => Boolean(value)))]
  if (names.length === 1) return names[0]
  if (names.length > 1) return `${names.length} sources`
  return "Sources"
}

function SupportingSourceTables({ sources, related }: { sources: unknown[]; related: unknown[] }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="group/source-tables min-w-0 max-w-full">
    <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-2 rounded-md text-body font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform group-open/source-tables:rotate-90" />
      Data tables
    </summary>
    {open && <div className="mt-3 space-y-4">
      {sources.map(source => <GatewayV2Result key={String(record(source).result_ref)} result={source} related={related} summaryOnly showMedia={false} />)}
    </div>}
  </details>
}

function InlineOutputDetails({ selection }: { selection: GatewayV2DetailSelection }) {
  const [open, setOpen] = useState(false)
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="min-w-0 max-w-full">
    <summary className="flex min-h-9 w-fit cursor-pointer items-center gap-2 text-tiny text-muted hover:text-foreground">
      <AnswerSourceLogos sources={selection.related.map(value => record(value).source)} />
      Sources and details
    </summary>
    {open && <div className="mt-3"><GatewayV2OutputDetails selection={selection} showUsageNotices={false} /></div>}
  </details>
}

export function GatewayV2Outputs({
  question = '',
  showSources = true,
  results,
  result,
  analysis,
  report,
  live = false,
  onOpenDetails,
  onPrepareQuestion,
}: {
  showSources?: boolean
  question?: string
  results?: unknown[]
  result?: unknown
  analysis?: GatewayV2Analysis | null
  report?: GatewayV2Report | null
  live?: boolean
  onOpenDetails?: (selection: GatewayV2DetailSelection) => void
  onPrepareQuestion?: (question: string) => void
}) {
  const visible = results ?? (result != null ? [result] : [])
  const {sourceCards, supportingSourceCards, displayedAnalysis} = savedResultPresentation(question, visible, analysis)
  const hasEvidence = Boolean(analysis?.observations.some(observation => observation.evidence.length))
  const hasDetails = visible.length > 0 || Boolean(reportUrl(report)) || hasEvidence
  const issue = postcodeSearchIssue(visible)
  // A supplier check answers with its verdict card; its observations repeat
  // the same checks as sentences, so only the limitations stay as text.
  const verdict = !issue && analysis?.kind === "supplier_payment_check" && analysis.verdict ? analysis.verdict : null
  const employers = !issue && !verdict ? savedEmployerRatings(visible, analysis) : []
  const prose = employers.length && displayedAnalysis ? { ...displayedAnalysis, limitations: [], follow_up_question: null } : displayedAnalysis
  const text = issue?.text ?? answerText(verdict && prose ? { ...prose, observations: [] } : prose, {results: visible, question, compact: true})
  const locale = answerLocale(question, analysis)
  const overview = !issue && !verdict && !sourceCards.length ? answerOverview(prose, visible, question) : null
  const evidence = !issue && !verdict ? (prose?.observations ?? []).map(observation => ({
    text: formatAnswerObservation(observation, visible, locale), facts: observation.evidence.map(item => ({ ...item, source: item.source?.name })),
  })) : []
  const employerNotes = employers.length && displayedAnalysis
    ? answerText({ ...displayedAnalysis, observations: [], follow_up_question: answerFollowUp(displayedAnalysis) }, {results: visible, question, compact: true}) : ''
  const documentRequested = analysis?.presentation?.kind === 'document' || /\b(document|pdf|rapport|report|dossier)\b/i.test(question)
  // Media belongs to the saved source response even when the synthesized answer
  // chooses different fields. Source cards already show their own gallery.
  const mediaSources = visible.filter(value => verdict || !sourceCards.includes(record(value)))
  const renderedAnswerData = !issue && !sourceCards.length && !verdict
    ? isBlocksAnswer(analysis) ? analysis.blocks
      : analysis?.presentation && 'title' in analysis.presentation
        ? presentationTable(analysis.presentation, visible).rows
        : legacyAnswerTables(question, visible, analysis).map(table => table.rows)
    : []
  const sourceMedia = mediaSources.map((value, index) => {
    const item = record(value)
    return <ResultMediaGallery key={String(item.result_ref ?? index)} value={item.data ?? item.preview_data} exclude={renderedAnswerData} label={`Media · ${sourceSummary([value])}`} />
  })
  return <AnswerEvidenceContext value={{ results: visible, analysis, locale }}><AnswerLayout sources={showSources ? answerSources(visible, analysis?.company_context, analysis?.supporting_news) : []}>
    <SourceUsageNotices sources={visible.map(value => record(value).source)} />
    {verdict ? <section aria-label="Answer" className="answer-content min-w-0 max-w-full space-y-3">
      <BuildIn key={text} live={live}><SupplierVerdictCard verdict={verdict} /></BuildIn>
      {text && <StreamingReply nameContext={{ results: visible, analysis }} live={live} text={text} className="text-body text-muted" />}
      {sourceMedia}
    </section> : (text || visible.length > 0 || isBlocksAnswer(analysis) && analysis.blocks.length > 0) && <section aria-label="Answer" className="answer-content min-w-0 max-w-full space-y-4">
      {sourceCards.length ? <>
        {sourceCards.map(source => <GatewayV2Result key={String(source.result_ref)} result={source} related={visible} summaryOnly />)}
        {analysis?.status !== 'completed' && text && <StreamingReply nameContext={{ results: visible, analysis }} live={live} text={text} evidence={evidence} />}
      </> : overview ? <AnswerOverview overview={overview} analysis={analysis} /> : text && <StreamingReply nameContext={{ results: visible, analysis }} live={live} text={text} evidence={evidence} />}
      {employers.map(employer => <EmployerRatings key={employer.resultRef} employer={employer} locale={answerLocale(question, analysis)} />)}
      {employerNotes && <StreamingReply text={employerNotes} nameContext={{ results: visible, analysis }} className="text-body text-muted" />}
      {/* Validated blocks and tables are ready as soon as the analysis is; they never wait
          for the word-by-word reply animation to finish (#56). */}
      {!issue && !sourceCards.length && <BuildIn key={text} live={live}>
        {/* Narrative observations are already rendered by StreamingReply above. */}
        {isBlocksAnswer(analysis) ? <AnswerBlocksList blocks={analysis.blocks.filter(block => block.kind !== 'narrative' && block.id !== overview?.summaryId)} analysis={analysis} /> : <AnswerPresentation question={question} results={visible} analysis={analysis} />}
      </BuildIn>}
      {!issue && supportingSourceCards.length > 0 && <SupportingSourceTables key={JSON.stringify([question, supportingSourceCards.map(source => source.result_ref)])} sources={supportingSourceCards} related={visible} />}
      {sourceMedia}
      {onOpenDetails && documentRequested && reportUrl(report) && <a href={reportUrl(report)!} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-border-2 px-4 py-2 text-body font-medium">Download onderzoeksrapport met analyse (PDF)</a>}
      {issue && onPrepareQuestion ? <Button type="button" variant="ghost" size="sm" className="mt-1 h-8 px-0 text-tiny" onClick={() => onPrepareQuestion(issue.question)}>Search postcode area</Button> : null}
    </section>}
    {!overview && <AnswerCoverage analysis={analysis} />}
    <SubjectWebContext value={analysis?.company_context} />
    {!issue && analysis && ['completed', 'partial'].includes(analysis.status) && <SupportingNews articles={analysis.supporting_news} />}
    {onOpenDetails && hasDetails ? (
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-auto min-h-8 w-fit max-w-full flex-wrap gap-1.5 px-2 py-1 text-tiny text-muted"
        onClick={() => onOpenDetails({ result: visible[0] ?? null, related: visible, analysis, report })}
        aria-label="Open sources and details"
      >
        <AnswerSourceLogos sources={visible.map(value => record(value).source)} fallback={<Database aria-hidden="true" className="size-3.5 shrink-0" />} />
        <span className="min-w-0 truncate">{sourceSummary(visible)}</span>
        <ChevronRight aria-hidden="true" className="size-3 shrink-0" />
      </Button>
    ) : null}
    {!onOpenDetails && hasDetails ? <InlineOutputDetails key={JSON.stringify([question, visible.map(value => record(value).result_ref)])}
      selection={{ result: visible[0] ?? null, related: visible, analysis, report }} /> : null}
  </AnswerLayout></AnswerEvidenceContext>
}

export function GatewayV2OutputDetails({ selection, readResultPage, totalChargedAtomic, showUsageNotices = true }: { selection: GatewayV2DetailSelection; readResultPage?: ReadSavedResultPage; totalChargedAtomic?: string; showUsageNotices?: boolean }) {
  const url = reportUrl(selection.report)
  const evidencePath = selection.report?.evidence_download_path
  const evidenceUrl = evidencePath && /^\/v2\/tasks\/[0-9a-f-]+\/reports\/[0-9a-f-]+\/evidence\.zip\?/.test(evidencePath) && config.gatewayV2Url
    ? new URL(evidencePath, config.gatewayV2Url).href : null
  const visible = selection.related.length
    ? selection.related
    : selection.result != null
      ? [selection.result]
      : []
  const evidence = selection.analysis?.observations.flatMap(observation => observation.evidence) ?? []
  const charges = visible.map(value => typeof record(value).charged_atomic === 'string' ? record(value).charged_atomic as string : undefined)
  // Never infer a task total from a partial/historical source selection. Only
  // reconcile display rounding when every saved charge matches actual billing.
  const chargeOffsets = totalChargedAtomic === undefined ? null : quoteBreakdownOffsets(totalChargedAtomic, charges)

  return <div className="answer-content space-y-4">
    {showUsageNotices && <SourceUsageNotices sources={visible.map(value => record(value).source)} />}
    {url ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-border-2 px-4 py-2 text-body font-medium">Download onderzoeksrapport met analyse (PDF)</a> : null}
    {evidenceUrl ? <a href={evidenceUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-lg border border-border-2 px-4 py-2 text-body font-medium">Download bewijsstukken en kaarten (ZIP)</a> : null}
    {selection.analysis?.limitations.length ? <section className="space-y-2 text-body" aria-label="Source limitations">
      <h3 className="font-medium">Source limitations</h3>
      <ul className="space-y-1.5 leading-snug text-muted">{selection.analysis.limitations.map((text, index) => <li key={index}><ResponseText text={formatDisplayNarrative(text, selection)} /></li>)}</ul>
    </section> : null}
    {evidence.length ? <section className="space-y-2" aria-label="Source evidence">
      <h3 className="text-body font-medium">Source evidence</h3>
      <ul className="space-y-2 text-tiny text-muted">{evidence.map((item, index) => <li key={index}>
        {item.source?.name ?? formatDisplayNarrative(item.subject?.label ?? '', selection)} · {item.field ?? item.pointer}: <span className="tabular-nums text-foreground"><ResponseText text={formatSourceValue(item.value, item.field ?? item.pointer, null, selection)} /></span>
        <span className="block break-all text-faint">{item.pointer}</span>
      </li>)}</ul>
    </section> : null}
    {visible.map((value, index) => <SavedSourceResult key={String(record(value).result_ref ?? index)} result={value} related={visible} readPage={readResultPage}
      chargeAllocation={chargeOffsets ? { amount: charges[index]!, previousAmount: chargeOffsets[index] } : undefined} />)}
  </div>
}

export function GatewayV2Countdown({ until, message }: { until: string; message: string }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer) }, [until])
  const seconds = Math.max(0, Math.ceil((Date.parse(until) - now) / 1000))
  return <div role="status" className="rounded-xl border border-border-2 bg-surface p-4 text-body">
    <p>{message}</p><p className="mt-1 tabular-nums">{seconds ? `Next annual report in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "Continuing the approved request…"}</p>
  </div>
}
