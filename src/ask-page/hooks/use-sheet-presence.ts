import { useEffect, useState } from "react"

/**
 * How long to wait for an exit animation before dropping the sheet anyway.
 *
 * NOT the animation's duration — that stays in the stylesheet, and
 * `animationend` is still what normally ends the exit. This is the backstop for
 * the cases where that event never arrives at all: the element is hidden
 * mid-exit, the tab goes to the background as it closes, a future stylesheet
 * edit removes the animation the unmount is waiting on. Generous on purpose, so
 * it never races a real animation (the slowest sheet here is 0.18s) and only
 * fires when nothing else did.
 */
export const EXIT_FALLBACK_MS = 400

/**
 * Whether an animated overlay should be in the DOM, and whether it is leaving.
 *
 * Pulled out of `MobileNav` because the interesting part is the state machine,
 * not the markup — and because that machine is what an overlay gets WRONG in a
 * way nobody sees in a screenshot: it strands. A sheet that stays mounted
 * holds the body's scroll lock, and a page whose scroll is locked with no
 * visible control to unlock it is a page that has, as far as anyone using it is
 * concerned, frozen.
 *
 * Three things can end the exit, and all three have to, or the sheet strands:
 *
 *   1. `endExit()` — the ordinary path, called from the panel's `animationend`.
 *   2. `active` going false — the layout that owns the sheet is gone. On a
 *      `lg:hidden` sheet, crossing the breakpoint sets `display: none`, which
 *      means no animation runs and no `animationend` is ever coming. This is
 *      the one that was stranding the app: an iPad turned to landscape
 *      (768px → 1024px, exactly the boundary), a foldable opened, a window
 *      widened — the sheet vanished, the lock stayed, and only a reload got
 *      the page scrolling again.
 *   3. The fallback timer, for everything neither of those covers.
 *
 * `onDismiss` clears the caller's own "open" intent once the sheet is gone for
 * good, so a layout change that took the sheet away doesn't leave a stored
 * `open: true` waiting to spring it back the moment the layout returns.
 */
export function useSheetPresence(
  /** The intent: someone asked for this sheet. */
  open: boolean,
  /** Whether the layout that owns the sheet is the one currently on screen. */
  active: boolean,
  /** Called when the sheet is dropped for a reason other than being closed. */
  onDismiss: () => void,
): {
  /** Whether the sheet belongs in the DOM at all. */
  rendered: boolean
  /** Whether it is on its way out, and should wear the `-out` animations. */
  leaving: boolean
  /** Call from the exit animation's `animationend`. */
  endExit: () => void
} {
  const [rendered, setRendered] = useState(open && active)

  // Adjusting state during render, which React supports for a component's own
  // state and which an effect cannot do without costing an extra frame — the
  // sheet would paint once at its open position before the enter animation
  // started, and flash.
  //
  // BOTH directions are conditioned on `active`, and they have to be: a mount
  // branch that ignored it would re-add what the drop branch just removed, on
  // every render, forever.
  if (open && !rendered && active) setRendered(true)
  if (rendered && !active) setRendered(false)

  const leaving = rendered && !open

  // Case 2 above. The DOM is already dropped by the render-phase adjustment —
  // a frame spent holding the scroll lock is a frame the page cannot scroll —
  // so all that is left here is clearing the intent.
  useEffect(() => {
    if (active) return
    onDismiss()
    // `onDismiss` is a store setter and stable; depending on it would re-run
    // this on every render that hands over a fresh arrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // Case 3.
  useEffect(() => {
    if (!leaving) return
    const timer = setTimeout(() => setRendered(false), EXIT_FALLBACK_MS)
    return () => clearTimeout(timer)
  }, [leaving])

  return {
    rendered,
    leaving,
    // Case 1. Guarded on `leaving` by the caller as well, because the ENTER
    // animation fires `animationend` too.
    endExit: () => setRendered(false),
  }
}
