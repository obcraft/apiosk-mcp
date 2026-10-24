import * as React from 'react'
import { SourceLogo } from "@/components/discover/source-logo"
import { cn } from "@/lib/ui/utils"

/**
 * The mark beside a name, for anything in the corpus: an Apiosk provider, an
 * external catalogue, a provider recovered out of one.
 *
 * A thin adapter over `SourceLogo`, which is the app's ONE implementation of
 * "a brand's mark, or the best thing available in its place" — the logo the
 * record carries, then the site's own icons, then initials. Explore had its
 * own copy of that chain once, and the two drifted: the discover surface
 * learned to load a mark before painting it (no torn-page glyph, no logo that
 * shows on one row and initials on the next) and this one never did.
 *
 * What is left here is the mapping this surface needs and that one does not:
 * an entity is addressed by a URL (`https://index.example/x402/list`) where an
 * offer is addressed by a host, and a card has two sizes.
 */
export function EntityLogo({
  name,
  logoUrl,
  siteUrl,
  size = "sm",
  className,
}: {
  name: string
  /** The logo the record carries, if it carries one. */
  logoUrl?: string | null
  /** The address this thing is read from — a URL or a bare host. */
  siteUrl?: string | null
  size?: "sm" | "lg"
  className?: string
}) {
  return (
    <SourceLogo
      name={name}
      src={logoUrl}
      host={hostOf(siteUrl)}
      className={cn(size === "lg" ? "size-11" : "size-8", className)}
    />
  )
}

/**
 * `https://index.example/x402/list` → `index.example`, and a bare host through
 * unchanged.
 *
 * `SourceLogo` guesses `/favicon.ico` on the host it is given, so handing it a
 * whole URL would ask for `https://https:/favicon.ico`. Anything unparseable
 * becomes null, which is the answer that leaves the initials alone.
 */
function hostOf(address?: string | null): string | null {
  const said = (address ?? "").trim()
  if (!said) return null
  try {
    return new URL(said.includes("://") ? said : `https://${said}`).hostname || null
  } catch {
    return null
  }
}
