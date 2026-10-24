import { useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from "react"
import { createPortal } from "react-dom"
import { usePortalRoot } from "@/lib/ui/portal-root"

import { useFocusTrap, useReturnFocus } from "@/hooks/use-focus-trap"
import { useLockBodyScroll } from "@/hooks/use-lock-body-scroll"
import { useSheetPresence } from "@/hooks/use-sheet-presence"
import { useDialogDrag } from "@/hooks/use-dialog-drag"
import { DialogContentWidthContext } from "@/lib/ui/dialog-content-width"
import { cn } from "@/lib/ui/utils"

/**
 * An overlay: a scrim, a panel, and everything that makes one safe to open.
 *
 * The navigation sheet and the run panel each carried their own copy of the
 * same six things — presence with an exit animation, a body scroll lock, a
 * focus trap, focus returned on close, Escape, a scrim that is a real button.
 * Two copies of a focus trap are two places for the keyboard to get stuck, so
 * they live here once and the two overlays keep only what differs between
 * them: where the panel sits and what is inside it.
 *
 * Three shapes. `dialog` is the run panel — a bottom sheet on a phone, a
 * centred box from `sm` up. `sheet` is docked to the bottom edge at every
 * width and rises out of it; the navigation below `lg` is one. `drawer` is a
 * column against either edge, kept for anything that genuinely reads as a
 * side panel. All three use the same scrim and the same state machine; the
 * animations differ, and are named in `index.css`.
 *
 * Rendered through a portal, always. A card in the result grid wears
 * `content-visibility: auto`, which applies paint containment, and a painted-
 * contained element becomes the containing block for its fixed-position
 * descendants — a dialog rendered inside one would be positioned against the
 * card and clipped to it, which looks exactly like the panel failing to open.
 */
export function Dialog({
  open,
  active = true,
  onClose,
  onDismiss,
  dismissible = true,
  draggable = false,
  variant = "dialog",
  drawerSide = "right",
  label,
  labelledBy,
  panelRef,
  initialFocus,
  className,
  panelClassName,
  children,
}: {
  /** The intent: someone asked for this overlay. */
  open: boolean
  /**
   * Whether the layout that owns the overlay is the one on screen. A drawer
   * that is `lg:hidden` passes the breakpoint here so its scroll lock can
   * never outlive the layout — see `useSheetPresence`.
   */
  active?: boolean
  onClose: () => void
  /** Called when the overlay is dropped for a reason other than being closed. */
  onDismiss?: () => void
  /**
   * Whether Escape and the scrim close it.
   *
   * Off while money is moving: a panel that closes mid-request hides the
   * outcome of a charge, and the next thing the person sees is a balance that
   * changed for no reason they were shown.
   */
  dismissible?: boolean
  /** Pull-to-dismiss below sm for dialogs and below lg for bottom sheets. */
  draggable?: boolean
  variant?: "dialog" | "sheet" | "drawer"
  /** A left drawer can extend the navigation rail through its outer className. */
  drawerSide?: "left" | "right"
  label?: string
  labelledBy?: string
  /** The panel element, for a caller that manages focus inside it. */
  panelRef?: RefObject<HTMLDivElement | null>
  /**
   * Where focus lands on open. Returns the element, or `null` to focus the
   * panel itself. The default is the panel: a trap with focus outside it is a
   * trap that does nothing until someone clicks inside.
   */
  initialFocus?: () => HTMLElement | null
  /** The outer, full-viewport layer. */
  className?: string
  panelClassName?: string
  children: React.ReactNode
}) {
  const portalRoot = usePortalRoot()
  const ownRef = useRef<HTMLDivElement>(null)
  const panel = panelRef ?? ownRef
  const contentWidth = useContext(DialogContentWidthContext)
  const [contentPixels, setContentPixels] = useState<number | null>(null)

  const { rendered, leaving, endExit } = useSheetPresence(open, active, onDismiss ?? onClose)
  useDialogDrag(panel, rendered && draggable && dismissible && variant !== "drawer", onClose,
    variant === "sheet" ? "(width < 64rem)" : "(max-width: 639px)", open)
  // Keyed on `rendered`, so the lock lasts through the exit — releasing on
  // `open` alone hands the page its scroll back while the panel is still
  // sliding, and the content jumps behind it.
  useLockBodyScroll(rendered)
  useFocusTrap(panel, rendered && !leaving)
  useReturnFocus(rendered)

  useEffect(() => {
    if (!open || !dismissible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, dismissible, onClose])

  // Latest-ref so the focus effect below runs once per open rather than every
  // time a caller hands over a fresh arrow.
  const focusRef = useRef(initialFocus)
  useEffect(() => {
    focusRef.current = initialFocus
  })
  useEffect(() => {
    if (!rendered) return
    ;(focusRef.current?.() ?? panel.current)?.focus()
  }, [rendered, panel])

  useLayoutEffect(() => {
    const content = contentWidth?.current
    if (!rendered || variant !== "dialog" || !content) return
    const resize = () => setContentPixels(content.getBoundingClientRect().width)
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize)
    observer?.observe(content)
    const frame = requestAnimationFrame(resize)
    window.addEventListener("resize", resize)
    return () => {
      observer?.disconnect()
      cancelAnimationFrame(frame)
      window.removeEventListener("resize", resize)
    }
  }, [rendered, variant, contentWidth])

  if (!rendered) return null

  const drawer = variant === "drawer"
  const sheet = variant === "sheet"

  return createPortal(
    <div
      className={cn(
        "app-viewport-overlay fixed inset-0 z-50 max-lg:top-[var(--app-viewport-top,0px)] max-lg:bottom-auto max-lg:h-[var(--app-viewport-height,100dvh)]",
        // A bottom sheet is docked at every width; the run panel only below
        // `sm`, where it becomes a centred box with room around it.
        sheet && "flex items-end justify-center",
        !drawer && !sheet && "flex items-end justify-center sm:items-center sm:p-4",
        draggable && variant === "dialog" && "dialog-draggable-layer",
        draggable && sheet && "sheet-draggable-layer",
        className,
      )}
    >
      {/* Scrim. A button rather than a div so tapping outside is reachable by
          keyboard and announced as the dismiss control it is. Disabled, not
          removed, while the overlay may not be dismissed — it still has to
          catch the click so nothing underneath does. */}
      <button
        type="button"
        aria-label={dismissible ? "Close" : "Close (unavailable while running)"}
        disabled={!dismissible}
        onClick={onClose}
        className={cn(
          "absolute inset-0",
          !dismissible && "cursor-default",
          // The sheet's scrim is given the panel's own, longer duration so the
          // page dims AS the panel rises rather than ahead of it.
          leaving ? "sheet-scrim-out" : sheet ? "sheet-scrim-slow" : "sheet-scrim",
        )}
      />

      <div
        ref={panel}
        style={contentWidth && variant === "dialog" && contentPixels !== null ? { width: contentPixels, maxWidth: "calc(100vw - 24px)" } : undefined}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        data-dialog-closing={leaving || undefined}
        tabIndex={-1}
        onAnimationEnd={(e) => {
          // Two guards. `leaving`, because the enter animation fires this
          // event too. And the target check, because animation events BUBBLE
          // — any child that ever animates would otherwise unmount the whole
          // overlay from underneath itself.
          if (leaving && e.target === e.currentTarget) endExit()
        }}
        className={cn(
          "outline-none",
          drawer
            ? cn(
                "absolute inset-y-0 flex flex-col",
                drawerSide === "left" ? "left-0" : "right-0",
                drawerSide === "left"
                  ? leaving ? "sheet-left-out" : "sheet-left"
                  : leaving ? "sheet-panel-out" : "sheet-panel",
              )
            : sheet
            ? cn(
                // Full width, capped, and rounded only where it has corners:
                // docked to the bottom edge, the lower two are off-screen.
                // `overflow-hidden` keeps the contents inside the curve, and
                // is what makes the panel's own scroll region — the nav —
                // stop at the rounded top rather than run under it.
                "relative flex max-h-[min(86dvh,calc(var(--app-viewport-height,100dvh)_-_var(--safe-top)_-_12px))] w-full flex-col overflow-hidden",
                "rounded-t-2xl border-t border-border bg-card shadow-[var(--shadow-pop)]",
                // The safe area belongs INSIDE the panel: its background has
                // to run all the way to the bottom of the screen, under the
                // home indicator, or the sheet floats on a strip of scrim.
                "pb-[var(--app-safe-bottom,var(--safe-bottom))]",
                leaving ? "sheet-up-out" : "sheet-up",
              )
            : cn(
                // A hairline and the surface `Card` draws, so a panel reads
                // as the card it came out of. The shadow is the one addition:
                // over a scrim, a border alone leaves the panel looking
                // painted onto the page rather than above it.
                //
                // The corners are the one thing that differs by width, and
                // they have to: docked to the bottom edge of a phone the
                // panel has no bottom corners to round, so only the top two
                // are — the shape a sheet actually has. `overflow-hidden`
                // keeps a full-bleed header or footer inside them.
                "relative flex max-h-[min(88dvh,calc(var(--app-viewport-height,100dvh)_-_var(--safe-top)_-_12px))] w-full flex-col gap-4 overflow-hidden rounded-t-2xl border border-border bg-card p-5 sm:rounded-2xl lg:max-h-[88dvh]",
                "shadow-[var(--shadow-pop)] sm:max-w-lg",
                // Padding, not margin: the safe area belongs inside the panel
                // so the footer's own background runs to the bottom edge.
                "pb-[calc(1.25rem+var(--app-safe-bottom,var(--safe-bottom)))] sm:pb-5",
                leaving ? "dialog-panel-out" : "dialog-panel",
              ),
          panelClassName,
          draggable && variant === "dialog" && "dialog-draggable",
          draggable && sheet && "sheet-draggable",
        )}
      >
        {draggable && !drawer && <div data-dialog-drag-handle aria-hidden="true" className={cn("flex h-8 shrink-0 items-center justify-center", sheet ? "-mb-2 lg:hidden" : "-mx-5 -mt-5 -mb-4 sm:hidden")}>
          <span className="h-1 w-10 rounded-full bg-muted/35" />
        </div>}
        {children}
      </div>
    </div>,
    portalRoot!,
  )
}

/** The Connect Claude template: one continuous surface with consistent spacing.
 * Keep long content in DialogBody so the heading and actions remain reachable.
 * Callers may adjust width, but should use these parts instead of custom chrome.
 */
export function DialogHeader({ className, ...props }: ComponentProps<"header">) {
  return <header data-dialog-header className={cn("flex shrink-0 items-start justify-between gap-3", className)} {...props} />
}

export function DialogTitle({ className, ...props }: ComponentProps<"h2">) {
  return <h2 className={cn("min-w-0 break-words text-body font-medium text-heading", className)} {...props} />
}

export function DialogBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain", className)} {...props} />
}

export function DialogFooter({ className, ...props }: ComponentProps<"footer">) {
  return <footer className={cn("flex shrink-0 flex-wrap items-center gap-2", className)} {...props} />
}
