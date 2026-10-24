import { useEffect, useMemo, useState } from "react"

/** How long a whole reply takes to arrive, and the bounds per word. */
const TOTAL_MS = 1200
const MIN_TICK_MS = 16
const MAX_TICK_MS = 60

/**
 * A reply arriving word by word, for a message that just landed.
 *
 * The gateway composes an answer and sends it whole, so the prose is drawn
 * the way a streamed reply reads — a few words at a time, over about a
 * second — and only for a message that arrived in this session (`live`). A
 * message read back from history is shown at once: it has been read before.
 *
 * Words, not letters: a letter-by-letter reveal at a readable speed takes
 * six seconds for a sentence, and a fast one flickers. Respects the reduced
 * motion preference by showing everything at once.
 */
export function useReveal(text: string, live: boolean): { shown: string; done: boolean } {
  const parts = useMemo(() => (live ? text.split(/(?<=\s)/) : []), [text, live])
  const instant = !live || parts.length <= 1 || reducedMotion()
  // The count belongs to one reply; a new reply starts it over, in render
  // rather than in an effect, so the first frame is already right.
  const [progress, setProgress] = useState({ parts, count: 0 })
  if (progress.parts !== parts) setProgress({ parts, count: 0 })
  const count = progress.parts === parts ? progress.count : 0
  const finished = count >= parts.length
  const done = instant || finished

  useEffect(() => {
    if (instant || finished) return
    const tick = Math.max(MIN_TICK_MS, Math.min(MAX_TICK_MS, TOTAL_MS / parts.length))
    const timer = window.setInterval(() => {
      setProgress((was) => (was.parts === parts ? { parts, count: was.count + 1 } : was))
    }, tick)
    return () => window.clearInterval(timer)
  }, [instant, parts, finished])

  return { shown: done ? text : parts.slice(0, count).join(""), done }
}

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false
}
