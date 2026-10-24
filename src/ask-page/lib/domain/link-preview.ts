export type ResponseLink = { url: string; title?: string }
export type LinkPreviewMetadata = { url: string; title?: string; description?: string; site_name?: string; image_data_url?: string }

/** Keep destinations literal; only ordinary HTTP(S) links can become anchors. */
export function safePreviewUrl(value: string): string | null {
  const text = value.trim()
  if (!text || text.length > 4096 || text.includes('\\') || [...text].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null
  try {
    const url = new URL(text)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    return url.href
  } catch { return null }
}

/** Public links only for automatic requests; a signed download stays a link. */
export function canFetchLinkPreview(value: string): boolean {
  const safe = safePreviewUrl(value)
  if (!safe) return false
  const url = new URL(safe), host = url.hostname.toLowerCase().replace(/\.$/, '')
  // Literal IPs and local names are never needed for public website previews.
  if (!host.includes('.') || host.startsWith('.') || /^[\d.]+$/.test(host) || host.includes(':') || url.port ||
      /(?:^|\.)(?:localhost|localdomain|local|internal|intranet|lan|home|corp|onion|test|invalid|example|home\.arpa)$/.test(host)) return false
  if (/\.(?:pdf|zip|docx?|xlsx?|csv|pptx?)$/i.test(url.pathname)) return false
  const credentialKey = (key: string) => /(?:token|auth|authorization|secret|password|passwd|signature|credential|session|jwt|key|sig|code|expires|expiry|exp|download)$/i.test(key.replace(/[^a-z\d]/gi, '')) || /^(?:x-amz-|x-goog-)/i.test(key)
  return ![...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(credentialKey)
}

function trimProseEnd(value: string): string {
  let result = value
  for (;;) {
    const before = result
    result = result.replace(/[.,!?;:'"\u2019\u201d]+$/, '')
    for (const [opening, closing] of [['(', ')'], ['[', ']'], ['{', '}']]) {
      while (result.endsWith(closing) && result.split(closing).length > result.split(opening).length) result = result.slice(0, -1)
    }
    if (result === before) return result
  }
}

/** Markdown labels plus bare URLs, in source order, without dropping balanced paths. */
export function extractResponseLinks(text: string): ResponseLink[] {
  const whole = text.trim()
  const exact = /^https?:\/\/\S+$/i.test(whole) ? safePreviewUrl(whole) : null
  if (exact) return [{ url: exact }]
  const found: { index: number; url: string; title?: string }[] = []
  const markdownRanges: [number, number][] = []
  const markdown = /\[([^\]\n]+)\]\(\s*(<?https?:\/\/)/gi
  for (const match of text.matchAll(markdown)) {
    const start = match.index! + match[0].length - match[2].length
    let cursor = start, value = ''
    if (text[cursor] === '<') {
      const end = text.indexOf('>', cursor + 1)
      if (end < 0) continue
      value = text.slice(cursor + 1, end)
      cursor = end + 1
    } else {
      let depth = 0
      for (; cursor < text.length; cursor++) {
        const char = text[cursor]
        if (/\s/.test(char) || char === ')' && depth === 0) break
        if (char === '(') depth++
        if (char === ')') depth--
        value += char
      }
    }
    const url = safePreviewUrl(value)
    if (url) {
      found.push({ index: match.index!, url, title: match[1].replace(/[*_`]/g, '').trim() || undefined })
      markdownRanges.push([start, cursor])
    }
  }
  for (const match of text.matchAll(/https?:\/\/[^\s<>"`]+/gi)) {
    if (markdownRanges.some(([start, end]) => match.index! >= start && match.index! < end)) continue
    const url = safePreviewUrl(trimProseEnd(match[0]))
    if (url) found.push({ index: match.index!, url })
  }
  const unique = new Map<string, ResponseLink>()
  for (const link of found.sort((a, b) => a.index - b.index)) {
    const prior = unique.get(link.url)
    if (!prior) unique.set(link.url, { url: link.url, ...(link.title ? { title: link.title } : {}) })
    else if (!prior.title && link.title) prior.title = link.title
  }
  return [...unique.values()]
}

// Embedded saved results use supplied link metadata; no background provider lookup.
export function loadLinkPreview(_value: string): Promise<LinkPreviewMetadata | null> { return Promise.resolve(null) }
