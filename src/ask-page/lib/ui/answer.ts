import { resultMedia } from '@/lib/domain/result-media'

/* -----------------------------------------------------------------------------
   Reading JSON as content: the tests the answer reader is made of

   Separated from the component that draws them so they can be tested as the
   rules they are, and so the file with the components in it exports only
   components — which is what keeps hot reload working on it.
   -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Only `http(s)`. A `javascript:` or `data:` string is not something this app
 *  turns into a link inside content a third party returned. */
export function isUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim())
}

export function isImageUrl(value: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(value.trim())
}

/** `2018-04-25T13:06:47.850Z` → `25 Apr 2018`. Anything else → null. */
export function asDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) return null
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return at.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

/** `_created_at` → `Created at`, `sourceImg` → `Source img`. */
export function label(key: string): string {
  const words = key
    .replace(/^_+/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase()
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : key
}

/** `https://news.bitcoin.com/feed/` → `news.bitcoin.com`. The address without
 *  the scheme, which is how a person reads a site. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** JSON for the fallback view, with the unprintable case handled. */
export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null"
  } catch {
    return "// could not be displayed"
  }
}

/* -----------------------------------------------------------------------------
   Plumbing

   A body from one of these endpoints is not all answer. Some of it is the
   answer, and some of it is the machinery that carried the answer here:
   identifiers the caller is meant to quote back, a content type, a schema
   version, a cursor for the next page. An agent needs every byte of that. A
   person who has just paid to know the price of something does not, and shown
   it they read a screen of `_id: "5adfd8..."` before reaching the number.

   So the reader drops it. Not from the response — the raw JSON under the
   answer is the whole body, untouched, and that is the point of keeping it one
   click away rather than replacing it. Only from the view that is trying to be
   an ANSWER.

   The rule is by key name and by emptiness, never by value: a field is
   plumbing because of what it is called, not because of what is in it, and
   guessing from a value is how a reader eventually hides the one number
   somebody came for.
   -------------------------------------------------------------------------- */

/**
 * Keys that are the machine's business.
 *
 * Whole names, matched case- and separator-insensitively, plus the `*_id` /
 * `*_key` / `*_hash` family — `sourceId`, `request_id` and `parentUuid` are
 * all the same field with different spelling, and there is no listing them.
 *
 * `status`, `type`, `state` and `code` are DELIBERATELY ABSENT. They read as
 * plumbing and they are routinely the answer: "status: delayed" is what
 * somebody asked a flight endpoint, and a reader that hid it would be hiding
 * the result while showing the departure time it belongs to.
 */
const NOISE_KEYS = new Set([
  "id",
  "uuid",
  "guid",
  "objectid",
  "key",
  "slug",
  "hash",
  "etag",
  "checksum",
  "signature",
  "nonce",
  "cursor",
  "pagetoken",
  "nextpagetoken",
  // WHICH PAGE OF THE ANSWER THIS IS, which is a fact about the request. The
  // KVK search opens `Pagina 1 · Resultaten per pagina 10` above the company
  // somebody looked up — three rows of the caller's own paging settings read
  // back, before the first word of the result. `resultatenperpagina` is here
  // because a flagship listing in this catalogue answers in Dutch and a key
  // is plumbing in whatever language it is spelled.
  //
  // `total` IS DELIBERATELY ABSENT, and `limit` with it. "How many were
  // there" is routinely the whole question — patents filed, companies
  // matching, rounds raised — and a credit limit is an answer somebody may
  // have paid for. Only the keys that can only ever be paging are here.
  "page",
  "pagenumber",
  "pagina",
  "pagesize",
  "perpage",
  "resultsperpage",
  "resultatenperpagina",
  "offset",
  "hasmore",
  "hasnext",
  "hasnextpage",
  "nextpage",
  "prevpage",
  "previouspage",
  "contenttype",
  "mimetype",
  "charset",
  "encoding",
  "statuscode",
  "httpstatus",
  "requestid",
  "traceid",
  "correlationid",
  "apiversion",
  "schemaversion",
  "typename",
])

/** `_created_at` → `createdat`, `sourceImg` → `sourceimg`. The shape a key
 *  comparison has to be made in, since these arrive in four conventions. */
function flatten(key: string): string {
  return key.replace(/[\s_-]+/g, "").toLowerCase()
}

