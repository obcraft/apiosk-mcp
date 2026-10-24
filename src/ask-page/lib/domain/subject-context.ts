import { safeSourceUrl } from './ask-v2-chats'

export interface SubjectWebPage {
  kind: 'homepage' | 'search_result'
  url: string
  title: string
  publisher: string
  description: string
  text?: string
  retrieved_at?: string
  search_provider?: string
}
export interface SubjectContext {
  /** Legacy wire key for the subject label; also contains people, places and objects. */
  company: string
  subject_type?: string
  search_url: string
  search_status: string
  homepage_status: string
  pages: SubjectWebPage[]
}

/** Persisted chats and web metadata are untrusted display data. */
export function readSubjectContext(value: unknown): SubjectContext[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, 4).flatMap(item => {
    if (!item || typeof item !== 'object' || typeof item.company !== 'string') return []
    const search = typeof item.search_url === 'string' ? safeSourceUrl(item.search_url) : null
    if (!search) return []
    const searchUrl = new URL(search)
    const paths: Record<string, string> = { 'www.google.com': '/search', 'www.bing.com': '/search', 'duckduckgo.com': '/', 'en.wikipedia.org': '/w/index.php' }
    if (paths[searchUrl.hostname] !== searchUrl.pathname) return []
    const text = (value: unknown, max = 600) => typeof value === 'string' ? value.slice(0, max) : ''
    return [{ company: text(item.company, 160), subject_type: text(item.subject_type, 40), search_url: search, search_status: text(item.search_status), homepage_status: text(item.homepage_status),
      pages: (Array.isArray(item.pages) ? item.pages : []).slice(0, 9).flatMap((page: unknown) => {
        if (!page || typeof page !== 'object') return []
        const p = page as Record<string, unknown>
        const url = typeof p.url === 'string' ? safeSourceUrl(p.url) : null
        if (!url || !['homepage', 'search_result'].includes(String(p.kind))) return []
        return [{ kind: p.kind as SubjectWebPage['kind'], url, title: text(p.title, 240), publisher: text(p.publisher, 200), description: text(p.description), text: text(p.text, 2400), retrieved_at: text(p.retrieved_at, 40), ...(typeof p.search_provider === 'string' ? { search_provider: text(p.search_provider, 40) } : {}) }]
      }) }]
  })
}

/** A short extract from one cited page, never an inferred identity or check. */
export function subjectIntro(context: SubjectContext) {
  const subject = context.company.replace(/\b(?:b\.?v\.?|n\.?v\.?|ltd\.?|limited|inc\.?|llc|plc)\s*$/i, '').trim().toLocaleLowerCase()
  // A name match alone is not an introduction: homepages often lead with ads,
  // cookie banners or slogans. Keep the original excerpt and its exact source.
  const promotional = /\b(cashback|korting|coupon|discount|sale|deals?|free shipping|gratis verzending|shop now|buy now|bestel nu|koop nu|ontvang|stap over|cookie|consent|accept all|subscribe|sign up|abonneer|latest offers)\b|\d\s*%\s*(?:off|discount)/i
  const name = subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const definition = new RegExp(`(?:^|[^\\p{L}\\p{N}])${name}(?:\\s+(?:B\\.?V\\.?|N\\.?V\\.?|Ltd\\.?|Limited|Inc\\.?|LLC|PLC))?(?:\\s*\\([^)]{0,160}\\)|,\\s*[^,]{0,100},)?\\s+(?:is|was|are|provides|offers|sells|operates|speciali[sz]es|est|ist|biedt|verkoopt)\\b`, 'iu')
  const candidates = context.pages.flatMap(page => [page.description, page.text ?? ''].flatMap(text => {
    const sentences = [...new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text.replace(/\s+/g, ' ').trim())].map(part => part.segment.trim())
    const index = sentences.findIndex(sentence => !promotional.test(sentence) && definition.test(sentence))
    if (index < 0 || !subject) return []
    const next = sentences[index + 1]
    return [{ page, short: [sentences[index], ...(next && !promotional.test(next) ? [next] : [])].join(' ') }]
  }))
  const selected = candidates[0]
  if (!selected) return null
  const { page, short } = selected
  const summary = short.length > 420 ? `${short.slice(0, 417).replace(/\s+\S*$/, '').trimEnd()}…` : short
  return { page, summary }
}
