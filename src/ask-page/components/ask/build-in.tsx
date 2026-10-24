import { useLayoutEffect, useRef, type ReactNode } from "react"
import { reducedMotion } from "./reveal"

/** Time between one piece of an answer arriving and the next. */
const STEP_MS = 45
/** A long table still finishes arriving in well under a second. */
const MAX_STEPS = 16

/**
 * An answer's cards, charts and tables assembling as it arrives.
 *
 * The gateway sends a whole answer at once, so this draws it the way a
 * streamed reply reads: the block rises in, then its rows, bars and list
 * items follow one after another, top to bottom. Only for an answer that
 * arrived in this session (`live`); one read back from history is shown at
 * once, as is everything under the reduced motion preference.
 */
export function BuildIn({ live, children }: { live: boolean; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = root.current
    if (!live || !node || reducedMotion()) return
    node.classList.add("answer-enter")
    const pieces = node.querySelectorAll<HTMLElement>("tbody tr, li, figure > div, [data-build]")
    pieces.forEach((piece, index) => {
      piece.classList.add("row-in")
      piece.style.animationDelay = `${120 + Math.min(index, MAX_STEPS) * STEP_MS}ms`
    })
    // Pieces render again later (sorting, paging) and must not replay.
    const timer = window.setTimeout(() => pieces.forEach(piece => {
      piece.classList.remove("row-in")
      piece.style.animationDelay = ""
    }), 1200 + MAX_STEPS * STEP_MS)
    return () => window.clearTimeout(timer)
  }, [live])
  return <div ref={root} className="min-w-0 max-w-full space-y-4">{children}</div>
}
