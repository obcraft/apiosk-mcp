import * as React from 'react'
import { Children, useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ExternalLink } from 'lucide-react'
import { EntityLogo } from '@/components/explore/entity-logo'
import { readSubjectContext, subjectIntro, type SubjectContext } from '@/lib/domain/subject-context'
import type { AnswerSource } from '@/lib/domain/answer-sources'
import { useRevealDelay, useTypedText } from './discovery-reveal'

/** Keep each reply and its sources together at the same content width. */
export function ConversationSourcesLayout({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 w-full flex-1 flex-col">{children}</div>
}

function SourcePanel({ count, children, selectionRequired = false, webSearches = false }: { count: number; children: ReactNode; selectionRequired?: boolean; webSearches?: boolean }) {
  const [open, setOpen] = useState(!webSearches)
  return <details open={open} onToggle={event => setOpen(event.currentTarget.open)} data-selection-required={selectionRequired || undefined} className={`ask-source-panel group rounded-xl border bg-surface transition-colors ${selectionRequired ? 'border-accent' : 'border-border-2'}`}>
    <summary className="flex min-h-12 cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-body text-muted [&::-webkit-details-marker]:hidden">{webSearches ? 'Web searches' : 'Sources'} <span className="ml-auto text-tiny">{count}</span><ChevronDown aria-hidden="true" className="size-4 transition-transform group-open:rotate-180" /></summary>
    <div className="max-h-[min(65dvh,36rem)] overflow-y-auto overscroll-contain">{children}</div>
  </details>
}

function SourcesList({ sources, showUrls = false }: { sources: AnswerSource[]; showUrls?: boolean }) {
  return <ul className="space-y-5 p-4">
    {sources.map(source => <li key={source.key} className="flex min-w-0 gap-2.5">
      <EntityLogo name={source.name} logoUrl={source.logoUrl} siteUrl={source.url} className="mt-0.5 size-5 shrink-0 rounded-full" />
      <div className="min-w-0 space-y-1">
        <p className="truncate text-tiny text-muted">{source.name}</p>
        {source.url ? <a href={source.url} target="_blank" rel="noopener noreferrer" className="block break-words text-body font-medium hover:underline">{source.title}<ExternalLink aria-hidden="true" className="ml-1 inline size-3 text-muted" /></a> : <p className="break-words text-body font-medium">{source.title}</p>}
        {showUrls && source.url && <p className="break-all text-tiny text-faint">{source.url}</p>}
        {source.description && <p className="line-clamp-3 break-words text-tiny text-muted">{source.description}</p>}
        {source.retrievedAt && !Number.isNaN(Date.parse(source.retrievedAt)) && <p className="text-tiny text-faint">Retrieved {new Date(source.retrievedAt).toLocaleDateString()}</p>}
      </div>
    </li>)}
  </ul>
}

/** Sources follow the answer at every width; selectors precede purchase inputs. */
export function AnswerLayout({ sources, children, sourceContent, sourceCount = sources.length, selectionRequired = false, sourcesFirst = false, webSearches = false, showSources = true }: { sources: AnswerSource[]; children: ReactNode; sourceContent?: ReactNode; sourceCount?: number; selectionRequired?: boolean; sourcesFirst?: boolean; webSearches?: boolean; showSources?: boolean }) {
  const panel = <aside aria-label={webSearches ? 'Web searches' : 'Response sources'} className="min-w-0 w-full"><SourcePanel webSearches={webSearches} count={sourceCount} selectionRequired={selectionRequired}>{sourceContent ?? <SourcesList sources={sources} showUrls={webSearches} />}</SourcePanel></aside>
  const hasPanel = showSources && (sources.length > 0 || Boolean(sourceContent))
  return <div className="min-w-0 w-full space-y-4">
    {hasPanel && sourcesFirst && panel}
    {Children.toArray(children).length > 0 && <div className="min-w-0 space-y-4">{children}</div>}
    {hasPanel && !sourcesFirst && panel}
  </div>
}

export function SubjectWebContext({ value, live = false, onReady }: { value: unknown; live?: boolean; onReady?: () => void }) {
  const subjects = readSubjectContext(value)
  const [readySubjects, setReadySubjects] = useState<string[]>([])
  const ready = useCallback((company: string) => setReadySubjects(previous => previous.includes(company) ? previous : [...previous, company]), [])
  const complete = subjects.length > 0 && subjects.every(subject => readySubjects.includes(subject.company))
  useEffect(() => { if (complete) onReady?.() }, [complete, onReady])
  if (!subjects.length) return null
  return <section aria-label="Quick introduction" className="space-y-4">
    {subjects.map(subject => <SubjectIntroduction key={subject.company} subject={subject} live={live} onReady={ready} />)}
  </section>
}

function TypedText({ text, shown, done }: { text: string; shown: string; done: boolean }) {
  if (done) return <>{text}</>
  // Screen readers receive the full sentence once, rather than every letter.
  return <><span className="sr-only">{text}</span><span aria-hidden="true">{shown}<span className="ml-0.5 inline-block h-[1em] w-0.5 translate-y-0.5 bg-current opacity-60" /></span></>
}

function SubjectIntroduction({ subject, live, onReady }: { subject: SubjectContext; live: boolean; onReady: (company: string) => void }) {
  const homepage = subject.pages.find(page => page.kind === 'homepage')
  const intro = subjectIntro(subject)
  const provider = ({ 'www.bing.com': 'Bing', 'duckduckgo.com': 'DuckDuckGo', 'en.wikipedia.org': 'Wikipedia' } as Record<string, string>)[new URL(subject.search_url).hostname] || 'Google'
  const introProvider = intro?.page.search_provider ? ({ google: 'Google', bing: 'Bing', duckduckgo: 'DuckDuckGo', wikipedia: 'Wikipedia', google_news: 'Google News' } as Record<string, string>)[intro.page.search_provider] ?? provider : provider
  const loading = subject.search_status === 'loading' || subject.homepage_status === 'loading'
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(new URL(subject.search_url).searchParams.get('q') || new URL(subject.search_url).searchParams.get('search') || subject.company)}`
  const titleText = `About ${subject.company}`
  const title = useTypedText(titleText, true, live)
  const bodyReady = useRevealDelay(title.done, 240, live)
  const waitExpired = useRevealDelay(bodyReady, 2500, live)
  const description = intro?.summary ?? (loading ? '' : subject.search_status === 'completed' ? 'The available pages do not provide a clear introduction. You can review them under Web searches.' : 'A short introduction is unavailable. We couldn’t retrieve web results for this lookup.')
  const body = useTypedText(description, bodyReady, live)
  const complete = body.done && (!loading || Boolean(intro) || waitExpired)
  useEffect(() => { if (complete) onReady(subject.company) }, [complete, onReady, subject.company])
  return <div className="space-y-2">
    <h3 className="text-body font-medium"><TypedText text={titleText} {...title} /></h3>
    {bodyReady && (intro ? <>
      <p className="text-body leading-relaxed"><TypedText text={description} {...body} /></p>
      {body.done && <>
        <a href={intro.page.url} target="_blank" rel="noopener noreferrer" className="text-tiny text-muted underline">{intro.page.publisher || new URL(intro.page.url).hostname}</a>
        <p className="text-tiny text-faint">{intro.page.kind === 'homepage' ? 'Website overview' : `Search excerpt from ${introProvider}`} · Background only; identity and requested checks are still unverified.</p>
        {homepage?.text && <details className="text-tiny text-muted"><summary className="w-fit cursor-pointer py-1">Read homepage excerpt</summary><p className="mt-2 whitespace-pre-wrap leading-relaxed">{homepage.text}</p></details>}
      </>}
    </> : <p className="text-tiny text-muted">{loading ? 'Looking for a descriptive overview…' : <TypedText text={description} {...body} />}</p>)}
    {complete && <div className="flex flex-wrap gap-x-4 gap-y-2">
      <a href={googleUrl} target="_blank" rel="noopener noreferrer" className="inline-flex text-tiny text-muted underline">View Google search</a>
      {provider !== 'Google' && <a href={subject.search_url} target="_blank" rel="noopener noreferrer" className="inline-flex text-tiny text-muted underline">View {provider} search</a>}
    </div>}
  </div>
}
