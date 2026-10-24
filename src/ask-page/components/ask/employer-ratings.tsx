import type { SavedEmployerRatings } from '@/lib/domain/saved-employer-ratings'

export function EmployerRatings({ employer, locale }: { employer: SavedEmployerRatings; locale: string }) {
  const nl = locale === 'nl-NL'
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 })
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 })
  const label = (item: { en: string; nl: string }) => nl ? item.nl : item.en
  const sorted = [...employer.categories].sort((a, b) => b.score - a.score)
  const highest = sorted.filter(item => item.score === sorted[0]?.score)
  const lowest = sorted.filter(item => item.score === sorted.at(-1)?.score)
  const date = employer.retrievedAt ? new Date(employer.retrievedAt) : null
  return <section aria-label={`${employer.name} · Glassdoor`} className="min-w-0 space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="font-medium">{employer.name} · Glassdoor</h3>
      <p className="text-body tabular-nums">
        {employer.rating !== null && <strong className="text-large">{number.format(employer.rating)}</strong>}
        {employer.reviewCount !== null && <span className="ml-2 text-muted">{new Intl.NumberFormat(locale).format(employer.reviewCount)} reviews</span>}
      </p>
    </div>
    {sorted.length > 0 && <table className="w-full text-body" aria-label={nl ? 'Beoordelingen per onderdeel' : 'Employer rating breakdown'}>
      <thead><tr className="border-b border-border-2 text-left text-tiny text-muted"><th className="pb-2 font-medium">{nl ? 'Onderdeel' : 'Category'}</th><th className="pb-2 text-right font-medium">{nl ? 'Score' : 'Rating'}</th></tr></thead>
      <tbody>{sorted.map(item => <tr key={item.field} className="border-b border-border-2 last:border-0"><td className="py-2 pr-3">{label(item)}</td><td className="py-2 text-right tabular-nums">{number.format(item.score)}</td></tr>)}</tbody>
    </table>}
    {highest.length > 0 && lowest.length > 0 && highest[0].score > lowest[0].score && <p className="text-body">
      {nl ? 'Binnen de gerapporteerde onderdelen scoort ' : 'Among the reported categories, '}{highest.map(label).join(', ')}{nl ? ' het hoogst' : ' scores highest'} ({number.format(highest[0].score)}), {nl ? 'en ' : 'while '}{lowest.map(label).join(', ')}{nl ? ' het laagst' : ' scores lowest'} ({number.format(lowest[0].score)}).
    </p>}
    {employer.indicators.length > 0 && <dl className="flex flex-wrap gap-x-6 gap-y-3">{employer.indicators.map(item => <div key={item.field}><dt className="text-tiny text-muted">{label(item)}</dt><dd className="mt-1 font-medium tabular-nums">{percent.format(item.fraction)}</dd></div>)}</dl>}
    <p className="text-tiny text-muted">{nl ? 'Dit zijn beoordelingen van de werkgever als geheel, geen klantscores voor afzonderlijke vestigingen.' : 'These are employer-wide ratings, not customer scores for individual locations.'}</p>
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-tiny">
      {employer.profileUrl && <a href={employer.profileUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{nl ? 'Glassdoor-bedrijfsprofiel' : 'Glassdoor company profile'} ↗</a>}
      {employer.reviewsUrl && <a href={employer.reviewsUrl} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{nl ? 'Lees de reviews' : 'Read the reviews'} ↗</a>}
      {date && Number.isFinite(date.getTime()) && <span className="text-muted">{nl ? 'Opgehaald op ' : 'Retrieved '}{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date)}</span>}
    </div>
  </section>
}
