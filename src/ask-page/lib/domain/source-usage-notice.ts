export interface SourceUsageNotice { text: string; url?: string; label?: string }

/** Provider-use conditions are displayed literally, without fetching the link. */
export function sourceUsageNotices(sources: unknown[]): SourceUsageNotice[] {
  const unique = new Map<string, SourceUsageNotice>()
  for (const source of sources) {
    if (!source || typeof source !== 'object' || !('usage_notice' in source)) continue
    const raw = source.usage_notice
    if (!raw || typeof raw !== 'object' || !('text' in raw) || typeof raw.text !== 'string' || !raw.text.trim()) continue
    const notice: SourceUsageNotice = { text: raw.text.trim() }
    if ('url' in raw && typeof raw.url === 'string') {
      try {
        const url = new URL(raw.url)
        if (url.protocol === 'https:' && !url.username && !url.password) notice.url = url.href
      } catch { /* Keep the required text even when its optional link is invalid. */ }
    }
    if ('label' in raw && typeof raw.label === 'string' && raw.label.trim()) notice.label = raw.label.trim()
    unique.set(JSON.stringify([notice.text, notice.url]), notice)
  }
  return [...unique.values()]
}
