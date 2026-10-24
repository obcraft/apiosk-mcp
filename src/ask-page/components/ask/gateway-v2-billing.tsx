import type { ReactNode } from "react"
import { ChevronDown } from "lucide-react"
import { useGatewayV2Money } from "@/components/ask/gateway-v2-money"
import { type GatewayV2Response } from "@/lib/domain/gateway-v2"
import { quoteBreakdownOffsets } from '@/lib/ui/source-price'

export function GatewayV2Billing({ billing, compact = false, children }: { billing: NonNullable<GatewayV2Response["billing"]>; compact?: boolean; children?: ReactNode }) {
  const amount = useGatewayV2Money()
  const costOffsets = quoteBreakdownOffsets(billing.total_charged, [billing.provider_cost, billing.apiosk_fee])
  const executionOffsets = quoteBreakdownOffsets(billing.total_charged, billing.executions.map(execution => execution.total_charged))
  const providerCost = billing.provider_cost == null ? null : amount(billing.provider_cost, false, undefined, costOffsets?.[0])
  const apioskFee = billing.apiosk_fee == null ? null : amount(billing.apiosk_fee, false, undefined, costOffsets?.[1])
  const labels: Record<string, string> = { not_started: "No purchase yet", reserved: "Amount reserved", pending_reconciliation: "Payment being checked", captured: "Payment completed", released: "No amount charged", refunded: "Amount refunded" }
  const hasDetails = billing.status !== "not_started" || billing.executions.length > 0
  if (compact) return <div role="group" aria-label="Apiosk balance payment" className="border-t border-border-2 pt-2 text-tiny text-muted">
    <details className="group">
      <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-3 transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <span>{labels[billing.status] || "Payment status unavailable"}{(billing.status === "captured" || billing.total_charged !== "0") && <> · {amount(billing.total_charged)}{billing.status !== "captured" && " spent"}</>}{billing.reserved !== "0" && <> · {amount(billing.reserved)} held</>}</span>
        <span className="flex shrink-0 items-center gap-1">Details<ChevronDown aria-hidden="true" className="size-3 transition-transform group-open:rotate-180" /></span>
      </summary>
      <div className="space-y-2 pb-1 pt-2">
        <p>Spent · {billing.workspace?.name ?? "Apiosk balance"}: {amount(billing.total_charged)}</p>
        {billing.balance_available != null && <p>Available balance: {amount(billing.balance_available, true)}</p>}
        {billing.reserved !== "0" && <p>Held / awaiting confirmation: {amount(billing.reserved)}</p>}
        {billing.status === "pending_reconciliation" && <p>The outcome is being checked. This does not start another purchase.</p>}
        {providerCost != null && <p>Provider tariff: {providerCost}</p>}
        {apioskFee != null && <p>Apiosk fee ({billing.fee_percent === 20 ? 20 : 15}%{billing.fee_percent === 20 ? ", workflow" : ""}): {apioskFee}</p>}
        {billing.executions.map((e, index) => <p key={e.execution_id} className="break-all">{labels[e.status] || e.status}: {amount(e.total_charged, false, undefined, executionOffsets?.[index])}{e.receipt_ref ? ` · Receipt ${e.receipt_ref}` : ""}</p>)}
        {children}
      </div>
    </details>
  </div>
  return <fieldset className="min-w-0 rounded-xl border border-border-2 px-4 pb-3 pt-2" aria-label="Apiosk balance payment">
    <legend className="px-2 text-tiny font-medium text-muted">{labels[billing.status] || "Payment status unavailable"}</legend>
    <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-body sm:flex sm:flex-wrap sm:gap-x-10">
      <div className="min-w-0 space-y-1"><dt className="text-tiny text-muted">Spent · {billing.workspace?.name ?? "Apiosk balance"}</dt><dd className="break-words font-medium tabular-nums">{amount(billing.total_charged)}</dd></div>
      {billing.balance_available != null && <div className="min-w-0 space-y-1"><dt className="text-tiny text-muted">Available balance</dt><dd className="break-words font-medium tabular-nums">{amount(billing.balance_available, true)}</dd></div>}
      {billing.reserved !== "0" && <div className="min-w-0 space-y-1"><dt className="text-tiny text-muted">Held / awaiting confirmation</dt><dd className="break-words font-medium tabular-nums">{amount(billing.reserved)}</dd></div>}
    </dl>
    {billing.status === "pending_reconciliation" && <p className="mt-3 text-tiny text-muted">The outcome is being checked. This does not start another purchase.</p>}
    {hasDetails && <details className="mt-3 border-t border-border pt-2 text-tiny text-muted">
      <summary className="cursor-pointer py-1 transition-colors hover:text-foreground">Price breakdown and receipts</summary>
      <div className="space-y-1.5 pt-2">
        {providerCost != null && <p>Provider tariff: {providerCost}</p>}
        {apioskFee != null && <p>Apiosk fee ({billing.fee_percent === 20 ? 20 : 15}%{billing.fee_percent === 20 ? ", workflow" : ""}): {apioskFee}</p>}
        {billing.executions.map((e, index) => <p key={e.execution_id} className="break-all">{labels[e.status] || e.status}: {amount(e.total_charged, false, undefined, executionOffsets?.[index])}{e.receipt_ref ? ` · Receipt ${e.receipt_ref}` : ""}</p>)}
      </div>
    </details>}
  </fieldset>
}
