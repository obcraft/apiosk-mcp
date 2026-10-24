import * as React from 'react'
import { absoluteLogo } from '@/environment'
import { useEffect, useMemo, useState } from "react"

import { cn } from "@/lib/ui/utils"
import { probeLogo } from "@/lib/ui/logo-cache"

/**
 * The provider's mark, or the best thing available in its place.
 *
 * Three steps, in order, and every one of them can be the last:
 *
 *   1. `provider_logo`, when the index that listed the offer published one —
 *      or when any OTHER listing on the same page published one for the same
 *      provider. See `markDirectory` in `lib/domain/discover`: a brand that
 *      has a mark anywhere in an answer wears it everywhere in that answer,
 *      which is what stops the reviewed half of a result list from being the
 *      grey half.
 *   2. The provider's own icons: `/favicon.ico` and `/apple-touch-icon.png`,
 *      on the host that serves the endpoint AND on the domain behind it —
 *      `api.example.com` rarely has an icon, `example.com` usually does. Four
 *      guesses, tried in order, first one with pixels wins. See `iconGuesses`.
 *      Never a favicon service, which would hand a third party the list of
 *      every API somebody browsed.
 *   3. A monogram off the name. Not a placeholder for a logo — a label. A grid
 *      of cards where a third of the tiles are a grey square with a broken
 *      image glyph reads as a page that failed to load; initials read as a
 *      page where some providers have marks and some do not.
 *
 * Deliberately neutral in step 3. Tinting the monograms by a hash of the name
 * would put a dozen arbitrary colours in a grid whose only colour anywhere
 * else is the accent, and would say something — "these are categories" — that
 * is not true.
 *
 * ---------------------------------------------------------------------------
 * THE MONOGRAM IS THE FLOOR, AND NOTHING IS PAINTED UNTIL IT IS KNOWN GOOD
 * ---------------------------------------------------------------------------
 *
 * The tile draws initials, and a mark replaces them only once a URL has been
 * loaded and found to have pixels in it. The loading is done by an `Image()`
 * OF ITS OWN, in an effect, and not by the element on screen — which is the
 * fix for the bug that started this: the same logo, on the same page, showing
 * on one row and initials on the next.
 *
 * The cause was a race nothing in the markup could win. React attaches `load`
 * and `error` to an `<img>` after it has set `src`, so the first row fetches
 * over the network and gets its event, while every row after it is served from
 * the memory cache — where the event can fire before the handler exists. That
 * row's `onLoad` never arrives, the image stays at `opacity-0` waiting for it,
 * and the initials underneath are what you see. Nothing about it is
 * deterministic: it depends on which tile the cache happens to be warm for.
 *
 * A detached `Image()` cannot lose that race, because the handlers are set
 * BEFORE `src` and a cached hit still delivers `load` to them. Two further
 * failures fall out of the same check:
 *
 *   - a URL that is already known-broken errors immediately and moves the
 *     chain on, rather than sitting on screen as a torn-page glyph;
 *   - a host that answers `/favicon.ico` with an HTML error page under a 200
 *     decodes to nothing, and a `load` with no intrinsic width is treated as
 *     the failure it is.
 *
 * So the worst case is a tile that shows initials, which is a tile that looks
 * finished. There is no state in which a broken or a blank image is painted.
 */
interface SourceLogoProps {
  /** `provider_logo`, when the offer carried one. */
  src?: string | null
  /** Optional link image when the preferred mark is unavailable. */
  fallbackSrc?: string | null
  /** The host serving the endpoint, for the favicon guess. */
  host?: string | null
  /** The provider's name — what the monogram is cut from, and the alt text. */
  name: string
  className?: string
}

export function SourceLogo(props: SourceLogoProps) {
  // Catalog refreshes can supply a logo after the old fallback chain failed.
  // Reset only this image's loading state when its identity or URLs change.
  return <SourceLogoImage key={JSON.stringify([props.name, props.src, props.fallbackSrc, props.host])} {...props} />
}

function SourceLogoImage({ src, fallbackSrc, host, name, className }: SourceLogoProps) {
  // Where in the chain this card currently is. Advanced by a failure, which is
  // why the chain is an array rather than a pair of booleans: one index, one
  // step per failure, and the monogram is simply what is left when it runs off
  // the end.
  const [step, setStep] = useState(0)
  // The URL that has been loaded and found to have pixels in it. Nothing is
  // painted over the initials until this is set — see the note above.
  const [loaded, setLoaded] = useState<string | null>(null)

  const chain = useMemo(
    () =>
      [...new Set([src?.trim() || null, fallbackSrc?.trim() || null, ...iconGuesses(host)])].filter((url): url is string =>
        Boolean(url),
      ),
    [src, fallbackSrc, host],
  )
  const current = chain[step] ?? null

  useEffect(() => {
    if (!current) return
    let live = true
    void probeLogo(current).then((valid) => {
      if (!live) return
      if (valid) setLoaded(current)
      else setStep((s) => s + 1)
    })
    return () => {
      // Other cards can still be waiting on the shared probe.
      live = false
    }
  }, [current])

  return (
    <span
      className={cn(
        "relative flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-soft",
        className,
      )}
    >
      {!loaded ? (
        <span
          aria-hidden="true"
          className="text-body font-medium uppercase leading-none text-muted"
        >
          {monogram(name)}
        </span>
      ) : null}

      {loaded ? (
        <img
          src={absoluteLogo(loaded)}
          alt=""
          // The name is on the card in words directly beside this, so the image
          // is decoration; announcing it again is the same fact twice.
          aria-hidden="true"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => { setLoaded(null); setStep(s => s + 1) }}
          // Already fetched by the probe above, so this is a cache hit and
          // paints on the frame it mounts.
          // Published vendor marks are generally drawn for a light canvas.
          // Keep their original colours legible in dark mode too, within the
          // same borderless tile (not an extra frame around the image).
          className={cn("logo-in absolute inset-0 size-full object-contain dark:bg-white", loaded === "/brand/mark-black-20260918.svg" && "dark:invert")}
        />
      ) : null}
    </span>
  )
}

