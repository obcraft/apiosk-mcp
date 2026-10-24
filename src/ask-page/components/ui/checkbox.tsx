import * as React from 'react'
import { cn } from "@/lib/ui/utils"

/**
 * A checkbox that follows the accent colour, with a hit area big enough to be
 * a real target rather than a 13px browser default.
 */
export function Checkbox({
  className,
  ...props
}: Omit<React.ComponentProps<"input">, "type">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer rounded border-border-3 accent-[var(--accent)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  )
}
