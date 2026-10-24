import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { appendSavedResultPage, initialSavedResultPages, savedResultLimit, type ReadSavedResultPage } from '@/lib/domain/saved-result-pages'
import { GatewayV2Result, type ResultChargeAllocation } from './gateway-v2-result'

type SavedSourceResultProps = { result: unknown; related: unknown[]; readPage?: ReadSavedResultPage; chargeAllocation?: ResultChargeAllocation }
type SavedDocument = Record<string, unknown>
type CompletedRead = { document: SavedDocument; baseline: SavedDocument }

// A render may clone the same envelope. Only a changed value is a new snapshot.
const snapshot = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item)
const metadata = (value: unknown): SavedDocument => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !['data', 'preview_data', 'encoding', 'text', 'next_offset'].includes(key))) : {}

/** A later task snapshot can correct metadata without discarding a read body.
 * Unchanged compact fields must not overwrite newer values learned by reading. */
function refreshedDocument(saved: CompletedRead, result: unknown): SavedDocument {
  const current = metadata(result), displayed = { ...saved.document }
  for (const key of new Set([...Object.keys(saved.baseline), ...Object.keys(current)])) {
    if (snapshot(saved.baseline[key]) === snapshot(current[key]) && Object.hasOwn(saved.baseline, key) === Object.hasOwn(current, key)) continue
    if (Object.hasOwn(current, key)) displayed[key] = current[key]
    else delete displayed[key]
  }
  return displayed
}

export function SavedSourceResult({ result, related, readPage, chargeAllocation }: SavedSourceResultProps) {
  const initial = initialSavedResultPages(result)
  return initial ? <SavedSourceResultBody key={initial.resultRef} result={result} related={related} readPage={readPage} chargeAllocation={chargeAllocation} />
    : <div className="space-y-3"><GatewayV2Result result={result} related={related} chargeAllocation={chargeAllocation} /></div>
}

function SavedSourceResultBody({ result, related, readPage, chargeAllocation }: SavedSourceResultProps) {
  const [completed, setCompleted] = useState<CompletedRead | null>(() => {
    const document = initialSavedResultPages(result)?.complete
    return document ? { document, baseline: metadata(result) } : null
  })
  if (completed) return <div className="space-y-3">
    <GatewayV2Result result={refreshedDocument(completed, result)} related={related} chargeAllocation={chargeAllocation} />
  </div>
  // Offset slices belong to one serialized envelope. A refreshed first page
  // remounts the reader, cancelling its old request before any more is appended.
  return <SavedSourceResultReader key={snapshot(result)} result={result} related={related} readPage={readPage} chargeAllocation={chargeAllocation}
    onComplete={document => setCompleted({ document, baseline: metadata(result) })} />
}

function SavedSourceResultReader({ result, related, readPage, chargeAllocation, onComplete }: SavedSourceResultProps & { onComplete: (document: SavedDocument) => void }) {
  const [pages, setPages] = useState(() => initialSavedResultPages(result))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const active = useRef<AbortController | null>(null)
  useEffect(() => () => { active.current?.abort(); active.current = null }, [])
  async function readNext() {
    if (!pages || pages.complete || savedResultLimit(pages) || !readPage || active.current) return
    const controller = new AbortController()
    active.current = controller; setBusy(true); setError('')
    try {
      let accumulated = pages
      while (!accumulated.complete && !savedResultLimit(accumulated)) {
        const page = await readPage(accumulated.resultRef, accumulated.offset, controller.signal)
        if (controller.signal.aborted || active.current !== controller) return
        accumulated = appendSavedResultPage(accumulated, page, accumulated.offset)
        if (accumulated.complete) { onComplete(accumulated.complete); return }
        setPages(accumulated)
      }
    } catch (cause) {
      if (!controller.signal.aborted && active.current === controller) setError(cause instanceof Error ? cause.message : 'The saved result could not be read. Try again.')
    } finally {
      if (active.current === controller) { active.current = null; setBusy(false) }
    }
  }
  function cancelRead() { active.current?.abort(); active.current = null; setBusy(false) }
  const displayed = pages?.complete ?? (pages?.text ? { ...(result as Record<string, unknown>), text: pages.text } : result)
  return <div className="space-y-3">
    <GatewayV2Result result={displayed} related={related} chargeAllocation={chargeAllocation} />
    {pages && !pages.complete && readPage && <div className="space-y-2" aria-label="Saved result pages">
      <p className="text-tiny text-muted">{pages.pages} saved {pages.pages === 1 ? 'part' : 'parts'} loaded. The full table appears when all parts are loaded. Reading saved data does not buy it again.</p>
      {savedResultLimit(pages) ? <p role="status" className="text-body">This result reached the display limit. The loaded source data remains available above.</p> : <div className="flex gap-2">
        <Button disabled={busy} onClick={() => void readNext()}>{busy ? 'Reading saved result…' : error ? 'Retry loading saved result' : 'Load full saved result'}</Button>
        {busy && <Button variant="ghost" onClick={cancelRead}>Cancel reading</Button>}
      </div>}
      {error && <p role="alert" className="text-body">{error}</p>}
    </div>}
  </div>
}
