import { useContext, type ReactNode } from 'react'
import { extractResponseLinks, safePreviewUrl } from '@/lib/domain/link-preview'
import { LinkPreviewCard, ResponseLinks } from './link-preview'
import { ResultTableContext } from './result-table-context'
import { resultDate } from '@/lib/ui/result-date'
import { resultMedia } from '@/lib/domain/result-media'
import { ResultMediaView } from './result-media'

/** Text stays readable while public page links gain a compact, optional preview. */
export function ResponseText({ text, children, className = '', previews = true }: {
  text: string; children?: ReactNode; className?: string; previews?: boolean
}) {
  const compact = useContext(ResultTableContext)
  const media = previews && children === undefined ? resultMedia(text) : null
  if (media) return <ResultMediaView media={media} className={className} />
  const date = compact && children === undefined ? resultDate(text) : null
  if (date?.raw) return <time dateTime={date.raw} title={date.raw} className="tabular-nums"><span className="block">{date.date}</span>{date.time && <span className="block text-tiny text-muted">{date.time}</span>}</time>
  const links = previews ? extractResponseLinks(text) : []
  if (!links.length) return <>{children ?? text}</>
  const onlyLink = links.length === 1 && ((!/\s/.test(text.trim()) && safePreviewUrl(text.trim()) === links[0].url)
    || /^\[[^\]]+\]\(https?:\/\/[^\s]+\)$/.test(text.trim()))
  if (onlyLink) return <LinkPreviewCard href={links[0].url} title={links[0].title} className={className} />
  return <span className={`min-w-0 ${className}`}>
    {children ?? text}
    {links.length > 0 && <ResponseLinks text={text} className="mt-2" />}
  </span>
}
