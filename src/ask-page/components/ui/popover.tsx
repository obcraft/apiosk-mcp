// https://ui.shadcn.com/docs/components/radix/popover
import type { ComponentProps } from "react"
import * as Primitive from "@radix-ui/react-popover"
import { cn } from "@/lib/ui/utils"
import { FloatingPortalProvider, useFloatingPortalContainer, useFloatingTriggerRef } from "./floating-portal"

export function Popover({ children, ...props }: ComponentProps<typeof Primitive.Root>) {
  return <FloatingPortalProvider><Primitive.Root {...props}>{children}</Primitive.Root></FloatingPortalProvider>
}
export function PopoverTrigger({ ref, ...props }: ComponentProps<typeof Primitive.Trigger>) {
  return <Primitive.Trigger ref={useFloatingTriggerRef(ref)} {...props} />
}
export function PopoverContent({ className, sideOffset = 6, collisionPadding = 12, ...props }: ComponentProps<typeof Primitive.Content>) {
  const container = useFloatingPortalContainer()
  return <Primitive.Portal container={container}><Primitive.Content
    data-slot="popover-content" sideOffset={sideOffset} collisionPadding={collisionPadding} collisionBoundary={container}
    onEscapeKeyDown={event => event.stopPropagation()}
    className={cn("floating-surface z-[80] w-80 max-w-[calc(100vw-1.5rem)] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto [--floating-origin:var(--radix-popover-content-transform-origin)]", className)} {...props}
  /></Primitive.Portal>
}
