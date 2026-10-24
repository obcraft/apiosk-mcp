import { formatDisplayText, formatDisplayNarrative } from "@/lib/ui/display-text"
import { CircleCheck, CircleHelp, CircleX, TriangleAlert } from "lucide-react"
import type { GatewayV2SupplierVerdict } from "@/lib/domain/gateway-v2"
import { cn } from "@/lib/ui/utils"
import { ResponseText } from '@/components/response/response-text'

type Check = GatewayV2SupplierVerdict["checks"][number]

const decisions = {
  hold: { emoji: "⚠️", banner: "border-danger-border bg-danger-bg text-danger" },
  review: { emoji: "🔎", banner: "border-warning-border bg-warning-bg text-warning" },
  ok: { emoji: "✅", banner: "border-success-border bg-success-bg text-success" },
} as const

const words = {
  en: { region: "Supplier payment check", reasons: "Why", checks: "Checks", source: "Source", vat: "VAT", status: { pass: "Passed", warn: "Warning", fail: "Failed", unknown: "Not checked" } },
  nl: { region: "Controle leverancier", reasons: "Waarom", checks: "Controles", source: "Bron", vat: "btw", status: { pass: "In orde", warn: "Let op", fail: "Niet in orde", unknown: "Niet gecontroleerd" } },
} as const

const statusStyle: Record<Check["status"], { icon: typeof CircleCheck; className: string }> = {
  pass: { icon: CircleCheck, className: "text-success" },
  warn: { icon: TriangleAlert, className: "text-warning" },
  fail: { icon: CircleX, className: "text-danger" },
  unknown: { icon: CircleHelp, className: "text-faint" },
}

/**
 * "Can I safely pay this supplier?", answered as a decision first: one banner
 * that says hold, review or pay, the reasons for it, and then every check
 * behind it with its source. Colour always travels with an emoji, an icon and
 * words, so the decision never depends on seeing red or green.
 */
export function SupplierVerdictCard({ verdict }: { verdict: GatewayV2SupplierVerdict }) {
  const copy = words[verdict.language === "en" ? "en" : "nl"]
  const decision = decisions[verdict.decision] ?? decisions.review
  const headline = verdict.headline?.trim() || `${decision.emoji} ${verdict.label}`
  const supplier = verdict.supplier
  const supplierLine = [
    supplier?.name ? formatDisplayText(supplier.name) : null,
    supplier?.kvk_number ? `KVK ${supplier.kvk_number}` : null,
    supplier?.vat_number ? `${copy.vat} ${supplier.vat_number}` : null,
    supplier?.iban_masked ? `IBAN ${supplier.iban_masked}` : null,
    supplier?.domain,
  ].filter(Boolean).join(" · ")
  const reasons = verdict.reasons ?? []
  const checks = verdict.checks ?? []

  return <section aria-label={copy.region} className="overflow-hidden rounded-xl border border-border-2 bg-surface">
    <div className={cn("border-b px-4 py-3.5 sm:px-5", decision.banner)}>
      <p className="text-large" data-decision={verdict.decision}>{headline}</p>
      {supplierLine && <p className="mt-1 break-words text-body text-foreground/80">{supplierLine}</p>}
    </div>
    <div className="space-y-4 px-4 py-4 sm:px-5">
      {reasons.length > 0 && <div className="space-y-1.5">
        <h3 className="text-body font-medium">{copy.reasons}</h3>
        <ul className="list-disc space-y-1 pl-5 text-body">{reasons.map((reason, index) => <li key={index}><ResponseText text={formatDisplayNarrative(reason, verdict)} /></li>)}</ul>
      </div>}
      {checks.length > 0 && <div className="space-y-1.5">
        <h3 className="text-body font-medium">{copy.checks}</h3>
        <ul aria-label={copy.checks} className="divide-y divide-border">{checks.map((check, index) => {
          const style = statusStyle[check.status] ?? statusStyle.unknown
          const Icon = style.icon
          const muted = !statusStyle[check.status] || check.status === "unknown"
          return <li key={`${check.id}-${index}`} data-status={check.status} className={cn("flex items-start gap-2.5 py-2.5 text-body", muted && "text-muted")}>
            <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", style.className)} />
            <div className="min-w-0 flex-1">
              <p className={cn("font-medium leading-snug", muted ? "text-muted" : "text-foreground")}>
                <span className="sr-only">{copy.status[check.status] ?? copy.status.unknown}: </span>{formatDisplayNarrative(check.label, verdict)}
              </p>
              {check.detail && <p className="mt-0.5 break-words leading-snug text-muted"><ResponseText text={formatDisplayNarrative(check.detail, verdict)} /></p>}
              {check.source && <p className="mt-0.5 text-tiny text-faint">{copy.source}: <ResponseText text={check.source} /></p>}
            </div>
          </li>
        })}</ul>
      </div>}
    </div>
  </section>
}
