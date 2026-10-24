const logos: Record<string, string> = {
  'bbc.com': 'bbc.gif', 'bbc.co.uk': 'bbc.gif', 'bbci.co.uk': 'bbc.gif', 'theguardian.com': 'guardian.png', 'npr.org': 'npr.jpg',
  'aljazeera.com': 'al-jazeera.png', 'nytimes.com': 'nytimes.png', 'dw.com': 'dw.png', 'arstechnica.com': 'ars-technica.png', 'nos.nl': 'nos.png',
}

/** Fixed local publisher artwork: never load an image URL supplied by a feed. */
export function NewsPublisherLogo({ domain, feedUrl }: { domain?: string; feedUrl?: string }) {
  let host = domain?.toLowerCase() ?? ''
  if (!host && feedUrl) {
    try {
      const feed = new URL(feedUrl)
      if (['https:', 'http:'].includes(feed.protocol) && !feed.username && !feed.password) host = feed.hostname.toLowerCase()
    } catch { /* Unknown publishers retain their text attribution. */ }
  }
  const match = Object.keys(logos).find(known => host === known || host.endsWith(`.${known}`))
  if (!match) return null
  return <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded border border-border-2 bg-white p-1">
    <img src={`/news-logos/${logos[match]}`} alt="" aria-hidden="true" className="max-h-full max-w-full object-contain" />
  </span>
}
