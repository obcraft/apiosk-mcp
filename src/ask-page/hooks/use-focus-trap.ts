import { useEffect, type RefObject } from "react"
import { activeElement } from "@/lib/ui/portal-root"

/**
 * What counts as somewhere focus can land.
 *
 * `:not([disabled])` matters more than it looks: a dialog whose only trailing
 * control is a disabled submit button would otherwise trap Tab on an element
 * that cannot take focus, and the cycle would silently stop working at exactly
 * the moment the form is incomplete — which is the moment someone is tabbing
 * through it looking for what they missed.
 */
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

/**
 * Keep Tab inside an open dialog.
 *
 * `aria-modal` tells a screen reader the rest of the page is inert; it does
 * nothing whatsoever to the Tab key. Without this, tabbing past the last
 * control walks out of the panel and into the result grid behind it — the
 * focus ring vanishes behind a scrim and the only way back is the mouse, which
 * is the same as saying the form cannot be filled in from the keyboard.
 *
 * The element list is read on every Tab rather than cached once. This panel's
 * controls come and go while it is open: the optional section unfolds, a list
 * grows a row, the submit button disables itself mid-request. A trap holding
 * yesterday's list sends focus to an element that is no longer there.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active) return
    const node = ref.current
    if (!node) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return

      const focusable = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // `offsetParent` is null for anything `display: none` — the collapsed
        // optional section, for one. Tabbing into a hidden field is a focus
        // ring nobody can see.
        (el) => el.offsetParent !== null || el === activeElement(),
      )
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const current = activeElement()

      // Wrapping is done by hand rather than left to the browser, because the
      // browser's next stop is outside the dialog and that is the whole
      // problem. Focus sitting on the panel itself (it holds `tabIndex={-1}`
      // so it can take focus on open) counts as "before the first control".
      if (event.shiftKey && (current === first || current === node)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }

    node.addEventListener("keydown", onKeyDown)
    return () => node.removeEventListener("keydown", onKeyDown)
  }, [ref, active])
}

/**
 * Give focus back to whatever had it before the dialog opened.
 *
 * Dismissing a dialog and finding focus on `<body>` means the next Tab starts
 * from the top of the page — so someone who opened the panel from the fourth
 * card and closed it lands back at the header, several dozen tab stops from
 * where they were.
 */
export function useReturnFocus(active: boolean) {
  useEffect(() => {
    if (!active) return
    const opener = activeElement() as HTMLElement | null
    return () => opener?.focus?.()
  }, [active])
}
