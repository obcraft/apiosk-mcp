import type { Fact, SourceIndexEntry } from '@/lib/domain/answer-blocks'
import { answerValueContext } from '@/lib/domain/answer-format'
import { safeSourceUrl } from '@/lib/domain/ask-v2-chats'
import { formatSourceValue } from '@/lib/domain/source-value-format'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ResponseText } from '@/components/response/response-text'
import { useAnswerEvidence } from './answer-evidence-context'
import type { ReactNode } from 'react'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined

/** Evidence is read from the saved answer. Opening this never retrieves a source. */
function EvidenceFact({ fact, sourceIndex }: { fact: Fact; sourceIndex: SourceIndexEntry[] }) {
  const { results, analysis, locale } = useAnswerEvidence()
  const nl = locale === 'nl-NL'
  const saved = results.map(record).find(result => result.result_ref === fact.result_ref)
  const source = record(saved?.source)
  const indexed = sourceIndex.find(entry => entry.result_ref === fact.result_ref)
  const observation = analysis?.observations.flatMap(item => item.evidence).find(item => item.result_ref === fact.result_ref && item.pointer === fact.pointer)
  const observedSource = record(observation?.source)
  const name = indexed?.name ?? text(source.name) ?? text(observedSource.name) ?? fact.source ?? indexed?.provider ?? text(source.provider) ?? (nl ? 'Opgeslagen bron' : 'Saved source')
  const retrieved = indexed?.retrieved_at ?? text(source.retrieved_at) ?? text(observedSource.retrieved_at)
  const url = safeSourceUrl(text(source.url) ?? '')
  const valueContext = fact.result_ref && fact.pointer ? answerValueContext({ result_ref: fact.result_ref, pointer: fact.pointer }, results) : null
  const period = fact.period?.value ?? fact.period?.key ?? valueContext?.period
  const currency = fact.currency?.value ?? valueContext?.currency ?? null
  const field = fact.field ?? valueContext?.field ?? ''
  const formatted = fact.value == null ? (nl ? 'Onbekend' : 'Unknown') : formatSourceValue(fact.value, field || (currency ? 'Amount' : ''), currency, undefined, locale)
  const validDate = retrieved && !Number.isNaN(Date.parse(retrieved))
  return <div className="space-y-2 py-3 first:pt-0 last:pb-0">
    <p className="text-body font-medium">{name}</p>
    <dl className="space-y-2 text-tiny">
      <div><dt className="text-muted">{nl ? 'Bronwaarde' : 'Source value'}{field ? ` · ${field.replaceAll('_', ' ')}` : ''}</dt><dd className="mt-0.5 break-words font-medium tabular-nums"><ResponseText text={formatted} previews={false} /></dd></div>
      {period && <div><dt className="text-muted">{nl ? 'Periode van de gegevens' : 'Data period'}</dt><dd>{period}</dd></div>}
      {fact.unit?.value && <div><dt className="text-muted">{nl ? 'Eenheid' : 'Unit'}</dt><dd>{fact.unit.value}</dd></div>}
      <div><dt className="text-muted">{nl ? 'Opgehaald op' : 'Retrieved on'}</dt><dd>{validDate ? <time dateTime={retrieved}>{new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(retrieved))}</time> : nl ? 'Datum niet beschikbaar' : 'Date unavailable'}</dd></div>
    </dl>
    {url && <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center text-tiny underline underline-offset-4">{nl ? 'Open bronwebsite' : 'Open source website'}</a>}
    {fact.pointer != null && <details className="text-tiny text-muted"><summary className="w-fit cursor-pointer py-1">{nl ? 'Exacte verwijzing' : 'Exact reference'}</summary><p className="break-all pt-1 font-mono">{fact.pointer || '/'}</p></details>}
  </div>
}

export function EvidenceCitation({ facts, label, sourceIndex, inline = false }: { facts: Fact[]; label?: ReactNode; sourceIndex?: SourceIndexEntry[]; inline?: boolean }) {
  const { analysis, locale } = useAnswerEvidence()
  const nl = locale === 'nl-NL'
  const index = sourceIndex?.length ? sourceIndex : analysis?.source_index ?? []
  const unique = [...new Map(facts.filter(fact => fact.result_ref && fact.pointer != null || fact.derivation_id)
    .map(fact => [JSON.stringify([fact.result_ref, fact.pointer, fact.derivation_id, fact.value]), fact])).values()]
  if (!unique.length) return null
  return <Popover>
    <PopoverTrigger asChild><button type="button" title={typeof label === 'string' ? label : undefined} aria-label={nl ? 'Bekijk brononderbouwing' : 'View supporting evidence'} className={`${inline ? 'ml-1 align-baseline' : ''} inline-flex min-h-7 max-w-full items-center rounded text-tiny font-normal text-muted underline decoration-border-2 underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring`}>
      <span className="truncate">{label ?? (nl ? 'Bronnen' : 'Sources')}</span>
    </button></PopoverTrigger>
    <PopoverContent align="start" className="w-96 p-4" aria-label={nl ? 'Brononderbouwing' : 'Supporting evidence'}>
      <h3 className="mb-3 text-body font-medium">{nl ? 'Onderbouwing uit opgeslagen gegevens' : 'Evidence from saved data'}</h3>
      <div className="divide-y divide-border-2">{unique.map((fact, i) => {
        if (!fact.derivation_id || fact.result_ref) return <EvidenceFact key={i} fact={fact} sourceIndex={index} />
        const derivation = analysis?.derivations?.find(item => item.id === fact.derivation_id)
        return <div key={i} className="space-y-2 py-3 first:pt-0 last:pb-0">
          <p className="text-body font-medium">{nl ? 'Berekende waarde' : 'Calculated value'}: {fact.value == null ? (nl ? 'Onbekend' : 'Unknown') : String(fact.value)}</p>
          {derivation?.result ? <>
            <p className="break-words text-tiny text-muted">{derivation.result.formula}</p>
            {derivation.result.inputs.map((input, inputIndex) => input.reference.result_ref && input.reference.pointer != null
              ? <EvidenceFact key={inputIndex} fact={{ ...input.reference, value: input.value, period: input.period_key ? { value: input.period_key } : undefined }} sourceIndex={index} />
              : <p key={inputIndex} className="text-tiny text-muted">{nl ? 'Berekende invoerwaarde' : 'Calculated input'}: {input.value == null ? (nl ? 'Onbekend' : 'Unknown') : String(input.value)}</p>)}
          </> : <p className="text-tiny text-muted">{nl ? 'Berekeningsdetails niet beschikbaar.' : 'Calculation details unavailable.'}</p>}
        </div>
      })}</div>
    </PopoverContent>
  </Popover>
}
