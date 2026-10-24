import * as React from 'react'
import { useAskStatus } from "./gateway-v2-status"

/**
 * A visible activity indicator, tied to the real request phase. `inline` drops
 * the bubble, for a reply that already sits beside Apiosk's mark.
 */
export function AskThinking({ label, inline = false }: { label: string; inline?: boolean }) {
  const elapsed = useAskStatus(label, true)
  return <div role="status" className={inline
    ? "ask-message flex w-fit max-w-full items-center gap-3 py-1.5"
    : "ask-message flex w-fit max-w-full items-center gap-3 rounded-2xl rounded-bl-md border border-border-2 bg-[color:var(--input-bg)] px-4 py-3"}>
    <span className="flex shrink-0 items-center gap-1 text-muted" aria-hidden="true">{[0, 1, 2].map(dot => <span key={dot} className="ask-typing-dot size-1.5 rounded-full bg-current" style={{ animationDelay: `${dot * 160}ms` }} />)}</span>
    <span className="text-body text-muted">{label}<span aria-hidden="true">{elapsed.slice(label.length)}</span></span>
  </div>
}
