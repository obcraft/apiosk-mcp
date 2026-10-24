import { useEffect, useState } from "react"

/** Keep the actual phase visible; elapsed time is not evidence of a new step. */
export function useAskStatus(first: string, active: boolean): string {
  const phase = active ? first : ""
  const [clock, setClock] = useState({ phase, seconds: 0 })
  if (clock.phase !== phase) setClock({ phase, seconds: 0 })

  useEffect(() => {
    if (!active) return
    const started = Date.now()
    const timer = window.setInterval(() => setClock({ phase, seconds: Math.floor((Date.now() - started) / 1000) }), 1000)
    return () => window.clearInterval(timer)
  }, [active, phase])

  return clock.phase === phase && clock.seconds >= 10 ? `${first} ${clock.seconds}s elapsed.` : first
}
