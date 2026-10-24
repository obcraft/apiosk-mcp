import { useContext, useEffect, useMemo, useState } from 'react'
import { ArrowUpRight, ChevronRight, Download, File } from 'lucide-react'
import { cn } from '@/lib/ui/utils'
import type { ResultMedia } from '@/lib/domain/result-media'
import { collectResultMedia } from '@/lib/domain/result-media-collection'
import { ResultTableContext } from './result-table-context'
import { Button } from '@/components/ui/button'

/** Local bytes live in an effect-owned Blob URL and are released on replacement/unmount. */
export function ResultMediaView({ media, className, thumbnail = false }: { media: ResultMedia; className?: string; thumbnail?: boolean }) {
  const compact = useContext(ResultTableContext)
  const [resource, setResource] = useState<{ source: unknown; url: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const binary = media.blob ?? media.bytes
  useEffect(() => {
    if (!binary || typeof URL.createObjectURL !== 'function') return
    // Download-only files never become active HTML/SVG documents in this page.
    const type = media.kind === 'file' ? 'application/octet-stream' : media.mimeType
    const blob = binary instanceof Blob ? binary.slice(0, binary.size, type) : new Blob([new Uint8Array(binary)], { type })
    const url = URL.createObjectURL(blob)
    // eslint-disable-next-line react-hooks/set-state-in-effect -- The browser resource must be created and released together in the effect.
    setResource({ source: binary, url })
    return () => URL.revokeObjectURL(url)
  }, [binary, media.kind, media.mimeType])
  const href = media.url ?? (resource && resource.source === binary ? resource.url : undefined)
  const unavailable = href && failed === href
  const action = media.url ? media.kind === 'file' ? 'Open file' : 'Open original' : 'Download'
  const size = media.blob?.size ?? media.bytes?.byteLength
  const sizeLabel = size === undefined ? '' : size < 1024 ? `${size} B` : `${new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 }).format(size / 1024)} KB`
  const typeLabel = media.name.match(/\.([a-z0-9]{1,6})$/i)?.[1].toUpperCase() ?? ({ image: 'Image', video: 'Video', audio: 'Audio', file: 'File' }[media.kind])
  return <span className={cn('min-w-0 max-w-full overflow-hidden rounded-xl border border-border-2 bg-surface', thumbnail ? 'flex w-full items-center gap-3 p-2' : ['my-2 block', compact ? 'w-full sm:max-w-sm' : 'w-full max-w-2xl'], className)}>
    {media.kind === 'image' && !unavailable && href && <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={`Open ${media.name}`} className={thumbnail ? 'block size-16 shrink-0 overflow-hidden rounded-md' : undefined}>
      <img src={href} alt={media.name} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(href)} className={cn('block w-full bg-surface-soft object-contain', thumbnail ? 'h-full' : ['h-auto', compact ? 'max-h-56' : 'max-h-96'])} />
    </a>}
    {media.kind === 'video' && !unavailable && <video key={href} src={href} controls playsInline preload="none" aria-label={media.name} onError={() => href && setFailed(href)} className={cn('block w-full bg-surface-soft object-contain', compact ? 'max-h-56' : 'max-h-96')} />}
    {media.kind === 'audio' && !unavailable && <audio key={href} src={href} controls preload="none" aria-label={media.name} onError={() => href && setFailed(href)} className="block w-full min-w-0 px-2 pt-2" />}
    <span className={cn('flex min-w-0', thumbnail ? 'flex-1 flex-col items-start gap-1' : 'flex-wrap items-center gap-2 px-3 py-2.5')}>
      {media.kind === 'file' && <File aria-hidden="true" className="size-5 shrink-0 text-muted" />}
      <span className="min-w-0 flex-1">
        <span className="block text-tiny font-medium [overflow-wrap:anywhere]">{media.name}</span>
        <span className="block text-tiny text-muted">{unavailable ? 'Preview unavailable · ' : ''}{typeLabel}{sizeLabel ? ` · ${sizeLabel}` : ''}</span>
      </span>
      {href && <a href={href} download={media.url ? undefined : media.name} target={media.url ? '_blank' : undefined} rel="noopener noreferrer" referrerPolicy="no-referrer"
        aria-label={`${action} ${media.name}`} className="inline-flex shrink-0 items-center gap-1 rounded-sm py-1 text-tiny font-medium text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">
        {action}{media.url ? <ArrowUpRight aria-hidden="true" className="size-3.5" /> : <Download aria-hidden="true" className="size-3.5" />}
      </a>}
    </span>
  </span>
}

/** Source attachments omitted by a selected table remain available beside its result. */
export function ResultMediaGallery({ value, label = 'Media and files', exclude }: { value: unknown; label?: string; exclude?: unknown }) {
  const found = useMemo(() => collectResultMedia(value), [value])
  const excluded = useMemo(() => new Set(collectResultMedia(exclude).items.map(item => item.identity)), [exclude])
  const items = found.items.filter(item => !excluded.has(item.identity))
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState(4)
  if (!items.length) return null
  return <details onToggle={event => setOpen(event.currentTarget.open)} className="group/result-media min-w-0">
    <summary className="flex min-h-9 w-fit cursor-pointer list-none items-center gap-2 rounded-md text-body font-medium text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform group-open/result-media:rotate-90" />
      <span>{label}</span>
      <span className="text-tiny tabular-nums">({items.length})</span>
    </summary>
    {open && <div className="mt-3 space-y-3">
      <div className="grid min-w-0 items-start gap-3 sm:grid-cols-2">{items.slice(0, shown).map(item => <ResultMediaView key={item.key} media={item.media} thumbnail={item.media.kind === 'image'} />)}</div>
      {shown < items.length && <Button type="button" variant="ghost" size="sm" onClick={() => setShown(count => count + 4)}>Show {Math.min(4, items.length - shown)} more files</Button>}
      {found.truncated && <p className="text-tiny text-muted">More content is available in the full source data.</p>}
    </div>}
  </details>
}
