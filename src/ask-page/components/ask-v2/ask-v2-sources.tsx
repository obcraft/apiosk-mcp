import * as React from 'react'
import { AnswerLayout } from '@/components/ask/answer-layout'
import { groupSourceItems } from '@/lib/domain/source-groups'
import { useEffect, useId, useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EntityLogo } from '@/components/explore/entity-logo'
import { curatedSourceMark } from '@/lib/ui/source-marks'
import { formatSourcePrice } from '@/lib/ui/source-price'
import { useMoney } from '@/environment'
import { cn } from '@/lib/ui/utils'
import { sourceRef, type PurchaseSource } from '@/environment'
import { safeSourceUrl, type AskSourceItem, type AskTurnSelection } from '@/environment'
import { availableSourcesFirst, purchasableSource, sourceSummary } from '@/lib/domain/source-summary'
import { loadPurchaseSource } from '@/environment'
import { stickyBar } from '@/environment'
import { StickyComposerSummary } from './sticky-composer-summary'

/** Rows shown before "Show all results"; the rest stay one click away. */
const RESULT_PREVIEW = 3
/** Selection is neutral, not the accent: a darker grey in either theme. */
const selectedPill = 'border-transparent bg-foreground/75 text-surface hover:bg-foreground/85'

/** Choose one or more sources. Their purchase opens below with one total; approval folds the other options away. */
export function SourcesTable({ label, rows: candidates, loading = false, selection, approved = false, disabled, onToggle, onGetPrice, onClear, children, scope, presentation = 'table' }: {
  presentation?: 'table' | 'answer'
  scope?: string
  label: string; rows: AskSourceItem[]; loading?: boolean; selection?: AskTurnSelection; disabled: boolean
  /** A source in the selection is approved: the rows fold away, once; after that the toggle is the person's. */
  approved?: boolean
  onToggle: (item: AskSourceItem) => void
  /** Reopens the saved purchase step for the selected sources. */
  onGetPrice: () => void
  onClear: () => void
  /** The open purchase step for the selection, with its own bar. */
  children?: ReactNode
}) {
  const [showAll, setShowAll] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // Approval collapses the rows once; after that the toggle is the person's.
  const [foldedOnApproval, setFoldedOnApproval] = useState(false)
  if (approved && !foldedOnApproval) { setFoldedOnApproval(true); setCollapsed(true) }
  if (!approved && foldedOnApproval) { setFoldedOnApproval(false); setCollapsed(false) }
  const rowsId = useId()
  const chosen = selection?.items ?? []
  const selected = new Set(chosen.map(item => item.key))
  // Apply this to restored conversations too. Saved purchases remain below
  // the table, even if their old discovery row is no longer a new choice.
  const rows = candidates.filter(row => purchasableSource(row.source))
  const ordered = availableSourcesFirst(rows)
  // Keep every chosen source visible wherever it ranks.
  const orderedGroups = groupSourceItems(ordered)
  const shown = (showAll ? orderedGroups : orderedGroups.filter((group, index) => index < RESULT_PREVIEW || group.items.some(item => selected.has(item.key)))).flatMap(group => group.items)
  // Warm all loaded choices, including collapsed results, three at a time.
  // This reads input metadata only; opening a source reuses the same cache.
  const warmSources = JSON.stringify(ordered.map(item => sourceRef(item.source)).filter(Boolean))
  useEffect(() => {
    if (!scope) return
    let active = true
    void (async () => {
      const sources = JSON.parse(warmSources) as NonNullable<ReturnType<typeof sourceRef>>[]
      for (let index = 0; index < sources.length && active; index += 3) {
        await Promise.allSettled(sources.slice(index, index + 3).map(source => loadPurchaseSource(scope, source)))
      }
    })()
    return () => { active = false }
  }, [scope, warmSources])
  const groups = groupSourceItems(shown)
  const hidden = rows.length - shown.length
  // A single chosen source already has its price review open. There is no
  // remaining source choice to make, including when this chat is reopened.
  const reviewingOnlySource = !loading && !approved && selection?.open && Boolean(children)
    && rows.length === 1 && chosen.length === 1 && rows[0].key === chosen[0].key
  const folded = (collapsed || reviewingOnlySource) && rows.length > 0
  const changeSource = folded && approved && chosen.length > 0
  const names = [...new Set(chosen.map(item => item.source.name))].join(', ')
  const chooser = <div className={presentation === 'answer' ? "[&_table]:text-tiny [&_thead]:text-tiny [&_tbody>tr>td>div]:border-0 [&_tbody>tr>td>div]:rounded-none" : ""} aria-busy={loading}>
    {rows.length > 0 && <div className="flex items-center gap-2 border-b border-border-2 px-3 py-1 sm:px-4">
      {folded && chosen.length > 0 && <span aria-hidden="true" className="flex shrink-0 -space-x-1">{chosen.slice(0, 3).map(item => <SourceMark key={item.key} source={item.source} className="size-4 rounded-sm ring-2 ring-surface [&_span]:text-tiny" />)}</span>}
      <p className="min-w-0 flex-1 truncate text-tiny text-muted">
        {folded && chosen.length > 0 ? names : <>{rows.length} {rows.length === 1 ? 'match' : 'matches'} · {rows.length} available{chosen.length > 0 && ` · ${chosen.length} selected`}</>}
      </p>
      {!reviewingOnlySource && <button type="button" aria-expanded={!folded} aria-controls={rowsId} disabled={changeSource && disabled} onClick={() => { if (changeSource) onClear(); setCollapsed(!folded) }}
        className="flex min-h-8 shrink-0 items-center gap-1 rounded-sm text-tiny text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--accent-line)] disabled:cursor-default disabled:opacity-50">
        {folded ? <>{changeSource ? chosen.length > 1 ? 'Change sources' : 'Change source' : 'Show sources'}<ChevronDown aria-hidden="true" className="size-3" /></> : <>Hide sources<ChevronUp aria-hidden="true" className="size-3" /></>}
      </button>}
    </div>}
    <div id={rowsId} hidden={folded}>
      <div className="px-3 pb-2 sm:px-4"><table aria-label={label} className="w-full table-fixed border-separate border-spacing-x-0 border-spacing-y-1 text-left text-body">
        <colgroup><col className="w-[3.75rem] sm:w-16" /><col /><col className="w-20 sm:w-24" /></colgroup>
        <thead className="border-b border-border-2 text-tiny text-muted"><tr><th scope="col" colSpan={2} className="py-3 pl-3 pr-2 font-medium sm:pl-4">Source</th><th scope="col" className="py-3 pr-3 text-right font-medium sm:pr-4">Price</th></tr></thead>
        {groups.map(group => <tbody key={group.key} aria-label={group.items[0].source.name}>
          <tr><td colSpan={3} className="p-0 pb-1">
            <div className="overflow-hidden rounded-xl border border-border-2">
              <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
                <SourceMark source={group.items[0].source} className="size-8 shrink-0 overflow-hidden rounded-lg bg-transparent [&_img]:rounded-lg [&_img]:!bg-transparent" />
                <div className="min-w-0">
                  <p className="truncate font-medium">{group.items[0].source.name}</p>
                  <p className="truncate text-tiny text-muted">{[...new Set(group.items.map(item => item.source.subject_label).filter(Boolean))].join(', ')}</p>
                </div>
              </div>
              <div className="mb-2 ml-5 mr-2 border-l border-border-2 pl-2 sm:ml-8">
              <table role="presentation" className="w-full table-fixed border-separate border-spacing-0">
                <colgroup><col /><col className="w-20 sm:w-24" /></colgroup>
                <tbody>{group.items.map(item => <SourceRow key={item.key} source={item.source} disabled={disabled} selected={selected.has(item.key)} onToggle={() => onToggle(item)} />)}</tbody>
              </table>
              </div>
            </div>
          </td></tr>
        </tbody>)}
        <tbody>
          {!rows.length && loading && [0, 1, 2].map(row => <tr key={row} aria-hidden="true" className="motion-safe:animate-pulse"><td className="p-3"><div className="size-7 rounded-lg bg-border" /></td><td className="py-4 pr-5"><div className="mb-2 h-3 w-1/3 rounded bg-border" /><div className="h-2 w-4/5 rounded bg-border" /></td><td className="pr-4"><div className="ml-auto h-3 w-12 rounded bg-border" /></td></tr>)}
        </tbody>
      </table></div>
      {!rows.length && !loading && <p role="status" className="px-4 py-3 text-body text-muted">No available sources found for this request.</p>}
      {(hidden > 0 || (showAll && orderedGroups.length > RESULT_PREVIEW)) && <button type="button" aria-expanded={showAll} onClick={() => setShowAll(open => !open)}
        className="flex w-full items-center justify-center gap-1 border-t border-border-2 py-2 text-tiny text-muted hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[color:var(--accent-line)]">
        {showAll ? <>Show fewer results<ChevronUp aria-hidden="true" className="size-3.5" /></> : <>Show all {rows.length} results<ChevronDown aria-hidden="true" className="size-3.5" /></>}
      </button>}
    </div>

  </div>
  const purchase = children ?? (chosen.length > 0 && <StickyComposerSummary role="region" aria-label={chosen.length > 1 ? 'Selected sources' : 'Selected source'} className={stickyBar}>
      <div className="min-w-0">
        <p className="truncate text-body font-medium">{chosen.length > 1 ? `${chosen.length} sources selected` : chosen[0].source.name}</p>
        <p className="text-tiny text-muted">Nothing is charged until you approve.</p>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" size="lg" className="rounded-full" disabled={disabled} onClick={onClear}>Clear</Button>
        <Button type="button" variant="secondary" size="lg" disabled={disabled} onClick={onGetPrice}
          className={cn('rounded-full', selectedPill)}>
          View price
        </Button>
      </div>
    </StickyComposerSummary>)
  if (presentation === 'answer') return <AnswerLayout sourcesFirst={!approved} sources={[]} selectionRequired={!loading && !disabled && !approved && chosen.length === 0 && rows.length > 0} sourceCount={approved ? chosen.length : rows.length} sourceContent={approved ? <div className="space-y-5 p-4">
    {chosen.map(item => <SourceOption key={item.key} item={item} />)}
    <button type="button" disabled={disabled} onClick={onClear} className="text-tiny text-muted hover:text-foreground disabled:opacity-50">{chosen.length > 1 ? 'Change sources' : 'Change source'}</button>
  </div> : chooser}>
    {purchase}
  </AnswerLayout>
  return <div className="overflow-clip rounded-xl border border-border-2 bg-surface">{chooser}{purchase}</div>

}

