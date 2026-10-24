import { useRef, useState } from 'react'
import { TaskChoices, TaskInput } from '@/components/ask-v2/task-decisions'
import type { GatewayV2Action } from '@/lib/domain/gateway-v2'

type Props = {
  output: Record<string, any>
  disabled?: boolean
  onAction: (action: GatewayV2Action, input: { entity_ref: string } | { value: string | number | boolean }) => unknown | Promise<unknown>
}

/** The Ask page's decisions, bound to the current saved task and action IDs. */
export function AskTaskDecisions({ output, onAction, disabled = false }: Props) {
  const active = useRef(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const actions: GatewayV2Action[] = Array.isArray(output.next_actions) ? output.next_actions : []
  const supply = actions.find(action => action.kind === 'supply_input' && action.requires_authorization === false)
  const select = actions.find(action => action.kind === 'select_entity' && action.requires_authorization === false)
  if (!output.state || !supply && !select) return null
  const blocked = disabled || busy || output.billing?.status === 'pending_reconciliation'
  async function run(action: GatewayV2Action, input: { entity_ref: string } | { value: string | number | boolean }) {
    if (blocked || active.current) return
    active.current = true; setBusy(true); setError('')
    try { await onAction(action, input) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The saved task could not continue. Try again.') }
    finally { active.current = false; setBusy(false) }
  }
  return <div className="space-y-3">
    {supply && <TaskInput key={supply.action_id} action={supply} disabled={blocked} onSubmit={value => void run(supply, { value })} />}
    {select && <TaskChoices candidates={output.context_view?.candidates ?? []} note={output.context_view?.candidates_note}
      disabled={blocked} onChoose={entity_ref => void run(select, { entity_ref })} />}
    {error && <p role="alert" className="text-body text-danger">{error}</p>}
  </div>
}
