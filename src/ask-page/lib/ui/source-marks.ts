/** Locally known provider marks shared by source search surfaces. */
export interface SourceMark { logoUrl: string | null; host: string | null }

function brandKey(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
}

/**
 * Marks we hold ourselves, for brands nothing in the answer carries one for.
 *
 * ---------------------------------------------------------------------------
 * THIS TABLE IS MEANT TO BE EDITED. Add a brand, give it a `logoUrl`, done.
 * ---------------------------------------------------------------------------
 *
 * The chain is: the offer's own `provider_logo`, then the gateway's provider
 * directory (`useProviderMarks`), then the answer's own marks, then this, then
 * the provider's favicon on its own hosts, then initials. Workflow definitions
 * carry source names and slugs without images; their marks below match the
 * public source catalog so steps use the same branding as the Sources page.
 *
 * Keyed the same way the response directory is: the letters and digits of the
 * name, so "PayAI", "payai" and "pay-ai" are one brand. Both the name an index
 * publishes and the brand read off the host are tried, which is why some of
 * these appear twice under two spellings.
 *
 * `logoUrl` may be a URL or a file in `public/`. A `null` there is not a bug —
 * it means we have no mark yet and the host below is the best guess left; the
 * row falls through to its initials, which is a finished-looking tile rather
 * than a hole.
 *
 * `host` earns its place separately: a reviewed catalogue row carries NO host
 * at all, so without one here there is not even a favicon to try. It is the
 * brand's own site, never the marketplace it happens to be served from.
 */
export const CURATED_SOURCE_MARKS = new Map<string, SourceMark>(
  (
    [
      // name as it appears, logo, the brand's own site
      [
        "agent-exchange",
        "https://ethglobal.b-cdn.net/organizations/3gx1k/square-logo/default.png",
        "store.agentexchange.work",
      ],
      ["agentic-market", null, "agentic.market"],
      ["anchor-x402", null, "anchor-x402.com"],
      ["anchor", null, "anchor-x402.com"],
      ["coinbase-bazaar", "/logos/coinbase.svg", "coinbase.com"],
      ["coinbase-x402-bazaar", "/logos/coinbase.svg", "coinbase.com"],
      ["coinbase", "/logos/coinbase.svg", "coinbase.com"],
      ["crunchbase", "/brands/crunchbase.ico", "crunchbase.com"],
      ["glassdoor", "/brands/glassdoor.svg", "glassdoor.com"],
      ["yelp", "/brands/yelp.ico", "yelp.com"],
      ["payai", null, "payai.network"],
      ["thirdweb", null, "thirdweb.com"],
      ["sirenic", "/brands/sirenic.png", "api.sirenic.eu"],
      ["kvk", "/logos/kvk.svg", "kvk.nl"],
      ["kvk-dutch-business-register", "/logos/kvk.svg", "kvk.nl"],
      ["KVK Business Register", "/logos/kvk.svg", "kvk.nl"],
      // Source catalog branding for workflow steps (including Apiosk-run checks).
      // Exa and StableEnrich marks come from each host's /favicon.ico; VIES
      // comes from ec.europa.eu/taxation_customs/vies/app/favicon.ico (PNG).
      // These three are bundled because their remote image loads are unreliable.
      ["bodemloket", "https://www.bodemloket.nl/sites/default/files/favicon_0.ico", "www.bodemloket.nl"],
      ["browserbase", "https://www.browserbase.com/favicon.svg", "www.browserbase.com"],
      ["cityfalcon-financial-api", "https://www.cityfalcon.ai/packs/static/round-logo-c74000265d51a8b378bd.png", "www.cityfalcon.ai"],
      ["companies-house", "https://api.apiosk.com/storage/v1/object/public/provider-avatars/4947323.png", "company-information.service.gov.uk"],
      ["domain-intelligence", "/apple-touch-icon.png", "app.apiosk.com"],
      ["eu-funding-tenders", "https://api.apiosk.com/storage/v1/object/public/provider-avatars/eurostat-logo.png", "ec.europa.eu"],
      ["exa", "/brands/exa.png", "exa.ai"],
      ["gleif", "https://www.gleif.org/favicon.svg", "www.gleif.org"],
      ["iban-check", "/apple-touch-icon.png", "app.apiosk.com"],
      ["koop", "https://apiosk.com/brands/koop.png", "koopoverheid.nl"],
      ["linkup", "https://www.linkup.so/_next/static/immutable/media/favicon.0nnprkm5qsjim.png", "www.linkup.so"],
      ["opensanctions", "https://api.apiosk.com/storage/v1/object/public/provider-avatars/images.jpeg", "www.opensanctions.org"],
      ["pdok", "https://api.apiosk.com/storage/v1/object/public/provider-avatars/pdok-logo.png", "www.pdok.nl"],
      ["pdok-ruimtelijke-plannen", "https://api.apiosk.com/storage/v1/object/public/provider-avatars/pdok-logo.png", "www.pdok.nl"],
      ["rdw", "https://apiosk.com/brands/rdw.svg", "rdw.nl"],
      ["reuters", "https://apiosk.com/brands/reuters.png", "www.reuters.com"],
      ["rvo", "https://apiosk.com/brands/rvo.svg", "www.rvo.nl"],
      ["stableenrich", "/brands/stableenrich.ico", "stableenrich.dev"],
      ["ted", "https://apiosk.com/brands/ted.png", "ted.europa.eu"],
      ["tenderned", "https://api.apiosk.com/storage/v1/object/public/provider-avatars/logo-tenderned.png", "www.tenderned.nl"],
      ["vies", "/brands/vies.png", "ec.europa.eu"],
    ] as const
  ).map(([name, logoUrl, host]) => [brandKey(name), { logoUrl, host }]),
)

/** Match the named provider first, then its own endpoint domain. */
export function curatedSourceMark(name: string, slug: string | null, url?: string): SourceMark | undefined {
  for (const label of [slug, name]) {
    const known = CURATED_SOURCE_MARKS.get(brandKey(label))
    if (known) return known
  }
  if (!url) return undefined
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
    return [...CURATED_SOURCE_MARKS.values()].find(mark => {
      const domain = mark.host?.replace(/^(?:api|www)\./, "")
      return domain && (host === domain || host.endsWith(`.${domain}`))
    })
  } catch { return undefined }
}
