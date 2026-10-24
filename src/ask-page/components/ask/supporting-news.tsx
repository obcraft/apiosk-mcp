import type { GatewayV2SupportingNews } from '@/lib/domain/gateway-v2'
import { safeSourceUrl } from '@/lib/domain/ask-v2-chats'
import { NewsPublisherLogo } from './news-publisher-logo'

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

/** Reads only the saved excerpts. Opening an answer never fetches news again. */
export function SupportingNews({ articles }: { articles?: GatewayV2SupportingNews[] }) {
  if (!Array.isArray(articles)) return null
  const seen = new Set<string>()
  const visible = articles.flatMap(value => {
    if (!value || typeof value !== 'object') return []
    const title = text(value.title), publisher = text(value.publisher)
    const url = safeSourceUrl(text(value.url)), feed = safeSourceUrl(text(value.feed_url))
    const published = text(value.published_at), timestamp = Date.parse(published)
    if (!title || !publisher || !url || !feed || !published || !Number.isFinite(timestamp) || seen.has(url)) return []
    seen.add(url)
    return [{ title, publisher, url, feed, published, date: dateFormat.format(timestamp), summary: text(value.summary) }]
  }).slice(0, 4)
  if (!visible.length) return null

  return <section aria-label="Related news" className="min-w-0 max-w-full space-y-2 rounded-xl border border-border-2 bg-surface p-4 sm:p-5">
    <div>
      <h3 className="text-body font-medium">Related news</h3>
      <p className="text-tiny text-muted">Additional context from publisher feeds.</p>
    </div>
    <ul className="space-y-3">
      {visible.map(article => <li key={article.url} className="flex min-w-0 gap-3">
        <NewsPublisherLogo feedUrl={article.feed} />
        <div className="min-w-0 flex-1 space-y-1">
        <a href={article.url} target="_blank" rel="noopener noreferrer" className="block text-body font-medium leading-snug underline decoration-border-2 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-current">{article.title}</a>
        <p className="text-tiny text-muted">{article.publisher} · <time dateTime={article.published}>{article.date}</time></p>
        {article.summary && <p className="line-clamp-2 text-tiny leading-snug text-muted [overflow-wrap:anywhere]">{article.summary}</p>}
        </div>
      </li>)}
    </ul>
  </section>
}
