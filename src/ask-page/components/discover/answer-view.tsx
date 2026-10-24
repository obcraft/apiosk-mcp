import { displayData } from "@/lib/ui/display-text"
import { useContext, useState } from "react"

import {
  asDate,
  isProse,
  isRecord,
  isUrl,
  label,
  pairsToRecord,
  readBlocks,
  unwrapEnvelope,
  withoutPlumbing,
} from "@/lib/ui/answer"
import { LinkPreviewCard } from '@/components/response/link-preview'
import { ResponseText } from '@/components/response/response-text'
import { ResultTable } from '@/components/response/result-table'
import { ResultTableContext } from '@/components/response/result-table-context'
import { resultMedia, resultMediaHints, type ResultMediaHints } from '@/lib/domain/result-media'
import { ResultMediaView } from '@/components/response/result-media'

/**
 * The answer a call came back with, read as content rather than as JSON.
 *
 * ---------------------------------------------------------------------------
 * Why a reader at all
 * ---------------------------------------------------------------------------
 *
 * What this replaces is a `<pre>` of pretty-printed JSON in a 256px box. For
 * the answer this product actually returns — a call to a news-sources endpoint
 * comes back with a hundred and eighty records, each with a name, a site, a
 * feed and a logo — that is four screens of punctuation with the answer spread
 * through it, and the person reading it has just paid for it.
 *
 * So the same value is drawn as what it is: a list of records becomes a list
 * of rows with the record's own name at the top, its picture beside it and its
 * links live. Nothing is summarised, nothing is dropped, and the raw JSON is
 * one toggle away — this is a second view of the same text, never a
 * replacement for it. An agent's answer is data; a person's answer is a page.
 *
 * ---------------------------------------------------------------------------
 * The rules, and they are only these
 * ---------------------------------------------------------------------------
 *
 * Every endpoint in this catalogue answers in its own shape, and there is no
 * schema for what comes back, so this cannot be a renderer per provider. It is
 * a handful of rules about JSON itself:
 *
 *   - an array of objects is a LIST OF RECORDS, and gets one block each;
 *   - inside a record, a name-shaped key is its heading and an image URL is
 *     its picture — both by key name, and only when the value really is one;
 *   - a URL is a link, always, and an image URL under an image-shaped key is
 *     shown;
 *   - an ISO timestamp is written as a date somebody can read;
 *   - anything nested deeper than a few levels stops being prose and is
 *     printed as its own JSON rather than flattened into nonsense.
 *
 * What it never does is guess at meaning. No field is renamed beyond
 * un-camel-casing it, no record is scored, nothing is reordered, and a shape
 * these rules do not fit falls back to JSON rather than being forced.
 */

/** How many records are drawn before the list offers to draw the rest. */
const FIRST_PAGE = 20

/**
 * How far down a body is drawn before it is summarised.
 *
 * IT USED TO BE 3, and three is shallower than the answers this catalogue
 * actually returns. A KVK company sits at `resultaten[] → adres → binnenland`,
 * which is depth four, so the street somebody paid to look up was replaced by
 * the words "1 more field". A cap this reader hits on an ordinary answer is
 * not a safety valve, it is a hole in the middle of the result.
 */
const MAX_DEPTH = 8

export function AnswerBody({ value }: { value: unknown }) {
  const media = resultMedia(value)
  if (media) return <div className="answer-content min-w-0"><ResultMediaView media={media} /></div>
  // The answer, out of whatever the endpoint wrapped it in. `{ data: [...] }`
  // is the shape of nearly every body here, and the reader was drawing a
  // heading that said DATA over it — a title naming the envelope, which tells
  // a reader nothing except that a machine packed this. See `unwrapEnvelope`.
  const body = unwrapEnvelope(displayData(value))
  // OData separates records from pagination/schema metadata. Keep both available
  // without wrapping every observation inside the response envelope.
  if (isRecord(body) && Array.isArray(body.value) && Object.keys(body).some(key => key.startsWith("@odata."))) {
    const {value: records, ...metadata} = body
    return <div className="answer-content min-w-0 space-y-3">
      <Node value={records} depth={0}/>
      <details className="border-t border-border pt-2 text-tiny text-muted">
        <summary className="cursor-pointer">Source metadata</summary>
        <div className="pt-3"><Fields record={metadata} depth={0}/></div>
      </details>
    </div>
  }
  return <div className="answer-content"><Node value={body} depth={0} /></div>
}