/**
 * The icons worth asking a host for, best first.
 *
 * `/favicon.ico` alone left most rows on a monogram, and the reason is what
 * these hosts ARE: an API is served from `api.example.com`, and it is
 * `example.com` that has the brand, the site and the icon. The API host very
 * often answers `/favicon.ico` with a 404 or with JSON, and that was the end
 * of the chain.
 *
 * So four guesses instead of one — two paths, on the host and then on the
 * domain behind it. Each is tried in order and the first that decodes to
 * pixels wins; `SourceLogo` is already built to walk a list, so this costs
 * nothing but the requests, and only for the rows that need them.
 *
 * Still the provider's OWN hosts and no one else's. No favicon service: that
 * would hand a third party the list of every API somebody browsed, which is
 * not a trade this app makes for an icon.
 */
function iconGuesses(host?: string | null): string[] {
  const bare = (host ?? "").trim().toLowerCase().replace(/\/.*$/, "")
  if (!bare || !usableHost(bare)) return []

  const hosts = [bare]
  const apex = apexOf(bare)
  // Only when the apex is a company. On a shared platform — `*.p.rapidapi.com`,
  // `*.vercel.app` — the apex mark belongs to the PLATFORM, so asking for it
  // would put one marketplace's logo on a dozen unrelated providers. That is
  // not a missing icon, it is a wrong one, and initials beat it.
  if (apex && apex !== bare && !PLATFORM_HOSTS.has(apex)) hosts.push(apex)

  return hosts.flatMap((h) => [
    `https://${h}/favicon.ico`,
    `https://${h}/apple-touch-icon.png`,
  ])
}

/**
 * Hosts that are an address or a platform rather than a name.
 *
 * Nobody puts a mark on a bare IP or on a `nip.io`-style wrapper, so those
 * requests are known in advance to 404 — a dozen of them per page of results
 * is noise in the console and in the network log for a payoff of zero.
 */
function usableHost(bare: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}/.test(bare)) return false
  if (/\.(nip|sslip|xip)\.io$/.test(bare)) return false
  if (/\.cloudapp\.azure\.com$/.test(bare)) return false
  return bare.includes(".")
}

/** Marketplaces and hosting platforms — see `iconGuesses`. */
const PLATFORM_HOSTS = new Set([
  "rapidapi.com",
  "herokuapp.com",
  "vercel.app",
  "netlify.app",
  "onrender.com",
  "railway.app",
  "fly.dev",
  "workers.dev",
  "pages.dev",
  "azurewebsites.net",
  "amazonaws.com",
  "googleapis.com",
  "cloudfunctions.net",
  "github.io",
  "replit.dev",
  "glitch.me",
  "ngrok.io",
])

/**
 * The registrable domain: "api.v2.cityfalcon.com" → "cityfalcon.com".
 *
 * The two-part suffixes that would otherwise return "co.uk" are handled by
 * name. Not a full public-suffix list, and it does not need to be: being wrong
 * costs one image request that 404s, and the monogram is still underneath.
 */
const TWO_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "co.jp", "co.kr", "co.nz", "co.za",
  "co.in", "com.au", "com.br", "com.mx", "com.tr", "com.cn", "com.sg",
  "com.hk", "net.au", "org.au",
])

function apexOf(bare: string): string | null {
  const labels = bare.split(".").filter(Boolean)
  if (labels.length < 3) return null
  const lastTwo = labels.slice(-2).join(".")
  const take = TWO_PART_SUFFIXES.has(lastTwo) ? 3 : 2
  if (labels.length <= take) return null
  return labels.slice(-take).join(".")
}

/**
 * One or two letters, from the name as a person would abbreviate it.
 *
 * Two initials where the name is two words ("OpenWeb Ninja" → ON), one letter
 * otherwise — never two letters cut out of the middle of a single word, which
 * is how "Openwebninja" becomes a tile that says OP and means nothing.
 */
function monogram(name: string): string {
  const words = name
    .replace(/^https?:\/\//, "")
    .split(/[\s._/-]+/)
    .filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].charAt(0)
  return words[0].charAt(0) + words[1].charAt(0)
}
