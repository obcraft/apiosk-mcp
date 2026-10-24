import { useEffect } from "react"

/** The id on the app shell's scrolling content pane. */
export const APP_SCROLL_ID = "app-scroll"

/**
 * The element the signed-in app scrolls, or `null` outside the shell.
 *
 * Anything that measures or listens to "the page scrolling" asks for this
 * rather than reaching for `window` / `document.documentElement`: inside the
 * shell the document does not scroll at all, so those read zero forever.
 */
export function appScrollElement(): HTMLElement | null {
  return document.getElementById(APP_SCROLL_ID)
}

/**
 * Stop the DOCUMENT scrolling while the app shell is mounted.
 *
 * The shell is a fixed frame with one scrolling pane inside it (see
 * `components/layout/app-shell.tsx`). If the document can scroll as well, an
 * overscroll bounce drags the whole frame — header included — away from the
 * top of the screen, which is the gap under the status bar this fixes. With
 * nothing to scroll, there is nothing to bounce, and the pane keeps its own
 * bounce because that one is the content moving, which is what it should mean.
 *
 * Scoped to the shell rather than set on `body` for good: the signed-out
 * screens and the 404 are ordinary documents and scroll like one.
 */
export function useLockDocumentScroll() {
  useEffect(() => {
    const root = document.documentElement
    root.setAttribute("data-scroll", "app")
    return () => root.removeAttribute("data-scroll")
  }, [])
}