/**
 * Whether a field is the machinery rather than the answer. See above.
 *
 * THE SUFFIX RULE MATCHES AT A WORD BOUNDARY AND NOWHERE ELSE. Tested against
 * the flattened key it also matches `valid`, `paid`, `hybrid`, `acid`, `grid`
 * and `humid` — six ordinary words ending in the same two letters, any of
 * which could be the answer somebody paid for. `user_id`, `userId` and
 * `user-id` are one field in three conventions and all three have a break
 * before the suffix; a word does not.
 */
export function isNoiseKey(key: string): boolean {
  if (NOISE_KEYS.has(flatten(key))) return true
  const bare = key.replace(/^_+/, "")
  return (
    /[_\-\s](id|ids|uuid|guid|key|hash|token|checksum)$/i.test(bare) ||
    /[a-z0-9](Id|Ids|UUID|Uuid|GUID|Guid|Key|Hash|Token|Checksum)$/.test(bare)
  )
}

/**
 * Whether a value says nothing at all.
 *
 * An absent field, a blank string, an empty list and an empty object are four
 * spellings of "there was nothing here", and a reader that prints all four
 * prints rows saying nothing under a heading that promised something.
 */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true
  // Binary values have no enumerable fields, but the bytes are the answer.
  if (typeof Blob !== 'undefined' && value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return false
  if (typeof value === "string") return value.trim() === ""
  if (Array.isArray(value)) return value.length === 0
  if (isRecord(value)) return Object.keys(value).length === 0
  return false
}

/**
 * The keys a HAL-style link object is made of.
 *
 * `{ "href": "https://api.kvk.nl/api/v2/zoeken?naam=…", "rel": "self" }` is
 * the request that was just made, handed back as a field of the answer. It is
 * the only rule here decided BY SHAPE rather than by key name, and it has to
 * be: `links` is a perfectly good answer — a list of articles, a set of
 * downloads — and hiding every key called `links` would delete it. What is
 * never an answer is the machine's own address for the call, so that is what
 * is matched: an object that carries an `href` and says nothing else.
 */
const LINK_OBJECT_KEYS = new Set([
  "href",
  "rel",
  "type",
  "title",
  "name",
  "method",
  "templated",
  "hreflang",
  "profile",
  "deprecation",
])

function isLinkObject(value: unknown): boolean {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).map(flatten)
  return keys.includes("href") && keys.every((key) => LINK_OBJECT_KEYS.has(key))
}

/**
 * Whether a field is a body's navigation rather than its answer.
 *
 * The KVK search answers `{ links: [{ href: "…&pagina=1", rel: "self" }],
 * resultaten: [...] }`, and the reader drew LINKS · 1 result · Href · Rel ·
 * self above the companies somebody had paid to find. That block is the URL
 * the app had just called, spelled out — it tells a reader nothing they can
 * act on and it sits between them and the answer.
 *
 * Matched under any of the three spellings these arrive in: a single link
 * object, an array of them, or a map of rel name to link object.
 */
export function isLinkPlumbing(value: unknown): boolean {
  // A typed attachment can use exactly the same shape as a navigation link.
  // Keep its MIME/type hints attached until the media renderer has read them.
  if (resultMedia(value)) return false
  if (isLinkObject(value)) return true
  if (Array.isArray(value)) return value.length > 0 && value.every(isLinkObject)
  if (isRecord(value)) {
    const values = Object.values(value)
    return values.length > 0 && values.every((inner) => isLinkPlumbing(inner))
  }
  return false
}

/**
 * One object with the plumbing taken out — AND NEVER EMPTIED.
 *
 * The last clause is the whole reason this is a function rather than a filter
 * written at the call site. A record of nothing but identifiers is a real
 * shape: a "related ids" list, a join table, an endpoint that answers with
 * keys to fetch next. Filtered to the rules above it becomes `{}`, and a
 * reader that draws nothing for it has not simplified the answer, it has
 * deleted it. So a filter that removes everything is not applied: the record
 * is drawn whole, ids and all, because in that record the ids ARE the answer.
 */
export function withoutPlumbing(
  record: Record<string, unknown>,
): Record<string, unknown> {
  if (resultMedia(record)) return record
  const kept = Object.entries(record).filter(
    ([key, value]) =>
      !isNoiseKey(key) && !isEmptyValue(value) && !isLinkPlumbing(value),
  )
  return kept.length ? Object.fromEntries(kept) : record
}

