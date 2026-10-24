import { useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { AskV2Result } from '@/components/ask-v2/ask-v2-result'
import { GatewayV2Outputs, GatewayV2OutputDetails, type GatewayV2DetailSelection } from '@/components/ask/gateway-v2-outputs'
import { GatewayV2Billing } from '@/components/ask/gateway-v2-billing'
import { useGatewayV2Money } from '@/components/ask/gateway-v2-money'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { config } from '@/lib/platform/config'
import type { ReadSavedResultPage } from '@/lib/domain/saved-result-pages'
import { recordFollowUp } from '@/lib/domain/ask-v2-result'

type RecordValue = Record<string, any>
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}

export type AskSavedResultsProps = {
  /** The saved Gateway task view, never a new source request. */
  output: RecordValue
  source?: RecordValue
  question?: string
  gatewayUrl?: string
  readResultPage?: ReadSavedResultPage
  onPrepareQuestion?: (question: string) => void
  onSelectRecord?: (record: Record<string, unknown>) => void
  showSources?: boolean
  grouped?: boolean
  onNewPurchase?: () => void
}

/** Match the frozen Ask purchase's result branch using its original readers. */
export function AskSavedResults({ output, source: suppliedSource, question: suppliedQuestion, gatewayUrl, readResultPage,
  onPrepareQuestion, onSelectRecord, showSources = true, grouped = false, onNewPurchase }: AskSavedResultsProps) {
  const [details, setDetails] = useState<GatewayV2DetailSelection | null>(null)
  const formatMoney = useGatewayV2Money()
  const context = record(output.context_view)
  const results: unknown[] = Array.isArray(context.results) ? context.results : []
  const result = output.result ?? results.at(-1)
  const question = suppliedQuestion ?? context.question ?? context.conversation?.at(-1)?.question ?? ''
  const document = record(result)
  const provenance = record(document.source)
  const offered = Array.isArray(context.source_selection?.original_intake?.source_rows)
    ? context.source_selection.original_intake.source_rows.find((row: RecordValue) => row.endpoint_id && row.endpoint_id === provenance.endpoint_id) : null
  const original = offered ?? record(output.source)
  const source = suppliedSource ?? { ...original, ...provenance,
    name: provenance.name || original.name || provenance.provider || 'Source',
    source_slug: provenance.provider || original.source_slug,
    endpoint_id: provenance.endpoint_id || original.endpoint_id,
  }
  // The iframe has one host origin. No App account client or token is installed.
  if (gatewayUrl) {
    try {
      const url = new URL(gatewayUrl)
      if (!url.username && !url.password && (url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) config.gatewayV2Url = url.origin
    } catch { /* Keep existing signed downloads unavailable for an invalid origin. */ }
  }
  if (result == null && output.result_present !== true && !context.analysis) return null
  const select = (output.next_actions || []).some((action: RecordValue) => action.kind === 'select_entity')
  const partial = output.status === 'partial' || document.coverage === 'partial' || output.result_truncated === true
  const selectRecord = onSelectRecord ?? (onPrepareQuestion ? (value: Record<string, unknown>) => onPrepareQuestion(recordFollowUp(source.name, value)) : undefined)
  const value = Object.hasOwn(document, 'data') ? document.data : result
  const sourceResult = <AskV2Result source={source} value={value} raw={result} partial={partial} readResultPage={readResultPage} onSelectRecord={selectRecord} />
  const billing = record(output.billing)
  const external = output.view === 'external_purchase' || Object.hasOwn(billing, 'charged_micro_usd')
  const hasBilling = !external && Array.isArray(billing.executions) && typeof billing.total_charged === 'string' && typeof billing.reserved === 'string'
  const settled = ['succeeded', 'partial', 'failed', 'cancelled', 'unsupported'].includes(output.status)
    && !context.worker_active && billing.status !== 'pending_reconciliation'
  const newPurchase = onNewPurchase && settled && <Button type="button" variant="ghost" size="sm" className="rounded-full px-2 text-tiny" onClick={onNewPurchase}>New purchase</Button>
  const withBilling = (children: ReactNode) => <>{children}
    {hasBilling && <GatewayV2Billing billing={billing as any} compact={grouped}>{grouped && newPurchase}</GatewayV2Billing>}
    {external && output.billing && <p className="border-t border-border-2 pt-3 text-tiny text-muted">{billing.charged_micro_usd == null
      ? billing.status === 'reserved' ? 'Amount reserved from Apiosk balance' : 'Payment being checked'
      : <>Spent from Apiosk balance · {formatMoney(String(billing.charged_micro_usd))}</>}</p>}
    {(!grouped || !hasBilling) && newPurchase}
  </>

  if (select) return withBilling(<details className="text-tiny text-muted">
    <summary className="cursor-pointer py-2 hover:text-foreground">Source data</summary>
    <div className="pt-2 text-foreground">{sourceResult}</div>
  </details>)
  if (!question || !context.analysis) return withBilling(sourceResult)
  return withBilling(<>
    <GatewayV2Outputs question={question} result={result} results={results.length ? results : undefined}
      analysis={context.analysis} report={context.report} showSources={showSources}
      onOpenDetails={setDetails} onPrepareQuestion={onPrepareQuestion} />
    <Dialog open={details !== null} onClose={() => setDetails(null)} label="Sources and details" panelClassName="sm:max-w-5xl">
      <DialogHeader><DialogTitle>Sources and details</DialogTitle>
        <Button type="button" size="icon-sm" variant="ghost" aria-label="Close source details" onClick={() => setDetails(null)}><X aria-hidden="true" /></Button>
      </DialogHeader>
      <DialogBody>{details && <GatewayV2OutputDetails selection={details} readResultPage={readResultPage}
        totalChargedAtomic={output.billing?.total_charged} />}</DialogBody>
    </Dialog>
  </>)
}
