import * as React from 'react'
import { useEffect, useId, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { SourcesTable } from './components/ask-v2/ask-v2-sources'
import { AnswerLayout, SubjectWebContext } from './components/ask/answer-layout'
import { answerSources } from './lib/domain/answer-sources'
import { InputFieldset } from './components/discover/input-fields'
import { Button } from './components/ui/button'
import { StickyComposerSummary } from './components/ask-v2/sticky-composer-summary'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { buildInputs, valuesFrom, type FieldValues } from './lib/domain/inputs'
import { groupSourceItems } from './lib/domain/source-groups'
import { MoneyContext, purchaseFields, stickyBar, type AskSourceItem } from './environment'
import { formatQuoteCeiling, formatQuoteItem, quoteBreakdownOffsets } from './lib/ui/source-price'
import { AskSavedResults, type AskSavedResultsProps } from './AskSavedResults'
import { AskThinking } from './components/ask/ask-thinking'
import { PortalRootContext } from './lib/ui/portal-root'
import { AskTaskDecisions } from './AskTaskDecisions'
import { AskAutomaticQuote } from './AskAutomaticQuote'
import css from './compiled.css?inline'

type Props = {
  data: Record<string, any>
  rows: AskSourceItem[]
  selectedKeys: string[]
  inputs: { key: string; source: Record<string, any>; values: Record<string, any>; byName: boolean;
    onValues: (built: Record<string, any> | null, byName: boolean) => void }[]
  busy: boolean
  onToggle: (item: AskSourceItem) => void
  onClear: () => void
  onReview: () => void
  onNewPurchase: () => void
  quoteError?: boolean
  saved?: AskSavedResultsProps[]
  decisions?: { output: Record<string, any>; onAction: (action: any, input: any) => void; onStatus: () => void }[]
  purchase?: { total: string | null; expired: boolean; proposal?: any; executionEnabled: boolean; steps: Record<string, any>[]; notices: string[]; errors: string[];
    canApprove: boolean; needsRecovery: boolean; incomplete: boolean; onRetry: () => void; onApprove: () => void; onRefresh: () => void; onStatus: () => void } | null
}

/** AskV2Purchase's input-only portion, with its exact InputFieldset and markup. */
function PurchaseInputs({ item, disabled }: { item: Props['inputs'][number]; disabled: boolean }) {
  const { source } = item, descriptor = source.endpoint
  const prefix = useId()
  const [byName, setByName] = useState(item.byName)
  const fields = purchaseFields(descriptor, byName)
  const [values, setValues] = useState<FieldValues>(() => valuesFrom(fields, item.values))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const lookup = descriptor.lookup
  const update = (next: FieldValues, lookupByName = byName) => {
    setValues(next)
    item.onValues(buildInputs(purchaseFields(descriptor, lookupByName), next).built?.inputs ?? null, lookupByName)
  }
  useEffect(() => { item.onValues(buildInputs(fields, values).built?.inputs ?? null, byName) }, [])
  return <section aria-label={`Purchase ${source.name}`} className="flex flex-col gap-2">
    <div className="space-y-2">
      <form data-purchase-inputs className="space-y-2 [&_input:not([type=checkbox])]:h-9 [&_textarea]:min-h-9 [&_textarea]:py-1.5"
        onSubmit={event => event.preventDefault()} onBlur={event => {
          const name = (event.target as HTMLElement).closest<HTMLElement>('[data-input-field]')?.dataset.inputField
          if (!name) return
          const error = buildInputs(fields, values).errors[name]
          setErrors(previous => { const next = { ...previous }; if (error) next[name] = error; else delete next[name]; return next })
        }}>
        {lookup && <div className="space-y-2">
          <p className="text-body text-muted">{lookup.field === 'geo.input.q'
            ? byName ? 'We’ll find the address and look up its linked records first. The lookup is included in your total price.' : 'Use the location identifiers you already have.'
            : byName ? `We’ll look up the ${lookup.resolves.some((field: string) => /kvk/i.test(field)) ? 'KVK number' : 'company identifier'} with ${source.name} first. The lookup is included in your total price.` : 'Use the company identifier you already have.'}</p>
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => {
            const next = !byName
            setByName(next)
            update(valuesFrom(purchaseFields(descriptor, next), source.endpoint?.input_values), next)
          }}>{lookup.field === 'geo.input.q' ? byName ? 'I already have the identifiers' : 'Find by address' : byName ? 'I already have the number' : 'Find the number by company name'}</Button>
        </div>}
        <InputFieldset compact idPrefix={`${prefix}-`} fields={fields} showTechnicalNames={false} values={values} errors={errors} disabled={disabled}
          onChange={(name, value) => update({ ...values, [name]: value })} />
      </form>
    </div>
  </section>
}

