import type { FinancialStatement as Statement } from '@/lib/domain/financial-statement'
import { financialValue } from '@/lib/domain/financial-statement'
import { asDate } from '@/lib/ui/answer'
import { cn } from '@/lib/ui/utils'
import { ResponseText } from '@/components/response/response-text'

export function FinancialStatement({ statement, compact = false, locale = typeof navigator === 'undefined' ? 'en-US' : navigator.language }: {
  statement: Statement; compact?: boolean; locale?: string
}) {
  const adopted = statement.metadata.find(row => row.key === 'DocumentAdoptionDate')
  return <div className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-tiny text-muted">
      {statement.year && <span>Financial year <strong className="font-medium text-foreground">{statement.year}</strong></span>}
      {adopted?.value != null && <span>Accounts adopted {asDate(String(adopted.value)) ?? String(adopted.value)}</span>}
      <span>{statement.currency ? `Amounts in ${statement.currency}` : 'Currency not provided by source'}</span>
    </div>
    {statement.highlights.length > 0 && <dl aria-label="Key figures" className="grid gap-3 sm:grid-cols-3">
      {statement.highlights.map(row => <div key={row.key} className="flex min-w-0 items-center justify-between gap-4 rounded-xl border border-border-2 bg-surface p-3 sm:block sm:p-4">
        <dt className="text-tiny text-muted">{row.label}</dt>
        <dd className="overflow-x-auto whitespace-nowrap text-right text-large tracking-tight text-heading tabular-nums sm:mt-2 sm:text-left">{financialValue(row, locale)}</dd>
      </div>)}
    </dl>}
    {!compact && <>
      {statement.sections.map((section, index) => <section key={`${section.key}-${index}`} aria-label={section.title} className="space-y-3">
        <h3 className="text-body font-medium text-heading">{section.title}</h3>
        <div className="overflow-x-auto rounded-xl border border-border-2 bg-surface">
          <table className="w-full table-fixed border-collapse text-body" aria-label={section.title}>
            <colgroup><col className="w-3/5" /><col className="w-2/5" /></colgroup>
            <thead><tr className="border-b border-border-2 bg-surface-soft text-tiny text-muted">
              <th scope="col" className="px-4 py-3 text-left font-medium">Item</th>
              <th scope="col" className="px-4 py-3 text-right font-medium">{statement.currency ?? 'Reported value'}</th>
            </tr></thead>
            <tbody>{section.rows.map((row, rowIndex) => <tr key={`${row.key}-${rowIndex}`} className={cn('border-b border-border-2 last:border-0', row.total && 'bg-surface-soft font-medium text-heading')}>
              <th scope="row" className={cn('break-words px-4 py-3 text-left align-top font-normal', row.total && 'font-medium')}>{row.label}</th>
              <td className="whitespace-nowrap px-4 py-3 text-right align-top tabular-nums">{financialValue(row, locale)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </section>)}
      {statement.metadata.length > 0 && <details className="border-t border-border-2 pt-4 text-tiny">
        <summary className="cursor-pointer font-medium text-muted">Filing details</summary>
        <dl className="mt-3 divide-y divide-border-2">{statement.metadata.map((row, index) => <div key={`${row.key}-${index}`} className="grid grid-cols-2 gap-4 py-2">
          <dt className="text-muted">{row.label}</dt><dd className="min-w-0 break-words text-right tabular-nums"><ResponseText text={/Date$/.test(row.key) && row.value != null ? asDate(String(row.value)) ?? financialValue(row, locale) : financialValue(row, locale)} /></dd>
        </div>)}</dl>
      </details>}
    </>}
  </div>
}
