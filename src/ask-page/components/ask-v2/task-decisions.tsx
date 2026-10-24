import { useId, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { GatewayV2Action, GatewayV2Response } from '@/lib/domain/gateway-v2'
import { candidateDetail, suppliedValue, taskInputLabel } from '@/lib/domain/ask-v2-task'
import { formatDisplayText } from '@/lib/ui/display-text'
type Candidate = NonNullable<GatewayV2Response['context_view']['candidates']>[number]


/**
 * The distinct matches a source returned for a name; picking one continues
 * within the approved amount. `note` says when these are not every match.
 */
export function TaskChoices({ candidates, note, disabled, onChoose }: { candidates: Candidate[]; note?: string | null; disabled: boolean; onChoose: (entityRef: string) => void }) {
  return <section aria-label="Choose the right result" className="space-y-3">
    <div>
      <h2 className="text-body font-medium">Which one do you mean?</h2>
      <p className="text-body text-muted">{candidates.length} {candidates.length === 1 ? "match" : "matches"}. Pick one to continue within your approved amount.</p>
      {note && <p className="text-tiny text-muted">{note}</p>}
    </div>
    <ul className="max-w-xl divide-y divide-border-2 overflow-hidden rounded-xl border border-border-2">
      {candidates.map(candidate => {
        const detail = candidateDetail(candidate.facts)
        return <li key={candidate.entity_ref}>
          <button type="button" disabled={disabled} aria-label={`Select ${formatDisplayText(candidate.label)}${detail ? `, ${detail}` : ""}`} onClick={() => onChoose(candidate.entity_ref)} className="group flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:bg-hover focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium">{formatDisplayText(candidate.label)}</span>
              {detail && <span className="block text-tiny tabular-nums text-muted">{detail}</span>}
            </span>
            <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-faint transition-transform group-hover:translate-x-0.5 group-hover:text-foreground" />
          </button>
        </li>
      })}
    </ul>
  </section>
}


/** A value the task needs before it can continue, typed as its action declares. */
export function TaskInput({ action, disabled, onSubmit }: { action: GatewayV2Action; disabled: boolean; onSubmit: (value: string | number | boolean) => void }) {
  const id = useId()
  const [value, setValue] = useState("")
  const description = action.input_schema.properties?.value?.description?.trim()
  return <form className="max-w-xl space-y-3" onSubmit={event => { event.preventDefault(); onSubmit(suppliedValue(action, value)) }}>
    <label htmlFor={id} className="block text-body">{taskInputLabel(action)}</label>
    {description && <p id={`${id}-help`} className="text-body text-muted">{description}</p>}
    <Input id={id} aria-describedby={description ? `${id}-help` : undefined} value={value} onChange={event => setValue(event.target.value)} required disabled={disabled} />
    <Button disabled={disabled}>Continue</Button>
  </form>
}
