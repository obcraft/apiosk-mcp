import { createContext, type RefObject } from "react"

/** Dialogs in a content column follow its actual width, including sidebars. */
export const DialogContentWidthContext = createContext<RefObject<HTMLElement | null> | null>(null)
