import * as React from 'react'
import { cn } from "@/lib/ui/utils"

/**
 * The text field. 44px tall — a real touch target, and the same height as the
 * buttons it sits above, so a form reads as one stack rather than a collage.
 */
export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        // `text-body` — THE SAME SIZE AND LINE BOX AS THE ASK
        // FIELD, deliberately. A value someone types is a value someone
        // types, and a form whose boxes render it a size smaller than the box
        // on the home page reads as a lesser copy of it.
        "h-11 w-full rounded-lg border border-border-2 bg-[color:var(--input-bg)] px-3.5 text-body text-foreground",
        "shadow-none outline-none transition-colors duration-150 placeholder:text-faint",
        "focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    />
  )
}

/**
 * The label above it.
 *
 * `field-label` carries no styling of its own — it is the hook a screen uses
 * to reach its own field labels without also catching the `<label>` that wraps
 * a checkbox and its sentence. The auth screens use it to tighten labels on a
 * phone (`brand-pages.css`).
 */
export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    <label
      className={cn("field-label block text-tiny font-medium text-muted", className)}
      {...props}
    />
  )
}

/**
 * A field: label, control, and the space between them, in one place — so two
 * forms written months apart still measure the same.
 */
export function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("space-y-1.5", className)} {...props} />
}
