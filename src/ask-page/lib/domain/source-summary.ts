import { purchaseInputKey, sourceRef, type PurchaseSource } from './ask-v2-purchase'

/**
 * What an endpoint does, in one line, for the rows and results that would
 * otherwise repeat its source's name: several endpoints of one source (PDOK,
 * Sirenic) read apart by this line, and the name goes beside it.
 *
 * The first clause of the description, cut at " — ", ";" or the end of its
 * first sentence, without trailing punctuation. A description that says no
 * more than the name gives way to the capability in words
 * (`area.cbs-neighbourhood-2025` → "CBS neighbourhood 2025").
 */
const LIMIT = 90
/** Written in capitals wherever a capability names them. */
const ACRONYMS = new Set(['api', 'bag', 'cbs', 'de', 'eu', 'fr', 'gb', 'iban', 'id', 'kvk', 'lei', 'nl', 'pdok', 'ted', 'uk', 'us', 'vat', 'xbrl'])
const trailing = /[\s.,;:!?…—–-]+$/

/** A capability slug in words; a `domain.detail` slug leaves its domain out when the detail still reads as a phrase. */
export function capabilityWords(slug: string | null | undefined): string {
  const segments = (slug ?? '').toLowerCase().split('.').filter(Boolean)
  const words = (list: string[]) => list.flatMap(segment => segment.split(/[-_\s]+/)).filter(Boolean)
  const detail = words(segments.slice(1))
  const chosen = segments.length === 2 && detail.length > 1 ? detail : words(segments)
  return chosen.map((word, index) => ACRONYMS.has(word) ? word.toUpperCase() : index === 0 ? word[0].toUpperCase() + word.slice(1) : word).join(' ')
}

export function sourceSummary(source: Pick<PurchaseSource, 'name' | 'description' | 'capability'>): string {
  const flat = (source.description ?? '').replace(/\s+/g, ' ').trim()
  let line = flat.split(/ [—–] |;|\.\s+(?=[A-Z0-9])/)[0].replace(trailing, '')
  if (line.length > LIMIT) {
    const cut = line.slice(0, LIMIT)
    line = `${(cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : cut).replace(trailing, '')}…`
  }
  // Nothing beyond the name (or a single word): the capability says more.
  const says = line.split(' ').length > 1 && line.toLowerCase() !== source.name.trim().toLowerCase()
  return says ? line : capabilityWords(source.capability) || line || source.name
}

/** A selection must have a purchase route; external routes must be admitted by the gateway. */
export function purchasableSource(source: PurchaseSource): boolean {
  return Boolean(sourceRef(source)) && (source.origin === 'apiosk' || source.availability === 'supported')
}

/** Keep usable calls first, including external offers already admitted by the gateway. */
export function availableSourcesFirst<T extends { source: PurchaseSource }>(items: T[]): T[] {
  const rank = (source: PurchaseSource) => purchasableSource(source) ? source.origin === 'apiosk' ? 0 : 1 : 2
  return [...items].sort((left, right) => rank(left.source) - rank(right.source))
}

/**
 * Rows that would read the same, from one source at one price, shown once:
 * the first stays, with its key. Endpoints that differ in what they do or in
 * price stay apart.
 */
export function distinctSources<T extends { source: PurchaseSource }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(({ source }) => {
    const id = JSON.stringify([source.origin, source.source_slug ?? source.name, sourceSummary(source), source.price, source.capability, source.subject_id, purchaseInputKey(source)])
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}
