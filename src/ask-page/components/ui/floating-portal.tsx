import { useComposedRefs } from "@radix-ui/react-compose-refs"
import { createContext, useCallback, useContext, useState, type ReactNode, type Ref } from "react"
import { usePortalRoot } from "@/lib/ui/portal-root"

const FloatingPortalContext = createContext<{
  container: HTMLElement | undefined
  setContainer: (container: HTMLElement | undefined) => void
}>({ container: undefined, setContainer: () => {} })

// Keep nested dropdowns inside our dialog's focus trap, outside its scrolling
// content. Elsewhere Radix portals to body, clear of sidebar clipping.
export function FloatingPortalProvider({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLElement>()
  return <FloatingPortalContext.Provider value={{ container, setContainer }}>{children}</FloatingPortalContext.Provider>
}

export function useFloatingPortalContainer() {
  const root = usePortalRoot()
  return useContext(FloatingPortalContext).container ?? root ?? undefined
}

export function useFloatingTriggerRef(ref?: Ref<HTMLButtonElement>) {
  const { setContainer } = useContext(FloatingPortalContext)
  const portalRef = useCallback((node: HTMLButtonElement | null) => {
    if (node) setContainer(node.closest<HTMLElement>('[role="dialog"]') ?? undefined)
  }, [setContainer])
  return useComposedRefs(ref, portalRef)
}
