import { sourceUsageNotices } from '@/lib/domain/source-usage-notice'

/** Visible before payment and alongside each access to saved source results. */
export function SourceUsageNotices({ sources }: { sources: unknown[] }) {
  const notices = sourceUsageNotices(sources)
  if (!notices.length) return null
  return <div role="note" aria-label="Source usage notices" className="space-y-2 text-tiny text-muted">
    {notices.map(notice => <p key={JSON.stringify([notice.text, notice.url])} className="break-words">
      {notice.text}{notice.url && <> <a href={notice.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">{notice.label || 'Original source'}</a></>}
    </p>)}
  </div>
}
