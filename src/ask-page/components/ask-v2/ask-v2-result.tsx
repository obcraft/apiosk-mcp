import { useMemo, useState } from 'react'
import { ArrowUpRight, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { AnswerBody } from '@/components/discover/answer-view'
import { previewResult, resultCsv, resultFileName, resultJson, resultRecords } from '@/lib/domain/ask-v2-result'
import type { PurchaseSource } from '@/lib/domain/ask-v2-purchase'
import { sourceSummary } from '@/lib/domain/source-summary'
import { financialStatement } from '@/lib/domain/financial-statement'
import { FinancialStatement } from '@/components/ask/financial-statement'
import { asDate, isRecord, isNoiseKey, label } from '@/lib/ui/answer'
import { ResponseText } from '@/components/response/response-text'
import { ResultTable } from '@/components/response/result-table'
import { ResultTableContext } from '@/components/response/result-table-context'
import { resultMedia, type ResultMediaHints } from '@/lib/domain/result-media'
import { ResultMediaView } from '@/components/response/result-media'
import { SourceUsageNotices } from '@/components/ask/source-usage-notices'
import { SavedSourceResult } from '@/components/ask/saved-source-result'
import type { ReadSavedResultPage } from '@/lib/domain/saved-result-pages'
import { AnswerSourceLogos } from '@/components/ask/answer-source-logos'

/** Hands the person a file; nothing is uploaded or kept. */
function save(text: string, name: string, type: string) {
  if (typeof URL.createObjectURL !== 'function') return
  const url = URL.createObjectURL(new Blob([text], { type }))
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function Downloads({ name, value, raw, csv }: { name: string; value: unknown; raw: unknown; csv: boolean }) {
  return <>
    <Button type="button" size="sm" variant="ghost" className="rounded-full px-2 text-tiny" aria-label={`Download ${name} result as JSON`} onClick={() => save(resultJson(raw), resultFileName(name, 'json'), 'application/json')}>JSON</Button>
    {csv && <Button type="button" size="sm" variant="ghost" className="rounded-full px-2 text-tiny" aria-label={`Download ${name} result as CSV`} onClick={() => { const text = resultCsv(value); if (text) save(text, resultFileName(name, 'csv'), 'text/csv;charset=utf-8') }}>CSV</Button>}
  </>
}

function PreviewValue({ value, hints }: { value: unknown; hints?: ResultMediaHints }) {
  const media = resultMedia(value, hints)
  if (media) return <ResultMediaView media={media} />
  return value != null && value !== '' ? <ResponseText text={typeof value === 'object' ? JSON.stringify(value) : String(value)} /> : <span className="text-faint">—</span>
}

/**
 * A purchased result in the chat. A handful of values shows whole, as before;
 * a larger one is a card: what it is, how many, the first rows, and the full
 * result in a dialog or as a file. The dialog draws it with the same reader.
 */
export function AskV2Result({ source, value, raw, partial = false, readResultPage, onSelectRecord }: { source: PurchaseSource; value: unknown; raw: unknown; partial?: boolean; readResultPage?: ReadSavedResultPage; onSelectRecord?: (record: Record<string, unknown>) => void }) {
  const preview = useMemo(() => previewResult(value), [value])
  const financial = useMemo(() => financialStatement(value), [value])
  const [open, setOpen] = useState(false)
  const records = useMemo(() => resultRecords(value)?.records ?? [], [value])
  const [selected, setSelected] = useState<Record<string, unknown> | null>(null)
  const selectedIndex = selected ? records.indexOf(selected) : -1
  const choose = records.length ? (index: number) => setSelected(records[index]) : undefined
  const useSelected = () => { if (selectedIndex >= 0 && onSelectRecord) { onSelectRecord(records[selectedIndex]); setOpen(false) } }
  const recordColumns = useMemo(() => {
    const keys = [...new Set(records.flatMap(record => Object.keys(record)))].filter(key => !isNoiseKey(key) && records.some(record => ['string', 'number', 'boolean'].includes(typeof record[key])))
    const names = keys.filter(key => /^(name|naam|title|label|company_name|handelsnaam|full_name|display_name)$/i.test(key))
    return [...names, ...keys.filter(key => !names.includes(key))].slice(0, 6)
  }, [records])
  const name = source.name
  // The enclosing purchase already names the source; the result names the data.
  const resultSource = raw && typeof raw === 'object' && 'source' in raw ? raw.source : null
  const fromDependency = resultSource && typeof resultSource === 'object' && 'endpoint_id' in resultSource
    && typeof resultSource.endpoint_id === 'string' && source.endpoint_id && resultSource.endpoint_id !== source.endpoint_id
  // A lookup returned while financials are pending is not the financials.
  const summary = financial ? 'Annual accounts' : fromDependency ? 'Source result' : sourceSummary(source)
  const document = isRecord(raw) ? raw : {}
  const matchingSource = isRecord(resultSource) && (
    typeof resultSource.endpoint_id === 'string' && resultSource.endpoint_id === source.endpoint_id
    || typeof resultSource.provider === 'string' && resultSource.provider === source.source_slug
  )
  const hasSourceIdentity = isRecord(resultSource) && ['name', 'provider', 'source_slug', 'slug', 'endpoint_id'].some(key => typeof resultSource[key] === 'string' && resultSource[key].trim())
  const hasSourceName = isRecord(resultSource) && ['name', 'provider', 'source_slug', 'slug'].some(key => typeof resultSource[key] === 'string' && resultSource[key].trim())
  const attribution = <AnswerSourceLogos sources={[hasSourceIdentity
    ? { ...resultSource, ...(matchingSource ? { name: resultSource.name ?? source.name, provider: resultSource.provider ?? source.source_slug, logo_url: resultSource.logo_url ?? source.logo_url, url: resultSource.url ?? source.url } : hasSourceName ? {} : { name: 'Source' }) }
    : source]} />
  const subject = isRecord(document.report_subject) ? document.report_subject : isRecord(document.subject) ? document.subject : {}
  const subjectName = typeof subject.name === 'string' ? subject.name : typeof subject.label === 'string' ? subject.label : null
  const retrieved = isRecord(resultSource) && typeof resultSource.retrieved_at === 'string' ? asDate(resultSource.retrieved_at) : null
  const provenance = financial && <p className="text-tiny text-muted">Source: {name}{retrieved && <> · Retrieved {retrieved}</>}</p>
  const coverageNote = typeof document.coverage_note === 'string' ? document.coverage_note.trim() : ''
  const partialNote = <>
    <SourceUsageNotices sources={[resultSource]} />
    {partial && <p className="text-tiny text-muted">This saved result is partial.</p>}
    {coverageNote && <p className="text-tiny text-muted"><ResponseText text={coverageNote} /></p>}
  </>
  const fullData = <details><summary className="cursor-pointer text-tiny text-muted">Full source data</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all text-tiny">{resultJson(raw)}</pre></details>

  if (document.encoding === 'json_text') return <section aria-label="Purchased result" className="answer-content space-y-3">
    {partialNote}
    <SavedSourceResult result={raw} related={[raw]} readPage={readResultPage} />
    {attribution}
  </section>

  if (preview.inline && !financial && !(onSelectRecord && preview.table)) return <section aria-label="Purchased result" className="answer-content space-y-3">
    {partialNote}
    <AnswerBody value={value} />
    {attribution}
    {fullData}
  </section>

  const shown = preview.table?.rows.length ?? 0
  return <section aria-label="Purchased result" className="answer-content space-y-3">
    <div className="min-w-0 space-y-1">
      <h4 className="break-words text-body font-medium">{summary === name ? 'Result' : summary}</h4>
      {financial ? subjectName && <p className="text-body text-muted">{subjectName}</p> : <p className="break-words text-tiny text-muted">{preview.headline}{preview.facts.map(fact => <span key={fact.label}> · {fact.label} {fact.value}</span>)}</p>}
    </div>
    {partialNote}
    {financial && <FinancialStatement statement={financial} compact />}
    {financial && provenance}
    {!financial && preview.table && <ResultTable
      label="Result preview"
      layout="table"
      onSelectRow={onSelectRecord ? choose : undefined}
      selectedRow={selectedIndex}
      columns={preview.table.columns}
      rows={preview.table.rows.map((row, ri) => row.map((value, ci) => <PreviewValue value={value} hints={preview.table?.mediaHints?.[ri]?.[ci]} />))}
    />}
    {onSelectRecord && preview.table && <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-tiny text-muted">Select a record to use in a follow-up.</p><Button type="button" variant="secondary" size="sm" className="rounded-full" disabled={selectedIndex < 0} onClick={useSelected}>Use in follow-up</Button></div>}
    {!financial && preview.fields.length > 0 && <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-body">
      {preview.fields.map(field => <div key={field.label} className="contents"><dt className="text-muted">{field.label}</dt><dd className="min-w-0 [overflow-wrap:anywhere]"><PreviewValue value={field.value} hints={field.mediaHints} /></dd></div>)}
    </dl>}
    {attribution}
    <div className="flex flex-wrap items-center gap-3 text-tiny">
      {!financial && preview.table && shown < preview.table.total && <p className="text-muted">{shown} of {preview.table.total} shown</p>}
      <div className="flex items-center"><Downloads name={name} value={value} raw={raw} csv={preview.csv} /></div>
      <Button type="button" size="xl" variant="primary" className="ml-auto rounded-full" aria-label={`View full answer from ${name}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>View full answer<ArrowUpRight aria-hidden="true" /></Button>
    </div>
    <Dialog open={open} onClose={() => setOpen(false)} draggable label={`${name} result`} panelClassName="sm:max-w-5xl">
      <DialogHeader className="-mx-5 border-b border-border-2 px-5 pb-4">
        <div className="min-w-0 space-y-1"><DialogTitle>{financial ? 'Annual accounts' : name}</DialogTitle><p className="text-tiny text-muted">{financial ? subjectName ?? name : preview.headline}</p></div>
        <Button type="button" size="icon-sm" variant="ghost" className="rounded-full [&_svg]:size-3.5" aria-label="Close result" onClick={() => setOpen(false)}><X aria-hidden="true" /></Button>
      </DialogHeader>
      <DialogBody className="answer-content">
        {partialNote}
        {financial ? <FinancialStatement statement={financial} /> : records.length > 0 && recordColumns.length > 0 ? <div className="space-y-4">
          <p className="text-body text-muted">{onSelectRecord ? 'Select one record to use in your next question or source.' : 'Select a record to view its details.'}</p>
          <ResultTable label="All result records" layout="table" columns={recordColumns.map(label)}
            rows={records.map(record => recordColumns.map(key => <ResultTableContext value={false}><AnswerBody value={record[key]} /></ResultTableContext>))} onSelectRow={choose} selectedRow={selectedIndex} />
          {selectedIndex >= 0 && <details className="rounded-lg border border-border-2 p-4"><summary className="cursor-pointer text-body font-medium">Selected record details</summary><div className="pt-4"><AnswerBody value={records[selectedIndex]} /></div></details>}
        </div> : <AnswerBody value={value} />}
        {provenance}
        {fullData}
      </DialogBody>
      <DialogFooter className="-mx-5 border-t border-border-2 px-5 pt-4"><Downloads name={name} value={value} raw={raw} csv={preview.csv} />{onSelectRecord && <Button type="button" variant="primary" className="ml-auto rounded-full" disabled={selectedIndex < 0} onClick={useSelected}>Use in follow-up</Button>}</DialogFooter>
    </Dialog>
  </section>
}