function Discovery(props: Props) {
  const { data, rows, selectedKeys, inputs, busy, onToggle, onClear, onReview, onNewPurchase, quoteError, purchase, saved = [], decisions = [] } = props
  const [theme, setTheme] = useState(document.documentElement.dataset.theme)
  const [portalRoot, setPortalRoot] = useState<HTMLDivElement | null>(null)
  const [followUp, setFollowUp] = useState<{ question: string; send: (question: string) => void } | null>(null)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(document.documentElement.dataset.theme))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => { (window as any).apiosk.resize() })
  const dark = theme === 'dark' || !theme && window.matchMedia?.('(prefers-color-scheme: dark)').matches
  const context = data.company_context ?? data.context_view?.companies ?? []
  const webSources = answerSources([], context)
  const selected = rows.filter(row => selectedKeys.includes(row.key))
  const display = data.context_view?.money_display
  const validRate = display?.base_currency === 'USD' && Number(display.rate) > 0 && /^[A-Z]{3}$/.test(display.currency || '')
  const money = { currency: validRate ? display.currency : 'USD', rate: validRate ? Number(display.rate) : 1, ready: true }
  const formatMoney = (amount: string) => formatQuoteCeiling(amount, money.currency, money.rate)
  const total = purchase?.total ? formatMoney(purchase.total) : null
  const groups = groupSourceItems(inputs)
  const offsets = purchase?.total ? quoteBreakdownOffsets(purchase.total, purchase.steps.map(step => step.max_total_atomic)) : null
  const hasSaved = saved.length > 0
  const approved = saved.some(result => result.output.billing?.authorization_active || ['running', 'succeeded', 'partial', 'cancelled'].includes(result.output.status))
  const completed = hasSaved && saved.every(result => ['succeeded', 'partial', 'failed', 'cancelled', 'unsupported'].includes(result.output.status))
  const automatic = !!purchase?.proposal && !inputs.length
  const running = saved.some(result => result.output.status === 'running' || result.output.context_view?.worker_active)
  const decisionNodes = decisions.map((decision, index) => {
    const view = decision.output
    const errors = (view.errors || []).flatMap((error: any) => typeof error.message === 'string' ? [error.message] : [])
    const cancelled = (view.next_actions || []).find((action: any) => action.kind === 'cancel' && action.requires_authorization === false)
    const recover = ['failed', 'unsupported'].includes(view.status) || view.billing?.status === 'pending_reconciliation'
      || view.context_view?.approval_outcome_unconfirmed || ['succeeded', 'partial'].includes(view.status) && view.result == null && !view.context_view?.results?.length && !view.context_view?.analysis
    const canDecide = (view.next_actions || []).some((action: any) => ['select_entity', 'supply_input'].includes(action.kind) && action.requires_authorization === false)
    if (!canDecide && !errors.length && !recover && !(view.status === 'running' && cancelled)) return null
    return <div key={view.state?.state_ref || view.purchase_id || index} className="space-y-3">
      <AskTaskDecisions output={view} onAction={decision.onAction} disabled={busy} />
      {errors.map((error: string, errorIndex: number) => <p key={errorIndex} role="status" className="text-body">{error}</p>)}
      {view.status === 'failed' && !errors.length && <p role="status" className="text-body">This source could not complete the request.</p>}
      {recover && <Button type="button" disabled={busy} onClick={decision.onStatus}>Check saved status</Button>}
      {view.status === 'running' && cancelled && <Button type="button" variant="ghost" disabled={busy} onClick={() => decision.onAction(cancelled, null)}>Stop request</Button>}
    </div>
  })
  const savedResults = saved.map((result, index) => <div key={result.output.state?.state_ref || result.output.purchase_id || index} className="space-y-4">
    {result.output.status === 'running' && <AskThinking label="Getting your result. Your purchase is saved." />}
    {result.output.status === 'cancelled' && <p role="status" className="text-body text-muted">This purchase was stopped. Saved results remain available.</p>}
    <AskSavedResults {...result} question={data.question || undefined} showSources={!rows.length}
      onPrepareQuestion={result.onPrepareQuestion ? question => setFollowUp({ question, send: result.onPrepareQuestion! }) : undefined} />
  </div>)
  return <MoneyContext.Provider value={money}>
    <PortalRootContext value={portalRoot}><div ref={setPortalRoot} className={`ask-app min-w-0 w-full space-y-4${dark ? ' dark' : ''}`} onClick={event => {
      const link = (event.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
      if (link) { event.preventDefault(); void (window as any).apiosk.openLink(link.href) }
    }}>
      <AnswerLayout sources={webSources} webSearches>
        <SubjectWebContext value={context} />
      </AnswerLayout>
      {!rows.length && !hasSaved && !automatic && <p role="status" className="text-body text-muted">{data.message || data.planning_message || 'We couldn’t find any results for you. Try a different question.'}</p>}
      {rows.length > 0 && !approved && !hasSaved && !automatic && <p className="text-body text-muted">Choose a source to review.</p>}
      {automatic && purchase ? <div className="space-y-4">{decisionNodes}<AskAutomaticQuote proposal={purchase.proposal} coverageNotices={purchase.notices}
        expired={purchase.expired} canApprove executionEnabled={purchase.executionEnabled} disabled={busy} approveDisabled={!purchase.canApprove}
        onApprove={purchase.onApprove} onRefreshPrice={purchase.onRefresh}>
        {purchase.needsRecovery && <Button disabled={busy} onClick={purchase.onStatus}>Check saved status</Button>}
      </AskAutomaticQuote></div>
        : !rows.length ? hasSaved ? <div className="space-y-4">{decisionNodes}{savedResults}</div> : null : <SourcesTable presentation="answer" label={data.question || 'Sources for this question'} rows={rows}
        approved={approved} disabled={busy || running} selection={{ items: selected, open: inputs.length > 0 }}
        onToggle={onToggle} onGetPrice={onReview} onClear={onClear}>
        {hasSaved ? <div className="space-y-5">{decisionNodes}{savedResults}</div> : inputs.length > 0 ? <div className="space-y-4">
          <div className="grid scroll-mt-[calc(var(--header-height)+1rem)] gap-5">
            {groups.map(group => <section key={group.key} className="min-w-0 rounded-lg border border-border-2 p-3" aria-label={group.items[0].source.name}>
              {inputs.length > 1 && <p className="mb-2 truncate text-tiny font-medium text-muted">{group.items[0].source.name}</p>}
              <div className="space-y-3">{group.items.map(item => <div key={item.key} className="space-y-2"><PurchaseInputs item={item} disabled={busy} /></div>)}</div>
              {purchase && purchase.steps.length > 1 && <details className="text-tiny text-muted">
                <summary className="cursor-pointer py-2 transition-colors hover:text-foreground">Price &amp; inputs</summary>
                <div className="space-y-2 pb-2 pt-1">
                  <p>{purchase.expired ? 'This price expired. Refresh it below for a current price.' : <>Maximum total · <span className="tabular-nums">{total}</span></>}</p>
                  <ol aria-label={`Price per item for ${group.items[0].source.name}`} className="divide-y divide-border-2">
                    {purchase.steps.filter(step => groups.length === 1 || [step.source?.name, step.source?.directory_name, step.source?.slug, step.source?.directory_slug].some(name => group.items.some(item => [item.source.name, item.source.source_slug].includes(name)))).map(step => {
                      const index = purchase.steps.indexOf(step)
                      return <li key={step.number ?? index} className="flex items-baseline justify-between gap-3 py-2">
                        <span className="min-w-0 break-words">{step.number ?? index + 1}. {step.title}<span className="block text-muted">{step.source?.directory_name || step.source?.name}</span></span>
                        <span className="whitespace-nowrap tabular-nums">{step.max_total_atomic != null ? offsets ? formatQuoteItem(step.max_total_atomic, offsets[index], money.currency, money.rate) : formatMoney(step.max_total_atomic) : 'Price unavailable'}</span>
                      </li>
                    })}
                  </ol>
                </div>
              </details>}
            </section>)}
          </div>
          {decisionNodes}
          {purchase?.notices.map((notice, index) => <p key={index} role="status" className="text-tiny text-muted">{notice}</p>)}
          {purchase?.errors.filter(error => !decisions.some(decision => decision.output.errors?.some((item: any) => item.message === error))).map((error, index) => <p key={index} role="status" className="text-body">{error}</p>)}
          <StickyComposerSummary role="region" aria-label="Purchase summary" aria-busy={busy} className={stickyBar}>
            <div className="min-w-0 flex-1">
              <p className="truncate text-tiny text-muted">{inputs.length > 1 ? `${inputs.length} sources selected` : inputs[0].source.name}</p>
              <p aria-live="polite" className={total && !busy && !purchase?.expired ? 'text-body font-medium tabular-nums' : 'text-tiny text-muted'}>{busy ? 'Checking details…' : purchase?.expired ? 'This price expired. Refresh it to continue.' : total ? `Total ${total}` : quoteError || purchase?.errors.length || purchase?.incomplete ? 'Check the details above and try again.' : 'Fill in the required details.'}</p>
              {total && <p className="text-tiny text-muted">Nothing is charged until you approve.</p>}
            </div>
            <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
              {purchase?.incomplete ? <Button type="button" variant="primary" size="lg" className="rounded-full text-menu" disabled={busy} onClick={purchase.onRetry}>Try again</Button>
                : purchase?.needsRecovery ? <Button type="button" variant="primary" size="lg" className="rounded-full text-menu" disabled={busy} onClick={purchase.onStatus}>Check saved status</Button>
                : purchase?.expired ? <Button type="button" variant="primary" size="lg" className="rounded-full text-menu [&_svg]:size-3" disabled={busy} onClick={purchase.onRefresh}><RefreshCw aria-hidden="true" />Refresh price</Button>
                : total ? <Button type="button" variant="primary" size="lg" className="rounded-full px-5" disabled={busy || !purchase?.canApprove} onClick={purchase?.onApprove}>Approve {total}</Button>
                : quoteError ? <Button type="button" variant="primary" size="lg" className="rounded-full text-menu" disabled={busy} onClick={onReview}>Try again</Button>
                : <Button type="button" variant="primary" size="lg" className="rounded-full text-menu" disabled>{busy && <LoaderCircle aria-hidden="true" className="size-4 motion-safe:animate-spin" />}Approve</Button>}
            </div>
          </StickyComposerSummary>
        </div> : decisions.length ? <div className="space-y-4">{decisionNodes}</div> : undefined}
      </SourcesTable>}
      {completed && !running && <Button type="button" variant="ghost" size="sm" className="rounded-full px-2 text-tiny" disabled={busy} onClick={onNewPurchase}>New purchase</Button>}
      {followUp && <form className="space-y-3 rounded-xl border border-border-2 bg-surface p-4" aria-label="Follow-up question" onSubmit={event => {
        event.preventDefault()
        if (busy || !followUp.question.trim()) return
        const draft = followUp
        setFollowUp(null)
        draft.send(draft.question.trim())
      }}>
        <textarea aria-label="Ask a follow-up" value={followUp.question} disabled={busy}
          onChange={event => setFollowUp({ ...followUp, question: event.target.value })}
          className="min-h-20 w-full resize-y rounded-lg bg-transparent text-body text-foreground outline-none" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={() => setFollowUp(null)}>Cancel</Button>
          <Button type="submit" variant="primary" className="rounded-full" disabled={busy || !followUp.question.trim()}>Send</Button>
        </div>
      </form>}
    </div></PortalRootContext>
  </MoneyContext.Provider>
}

// The original MCP action journal owns selection and approval. This component
// receives display data and free click callbacks only.
;(window as any).mountApioskAskPage = (container: HTMLElement, initial: Props) => {
  const shadow = container.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = css
  const mount = document.createElement('div')
  shadow.append(style, mount)
  const root = createRoot(mount)
  const update = (props: Props) => root.render(<Discovery {...props} />)
  update(initial)
  return { update, unmount: () => root.unmount() }
}
