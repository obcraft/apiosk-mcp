import type { BlockOf, TimelineEvent } from '@/lib/domain/answer-blocks'
import type { GatewayV2Analysis } from '@/lib/domain/gateway-v2'
import { periodCoordinate } from '@/lib/domain/answer-chart'
import { FactSourceLink, FactValue } from './fact-value'
import { useAnswerEvidence } from '../answer-evidence-context'

function eventDate(event: TimelineEvent): string | null {
  if (event.date?.value == null || event.when?.precision === 'unknown') return null
  const date = String(event.date.value)
  if (periodCoordinate({ key: date })) return event.when?.sort_key ?? date
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date) && Number.isFinite(Date.parse(date))) return event.when?.sort_key ?? date
  return null
}

export function TimelineBlockView({ block, analysis }: { block: BlockOf<'timeline'>; analysis?: GatewayV2Analysis | null }) {
  const { locale } = useAnswerEvidence()
  const nl = locale === 'nl-NL'
  const events = block.events.map((event, index) => ({ ...event, row_index: event.row_index ?? block.collection?.row_indices[index] ?? index }))
  const dated = events.filter(event => eventDate(event) != null).sort((a, b) => eventDate(a)!.localeCompare(eventDate(b)!))
  const undated = events.filter(event => eventDate(event) == null)
  const kinds: Record<string, [string, string]> = { published: ['Published', 'Gepubliceerd'], effective: ['Effective', 'Van kracht'], deadline: ['Deadline', 'Deadline'], filed: ['Filed', 'Ingediend'], registered: ['Registered', 'Geregistreerd'], decision: ['Decision', 'Besluit'], start: ['Start', 'Start'], end: ['End', 'Einde'], period_end: ['Period end', 'Einde periode'] }
  const renderEvent = (event: TimelineEvent, dated: boolean) => <li key={event.id} className="relative min-w-0 space-y-2 pb-5 pl-5 last:pb-0">
    <span aria-hidden="true" className={`absolute -left-[5px] top-1.5 size-2 rounded-full ${dated ? 'bg-accent' : 'bg-muted'}`} />
    <div className="text-tiny text-muted">{kinds[event.date_kind]?.[nl ? 1 : 0] ?? (nl ? 'Datum' : 'Date')} · {event.date?.value != null ? String(event.date.value) : nl ? 'Datum onbekend' : 'Date unknown'}</div>
    <h4 className="text-body font-medium">{event.label ?? (event.label_fact?.value != null ? String(event.label_fact.value) : nl ? 'Gebeurtenis' : 'Event')}</h4>
    <FactSourceLink fact={event.date} sourceIndex={analysis?.source_index} collection={block.collection} rowIndex={event.row_index} relativePointer={block.date_pointer} />
    {event.label_fact && <FactSourceLink fact={event.label_fact} sourceIndex={analysis?.source_index} collection={block.collection} rowIndex={event.row_index} relativePointer={block.label_pointer} />}
    {event.facts.length > 0 && <dl className="space-y-2">{event.facts.map((item, index) => <div key={index}><dt className="text-tiny text-muted">{item.label}</dt><dd className="text-body"><FactValue fact={item.fact} locale={locale} /><FactSourceLink fact={item.fact} sourceIndex={analysis?.source_index} /></dd></div>)}</dl>}
    {event.link && <FactValue fact={event.link} locale={locale} />}
  </li>
  return <section aria-label={block.title ?? (nl ? 'Tijdlijn' : 'Timeline')} className="min-w-0 max-w-full space-y-4">
    <h3 className="font-medium">{block.title ?? (nl ? 'Tijdlijn' : 'Timeline')}</h3>
    {dated.length > 0 && <ol aria-label={nl ? 'Gebeurtenissen op datum' : 'Events by date'} className="ml-1 border-l border-border-2">{dated.map(event => renderEvent(event, true))}</ol>}
    {undated.length > 0 && <div className="space-y-3"><h4 className="text-body font-medium">{nl ? 'Zonder vastgestelde datum' : 'Date not established'}</h4><ul className="ml-1 border-l border-dashed border-border-2">{undated.map(event => renderEvent(event, false))}</ul></div>}
    {!events.length && <p className="text-body text-muted">{nl ? 'Geen gebeurtenissen beschikbaar.' : 'No events available.'}</p>}
  </section>
}
