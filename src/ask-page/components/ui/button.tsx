import * as React from 'react'
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/ui/utils"

/** Shared button variants follow the Apiosk theme tokens in index.css. */
const buttonVariants = cva(
  cn(
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap",
    "rounded-base font-medium transition-colors duration-150",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  ),
  {
    variants: {
      variant: {
        primary:
          "bg-[color:var(--button-primary-bg)] text-[color:var(--button-primary-fg)] hover:bg-[color:var(--button-primary-bg-hover)]",
        secondary:
          "border border-border-2 bg-[color:var(--button-secondary-bg)] text-[color:var(--button-secondary-fg)] hover:bg-[color:var(--button-secondary-bg-hover)]",
        ghost: "text-muted hover:bg-hover hover:text-foreground",
        accent:
          "bg-accent text-accent-fg hover:opacity-90",
        danger:
          "border border-danger-border bg-danger-bg text-danger hover:brightness-95",
      },
      size: {
        sm: "h-8 px-3 text-body",
        md: "h-9 px-3 text-body",
        lg: "h-10 px-4 text-body",
        // FIELD HEIGHT. `Input` and `Select` are both 44px, and the button at
        // the foot of a form has to match them or the stack steps in and out
        // by 4px down its right edge. It was five copies of `size="lg"
        // className="h-11"` across the auth screens — a size prop overridden
        // everywhere it was used, which is a missing size, not a preference.
        xl: "h-11 px-5 text-body",
        icon: "size-9",
        "icon-sm": "size-8",
      },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
)

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants>

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
}

export { buttonVariants }