function Node({ value, depth, hints }: { value: unknown; depth: number; hints?: ResultMediaHints }) {
  const media = resultMedia(value, hints)
  if (media) return <ResultMediaView media={media} />
  if (value === null || value === undefined) {
    return <Muted>null</Muted>
  }

  // A top-level string that is writing gets read as writing. `Scalar` still
  // handles the rest — a link, a date, a word — and a prose string never
  // reaches it.
  if (typeof value === "string") {
    return isProse(value) ? <Prose text={value} /> : <Scalar value={value} />
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="tabular-nums text-foreground">{String(value)}</span>
  }

  if (Array.isArray(value)) return <List items={value} depth={depth} hints={hints} />
  if (isRecord(value)) return <Fields record={value} depth={depth} />

  // A function, a symbol, a bigint — nothing JSON can hold, so nothing that
  // reaches here from a parsed body. Named rather than printed, because THE
  // READER NEVER SHOWS JSON: the whole body is under it, in one place, behind
  // one link, and a second copy leaking through the readable view is what made
  // the two views indistinguishable.
  return <Muted>not shown</Muted>
}

/* -----------------------------------------------------------------------------
   Lists
   -------------------------------------------------------------------------- */

function List({ items, depth, hints }: { items: unknown[]; depth: number; hints?: ResultMediaHints }) {
  const [all, setAll] = useState(false)

  if (items.length === 0) return <Muted>Empty list.</Muted>

  // A record written as a list of `{ key, value }` pairs is a record, and is
  // drawn as its fields rather than as a column of rows each saying "Value".
  // See `pairsToRecord` for the shape, and for why it is read narrowly.
  const spelled = pairsToRecord(items)
  if (spelled) return <Fields record={spelled} depth={depth} />

  const scalars = items.every((item) => !isRecord(item) && !Array.isArray(item))

  // A list of SENTENCES is a list, not a row of chips. Findings, steps,
  // headlines and recommendations all arrive as an array of strings, and set
  // as chips they were a paragraph chopped into boxes with borders through the
  // middle of it. One long item is enough to decide it for the whole list:
  // a mixed list read as chips is the same failure on a subset.
  if (scalars && items.some((item) => typeof item === "string" && isProse(item))) {
    return (
      <ul className="max-w-[68ch] space-y-1">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2 text-body text-foreground">
            <span aria-hidden="true" className="select-none text-faint">
              •
            </span>
            {/* The string directly, not through `Node` — a prose string
                there renders a block element, and a <div> inside this <span>
                is markup a browser is entitled to rearrange. */}
            {typeof item === "string" ? (
              <span className="min-w-0 flex-1 whitespace-pre-wrap"><ResponseText text={item} /></span>
            ) : (
              <span className="min-w-0">
                <Node value={item} depth={depth + 1} />
              </span>
            )}
          </li>
        ))}
      </ul>
    )
  }

  // A list of names, numbers or ids reads as a line of text, not as twenty
  // boxes with one word in each.
  if (scalars) {
    return (
      <ul className="flex flex-wrap gap-1.5">
        {items.map((item, index) => (
          <li
            key={index}
            className="text-body text-foreground after:content-[','] last:after:content-none"
          >
            <Node value={item} depth={depth + 1} hints={hints} />
          </li>
        ))}
      </ul>
    )
  }

  const shown = all ? items : items.slice(0, FIRST_PAGE)
  const rest = items.length - shown.length
  const columns = tableColumns(items)
  const hasMeasures = columns?.some(key =>
    !/(?:^|\s)(?:id|identifier|code|year|number)$/i.test(label(key))
    && items.some(item => typeof (item as Record<string, unknown>)[key] === 'number'),
  )

  if (columns) return <div className="min-w-0 space-y-2">
    <p className="text-tiny text-muted">{items.length} results</p>
    <ResultTable
      label="Result records"
      columns={columns.map(label)}
      layout={hasMeasures || columns.length <= 2 ? 'table' : 'records'}
      rows={shown.map(item => columns.map(key => <Node value={(item as Record<string, unknown>)[key]} depth={depth + 1} hints={resultMediaHints(item as Record<string, unknown>, key)} />))}
    />
    {rest > 0 && <button type="button" onClick={() => setAll(true)} className="text-tiny text-accent hover:underline">Show {rest} more</button>}
  </div>

  return (
    <div className="space-y-2">
      <p className="text-tiny text-faint">
        {items.length} {items.length === 1 ? "result" : "results"}
      </p>

      <ol className="divide-y divide-border">
        {shown.map((item, index) => (
          <li
            key={index}
            className="py-3 first:pt-0 last:pb-0"
          >
            {isRecord(item) ? (
              <Record record={item} depth={depth + 1} />
            ) : (
              <Node value={item} depth={depth + 1} />
            )}
          </li>
        ))}
      </ol>

      {rest > 0 ? (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="text-tiny text-muted transition-colors duration-150 hover:text-foreground"
        >
          Show {rest} more
        </button>
      ) : null}
    </div>
  )
}