/**
 * Keys that are a wrapper around the answer rather than a part of it.
 *
 * `{ data: [...] }`, `{ results: { ... } }`, `{ response: { payload: [...] } }`
 * — the body of nearly every one of these endpoints is the answer inside one
 * or two of these, and the reader was printing "DATA" as a heading over it. A
 * heading naming the envelope is a title that tells the reader nothing except
 * that they are looking at a machine's idea of an answer.
 */
const ENVELOPE_KEYS = new Set([
  "data",
  "result",
  "results",
  "response",
  "payload",
  "body",
  "content",
  "items",
  "records",
  "rows",
  "list",
  "output",
  "value",
  "values",
  // A body that is nothing but its field list. KVK's annual accounts arrive
  // as `{ opendataFields: [ …pairs… ] }` and the reader drew OPENDATA FIELDS
  // as a heading over the whole answer — the envelope's name, again.
  "fields",
  "opendatafields",
])

/**
 * The answer inside its envelopes.
 *
 * Peeled only while the object has EXACTLY ONE meaningful key and that key is
 * an envelope name. Both halves matter: `{ data: [...], meta: {...} }` is not
 * an envelope, it is an answer with a note attached, and unwrapping it would
 * throw the note away. Plumbing does not count towards "one key", so
 * `{ requestId, data }` unwraps and `{ data, total }` does not.
 *
 * Bounded, because a body is a third party's and a cycle in it is not this
 * function's to discover the hard way.
 */
export function unwrapEnvelope(value: unknown, limit = 4): unknown {
  let current = value
  for (let i = 0; i < limit; i++) {
    if (resultMedia(current)) return current
    if (!isRecord(current)) return current
    const entries = Object.entries(current).filter(
      ([key, inner]) =>
        !isNoiseKey(key) && !isEmptyValue(inner) && !isLinkPlumbing(inner),
    )
    if (entries.length !== 1) return current
    const [key, inner] = entries[0]
    if (!ENVELOPE_KEYS.has(flatten(key))) return current
    current = inner
  }
  return current
}

/* -----------------------------------------------------------------------------
   Pairs

   Some providers write a record as a LIST: `[{ key: "FinancialYear", value:
   "2024" }, { key: "BalanceSheet", opendataFields: [ … ] }]`. KVK's annual
   accounts arrive exactly so — a tree of key/value pairs, nested through a
   field that is itself a list of pairs, and the balance sheet somebody paid
   for is four levels of it.

   Read as a list of records, every pair was drawn as a record whose one named
   field, `key`, is plumbing (see NOISE_KEYS), so the reader printed "Value
   2024", "Value 123456", "Value 65432" down the page with nothing saying
   which was the year, which the assets and which the equity: the names had
   been thrown away as identifiers. They are not identifiers. They are the
   field names, and the whole list is one record.
   -------------------------------------------------------------------------- */

/** The field a pair keeps its name in, and the one it keeps its value in. */
const PAIR_KEY_FIELDS = new Set(["key", "name", "field"])
const PAIR_VALUE_FIELDS = new Set(["value", "val"])

/**
 * A list of pairs as the record it spells out, or null where it is a list.
 *
 * EVERY item has to be a pair, and a pair is a narrow thing: a record with a
 * string under `key` (or `name`, or `field`), a `value` and/or exactly one
 * list of pairs under any other name — the children — and NOTHING ELSE. One
 * item with an `id` beside its `name`, or with no value and no children, and
 * the list is a list of records and is drawn as one. Being wrong that way
 * keeps today's reading; being wrong the other way would fold a list of
 * people called `name` into an object keyed by their first names.
 *
 * A repeated key collects its values into a list rather than losing all but
 * the last: two `SbiBusinessCode` pairs are two codes.
 */
export function pairsToRecord(items: unknown[]): Record<string, unknown> | null {
  if (items.length === 0) return null
  const held = new Map<string, unknown[]>()
  for (const item of items) {
    const pair = readPair(item)
    if (!pair) return null
    const [key, value] = pair
    const values = held.get(key)
    if (values) values.push(value)
    else held.set(key, [value])
  }
  const out: Record<string, unknown> = {}
  for (const [key, values] of held) out[key] = values.length === 1 ? values[0] : values
  return out
}

