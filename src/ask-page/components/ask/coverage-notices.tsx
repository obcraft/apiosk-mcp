/** Coverage is part of the offer and must remain visible before approval. */
export function GatewayV2CoverageNotices({ notices }: { notices?: string[] }) {
  const scopeNotes = [...new Set((Array.isArray(notices) ? notices : []).filter(note => typeof note === 'string' && note.trim()))]
  if (!scopeNotes.length) return null
  return <section aria-label="Scope of this request" className="space-y-2 text-body">
    <h3 className="font-medium">Scope of this request</h3>
    <ul className="list-disc space-y-1.5 pl-5 text-muted">{scopeNotes.map(note => <li key={note}>{note}</li>)}</ul>
  </section>
}
