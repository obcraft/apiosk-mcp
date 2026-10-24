import type { ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { GatewayV2Proposal } from '@/components/ask/gateway-v2-proposal'
import { useGatewayV2Money } from '@/components/ask/gateway-v2-money'
import type { GatewayV2Response } from '@/lib/domain/gateway-v2'
type Proposal = NonNullable<GatewayV2Response['proposal']>


/**
 * A priced plan and its one approval. The only card on a task: the sources,
 * the ceiling, and the button that authorises exactly that ceiling.
 */
export function TaskQuote({ proposal, coverageNotices, expired, canApprove, executionEnabled = true, disabled, approveDisabled = false, onApprove, onRefreshPrice, analysisChoice, sourceChoice, children }: {
  proposal: Proposal
  coverageNotices?: string[]
  expired: boolean
  /** The task has a step this approval would start. */
  canApprove: boolean
  executionEnabled?: boolean
  disabled: boolean
  approveDisabled?: boolean
  onApprove: () => void
  onRefreshPrice: () => void
  analysisChoice?: ReactNode
  sourceChoice?: ReactNode
  /** Further choices beside the approval (the purchase panel's Edit inputs). */
  children?: ReactNode
}) {
  const formatMoney = useGatewayV2Money()
  const refresh = canApprove && expired
  const approve = canApprove && !expired
  return <GatewayV2Proposal proposal={proposal} coverageNotices={coverageNotices}>
    {!executionEnabled && <p role="status" className="text-body text-muted">Purchases are disabled for this environment or workspace. You can review the plan and price.</p>}
    {refresh && <p className="text-body">This quote has expired. Refresh it for a current price.</p>}
    {sourceChoice}
    {analysisChoice}
    {(refresh || approve || children) && <div className="flex flex-wrap items-center gap-2">
      {refresh && <Button variant="primary" disabled={disabled} onClick={onRefreshPrice}><RefreshCw aria-hidden="true" />Refresh price</Button>}
      {approve && <Button variant="primary" disabled={disabled || approveDisabled || !executionEnabled} onClick={onApprove}>Approve up to {formatMoney(proposal.max_total_atomic)}</Button>}
      {children}
    </div>}
  </GatewayV2Proposal>
}
export { TaskQuote as AskAutomaticQuote }
