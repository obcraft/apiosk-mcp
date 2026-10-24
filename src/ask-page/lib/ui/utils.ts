import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * tailwind-merge, taught this app's own type scale.
 *
 * `--text-tiny`, `--text-body`, `--text-large` and `--text-display` are OURS, so a stock
 * tailwind-merge has never heard of them — and its rule for an unknown
 * `text-*` is "that is a colour". So `cn("text-tiny text-faint")` looked like
 * two colours in a row, the second won, and the SIZE WAS SILENTLY DROPPED:
 * every one of those elements rendered at the inherited 16px instead of the
 * 11, 13 or 14 it asked for. That is why a field's hint read as large as the
 * value above it and a card's description shouted over its own title.
 *
 * Naming them here (and `--text-menu`) puts them in the font-size group,
 * where they belong: a size and a colour stop colliding, and two sizes still
 * resolve last-wins.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: { "font-size": ["text-tiny", "text-menu", "text-body", "text-large", "text-display"] },
  },
})

/**
 * Merge class names, letting later Tailwind utilities beat earlier ones.
 *
 * Every component in this app takes a `className` and ends with `cn(base,
 * className)`, so a caller can always override a style without a wrapper div
 * and without `!important`.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
