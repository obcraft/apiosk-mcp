import { formatDisplayNarrative } from "@/lib/ui/display-text"
import type { ReactNode } from "react"
import { useGatewayV2Money } from "@/components/ask/gateway-v2-money"
import { EntityLogo } from "@/components/explore/entity-logo"
import type { GatewayV2Response } from "@/lib/domain/gateway-v2"
import { SourceUsageNotices } from './source-usage-notices'
import { quoteBreakdownOffsets } from '@/lib/ui/source-price'

import { GatewayV2CoverageNotices } from "./coverage-notices"
export { GatewayV2CoverageNotices } from "./coverage-notices"

type StepDetail = NonNullable<NonNullable<GatewayV2Response["proposal"]>["step_details"]>[number]
const STEP_STATUS: Record<NonNullable<StepDetail["status"]>, string> = { pending: "Waiting", running: "Getting data…", completed: "Completed", failed: "Could not complete", cancelled: "Cancelled", paused: "Paused" }

/** The same operation from the same source for several subjects is one row:
 *  its count, its subjects and their summed price. */
function groupSteps(steps: StepDetail[]) {
  const groups = new Map<string, StepDetail[]>()
  for (const step of steps) {
    const key = [step.kind, step.title, step.source.directory_slug || step.source.slug || step.source.name, step.conditional ? step.condition : ""].join("\u0000")
    groups.set(key, [...(groups.get(key) ?? []), step])
  }
  return [...groups.values()].map(items => ({ items, total: items.length === 1 ? items[0].max_total_atomic
    : items.every(step => /^\d+$/.test(step.max_total_atomic ?? "")) ? items.reduce((sum, step) => sum + BigInt(step.max_total_atomic!), 0n).toString() : undefined }))
}
function groupStatus(items: StepDetail[]) {
  const statuses = [...new Set(items.flatMap(step => step.status ? [step.status] : []))]
  if (statuses.length <= 1) return statuses[0] && STEP_STATUS[statuses[0]]
  return statuses.map(status => `${items.filter(step => step.status === status).length} ${STEP_STATUS[status].toLowerCase()}`).join(" · ")
}

/** The execution graph is private; people review the request and its ceiling. */
export function GatewayV2Proposal({ proposal, coverageNotices, approved = false, children }: { proposal: NonNullable<GatewayV2Response["proposal"]>; coverageNotices?: string[]; approved?: boolean; children?: ReactNode }) {
  const formatMoney = useGatewayV2Money()
  const groups = groupSteps(proposal.step_details ?? [])
  const priceOffsets = quoteBreakdownOffsets(proposal.max_total_atomic, groups.map(group => group.total))
  const sources = [...new Map((proposal.step_details ?? []).filter(d => d.kind !== "compute").map(d => [d.source.directory_slug || d.source.slug || d.source.name, { ...d.source, name: d.source.directory_name || d.source.name }])).values()]
  const subjects = [...new Set((proposal.step_details ?? []).map(d => d.subject).filter(Boolean))]
  const title = subjects.length ? subjects.join(" · ") : proposal.label || "Data request"
  // One source: its mark heads the card and its name sits under the title.
  const only = sources.length === 1 ? sources[0] : null
  return <div className="space-y-4 rounded-xl border border-border-2 bg-surface p-5">
    {only ? <div className="flex items-center gap-3">
      <EntityLogo name={only.name} logoUrl={only.logo_url} siteUrl={only.url} className="!size-10 shrink-0" />
      <div className="min-w-0">
        <h2 className="font-medium">{formatDisplayNarrative(title, proposal)}</h2>
        <p className="text-body text-muted">{only.name}</p>
      </div>
    </div> : <h2 className="font-medium">{formatDisplayNarrative(title, proposal)}</h2>}
    {/* WHO IS BEING PAID, IN THE OPEN. Approving a charge without seeing the
        sources it buys is approving a number; the names belong next to it, not
        behind a disclosure nobody opens. */}
    {sources.length > 1 && <div className="text-body text-muted">
      <p>{sources.length} {sources.length === 1 ? "source" : "sources"}</p>
      <ul className="mt-2 space-y-2">{sources.map(source => <li key={source.slug || source.name} className="flex items-center gap-2">
        <EntityLogo name={source.name} logoUrl={source.logo_url} siteUrl={source.url} className="!size-6 shrink-0" />
        <span>{source.name}</span>
      </li>)}</ul>
    </div>}
    <div><p className="text-tiny text-muted">{approved ? "Approved maximum" : "Maximum total"}</p><p className="text-large tabular-nums">{formatMoney(proposal.max_total_atomic)}</p></div>
    <p className="text-tiny text-muted">{approved ? "Approved. Your entire request stays within this amount." : "Approve once. The entire request stays within this amount."}</p>
    {!!proposal.step_details?.length && <ol aria-label="Price per item" className="divide-y divide-border-2">
      {groups.map(({ items, total }, index) => { const step = items[0]; const subjects = [...new Set(items.map(item => item.subject).filter(Boolean))]; const status = approved && groupStatus(items)
        return <li key={step.number} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 py-3 text-body">
        <div className="min-w-0">
          <p className="break-words">{index + 1}. {step.title}{items.length > 1 && ` · ${items.length}×`}</p>
          <p className="mt-1 text-tiny text-muted">{step.source.directory_name || step.source.name}</p>
          {items.length > 1 && subjects.length > 0 && <p className="mt-1 text-tiny text-muted">{subjects.join(" · ")}</p>}
          {status && <p className="mt-1 text-tiny text-muted">{status}</p>}
          {step.conditional && step.condition && <p className="mt-1 text-tiny text-muted">{step.condition}</p>}
        </div>
        <span className="whitespace-nowrap font-medium tabular-nums">{total != null ? formatMoney(total, false, undefined, priceOffsets?.[index]) : "Price unavailable"}</span>
      </li> })}
    </ol>}
    <SourceUsageNotices sources={(proposal.step_details ?? []).map(step => step.source)} />
    <GatewayV2CoverageNotices notices={coverageNotices} />
    {children}
  </div>
}
