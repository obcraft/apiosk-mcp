import { useEffect } from "react"

import { appScrollElement } from "@/hooks/use-app-scroll"

/**
 * Freeze page scrolling while an overlay is open.
 *
 * Both places the page can scroll: the document on a signed-out screen, and
 * the app shell's content pane on a signed-in one — inside the shell the
 * document does not scroll at all, so locking the body alone left the page
 * sliding underneath the dialog.
 *
 * Restores whatever `overflow` each element actually had rather than blanking
 * it, so two overlays closing out of order can't leave the page unscrollable.
 */
export function useLockBodyScroll(locked: boolean) {
  useEffect(() => {
    if (!locked) return
    const targets = [document.body, appScrollElement()].filter(
      (element): element is HTMLElement => element !== null,
    )
    const previous = targets.map((element) => element.style.overflow)
    for (const element of targets) element.style.overflow = "hidden"
    return () => {
      targets.forEach((element, index) => {
        element.style.overflow = previous[index]
      })
    }
  }, [locked])
}