/** Tabulate uniform short records; keep rich content and mixed shapes as rows. */
function tableColumns(items: unknown[]): string[] | null {
  if (items.length < 2 || !items.every(isRecord)) return null
  const columns = Object.keys(items[0])
  if (!columns.length || columns.length > 10 || columns.some(key => NAME_KEYS.includes(key.toLowerCase()) || IMAGE_KEYS.includes(key.toLowerCase()))) return null
  const eligible = items.every(item => {
    const record = item
    return Object.keys(record).length === columns.length && columns.every(key =>
      Object.hasOwn(record, key) && !isRecord(record[key]) && !Array.isArray(record[key]) &&
      !(typeof record[key] === "string" && isProse(record[key] as string)),
    )
  })
  return eligible ? columns : null
}

/* -----------------------------------------------------------------------------
   One record
   -------------------------------------------------------------------------- */

/** Keys that name a thing, best first. The heading of a record, when present. */
const NAME_KEYS = [
  "sourcename",
  "name",
  "title",
  "headline",
  "label",
  "provider",
  "symbol",
]

/* `id` USED TO BE THE LAST ENTRY HERE, as a heading of last resort, and it is
   the single worst thing the reader did: a record with no name got
   `5adfd8e5f9a3c1b40e6d2f77` set as a title in medium-weight heading type, and
   a list of forty of them was forty rows led by a hex string. A record with
   nothing human in it has no heading — the fields under it are the whole of
   what it says, and they say it better without a checksum over the top. */

/** Keys whose value, when it is a URL, is a picture of the thing. */
const IMAGE_KEYS = ["sourceimg", "image", "img", "logo", "icon", "avatar", "thumbnail", "picture"]

/** Keys that link to the thing itself rather than describing it. */
const LINK_KEYS = ["weburl", "url", "link", "href", "website", "site"]