/** A source's logo: the one it carries, else a curated mark, else its site's own. */
function SourceMark({ source, className }: { source: PurchaseSource; className: string }) {
  const href = safeSourceUrl(source.url)
  const known = curatedSourceMark(source.name, source.source_slug, href)
  const logoUrl = source.logo_url?.startsWith('/') && !source.logo_url.startsWith('//') ? source.logo_url : safeSourceUrl(source.logo_url ?? null)
  return <EntityLogo name={source.name} logoUrl={logoUrl ?? known?.logoUrl} siteUrl={href ?? known?.host} className={className} />
}

function SourceRow({ source, disabled, selected, onToggle }: { source: PurchaseSource; disabled: boolean; selected: boolean; onToggle: () => void }) {
  const money = useMoney()
  const price = money.ready ? formatSourcePrice(source.price, money.currency, money.rate) : '…'
  const selectable = Boolean(sourceRef(source))
  // What the endpoint does leads; its source follows, and the full description is on hover.
  const summary = sourceSummary(source)
  const described = source.description?.trim()
  // The name, summary and logo all choose this source inside Ask.
  // The checkbox keeps its own click so selection fires only once.
  const toggleRow = (event: MouseEvent<HTMLTableRowElement>) => {
    if (!selectable || disabled || (event.target as HTMLElement).closest('a, button, input, label')) return
    onToggle()
  }
  return <tr onClick={toggleRow} className={cn('group [&+tr>td]:border-t [&+tr>td]:border-border-2/50 [&>td]:transition-colors [&>td:first-child]:rounded-l-lg [&>td:last-child]:rounded-r-lg has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--accent-line)]', selectable && !disabled && 'cursor-pointer', selected ? '[&>td]:bg-hover hover:[&>td]:bg-foreground/10' : selectable && !disabled && 'hover:[&>td]:bg-hover')}>
    <td className="min-w-0 py-2 pl-3 pr-2 align-middle">
      <p className="line-clamp-2 break-words" title={described || summary}>{summary}</p>
    </td>
    <td className="py-2 pr-3 text-right align-middle text-tiny tabular-nums sm:pr-4">
      <span className="block whitespace-nowrap">{price || <span aria-label="Price unavailable">—</span>}</span>
      {selectable && <input type="checkbox" checked={selected}
        aria-label={summary === source.name ? `Select ${source.name}` : `Select ${summary} from ${source.name}`}
        disabled={disabled} onChange={onToggle} className="sr-only" />}
    </td>
  </tr>
}

function SourceOption({ item }: { item: AskSourceItem }) {
  const source = item.source
  return <div className="flex items-start gap-2.5">
    <SourceMark source={source} className="mt-0.5 size-6 shrink-0 rounded-full" />
    <div className="min-w-0 space-y-1">
      <p className="text-tiny text-muted">{source.name}</p>
      <p className="text-body font-medium">{sourceSummary(source)}</p>
      {source.subject_label && <p className="text-tiny text-muted">{source.subject_label}</p>}
      {source.description && <p className="line-clamp-3 text-tiny text-muted">{source.description}</p>}
    </div>
  </div>
}
