import { safeSourceUrl } from './ask-v2-chats'
import { curatedSourceMark } from '@/lib/ui/source-marks'
import { readSubjectContext } from './subject-context'

export interface AnswerSource {
  key: string
  name: string
  title: string
  description: string
  url?: string | null
  logoUrl?: string | null
  retrievedAt?: string
}
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

export function answerSources(results: unknown[], context?: unknown, news?: unknown): AnswerSource[] {
  const entries: AnswerSource[] = results.flatMap(value => {
    const item = record(value), source = record(item.source)
    const name = text(source.name) || text(source.provider)
    if (!name) return []
    const url = safeSourceUrl(text(source.url))
    const mark = curatedSourceMark(name, text(source.provider), url)
    const logo = text(source.logo_url)
    return [{ key: text(item.result_ref) || `${name}:${url}:${text(source.path)}`, name,
      title: text(record(item.subject).label) || name,
      description: text(source.description) || text(item.coverage_note) || 'Saved source result', url,
      logoUrl: logo.startsWith('/') && !logo.startsWith('//') && !logo.includes('\\') ? logo : safeSourceUrl(logo) ?? mark?.logoUrl,
      retrievedAt: text(source.retrieved_at) }]
  })
  for (const subject of readSubjectContext(context)) for (const page of subject.pages) entries.push({
    key: page.url, name: page.publisher || new URL(page.url).hostname, title: page.title, description: page.description,
    url: page.url, retrievedAt: page.retrieved_at,
  })
  if (Array.isArray(news)) for (const item of news) {
    const page = record(item), url = safeSourceUrl(text(page.url))
    if (url) entries.push({ key: url, name: text(page.publisher), title: text(page.title), description: text(page.summary), url })
  }
  return [...new Map(entries.map(entry => [entry.key, entry])).values()]
}

