import type { ReactNode } from 'react'
import { EntityLogo } from '@/components/explore/entity-logo'
import { Tooltip } from '@/components/ui/tooltip'
import { safeSourceUrl } from '@/lib/domain/ask-v2-chats'
import { curatedSourceMark } from '@/lib/ui/source-marks'

const text = (value: unknown) => typeof value === 'string' ? value.trim() : ''

/** Only sources attached to this answer; repeated calls share one mark. */
export function AnswerSourceLogos({ sources, fallback = null }: { sources: unknown[]; fallback?: ReactNode }) {
  const marks = new Map<string, { name: string; logoUrl?: string | null; siteUrl?: string | null }>()
  for (const value of sources) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const source = value as Record<string, unknown>
    const slug = text(source.provider) || text(source.source_slug) || text(source.slug)
    const name = text(source.name) || slug
    if (!name) continue
    const site = safeSourceUrl(text(source.url))
    const known = curatedSourceMark(name, slug, site)
    const logo = text(source.logo_url)
    const logoUrl = logo.startsWith('/') && !logo.startsWith('//') && !logo.includes('\\') ? logo : safeSourceUrl(logo)
    const key = (slug || name).toLowerCase()
    const previous = marks.get(key)
    marks.set(key, {
      name: previous?.name ?? name,
      logoUrl: previous?.logoUrl ?? logoUrl ?? known?.logoUrl,
      siteUrl: previous?.siteUrl ?? site ?? known?.host,
    })
  }
  if (!marks.size) return fallback
  return <span aria-label="Used sources" className="inline-flex min-w-0 flex-wrap items-center gap-1">
    {[...marks].map(([key, mark]) => <Tooltip key={key} label={mark.name} className="shrink-0">
      <span role="img" aria-label={mark.name} className="inline-flex">
        <EntityLogo {...mark} className="size-5 rounded-full ring-1 ring-border-2 [&_span]:text-tiny" />
      </span>
    </Tooltip>)}
  </span>
}