function Record({ record, depth }: { record: Record<string, unknown>; depth: number }) {
  const media = resultMedia(record)
  if (media) return <ResultMediaView media={media} />
  // The machinery out, before anything is chosen off it — so an `_id` cannot
  // be picked as a heading and a `content_type` cannot take a row in the grid.
  // `withoutPlumbing` declines to empty a record, so one made only of
  // identifiers still draws whole: there, the identifiers are the answer.
  const entries = Object.entries(withoutPlumbing(record))

  const nameKey = entries.find(
    ([key, value]) => typeof value === "string" && NAME_KEYS.includes(key.toLowerCase()),
  )
  const linkKey = entries.find(
    ([key, value]) =>
      typeof value === "string" && LINK_KEYS.includes(key.toLowerCase()) && isUrl(value),
  )

  // Everything the heading did not already say. The picture and the heading
  // are drawn once, at the top; repeating them in the field list underneath is
  // the same fact twice.
  const rest = entries.filter(
    ([key]) => key !== nameKey?.[0] && key !== linkKey?.[0],
  )
  const mime = record.mime_type ?? record.mimeType ?? record.content_type ?? record.contentType ?? record.media_type ?? record.mediaType
  const linkedMedia = linkKey ? resultMedia(linkKey[1], resultMediaHints(record, linkKey[0])) : null

  return (
    <div className="space-y-2">
      {!linkKey && nameKey ? (
        <div className="flex items-center gap-2.5">
          <div className="min-w-0">
            {nameKey ? (
              <p className="truncate text-body font-medium text-heading">
                {nameKey[1] as string}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {linkedMedia ? <ResultMediaView media={linkedMedia} /> : linkKey && <LinkPreviewCard href={linkKey[1] as string} title={nameKey?.[1] as string | undefined} />}
      {rest.length ? <Fields record={{ ...Object.fromEntries(rest), ...(mime ? { mime_type: mime } : {}) }} depth={depth} /> : null}
    </div>
  )
}

/* -----------------------------------------------------------------------------
   Key/value rows
   -------------------------------------------------------------------------- */

function Fields({
  record,
  depth,
}: {
  record: Record<string, unknown>
  depth: number
}) {
  const descriptor = resultMedia(record)
  if (descriptor) return <ResultMediaView media={descriptor} />
  const allEntries = Object.entries(withoutPlumbing(record))
  const mediaEntries = allEntries.flatMap(([key, value]) => {
    const media = resultMedia(value, resultMediaHints(record, key))
    return media ? [{ key, media }] : []
  })
  const mediaKeys = new Set(mediaEntries.map(item => item.key))
  const entries = allEntries.filter(([key]) => !mediaKeys.has(key))
  const mediaViews = mediaEntries.map(({ key, media }) => <section key={key} className="min-w-0 space-y-1"><h4 className="text-tiny font-medium text-muted">{label(key)}</h4><ResultMediaView media={media} /></section>)
  if (!entries.length && mediaEntries.length) return <div className="min-w-0 space-y-3">{mediaViews}</div>
  if (entries.length === 0) return <Muted>Nothing in it.</Muted>

  // TOO DEEP TO READ. Two things this must not do, and it used to do both.
  //
  // It printed the object's JSON — a box of punctuation three levels into the
  // view that exists to replace one. Then it printed "2 more fields — in the
  // raw JSON below", which is worse: a promise pointing at a fold that is no
  // longer there, and, to anybody who is not a programmer, a sentence that
  // says the thing they paid for is somewhere else.
  //
  // So the fields are DRAWN, flat: their names and whatever each one plainly
  // says. Nothing is named-and-counted, and nothing sends the reader away.
  if (depth >= MAX_DEPTH) {
    return (
      <div className="min-w-0 space-y-3">{mediaViews}<dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
        {entries.map(([key, value]) => (
          <div key={key} className="contents">
            <dt className="truncate text-tiny text-faint">{label(key)}</dt>
            <dd className="min-w-0 break-words text-body text-foreground">
              {isRecord(value) || Array.isArray(value) ? (
                <Muted>{summarise(value)}</Muted>
              ) : (
                <Node value={value} depth={depth} />
              )}
            </dd>
          </div>
        ))}
      </dl></div>
    )
  }

  // THREE KINDS, and the middle one is the reason this is not one grid.
  //
  //   flat    a short scalar. A label and a value on one line, which is what
  //           the grid is for and what it is good at.
  //   prose   a paragraph, a summary, an article, a set of instructions. Set
  //           in the value column of a two-column grid it was a 600-word
  //           answer in a strip about 30 characters wide, which is the single
  //           worst thing this reader did to an answer somebody had paid for.
  //           It gets its own full-width block under its own heading.
  //   nested  a structure. Its own titled block, as before — a two-line label
  //           with an array folded into it is the shape that made the JSON
  //           hard to read in the first place.
  const flat = entries.filter(
    ([, value]) =>
      !isRecord(value) &&
      !Array.isArray(value) &&
      !(typeof value === "string" && isProse(value)),
  )
  const prose = entries.filter(
    ([, value]) => typeof value === "string" && isProse(value),
  )
  const nested = entries.filter(([, value]) => isRecord(value) || Array.isArray(value))

  return (
    <div className="space-y-2.5">
      {mediaViews}
      {flat.length ? (
        <dl className="grid grid-cols-[minmax(5rem,auto)_1fr] gap-x-3 gap-y-1">
          {flat.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate text-tiny text-faint">{label(key)}</dt>
              <dd className="min-w-0 break-words text-body text-foreground">
                <Node value={value} depth={depth + 1} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {prose.map(([key, value]) => (
        <section key={key} className="space-y-1.5">
          <h4 className="text-tiny font-medium text-faint">
            {label(key)}
          </h4>
          <Prose text={value as string} />
        </section>
      ))}

      {nested.map(([key, value]) => (
        <section key={key} className="space-y-1.5">
          <h4 className="text-tiny font-medium text-faint">
            {label(key)}
          </h4>
          <Node value={value} depth={depth + 1} hints={resultMediaHints(record, key)} />
        </section>
      ))}
    </div>
  )
}

/**
 * A string that is writing, set as writing.
 *
 * Headings, paragraphs, bullets and numbered lists — see `readBlocks` for what
 * is recognised and, more importantly, what deliberately is not. The measure is
 * capped: a paragraph running the full width of an expanded panel is one the
 * eye loses its place in on every line, and 68 characters is where prose stops
 * being harder to read the wider it gets.
 */
function Prose({ text }: { text: string }) {
  const blocks = readBlocks(text)
  if (blocks.length === 0) return <Muted>empty</Muted>

  return (
    <div className="answer-prose max-w-[68ch]">
      {blocks.map((block, index) => {
        switch (block.kind) {
          case "heading":
            return (
              <h3 key={index} className="text-large text-heading">
                <ResponseText text={block.text} />
              </h3>
            )
          case "bullets":
            return (
              <ul key={index} className="space-y-1">
                {block.items.map((item, i) => (
                  <li key={i} className="flex gap-2 text-body text-foreground">
                    <span aria-hidden="true" className="select-none text-faint">
                      •
                    </span>
                    <span className="min-w-0 flex-1"><ResponseText text={item} /></span>
                  </li>
                ))}
              </ul>
            )
          case "numbers":
            return (
              <ol key={index} className="space-y-1">
                {block.items.map((item, i) => (
                  <li key={i} className="flex gap-2 text-body text-foreground">
                    <span
                      aria-hidden="true"
                      className="select-none tabular-nums text-faint"
                    >
                      {i + 1}.
                    </span>
                    <span className="min-w-0 flex-1"><ResponseText text={item} /></span>
                  </li>
                ))}
              </ol>
            )
          default:
            return (
              <p
                key={index}
                // `pre-wrap` because `readBlocks` keeps a paragraph's own line
                // breaks: an address, a stack trace and a poem are all
                // paragraphs by its rule, and all three are ruined by reflowing.
                className="whitespace-pre-wrap text-body text-foreground"
              >
                <ResponseText text={block.text} />
              </p>
            )
        }
      })}
    </div>
  )
}

/* -----------------------------------------------------------------------------
   The small pieces
   -------------------------------------------------------------------------- */

/** A string, which may be a link, a picture, a date, or just a string. */
function Scalar({ value }: { value: string }) {
  const inTable = useContext(ResultTableContext)
  const text = value.trim()
  if (!text) return <Muted>empty</Muted>

  if (inTable) return <ResponseText text={text} />

  if (isUrl(text)) {
    return <LinkPreviewCard href={text} />
  }

  const when = asDate(text)
  if (when) {
    return (
      <span className="text-foreground" title={text}>
        {when}
      </span>
    )
  }

  return <span className="whitespace-pre-wrap text-foreground"><ResponseText text={text} /></span>
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-body text-faint">{children}</span>
}

/**
 * What a structure at the bottom of the reader's reach is, in plain words.
 *
 * Only reached past `MAX_DEPTH`, which an ordinary body no longer gets near.
 * "3 items" and "4 details" are not much, but they are true, they are English,
 * and they do not point at a JSON view that no longer exists.
 */
function summarise(value: unknown): string {
  if (Array.isArray(value)) {
    return `${value.length} ${value.length === 1 ? "item" : "items"}`
  }
  const count = Object.keys(value as Record<string, unknown>).length
  return `${count} ${count === 1 ? "detail" : "details"}`
}

/* `Json` USED TO BE HERE — a `<pre>` of `safeJson`, drawn wherever these
   rules ran out: past `MAX_DEPTH`, and for a value none of them fitted. It is
   gone, and its absence is the rule the reader is now built on: THE READABLE
   VIEW CONTAINS NO JSON. Every one of those escapes drew a box of punctuation
   inside the view whose whole purpose is to be the alternative to one, and the
   two views stopped being distinguishable exactly where the answer got hard —
   which is where the reader was most needed.

   THERE IS NO LONGER A SECOND VIEW EITHER. The `Raw JSON` fold that used to
   sit under the answer is gone from `run-panel`: a reader who is eight years
   old or eighty opens a result to find out what it says, and a disclosure
   offering them the same answer as punctuation is one more thing on the screen
   to be uncertain about. `Copy` still puts the whole body on the clipboard for
   anyone who wants it, and /history keeps every response intact. */