/** One pair, as `[name, what it holds]` — or null where the item is not one. */
function readPair(item: unknown): [string, unknown] | null {
  if (!isRecord(item)) return null
  let key: string | null = null
  let value: unknown = undefined
  let hasValue = false
  let children: unknown[] | null = null
  for (const [name, inner] of Object.entries(item)) {
    const flat = flatten(name)
    if (key === null && PAIR_KEY_FIELDS.has(flat) && typeof inner === "string") {
      key = inner.trim()
      continue
    }
    if (!hasValue && PAIR_VALUE_FIELDS.has(flat)) {
      value = inner
      hasValue = true
      continue
    }
    if (children === null && Array.isArray(inner)) {
      children = inner
      continue
    }
    return null
  }
  if (!key || (!hasValue && children === null)) return null

  if (children !== null && children.length > 0) {
    // A branch. Its children have to be pairs too, or this is not a tree of
    // them — it is a record with a name and a list in it.
    const nested = pairsToRecord(children)
    if (nested === null) return null
    return [key, nested]
  }
  // A leaf, or an empty branch, which says nothing either way.
  return [key, hasValue ? value : null]
}

/* -----------------------------------------------------------------------------
   Prose

   A provider that answers with a paragraph, a summary, an article or a set of
   instructions is answering with WRITING, and writing set in the right-hand
   column of a two-column key/value grid is writing nobody reads. These two
   decide which strings are that, and what shape the writing is in.
   -------------------------------------------------------------------------- */

/**
 * Long enough, or structured enough, to be read rather than scanned.
 *
 * A field is prose when it has a line break in it — nothing that fits on one
 * line was written with a newline in it by accident — or when it is longer
 * than fits comfortably beside a label. 180 characters is about two lines at
 * the width the value column actually gets, which is where a value stops being
 * a value and starts being a paragraph in a box too narrow for it.
 */
export function isProse(value: string): boolean {
  const text = value.trim()
  if (!text) return false
  // A URL is a link however long it is, and a link is not prose.
  if (isUrl(text)) return false
  return text.includes("\n") || text.length > 180
}

export type Block =
  | { kind: "heading"; text: string; level: number }
  | { kind: "paragraph"; text: string }
  | { kind: "bullets"; items: string[] }
  | { kind: "numbers"; items: string[] }

/**
 * A string, as the blocks it is written in.
 *
 * Markdown-shaped, because that is what these endpoints actually return — a
 * `summary` field with `## Findings` and three `- ` lines in it is common
 * enough that printing the hyphens is a visible failure to read what was sent.
 * Four block kinds and no inline parsing: headings, paragraphs, bullets and
 * numbered lists are the structure, and `**bold**` is a decoration. Guessing at
 * decoration means guessing wrong on a provider that meant the asterisks.
 *
 * A paragraph keeps its own line breaks rather than being reflowed. An address,
 * a stack trace and a poem are all paragraphs by this rule and all three are
 * ruined by joining their lines; a blank line is the only break that starts a
 * new block, which is the convention every one of these providers is writing
 * to anyway.
 */
export function readBlocks(text: string): Block[] {
  const blocks: Block[] = []
  const lines = text.replace(/\r\n?/g, "\n").split("\n")

  let paragraph: string[] = []
  let items: string[] = []
  let listKind: "bullets" | "numbers" | null = null

  const endParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") })
    paragraph = []
  }
  const endList = () => {
    if (listKind && items.length) blocks.push({ kind: listKind, items })
    items = []
    listKind = null
  }
  const end = () => {
    endParagraph()
    endList()
  }

  for (const line of lines) {
    if (!line.trim()) {
      end()
      continue
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      end()
      blocks.push({
        kind: "heading",
        text: heading[2],
        // Clamped to three: a document with an `<h5>` in a 320px panel is a
        // heading indistinguishable from the text under it.
        level: Math.min(heading[1].length, 3),
      })
      continue
    }

    const bullet = /^ {0,3}[-*•]\s+(.+)$/.exec(line)
    if (bullet) {
      endParagraph()
      if (listKind !== "bullets") endList()
      listKind = "bullets"
      items.push(bullet[1].trim())
      continue
    }

    const numbered = /^ {0,3}\d{1,3}[.)]\s+(.+)$/.exec(line)
    if (numbered) {
      endParagraph()
      if (listKind !== "numbers") endList()
      listKind = "numbers"
      items.push(numbered[1].trim())
      continue
    }

    // An ordinary line. It continues a paragraph, and it ENDS a list — a
    // provider that wrapped one long bullet onto a second line is rarer than
    // one that followed a list with a closing sentence, and the second reads
    // wrong as a bullet where the first only reads as two.
    endList()
    paragraph.push(line.trimEnd())
  }

  end()
  return blocks
}
