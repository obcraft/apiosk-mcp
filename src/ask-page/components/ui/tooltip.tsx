import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { usePortalRoot } from "@/lib/ui/portal-root"

import { cn } from "@/lib/ui/utils"

/**
 * A tooltip for icon-only controls.
 *
 * Deliberately not a positioning library: the one place this app needs a
 * tooltip is the collapsed sidebar, where the target is a fixed-width rail and
 * the label always opens to the right with room to spare. When a tooltip is
 * ever needed somewhere that can collide with a viewport edge, that is the
 * moment to bring in a real popper — not before.
 *
 * THE BUBBLE LIVES IN A PORTAL, AND IS ONLY THERE WHILE IT SHOWS. It used to
 * be a CSS-only sibling of the trigger: absolutely positioned to the right of
 * it, `opacity-0` until hover. Two things were wrong with that, and both came
 * from the rail's nav being a scroll container (`overflow-y-auto`, which
 * makes overflow-x `auto` too). An element that is invisible is still laid
 * out, so eight bubbles hanging off the right of eight rows were eight
 * rectangles outside the nav's box — scrollable overflow, which the nav duly
 * grew a horizontal scrollbar for: a thin grey pill at the foot of the rail,
 * permanently, on a column with nothing to scroll. And on hover the bubble
 * appeared INSIDE that scroll box, which is 60px wide, so a label that opens
 * to the right of the rail was clipped to a sliver.
 *
 * Rendered into `document.body` at a fixed position measured off the trigger
 * when it opens, it is outside every scroll container and takes no space in
 * any of them: nothing to overflow, nothing to clip. Closed on scroll and on
 * resize rather than followed, because a label that has to move is a label
 * whose moment has passed.
 *
 * `pointer-events-none` on the bubble means it can never eat a click meant
 * for the control underneath.
 */
export function Tooltip({
  label,
  side = "right",
  wrap = false,
  children,
  className,
}: {
  label: string
  side?: "right" | "top"
  /**
   * Let the label run to several lines inside a fixed width.
   *
   * Off by default, because the original caller is the collapsed rail and a
   * one-word label that wraps is a bug. On for a sentence — a refund policy
   * does not fit on one line and `whitespace-nowrap` would run it off the
   * screen rather than break it.
   */
  wrap?: boolean
  children: React.ReactNode
  className?: string
}) {
  const portalRoot = usePortalRoot()
  const anchor = useRef<HTMLSpanElement>(null)
  /** Where the bubble goes, in viewport pixels — or null while it is closed. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  const show = () => {
    const rect = anchor.current?.getBoundingClientRect()
    if (!rect) return
    setAt(
      side === "right"
        ? { x: rect.right + 8, y: rect.top + rect.height / 2 }
        : { x: rect.left + rect.width / 2, y: rect.top - 8 },
    )
  }
  const hide = () => setAt(null)

  useEffect(() => {
    if (!at) return
    // Capture, so a scroll inside any nested panel closes it too.
    window.addEventListener("scroll", hide, true)
    window.addEventListener("resize", hide)
    return () => {
      window.removeEventListener("scroll", hide, true)
      window.removeEventListener("resize", hide)
    }
  }, [at])

  return (
    <span
      ref={anchor}
      className={cn("relative inline-flex", className)}
      onMouseEnter={show}
      onMouseLeave={hide}
      // Focus bubbles here from the control inside, so keyboard users get
      // the label the moment the row is focused, as before.
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {at
        ? createPortal(
            <span
              role="tooltip"
              style={{ left: at.x, top: at.y }}
              className={cn(
                "pointer-events-none fixed z-50 rounded-md border border-border bg-surface px-2 py-1 text-tiny font-medium text-heading shadow-[var(--shadow-pop)]",
                wrap ? "w-56 text-left font-normal leading-4" : "whitespace-nowrap",
                side === "right" ? "-translate-y-1/2" : "-translate-x-1/2 -translate-y-full",
              )}
            >
              {label}
            </span>,
            portalRoot!,
          )
        : null}
    </span>
  )
}
