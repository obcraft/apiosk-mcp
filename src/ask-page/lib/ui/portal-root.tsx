import { createContext, useContext } from 'react'

/** Keep the App's overlays within the embedded host's styled shadow tree. */
export const PortalRootContext = createContext<HTMLElement | null>(null)
export function usePortalRoot() {
  return useContext(PortalRootContext) ?? (typeof document === 'undefined' ? null : document.body)
}

export function activeElement() {
  let active = document.activeElement
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement
  return active
}
