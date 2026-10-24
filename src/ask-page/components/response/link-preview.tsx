import { useContext, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronRight, Globe2 } from 'lucide-react'
import { ResultTableContext } from './result-table-context'
import { resultMedia } from '@/lib/domain/result-media'
import { ResultMediaView } from './result-media'
import { cn } from '@/lib/ui/utils'
import { SourceLogo } from '@/components/discover/source-logo'
import { curatedSourceMark } from '@/lib/ui/source-marks'
import { canFetchLinkPreview, extractResponseLinks, loadLinkPreview, safePreviewUrl, type LinkPreviewMetadata } from '@/lib/domain/link-preview'

type Props = { href: string; title?: string; description?: string; image?: string; className?: string }

export function LinkPreviewCard({ href, ...props }: Props) {
  const compact = useContext(ResultTableContext)
  const media = resultMedia(href, { name: props.title })
  if (media) return <ResultMediaView media={media} className={props.className} />
  const url = safePreviewUrl(href)
  if (compact && url) return <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" title={url}
    className="inline-flex max-w-full items-start gap-1 rounded-sm text-body underline decoration-border-2 underline-offset-4 hover:text-accent focus-visible:outline-2 focus-visible:outline-ring">
    <span className="min-w-0 [overflow-wrap:anywhere]">{props.title || new URL(url).hostname.replace(/^www\./, '')}</span><ArrowUpRight aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
  </a>
  return url ? <PreviewCard key={url} href={url} {...props} /> : <span className={props.className}>{props.title || href}</span>
}

function PreviewCard({ href, title, description, image, className }: Props) {
  const element = useRef<HTMLAnchorElement>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  const [metadata, setMetadata] = useState<LinkPreviewMetadata | null>(null)
  useEffect(() => {
    const node = element.current
    if (seen || !node) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setSeen(true); observer.disconnect() }
    }, { rootMargin: '160px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [seen])
  useEffect(() => {
    if (!seen) return
    let current = true
    void loadLinkPreview(href).then(value => { if (current) setMetadata(value) })
    return () => { current = false }
  }, [href, seen])
  const url = new URL(href)
  const hostname = url.hostname.replace(/^www\./, '')
  const shownTitle = metadata?.title || title || hostname
  const shownDescription = metadata?.description || description
  const shownImage = metadata?.image_data_url || (image && canFetchLinkPreview(image) ? safePreviewUrl(image) : null)
  // Match the destination, never a model-provided title that could name another brand.
  const mark = curatedSourceMark('', null, href)
  return <a ref={element} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`${shownTitle} — ${hostname}`}
    className={cn('my-2 flex w-full min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-xl border border-border-2 bg-surface p-2.5 text-left no-underline transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent', className)}>
    {seen && canFetchLinkPreview(href)
      ? <SourceLogo name={hostname} src={mark?.logoUrl || shownImage} fallbackSrc={mark?.logoUrl ? shownImage : null} host={url.hostname} className="size-16 rounded-lg bg-hover" />
      : <span aria-hidden="true" className="flex size-16 shrink-0 items-center justify-center rounded-lg bg-hover text-faint"><Globe2 className="size-5" /></span>}
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="line-clamp-2 text-body font-medium leading-snug text-heading [overflow-wrap:anywhere]">{shownTitle}</span>
      {shownDescription && <span className="line-clamp-2 text-tiny leading-snug text-muted [overflow-wrap:anywhere]">{shownDescription}</span>}
      <span className="truncate text-tiny text-faint">{hostname}</span>
    </span>
    <ChevronRight aria-hidden="true" className="mr-1 size-4 shrink-0 text-faint" />
  </a>
}

export function ResponseLinks({ text, className }: { text: string; className?: string }) {
  const links = extractResponseLinks(text)
  return links.length ? <span className={cn('block min-w-0 max-w-full', className)}>{links.map(link => <LinkPreviewCard key={link.url} href={link.url} title={link.title} />)}</span> : null
}
