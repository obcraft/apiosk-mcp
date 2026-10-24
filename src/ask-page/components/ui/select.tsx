import * as React from 'react'
import { ChevronDown } from "lucide-react"

import { cn } from "@/lib/ui/utils"

/**
 * A native `<select>`, dressed to match `Input`.
 *
 * Native on purpose. The alternative — a listbox built out of divs — has to
 * re-implement keyboard navigation, typeahead, screen-reader semantics and the
 * scroll behaviour of a long list, and it gets the last one wrong on a phone,
 * where the platform picker is genuinely better than anything a web page can
 * draw. The only thing given up is styling the option rows, which no list in
 * this app needs.
 *
 * The chevron is ours and the browser's is suppressed (`appearance-none`), so
 * the control looks the same on every platform; `pointer-events-none` on it
 * keeps clicks going to the select underneath.
 */
export function Select({ className, children, ...props }: React.ComponentProps<"select">) {
  return (
    <div className="relative">
      <select
        className={cn(
          // Same size and line box as `Input` and the ask field — see there.
          "h-11 w-full appearance-none rounded-lg border border-border-2 bg-[color:var(--input-bg)] pl-3.5 pr-10 text-body text-foreground",
          "outline-none transition-colors duration-150",
          "focus:border-[color:var(--accent-line)] focus:ring-4 focus:ring-[color:var(--accent-wash)]",
          "disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3.5 top-1/2 size-4 -translate-y-1/2 text-faint"
      />
    </div>
  )
}
