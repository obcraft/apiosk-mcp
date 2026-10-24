import type { Collection, Fact, FlagKind, SourceIndexEntry } from '@/lib/domain/answer-blocks'
import { factOrigin } from '@/lib/domain/answer-blocks-view'
import { formatSourceValue } from '@/lib/domain/source-value-format'
import { ResponseText } from '@/components/response/response-text'
import { resultMedia } from '@/lib/domain/result-media'
import { ResultMediaView } from '@/components/response/result-media'
import { EvidenceCitation } from '../answer-evidence'
import { useAnswerEvidence } from '../answer-evidence-context'

const FLAG_LABEL: Record<FlagKind, string> = {
  estimated: 'Estimated', provisional: 'Provisional', revised: 'Revised', rounded: 'Rounded', confidential: 'Confidential',
}

export function FlagBadges({ flags }: { flags?: { kind: FlagKind }[] }) {
  if (!flags?.length) return null
  return <span className="ml-1.5 inline-flex gap-1 align-middle">
    {flags.map((flag, i) => <span key={i} className="rounded bg-[color:var(--accent-wash)] px-1.5 py-0.5 text-tiny font-medium text-muted">{FLAG_LABEL[flag.kind]}</span>)}
  </span>
}

/**
 * A Fact's value, formatted for display. A null value (missing) always
 * reads "Unknown"; a `state: "zero"` fact reports 0, never blank, so the
 * two stay distinguishable (backlog #47/#55).
 */
export function FactValue({ fact, locale = 'nl-NL' }: { fact?: Fact | null; locale?: string }) {
  if (!fact || fact.value == null) return <span className="text-muted">Unknown</span>
  const media = resultMedia(fact.value, { field: fact.field })
  if (media) return <span className="block min-w-0"><ResultMediaView media={media} /><FlagBadges flags={fact.flags} /></span>
  const currency = fact.currency?.value != null ? String(fact.currency.value) : null
  const text = formatSourceValue(fact.value, fact.field ?? (currency ? 'Amount' : ''), currency, undefined, locale)
  return <span className="tabular-nums"><ResponseText text={text} /><FlagBadges flags={fact.flags} /></span>
}

/** Open the saved value, source and date, with its exact reference available. */
export function FactSourceLink({ fact, sourceIndex = [], collection, rowIndex, relativePointer }: {
  fact?: Fact | null; sourceIndex?: SourceIndexEntry[]; collection?: Collection; rowIndex?: number; relativePointer?: string
}) {
  const { analysis, locale } = useAnswerEvidence()
  const origin = factOrigin(fact, collection, rowIndex, relativePointer)
  if (!origin) return fact?.derivation_id ? <span className="block"><EvidenceCitation facts={[fact]} label={locale === 'nl-NL' ? 'Berekend' : 'Calculated'} /></span> : null
  const entry = (sourceIndex.length ? sourceIndex : analysis?.source_index ?? []).find(s => s.result_ref === origin.result_ref)
  const name = entry?.name ?? fact?.source ?? entry?.provider ?? (locale === 'nl-NL' ? 'Bron' : 'Source')
  return <span className="block"><EvidenceCitation facts={[{ ...fact, value: fact?.value ?? null, ...origin }]} sourceIndex={sourceIndex} label={name} /></span>
}
