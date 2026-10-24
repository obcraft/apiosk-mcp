/* -----------------------------------------------------------------------------
   The inputs a source takes, read off whatever it published

   A discovery result is only half an answer. "This endpoint can do your job"
   is useless if the call then goes out with no arguments — most of this
   catalogue answers a bare request with a 400, the balance is refunded, and the
   user is left with a failure that reads like the product is broken when in
   fact nobody was ever asked for the URL, the ticker or the query string.

   This module turns a published input schema into a list of FIELDS a form can
   render and a payload a call can be made with. Everything it does is in
   service of one number: the share of runs that come back with an answer.

   ---------------------------------------------------------------------------
   Four dialects, one shape
   ---------------------------------------------------------------------------

   The gateway normalises most of what the indexes publish, but not all of it,
   so four shapes reach the browser and all four have to be read:

     1. A grouped JSON Schema — `{properties: {pathParams|queryParams|body:
        {type, properties, required: [...]}}}`. What `src/sources.rs` builds
        out of thirdweb's OpenAPI-ish parameter lists and x402engine's grouped
        maps. The common case.

     2. A flat JSON Schema — `{type, required: [...], properties: {...}}`, no
        location groups. Two sources of this: a capability's `input_contract`,
        and the Bazaar's own `schema.properties.input`, which the gateway
        carries verbatim rather than normalising.

     3. A flat FIELD MAP with per-field `required` — `{url: {type: "string",
        required: true}, format: {enum: [...]}}`. The legacy x402 dialect, under
        `outputSchema.input.bodyFields` / `.queryParams`, which arrives on the
        offer's `input` rather than its `input_schema`.

     4. An EXAMPLE CALL — `{queryParams: {limit: 10}}`. No types, no required
        flags, just values somebody once sent. The weakest source, and still
        better than an empty form: it names the parameters.

   `readFields` reads all four into one `InputField[]`, and nothing downstream
   ever learns which one it came from.

   ---------------------------------------------------------------------------
   What is validated, and what deliberately is not
   ---------------------------------------------------------------------------

   Only the checks where sending the value is GUARANTEED to fail: a missing
   required field, a number that is not a number, an integer with a fraction, a
   value outside a published range, a choice outside a published enum, JSON that
   does not parse, a string against a pattern the provider published.

   Not e-mail shape, not URL shape, not "looks like a date". Those get the right
   `<input type>` — so the phone keyboard and the date picker are right — and
   are then sent as typed. A form that refuses `example.com` because it has no
   scheme is a form that blocks a call the provider would have answered, and a
   false refusal costs more than a 400 does: the 400 is refunded and explains
   itself, the refusal just looks broken.
   -------------------------------------------------------------------------- */

/** JSON Schema, as far as anything here reads it. */
export interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  /** An array on a group (`required: ["q"]`), a boolean on a field (dialect 3). */
  required?: string[] | boolean
  /**
   * The name of a group this field is one acceptable answer to.
   *
   * See `InputField.requiredOneOf`. A provider's own vocabulary never carries
   * this — it is written into a reviewed listing's schema by the catalogue,
   * for endpoints whose real rule is "give me one of these".
   */
  requiredOneOf?: string
  enum?: unknown[]
  items?: SchemaNode
  title?: string
  description?: string
  example?: unknown
  examples?: unknown[]
  default?: unknown
  format?: string
  pattern?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  multipleOf?: number
}

/**
 * An input schema as a source actually published it.
 *
 * Not every one is a JSON Schema. Dialect 3 above — the flat FIELD MAP, whose
 * properties sit at the ROOT beside the odd `type` or `$schema` — is what the
 * catalogue holds for KVK among others, and it reaches the browser verbatim on
 * a candidate's `input_schema`. Typing that field as a `SchemaNode` alone said
 * the flat map could not occur, which is a statement about the shape this
 * module WISHES it received: `readFields` has read all four dialects since it
 * was written, and the KVK basisprofiel — the one endpoint the paid company
 * lookup exists for — publishes exactly the shape the type ruled out.
 */
export type PublishedSchema = SchemaNode | Record<string, SchemaNode>

/** Where the value goes on the wire. */
export type InputLocation = "path" | "query" | "body"

/**
 * Which control to draw.
 *
 * Chosen from the schema, never from the field name alone. A `select` exists
 * because the provider published an enum; a `boolean` because it published
 * `type: "boolean"`. Guessing a control from a name would eventually render a
 * checkbox for a field called `active` that takes the string `"yes"`.
 */
type InputControl =
  | "text"
  | "textarea"
  | "number"
  | "boolean"
  | "select"
  | "multiselect"
  | "list"
  | "json"

interface EnumOption {
  /** The value as the form holds it — always a string. */
  value: string
  /** The value as the provider published it, which may be a number or a bool. */
  raw: unknown
}

export interface InputField {
  /**
   * The field's identity on this form: `query`, or `input.query` for a value
   * that sits inside an object the provider published.
   *
   * Unique per form, because it is what `values`, `errors` and the DOM id are
   * keyed by. It is NOT necessarily the name on the wire — see `path`.
   */
  name: string
  /**
   * Where the value goes inside its location, one key per level.
   *
   * `["query"]` for an ordinary parameter, `["input", "query"]` for one the
   * schema nested. Held as a list rather than derived from `name` because a
   * parameter is allowed to have a dot in its own name — `filter.status` is a
   * real query string key — and splitting on it would send that value one
   * level down from where the provider asked for it.
   *
   * Absent on a field read back from a selection recorded before this existed;
   * `wirePath` is what everything reads it through.
   */
  path?: string[]
  /** The name as a person reads it: `full_page` → "Full page". */
  label: string
  location: InputLocation
  control: InputControl
  required: boolean
  /**
   * The group this field is ONE acceptable answer to, or null.
   *
   * The rule some endpoints actually have is neither "this field is required"
   * nor "nothing is required" — it is "give me at least one of these". KVK's
   * `/api/v2/zoeken` is the case that forced it: every one of its fourteen
   * parameters is optional in the provider's own spec, and a call carrying
   * none of them is refused with `IPD1998 Algemene invoer parameter fout`.
   *
   * Marking one field required is the wrong repair, and it was the repair that
   * shipped: it made `naam` the only way in, so a person holding a KVK number
   * or an address — both of which that endpoint searches on perfectly well —
   * had to type a company name they did not have to get past the form.
   *
   * A field in a group is REQUIRED-ISH: it never sits in the folded "optional
   * settings" section, and the form refuses while every member of its group is
   * empty. Filling any one of them satisfies all of them.
   */
  requiredOneOf: string | null
  /** The provider's own words about this field. Rendered under the control. */
  description: string | null
  /** `<input type>` for a text control — `email`, `url`, `date`, `number`. */
  inputType: string
  /** Published choices. Non-empty exactly when the control is a select. */
  options: EnumOption[]
  /** What one entry of a `list` is coerced to. */
  itemType: "string" | "number" | "integer" | "boolean"
  /** An example value, shown as placeholder text — never prefilled. */
  placeholder: string | null
  /** The schema's `default`, which IS prefilled. */
  defaultValue: FieldValue | null
  min: number | null
  max: number | null
  /** `multipleOf`, or 1 for an integer, or null for "any". */
  step: number | null
  pattern: string | null
  /**
   * The paid lookup that can produce this value from a NAME, or null.
   *
   * Set by `withLookups` from the gateway's own pre-steps, never read off a
   * schema. Three things change for a field that has one, and all three are
   * the same fact — this box takes the name, because the name is what the
   * person has:
   *
   *   - it is labelled for the name first and the identifier second;
   *   - the provider's `pattern` stops being a wall (see `coerceField`);
   *   - the job's own company name is put in it (see `nameFromJob`).
   *
   * WHAT THIS FIXES. "Basis KVK profiel van Mollie BV" opened a required,
   * empty box labelled `Kvk nummer` whose published pattern is `^[0-9]{8}$`.
   * Typing the only thing the person had — `Mollie BV`, a name they had
   * already written one line above — was refused with "Doesn't match the
   * format this source expects", and the lookup that exists precisely to turn
   * that name into that number was priced, listed in the footer, and
   * unreachable. The answer was in the question and the form asked it again.
   */
  lookup?: LookupNote | null
}

/** A lookup that fills one field in, as the form needs to describe it. */
export interface LookupNote {
  /** The step's own name, e.g. "KVK company lookup". */
  label: string
  /** What it costs the buyer, in USD, for the line under the field. */
  buyerPriceUsd: number
  /**
   * What the identifier this lookup produces looks like, in the gateway's own
   * vocabulary (`digits:8`), or null where the step does not say.
   *
   * The form's second source for the field's format, after the provider's
   * own `pattern` — see `identifierFormat`. It is what lets a job that spells
   * the number out skip the lookup on a field whose schema published no
   * pattern at all.
   */
  shape: string | null
}

/**
 * A form value, before it is coerced into what the wire takes.
 *
 * Three shapes and no more: a string for everything typed or chosen, a boolean
 * for a checkbox, a string array for a list or a multi-select. Holding numbers
 * as numbers here would mean a half-typed `-` or `1.` had no representation,
 * and the field would fight the person filling it in.
 */
export type FieldValue = string | boolean | string[]

export type FieldValues = Record<string, FieldValue>

/* -----------------------------------------------------------------------------
   Reading a schema
   -------------------------------------------------------------------------- */

/**
 * The location groups, in the spellings the four dialects use.
 *
 * `headers` is absent on purpose. The gateway refuses to forward arbitrary
 * caller headers (see `build_outbound` in `proxy/external_fetch.rs`) precisely
 * so a caller cannot inject one or leak a secret through it — so a header field
 * on this form would be a control that silently does nothing.
 */
const GROUPS: Record<string, InputLocation> = {
  pathParams: "path",
  path: "path",
  queryParams: "query",
  query: "query",
  body: "body",
  bodyFields: "body",
  data: "body",
}

/**
 * Keys that describe the CALL rather than name a parameter of it.
 *
 * Only ever dropped from a container read at its TOP level — the shape
 * `{method: "GET", type: "http", queryParams: {...}}` the x402 dialect
 * publishes, whether it arrives as an example or as a schema's flat property
 * map. Inside a location group these words are ordinary parameter names
 * (a screenshot endpoint really does take a `format`), so the filter must not
 * reach there.
 *
 * And even at the top level the NAME is only half the test — see the
 * `requestShaped` guard in `fieldsFromGroup`. KVK's `/api/v2/zoeken` publishes
 * a real `type` parameter (`hoofdvestiging | nevenvestiging | rechtspersoon`)
 * in a flat map that names no `url` and no group, and the name alone erased it
 * from the form.
 */
const NOT_A_FIELD = new Set(["method", "type", "discoverable", "bodyType", "headers"])

/** The order groups are rendered in — the order a URL is read in. */
const GROUP_ORDER: InputLocation[] = ["path", "query", "body"]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * The parameter names a URL's own path declares.
 *
 * `/stock/:symbol` is a schema whether or not anyone published one: the token
 * cannot be left blank, because the call would then go out with a literal
 * `:symbol` in the URL. The three spellings read here are exactly the three
 * `applyPathParams` (the execution side, `supabase/functions/_shared/
 * request.ts`) substitutes — `{name}`, `%7Bname%7D` and `:name` — and a shared
 * test holds the two together, so a field asked for here is always a token the
 * call can fill.
 *
 * Only the pathname is read, through the same WHATWG parser the substitution
 * uses; a resource that parser refuses declares nothing. A `:name` counts only
 * at the start of a segment — a mid-segment colon is a custom verb
 * (`/thing:activate`), not a parameter.
 */
export function pathParamNames(resource: string | null | undefined): string[] {
  if (!resource) return []
  let pathname: string
  try {
    pathname = new URL(resource).pathname
  } catch {
    return []
  }

  const names: string[] = []
  const add = (name: string | undefined) => {
    if (name && !names.includes(name)) names.push(name)
  }
  for (const [, name] of pathname.matchAll(/\{([^/{}]+)\}/g)) add(name)
  for (const [, name] of pathname.matchAll(/%7B([^/%]+?)%7D/gi)) add(name)
  for (const [, name] of pathname.matchAll(/(?:^|\/):([A-Za-z_][A-Za-z0-9_]*)/g)) add(name)
  return names
}

/**
 * Where a value goes when the schema did not say.
 *
 * The methods that carry a body take one; everything else, including an offer
 * that published no method at all, takes a query string. That last case is not
 * a guess for its own sake — `use-selection` sends `method ?? "GET"`, so an
 * undeclared method IS a GET by the time the call is made, and putting its
 * arguments anywhere but the query string would put them where nobody reads
 * them.
 */
function defaultLocation(method: string | null | undefined): InputLocation {
  const verb = (method ?? "").trim().toUpperCase()
  return verb === "POST" || verb === "PUT" || verb === "PATCH" ? "body" : "query"
}

/**
 * Words that are shouted rather than capitalised.
 *
 * Without these, `id` becomes "Id" and `api_key` becomes "Api key" — labels
 * that read as a typo on a form someone is being asked to trust with money.
 */
const ACRONYMS = new Set([
  "id", "url", "uri", "api", "ip", "iso", "utc", "css", "html", "json", "csv",
  "html", "sku", "isbn", "vat", "usd", "eur", "faq", "pdf", "svg", "png", "jpg",
])

/** `full_page` → "Full page", `maxResults` → "Max results", `api_key` → "API key". */
function humanize(name: string): string {
  const words = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return name

  return words
    .map((word, index) => {
      if (ACRONYMS.has(word)) return word.toUpperCase()
      // The plural of an acronym is still the acronym. `startUrls` is "Start
      // URLs" — not "Start urls", and not the shouted "Start URLS". Worth its
      // own line because a list parameter is named for more than one of the
      // thing, and an object's properties are where the lists live: `urls`,
      // `ids`, `startUrls`.
      if (word.endsWith("s") && ACRONYMS.has(word.slice(0, -1))) {
        return `${word.slice(0, -1).toUpperCase()}s`
      }
      return index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word
    })
    .join(" ")
}

/**
 * Where a field's value goes inside its location.
 *
 * The fallback is the field's own name, which is the right answer for every
 * field that was never nested and for every one read back out of a selection
 * recorded before `path` was written down.
 */
export function wirePath(field: InputField): string[] {
  return field.path?.length ? field.path : [field.name]
}

/**
 * The last segment of a field's path — what the PROVIDER called this value.
 *
 * Every rule in this file that reads a name to work out what a field means —
 * "is this the search box", "is this a country", "is this the start of a date
 * range" — asks this rather than `name`. `input.query` is still a query; a
 * pattern anchored to the whole name stops recognising it the moment the
 * schema puts it one level down, and the form quietly stops filling in the
 * sentence the person already typed.
 */
function leafName(field: InputField): string {
  const path = wirePath(field)
  return path[path.length - 1]
}

/** The first type, when a schema declares a union (`["string", "null"]`). */
function typeOf(node: SchemaNode): string | null {
  const type = node.type
  if (typeof type === "string") return type.toLowerCase()
  if (Array.isArray(type)) {
    const first = type.find((t) => typeof t === "string" && t.toLowerCase() !== "null")
    return typeof first === "string" ? first.toLowerCase() : null
  }
  return null
}

/** The type an example value implies, when nothing declared one. */
function typeOfValue(value: unknown): string | null {
  if (typeof value === "boolean") return "boolean"
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"
  if (typeof value === "string") return "string"
  if (Array.isArray(value)) return "array"
  if (isRecord(value)) return "object"
  return null
}

/** Schema keywords weak enough to double as a parameter name. */
const SOFT_KEYS = [
  "description", "format", "pattern", "title", "default", "example", "examples",
  "minimum", "maximum", "minLength", "maxLength", "multipleOf", "required",
  "requiredOneOf",
]

/**
 * Whether this object DESCRIBES a field or simply IS one field's value.
 *
 * `{type: "string", required: true}` is the first; `{lat: 52, lon: 4}` is the
 * second, and reading it as a description would invent two parameters called
 * `lat` and `lon` out of one called something else entirely.
 *
 * The check is on the value's TYPE, not on the key's presence, and that is the
 * whole difficulty. A screenshot endpoint publishes a parameter map
 * `{format: {...}, width: {...}}` whose first key is a schema keyword — so
 * "has a key called `format`" would misread the map as a single field. A field
 * description's `format` is a STRING; a parameter map's is the nested object
 * describing that parameter. Hence: strong keywords decide on their own, soft
 * ones only when nothing nested is sitting underneath them.
 */
function isFieldSpec(value: unknown): value is SchemaNode {
  if (!isRecord(value)) return false
  if (isRecord(value.properties) || isRecord(value.items)) return true
  if (Array.isArray(value.enum)) return true
  if (typeof value.type === "string") return true
  if (Array.isArray(value.type) && value.type.every((t) => typeof t === "string")) {
    return true
  }
  if (Object.values(value).some(isRecord)) return false
  return SOFT_KEYS.some((key) => key in value)
}

/**
 * Whether this object is a LOCATION GROUP rather than one field's description.
 *
 * Asked only of values sitting under a key like `queryParams`, which several
 * capability contracts also use as an ordinary parameter name — `web.search`
 * takes a `query`, and reading that as a group is how a form ends up with no
 * fields at all on the most common capability in the catalogue.
 */
function looksLikeGroup(value: unknown): boolean {
  if (!isRecord(value)) return false
  return isRecord(value.properties) || !isFieldSpec(value)
}

/** Names whose value is prose rather than a token, so it gets a textarea. */
const LONG_TEXT =
  /^(text|content|html|markdown|body|message|prompt|instructions?|notes?|description)$/i

/** A string long enough that a one-line field would hide most of it. */
const LONG_TEXT_MAX = 200

function mixedTypes(node: SchemaNode): boolean {
  return Array.isArray(node.type) && new Set(node.type.filter(type => type !== 'null')).size > 1
}

function controlFor(type: string | null, node: SchemaNode, name: string): InputControl {
  if (Array.isArray(node.enum) && node.enum.length > 0) return "select"
  if (mixedTypes(node)) return "json"
  if (type === "array") {
    const items = node.items
    const itemTypes = Array.isArray(items?.type) ? items.type : [items?.type]
    // A scalar list stringifies each entry. Keep structured entries as JSON
    // so addresses, nested data and unknown object keys survive input review.
    if (itemTypes.some(type => type === "object" || type === "array") || isRecord(items?.properties)) return "json"
    return items && Array.isArray(items.enum) && items.enum.length > 0
      ? "multiselect"
      : "list"
  }
  if (type === "object") return "json"
  if (type === "boolean") return "boolean"
  if (type === "number" || type === "integer") return "number"
  if (LONG_TEXT.test(name)) return "textarea"
  if (typeof node.maxLength === "number" && node.maxLength > LONG_TEXT_MAX) return "textarea"
  return "text"
}

/**
 * The `<input type>` a text control wears.
 *
 * A hint, not a gate — `coerceField` never rejects on it. What it buys is the
 * right keyboard on a phone and the platform's own date picker, which is worth
 * more to someone filling in a form than any validation message.
 */
function inputTypeFor(control: InputControl, node: SchemaNode, name: string): string {
  if (control === "number") return "number"
  if (control !== "text") return "text"
  const format = (node.format ?? "").toLowerCase()
  if (format === "date") return "date"
  if (format === "date-time") return "datetime-local"
  if (format === "time") return "time"
  if (format === "email" || /^e?mail$/i.test(name)) return "email"
  if (format === "uri" || format === "url" || /^(url|uri|link|website)$/i.test(name)) {
    return "url"
  }
  if (format === "password") return "password"
  return "text"
}

function itemTypeOf(node: SchemaNode): InputField["itemType"] {
  const type = node.items ? typeOf(node.items) : null
  if (type === "number") return "number"
  if (type === "integer") return "integer"
  if (type === "boolean") return "boolean"
  return "string"
}

/** An example value as one line of placeholder text. */
function placeholderOf(node: SchemaNode): string | null {
  const example =
    node.example ?? (Array.isArray(node.examples) ? node.examples[0] : undefined)
  return asPlaceholder(example)
}

function asPlaceholder(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === "string") return value || null
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** The schema's `default`, in the shape the form holds values in. */
function defaultOf(node: SchemaNode, control: InputControl): FieldValue | null {
  const value = node.default
  if (value == null) return null
  if (control === "boolean") return value === true || value === "true"
  if (control === "list" || control === "multiselect") {
    return Array.isArray(value) ? value.map((entry) => String(entry)) : null
  }
  if (control === "json") {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return null
    }
  }
  if (typeof value === "object") return null
  return String(value)
}

function optionsOf(node: SchemaNode, control: InputControl): EnumOption[] {
  const values =
    control === "multiselect" ? node.items?.enum : control === "select" ? node.enum : null
  if (!Array.isArray(values)) return []
  return values
    .filter((raw) => raw != null)
    .map((raw) => ({ value: String(raw), raw }))
}

/** One field, from a spec that may be a schema node or a bare example value. */
function fieldFrom(
  name: string,
  spec: unknown,
  location: InputLocation,
  requiredByGroup: boolean,
  parentPath: string[] = [],
): InputField {
  const described = isFieldSpec(spec)
  const node: SchemaNode = described ? spec : {}
  // The flat dialect puts `required` on the field itself; a group's
  // `required: [...]` says the same thing one level up. Either is enough.
  const required = requiredByGroup || node.required === true

  const type = described ? typeOf(node) : typeOfValue(spec)
  const control = controlFor(type, node, name)
  const path = [...parentPath, name]

  return {
    // Dotted once it is nested, so two objects that both publish a `url` are
    // two boxes and not one. `path` is what the value is sent under.
    name: path.join("."),
    path,
    label: node.title?.trim() || humanize(name),
    location,
    control,
    required,
    requiredOneOf:
      typeof node.requiredOneOf === "string" && node.requiredOneOf.trim()
        ? node.requiredOneOf.trim()
        : null,
    description: node.description?.trim() || null,
    inputType: inputTypeFor(control, node, name),
    options: optionsOf(node, control),
    itemType: itemTypeOf(node),
    // A bare example value IS the example, so it becomes the placeholder — the
    // one thing the weakest dialect can still tell someone.
    placeholder: described ? placeholderOf(node) : asPlaceholder(spec),
    defaultValue: defaultOf(node, control),
    min: typeof node.minimum === "number" ? node.minimum : null,
    max: typeof node.maximum === "number" ? node.maximum : null,
    step:
      typeof node.multipleOf === "number" ? node.multipleOf : type === "integer" ? 1 : null,
    pattern: typeof node.pattern === "string" ? node.pattern : null,
  }
}

/**
 * How many objects deep the form opens before it gives up and draws a box.
 *
 * Two, which covers every nested schema in this catalogue and stops a
 * pathological one from turning a modal into a page. Past it the object keeps
 * its JSON control, which is the honest answer for a shape nobody can lay out.
 */
const MAX_OBJECT_DEPTH = 2

/**
 * The fields ONE named entry produces.
 *
 * Usually one. An object the provider actually described produces one per
 * property instead, recursively, and this is the whole of the difference
 * between a form and a textarea:
 *
 *   {"input": {"query": "...", "location": "..."}}
 *
 * CrowdPull's scrapers, the Bazaar's actor calls and most of the POST bodies
 * in this catalogue publish exactly that — a required `input` object whose
 * every field is named, typed, described, defaulted and ranged. Reading it as
 * "one parameter of type object" threw all of that away and asked somebody who
 * had just typed a sentence in English to write JSON, in a modal, above a
 * button that spends their money. The schema was never the problem; nothing
 * was looking inside it.
 *
 * An object with no `properties` still gets the JSON box. That is not the same
 * case: there the provider published a shape nobody can draw, and a box the
 * reader can paste an example into is the best that is available.
 */
function fieldsForEntry(
  name: string,
  spec: unknown,
  location: InputLocation,
  requiredHere: boolean,
  parentPath: string[],
  depth: number,
): InputField[] {
  const field = fieldFrom(name, spec, location, requiredHere, parentPath)
  return expandObject(field, spec, location, depth) ?? [field]
}

/**
 * One object field, replaced by the fields it describes — or null when it
 * describes none.
 *
 * A child is required only when the object holding it is: `{"filters": {...}}`
 * that nobody has to send does not become three boxes with asterisks on them
 * the moment its own `required` names them. What that under-enforces is a
 * half-filled optional object, and the endpoint's own 400 is a better place to
 * discover that than a form refusing to send something nobody asked for.
 */
function expandObject(
  parent: InputField,
  spec: unknown,
  location: InputLocation,
  depth: number,
): InputField[] | null {
  if (parent.control !== "json" || depth >= MAX_OBJECT_DEPTH) return null
  if (!isRecord(spec)) return null

  const node = spec as SchemaNode
  if (mixedTypes(node)) return null
  const properties = isRecord(node.properties) ? node.properties : null
  if (!properties) return null
  const names = Object.keys(properties)
  if (!names.length) return null

  const required = new Set(
    Array.isArray(node.required) ? node.required.filter((n) => typeof n === "string") : [],
  )
  const parentPath = wirePath(parent)
  const children = names.flatMap((child) =>
    fieldsForEntry(
      child,
      properties[child],
      location,
      parent.required && required.has(child),
      parentPath,
      depth + 1,
    ),
  )
  if (!children.length) return null

  return parent.required && !children.some((child) => child.required)
    ? mustAnswerOne(parent, children)
    : children
}

/**
 * A REQUIRED object that named no required child, made answerable.
 *
 * The commonest shape in this catalogue and, read literally, a contradiction:
 * `required: ["input"]` with `input.required: []` says the call must carry an
 * object and that the object may be empty. It cannot — a scraper sent `{}` is
 * a paid call that fetches nothing — and before the object was expanded the
 * form said so by refusing to send an empty JSON box. Expanding it must not
 * lose that refusal, or the panel would go from "fill this in" to "nothing to
 * fill in" over a call that is now guaranteed to be wasted.
 *
 * So the object's requirement becomes the one the form already knows how to
 * ask: FILL IN AT LEAST ONE. Two kinds of child are kept out of that question,
 * and for the same reason in both cases — they are already answered, so a
 * group containing one is satisfied before the reader has read it:
 *
 *   - anything with a `default`, which `initialValues` puts in the box;
 *   - a checkbox, which is answered by existing (`false` IS its answer).
 *
 * Numbers are kept out too, on a different ground: a number is a limit on an
 * answer — `maxItems`, `maxPages` — never the thing being asked for, and a
 * form satisfied by `maxPages: 3` has let through exactly the empty call this
 * is here to stop. An object whose every remaining child is a number falls
 * back to those, because there the number IS the subject.
 */
function mustAnswerOne(parent: InputField, children: InputField[]): InputField[] {
  const open = children.filter(
    (child) =>
      !child.requiredOneOf && child.defaultValue == null && child.control !== "boolean",
  )
  const subjects = open.filter((child) => child.control !== "number")
  const members = subjects.length ? subjects : open
  if (!members.length) return children

  // A group of one is a bordered block reading "fill in at least one" around a
  // single box. That is one field, and it says so.
  if (members.length === 1) members[0].required = true
  else for (const member of members) member.requiredOneOf = parent.name

  return children
}

/**
 * One location's fields, from either a schema group or a flat parameter map.
 *
 * Both dialects arrive here: `{type, properties, required: [...]}` and the bare
 * `{name: spec}` map. `properties` is what tells them apart, and when it is
 * absent the object itself is the map.
 */
function fieldsFromGroup(
  group: unknown,
  location: InputLocation,
  dropMeta: boolean,
): InputField[] {
  if (!isRecord(group)) return []
  const node = group as SchemaNode
  const properties = isRecord(node.properties) ? node.properties : null
  // A group with no `properties` that itself reads as a schema node —
  // `queryParams: {type: "object"}` — declares NO parameters. Reading the node
  // as the map would turn its own keywords into fields called `type`.
  if (!properties && isFieldSpec(group)) return []
  const map: Record<string, unknown> = properties ?? (group as Record<string, unknown>)
  const required = new Set(
    Array.isArray(node.required) ? node.required.filter((n) => typeof n === "string") : [],
  )

  // `dropMeta` is for a container that describes an HTTP REQUEST, and such a
  // container always names its target: a `url`, or a location group to put
  // arguments in. A flat parameter map names neither, and there a call-shape
  // word whose value DESCRIBES a field is simply a parameter that shares the
  // name. Scalar envelope keys (`type: "http"`) are still dropped either way,
  // since no parameter is described by a bare string.
  const requestShaped =
    dropMeta && Object.keys(map).some((name) => name === "url" || name in GROUPS)
  const isEnvelope = (name: string) =>
    NOT_A_FIELD.has(name) && (requestShaped || !isFieldSpec(map[name]))

  return Object.keys(map)
    .filter((name) => !(dropMeta && isEnvelope(name)))
    .flatMap((name) => fieldsForEntry(name, map[name], location, required.has(name), [], 0))
}

/**
 * The group spellings that can ONLY be a group. `query`, `body`, `path` and
 * `data` are also ordinary parameter names (`{data: {type: "object"}}` is one
 * object-valued field, and reading it as an empty group erases it), so the
 * empty-group treatment below is reserved for the spellings nobody names a
 * parameter with.
 */
const EXPLICIT_GROUPS = new Set(["pathParams", "queryParams", "bodyFields"])

/**
 * An explicitly-named group that declares NOTHING — `{type: "object"}`, no
 * `properties`. The commonest way the Bazaar's schemas say "no query
 * parameters", and previously read as a parameter called `queryParams` with
 * envelope fields around it.
 */
function isEmptyGroup(value: unknown): boolean {
  if (!isRecord(value)) return false
  if (isRecord(value.properties)) return false
  return typeOf(value as SchemaNode) === "object"
}

/**
 * Whether an object is keyed by location rather than by parameter name.
 *
 * An empty group (`queryParams: {type: "object"}`) counts, but only under an
 * EXPLICIT_GROUPS spelling and only when no sibling outside GROUPS and
 * NOT_A_FIELD reads as a field spec. The sibling is what disambiguates: in
 * `{method: {...}, type: {...}, queryParams: {type: "object"}}` every other
 * key describes the call, so the container is grouped and empty; in `{url:
 * {...}, queryParams: {type: "object", ...}}` the `url` sibling shows a flat
 * parameter map.
 */
function hasGroups(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  const hasParamSiblings = keys.some(
    (key) => !(key in GROUPS) && !NOT_A_FIELD.has(key) && isFieldSpec(value[key]),
  )
  return keys.some(
    (key) =>
      (key in GROUPS && looksLikeGroup(value[key])) ||
      (EXPLICIT_GROUPS.has(key) && !hasParamSiblings && isEmptyGroup(value[key])),
  )
}

/**
 * Every group in a container, path first, one field per name.
 *
 * A name published in two groups is one parameter described twice, and the
 * schemas that do it (tickersfeed publishes `symbol` under `pathParams` and
 * again under `queryParams`) tend to put the prose on the copy that loses. So
 * the first location wins the FIELD, and a later copy fills in whatever the
 * winner was missing: a description, a placeholder, published choices.
 * Dropping the loser whole was how a path param rendered undescribed while
 * its own documentation sat in the discarded copy.
 */
function fieldsFromGrouped(container: Record<string, unknown>): InputField[] {
  const seen = new Map<string, InputField>()
  const out: InputField[] = []
  for (const location of GROUP_ORDER) {
    for (const [key, group] of Object.entries(container)) {
      if (GROUPS[key] !== location) continue
      for (const field of fieldsFromGroup(group, location, false)) {
        const kept = seen.get(field.name)
        if (!kept) {
          seen.set(field.name, field)
          out.push(field)
          continue
        }
        kept.description ??= field.description
        kept.placeholder ??= field.placeholder
        // Choices only travel with their control: options on a text field
        // would be a select the form never draws.
        if (!kept.options.length && field.options.length && kept.control === "text") {
          kept.options = field.options
          kept.control = field.control
        }
      }
    }
  }
  return out
}

/**
 * One container — a schema or an example call — read into fields.
 *
 * Both flat fallbacks drop the NOT_A_FIELD keys: a container's top level is
 * exactly where the call-shape words live, whichever dialect it arrived in.
 * Only inside a location group are they ordinary parameter names, and the
 * grouped path never comes through here with `dropMeta` on.
 */
function readContainer(container: unknown, fallback: InputLocation): InputField[] {
  if (!isRecord(container)) return []

  const properties = (container as SchemaNode).properties
  if (isRecord(properties)) {
    return hasGroups(properties)
      ? fieldsFromGrouped(properties)
      : fieldsFromGroup(container, fallback, true)
  }
  if (hasGroups(container)) return fieldsFromGrouped(container)

  // Nothing grouped and no `properties`: either a flat parameter map, or one
  // field's description that arrived where a map was expected (`{type:
  // "object"}` is what several listings publish when they mean "no schema").
  // The second must produce nothing rather than a parameter called `type`.
  if (isFieldSpec(container)) return []
  return fieldsFromGroup(container, fallback, true)
}

/**
 * Every input a source takes, from the strongest source that published one.
 *
 * The schema wins over the example call, and within the schema a location group
 * wins over a flat map — in both cases because the stronger source carries the
 * `required` flags, and "which of these must I fill in" is the single fact that
 * decides whether the call succeeds.
 *
 * The example call is still read when the schema produced nothing, and only
 * then. Merging the two would let an untyped example value overwrite a declared
 * type, which is the one way this could end up rendering a worse form than the
 * provider's own documentation describes.
 *
 * `resource` is the URL the call will be made to, when there is one — an
 * external offer's `resource`, a catalogue endpoint's `full_url`. Its path
 * tokens are read as the schema they are: see `withPathParams`. A reviewed
 * candidate is executed by id, never by URL, and passes nothing here.
 */
export function readFields(
  schema: unknown,
  example: unknown,
  method: string | null | undefined,
  resource?: string | null,
): InputField[] {
  const fallback = defaultLocation(method)
  const fromSchema = readContainer(schema, fallback)
  const fields = fromSchema.length ? fromSchema : readContainer(example, fallback)
  return withPathParams(fields, resource)
}

/**
 * The fields, corrected against the URL the call will actually be made to.
 *
 * A path token is required by construction — left blank, the call goes out
 * with a literal `:symbol` in the URL — so whatever the schema said, a field
 * matching one is marked required and routed to the path. Routing matters as
 * much as requiring: a schema that declared the token under `queryParams`
 * alone would otherwise send `?symbol=X` against a URL still carrying
 * `:symbol`.
 *
 * A token no field covers gets a plain required text field of its own.
 * `svm402.com/price/:address` publishes no schema at all, and without this
 * the form for it never asked for the one value it cannot run without.
 */
function withPathParams(
  fields: InputField[],
  resource: string | null | undefined,
): InputField[] {
  const tokens = pathParamNames(resource)
  if (!tokens.length) return fields

  const out = [...fields]
  for (const name of tokens) {
    const declared = out.find((field) => field.name === name)
    if (declared) {
      declared.location = "path"
      declared.required = true
    } else {
      out.push(syntheticPathField(name))
    }
  }
  return out
}

/** A required text field for a path token nothing declared. */
function syntheticPathField(name: string): InputField {
  return {
    name,
    path: [name],
    label: humanize(name),
    location: "path",
    control: "text",
    required: true,
    requiredOneOf: null,
    description: null,
    inputType: inputTypeFor("text", {}, name),
    options: [],
    itemType: "string",
    placeholder: null,
    defaultValue: null,
    min: null,
    max: null,
    step: null,
    pattern: null,
  }
}

/* -----------------------------------------------------------------------------
   Chips, for the card
   -------------------------------------------------------------------------- */

/** At most this many chips per cell — a card is a summary, not a schema dump. */
export const MAX_CHIPS = 6

export interface FieldChip {
  name: string
  required: boolean
}

/**
 * The few field names a card has room for — the ones it ASKS for first.
 *
 * Schema order was fine while a form was a handful of top-level parameters.
 * An expanded object publishes its properties alphabetically, and six chips
 * off the top of that reads `input.includeDetails`, `input.maxItems`,
 * `input.maxListings` — three limits and a checkbox on a card whose reader is
 * deciding whether this endpoint does what they want. What answers that
 * question is the value the call cannot go without, so the required fields and
 * the members of a "fill in at least one" group come first, and the rest keep
 * the order the provider published them in.
 */
export function chipsOf(fields: InputField[]): FieldChip[] {
  const asked = (field: InputField) => (field.required || field.requiredOneOf ? 0 : 1)
  return [...fields]
    .sort((a, b) => asked(a) - asked(b))
    .slice(0, MAX_CHIPS)
    .map((field) => ({ name: field.name, required: field.required }))
}

/* -----------------------------------------------------------------------------
   Filling the form in
   -------------------------------------------------------------------------- */

function emptyValue(field: InputField): FieldValue {
  if (field.control === "boolean") return false
  if (field.control === "list" || field.control === "multiselect") return []
  return ""
}

/**
 * The form as it opens.
 *
 * Defaults are filled in; examples are NOT. A `default` is the provider saying
 * "this is what I use when you say nothing", so prefilling it changes nothing
 * about the call and saves a decision. An `example` is the provider saying
 * "here is what one looks like", and prefilling that would send somebody else's
 * URL as if the user had chosen it — a call that costs real money and returns
 * an answer about the wrong thing. Examples go in the placeholder, where they
 * inform without being sent.
 */
export function initialValues(fields: InputField[]): FieldValues {
  const values: FieldValues = {}
  for (const field of fields) {
    values[field.name] = field.defaultValue ?? emptyValue(field)
  }
  return values
}

/** Whether a value is the "nothing was entered" state for its control. */
function isBlank(value: FieldValue | undefined): boolean {
  if (value == null) return true
  if (typeof value === "boolean") return false
  if (Array.isArray(value)) return value.length === 0
  return value.trim().length === 0
}

function coerceScalar(
  type: InputField["itemType"],
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (type === "boolean") {
    const lower = raw.trim().toLowerCase()
    if (["true", "yes", "1"].includes(lower)) return { ok: true, value: true }
    if (["false", "no", "0"].includes(lower)) return { ok: true, value: false }
    return { ok: false, error: "Use true or false." }
  }
  if (type === "number" || type === "integer") {
    const value = Number(raw.trim())
    if (!Number.isFinite(value)) return { ok: false, error: "Enter a number." }
    if (type === "integer" && !Number.isInteger(value)) {
      return { ok: false, error: "Enter a whole number." }
    }
    return { ok: true, value }
  }
  return { ok: true, value: raw }
}

/**
 * One form value → the value that goes on the wire, or the reason it cannot.
 *
 * `undefined` means "send nothing for this field", and it is a real answer
 * rather than a failure: an optional parameter left blank must be OMITTED, not
 * sent as an empty string. Half this catalogue answers `?limit=` with a 400,
 * and that is a paid call lost to a field nobody filled in on purpose.
 */
export function coerceField(
  field: InputField,
  value: FieldValue | undefined,
): { ok: true; value: unknown | undefined } | { ok: false; error: string } {
  if (isBlank(value)) {
    if (field.required) return { ok: false, error: "Required." }
    return { ok: true, value: undefined }
  }

  switch (field.control) {
    case "boolean":
      return { ok: true, value: value === true }

    case "number": {
      const type = field.step === 1 ? "integer" : "number"
      const scalar = coerceScalar(type, String(value))
      if (!scalar.ok) return scalar
      const num = scalar.value as number
      if (field.min != null && num < field.min) {
        return { ok: false, error: `Must be ${field.min} or more.` }
      }
      if (field.max != null && num > field.max) {
        return { ok: false, error: `Must be ${field.max} or less.` }
      }
      return { ok: true, value: num }
    }

    case "select": {
      const match = field.options.find((option) => option.value === String(value))
      // Sent as the provider published it, not as the string the `<select>`
      // held: an enum of `[1, 2, 3]` takes numbers, and `"1"` is a different
      // value to an API that type-checks its arguments.
      return match
        ? { ok: true, value: match.raw }
        : { ok: false, error: "Choose one of the listed values." }
    }

    case "multiselect": {
      const chosen = Array.isArray(value) ? value : []
      const out: unknown[] = []
      for (const entry of chosen) {
        const match = field.options.find((option) => option.value === entry)
        if (!match) return { ok: false, error: "Choose from the listed values." }
        out.push(match.raw)
      }
      return { ok: true, value: out }
    }

    case "list": {
      const entries = (Array.isArray(value) ? value : []).filter(
        (entry) => entry.trim().length > 0,
      )
      if (entries.length === 0) {
        return field.required ? { ok: false, error: "Required." } : { ok: true, value: undefined }
      }
      const out: unknown[] = []
      for (const entry of entries) {
        const scalar = coerceScalar(field.itemType, entry)
        if (!scalar.ok) return { ok: false, error: `“${entry}”: ${scalar.error}` }
        out.push(scalar.value)
      }
      return { ok: true, value: out }
    }

    case "json": {
      try {
        return { ok: true, value: JSON.parse(String(value)) }
      } catch {
        return { ok: false, error: "Not valid JSON." }
      }
    }

    default: {
      const text = String(value)
      if (field.pattern) {
        try {
          if (!new RegExp(field.pattern).test(text)) {
            // A NAME IS NOT A FAILED IDENTIFIER. Where a lookup exists to
            // produce this value, the box takes either one, and "Mollie BV"
            // against `^[0-9]{8}$` is not somebody mistyping a KVK number —
            // it is somebody typing the thing the lookup was built to
            // resolve. Judged the same way `fitsShape` judges it: anything
            // carrying a letter is a name, and goes.
            if (field.lookup && /\p{L}/u.test(text)) {
              return { ok: true, value: text }
            }
            return {
              ok: false,
              error: field.lookup
                ? `Doesn't match the format this source expects. Type the name instead and Apiosk looks it up.`
                : "Doesn't match the format this source expects.",
            }
          }
        } catch {
          // A pattern this browser cannot compile is the provider's problem,
          // not the user's. Never block a call over one.
        }
      }
      return { ok: true, value: text }
    }
  }
}

/* -----------------------------------------------------------------------------
   Filling it in again
   -------------------------------------------------------------------------- */

const CONTROLS = new Set<string>([
  "text",
  "textarea",
  "number",
  "boolean",
  "select",
  "multiselect",
  "list",
  "json",
])

const LOCATIONS = new Set<string>(["path", "query", "body"])
const ITEM_TYPES = new Set<string>(["string", "number", "integer", "boolean"])

/** One stored value, back into whatever its control holds. */
function seedValue(field: InputField, value: unknown): FieldValue | null {
  if (value == null) return null

  if (field.control === "boolean") return value === true || value === "true"

  if (field.control === "list" || field.control === "multiselect") {
    if (!Array.isArray(value)) return null
    return value.filter((entry) => entry != null).map((entry) => String(entry))
  }

  if (field.control === "json") {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return null
    }
  }

  // An object where a scalar control lives is a value this form cannot hold.
  // An empty field beats one reading "[object Object]" and then sending it.
  if (typeof value === "object") return null
  return String(value)
}

/**
 * The form, opened on what a previous call was actually given.
 *
 * This is the half that makes a run repeatable. A retry from the history page
 * starts from the values that were sent, so the common case (the same call
 * again with one argument changed) is one edit rather than a form typed out
 * from scratch against a payload in the panel behind it.
 *
 * A value the schema no longer declares is dropped rather than smuggled
 * through. The form can only send what it can draw, and a value with no
 * control behind it would sit in the payload where nobody could see it, let
 * alone correct it.
 */
export function valuesFrom(fields: InputField[], sent: unknown): FieldValues {
  const values = initialValues(fields)
  if (!isRecord(sent)) return values

  for (const field of fields) {
    const found = valueAt(sent, wirePath(field))
    if (found === MISSING) continue
    const seeded = seedValue(field, found)
    if (seeded !== null) values[field.name] = seeded
  }
  return values
}

/** "This call sent nothing for that field", which is not the same fact as it
 *  having sent a null. */
const MISSING = Symbol("missing")

/** What a previous call sent at one field's path, or `MISSING`. */
function valueAt(sent: Record<string, unknown>, path: string[]): unknown {
  let node: unknown = sent
  for (const key of path) {
    if (!isRecord(node) || !(key in node)) return MISSING
    node = node[key]
  }
  return node
}

/**
 * A form read at discovery, recovered from a selection's stored metadata.
 *
 * The schema is snapshotted with the pick for the reason the price is: running
 * one from history a week later has to draw the form the person was shown, not
 * whatever the listing happens to say today. Anything unreadable here produces
 * nothing rather than a half-field, and a source with no snapshot falls back to
 * the name-and-value rows an undocumented source has always landed on.
 */
export function readStoredFields(value: unknown): InputField[] {
  if (!Array.isArray(value)) return []

  const out: InputField[] = []
  for (const entry of value) {
    if (!isRecord(entry)) continue
    const name = entry.name
    if (typeof name !== "string" || !name) continue

    const control = (
      typeof entry.control === "string" && CONTROLS.has(entry.control)
        ? entry.control
        : "text"
    ) as InputControl

    out.push({
      name,
      path: storedPath(entry.path, name),
      label: typeof entry.label === "string" ? entry.label : name,
      location: (typeof entry.location === "string" && LOCATIONS.has(entry.location)
        ? entry.location
        : "query") as InputLocation,
      control,
      required: entry.required === true,
      requiredOneOf:
        typeof entry.requiredOneOf === "string" && entry.requiredOneOf.trim()
          ? entry.requiredOneOf.trim()
          : null,
      description: typeof entry.description === "string" ? entry.description : null,
      inputType: typeof entry.inputType === "string" ? entry.inputType : "text",
      options: Array.isArray(entry.options)
        ? entry.options
            .filter((option): option is Record<string, unknown> => isRecord(option))
            .filter((option) => typeof option.value === "string")
            .map((option) => ({ value: option.value as string, raw: option.raw }))
        : [],
      itemType: (typeof entry.itemType === "string" && ITEM_TYPES.has(entry.itemType)
        ? entry.itemType
        : "string") as InputField["itemType"],
      placeholder: typeof entry.placeholder === "string" ? entry.placeholder : null,
      defaultValue: seedValue({ control } as InputField, entry.defaultValue),
      min: typeof entry.min === "number" ? entry.min : null,
      max: typeof entry.max === "number" ? entry.max : null,
      step: typeof entry.step === "number" ? entry.step : null,
      pattern: typeof entry.pattern === "string" ? entry.pattern : null,
    })
  }
  return out
}

/**
 * A stored field's path, or the one its name implies.
 *
 * A selection recorded before nested objects were read has no `path`, and its
 * fields were all top-level by construction — so the name IS the path, and a
 * run repeated from History still sends what it sent the first time.
 */
function storedPath(raw: unknown, name: string): string[] {
  if (!Array.isArray(raw)) return [name]
  const path = raw.filter((key): key is string => typeof key === "string" && key.length > 0)
  return path.length ? path : [name]
}

/* -----------------------------------------------------------------------------
   The payload
   -------------------------------------------------------------------------- */

/** Values split by where they go on the wire. */
export interface InputParts {
  path: Record<string, unknown>
  query: Record<string, unknown>
  body: Record<string, unknown>
}

export interface BuiltInputs {
  /**
   * Every value, under the names the schema gave them. What `/v1/do` takes,
   * and what a run records.
   *
   * Flat, except where the provider published an object: a field whose `path`
   * is `["input", "query"]` is written as `{input: {query: ...}}`, which is the
   * payload the endpoint documented. The form's own dotted names never reach
   * the wire.
   */
  inputs: Record<string, unknown>
  /** The same values, routed. What `/v1/x402/fetch` needs to build a request. */
  parts: InputParts
}

/**
 * The form → what gets sent, or the fields standing in the way.
 *
 * Both halves are produced together on purpose. A caller that validated in one
 * place and serialised in another would eventually send a value the check never
 * saw, and the only symptom would be a paid call coming back 400.
 */
export function buildInputs(
  fields: InputField[],
  values: FieldValues,
): { errors: Record<string, string>; built: BuiltInputs | null } {
  const errors: Record<string, string> = {}
  const inputs: Record<string, unknown> = {}
  const parts: InputParts = { path: {}, query: {}, body: {} }
  /**
   * The fields that put something in the payload, by FORM name.
   *
   * Kept beside the payload rather than read back out of it, because the
   * payload is nested and the form's names are not: `inputs["input.query"]` is
   * undefined however full the box is, and the group check below read exactly
   * that — so a required object was refused as empty while the value the
   * reader had typed sat one level down in the object about to be sent.
   */
  const answered = new Set<string>()

  for (const field of fields) {
    const result = coerceField(field, values[field.name])
    if (!result.ok) {
      errors[field.name] = result.error
      continue
    }
    if (result.value === undefined) continue
    const path = wirePath(field)
    placeAt(inputs, path, result.value)
    placeAt(parts[field.location], path, result.value)
    answered.add(field.name)
  }

  // "At least one of these" — the rule a per-field `required` cannot express.
  // Checked against what was BUILT rather than against `values`, so a member
  // holding a blank string counts as empty exactly the way `coerceField`
  // decided it was.
  for (const members of oneOfGroups(fields).values()) {
    if (members.some((member) => answered.has(member.name))) continue
    const first = members[0]
    // The message lands on the first member because the section it opens is
    // what the reader is looking at; `InputFieldset` draws the group's own
    // heading above it, so it reads as being about the block and not the box.
    if (first && !errors[first.name]) errors[first.name] = ONE_OF_MESSAGE
  }

  return {
    errors,
    built: Object.keys(errors).length ? null : { inputs, parts },
  }
}

/**
 * One value, written where its path says it goes, building the objects above
 * it on the way down.
 *
 * Only the levels a filled field passes through are created, which is what
 * keeps an object nobody touched out of the payload entirely: an optional
 * `options` block with every box empty sends no `options` key, rather than an
 * empty one for the endpoint to reject.
 */
function placeAt(root: Record<string, unknown>, path: string[], value: unknown): void {
  let node = root
  for (const key of path.slice(0, -1)) {
    if (!isRecord(node[key])) node[key] = {}
    node = node[key] as Record<string, unknown>
  }
  node[path[path.length - 1]] = value
}

/** What a group says when none of it is filled in. */
export const ONE_OF_MESSAGE = "Fill in at least one of these."

/**
 * The one-of groups on a form, in the order their first member appears.
 *
 * A Map rather than a record so the order survives — the group holding the
 * search terms has to be drawn where the reader looks first, and object key
 * order is only insertion order by accident of the runtime.
 */
export function oneOfGroups(fields: InputField[]): Map<string, InputField[]> {
  const groups = new Map<string, InputField[]>()
  for (const field of fields) {
    if (!field.requiredOneOf) continue
    const members = groups.get(field.requiredOneOf)
    if (members) members.push(field)
    else groups.set(field.requiredOneOf, [field])
  }
  return groups
}

/** A value a person actually gave. `false` counts — an unticked box is an
 *  answer to a boolean and not a blank. */
function hasFieldValue(value: FieldValue | undefined): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.some((entry) => entry.trim().length > 0)
  return true
}

/** The groups on this form with no member filled in. */
export function unsatisfiedGroups(
  fields: InputField[],
  values: FieldValues,
): Map<string, InputField[]> {
  const out = new Map<string, InputField[]>()
  for (const [name, members] of oneOfGroups(fields)) {
    if (members.some((member) => hasFieldValue(values[member.name]))) continue
    out.set(name, members)
  }
  return out
}

/**
 * How many QUESTIONS a list of fields asks, counting a one-of group as one.
 *
 * "Three things to fill in" over a form whose three boxes are three ways of
 * answering the same question is a panel that has miscounted its own demands.
 * An expanded object makes that arithmetic matter more than it used to: the
 * group a required object turns into can have six members, and six is a
 * number that would tell somebody their sentence left six things out when it
 * left out one.
 */
export function questionCount(fields: InputField[]): number {
  const groups = new Set<string>()
  let plain = 0
  for (const field of fields) {
    if (field.requiredOneOf) groups.add(field.requiredOneOf)
    else plain += 1
  }
  return plain + groups.size
}

/** The same count, over the fields a form insists on before it can be sent. */
export function requiredQuestionCount(fields: InputField[]): number {
  return questionCount(fields.filter((field) => field.required || field.requiredOneOf))
}

/* -----------------------------------------------------------------------------
   The form a source that published nothing still gets
   -------------------------------------------------------------------------- */

/** One input on that form: a name, and the value exactly as it was typed. */
export interface InputPair {
  name: string
  value: string
}

/**
 * Text as typed, turned into the value that goes on the wire.
 *
 * Conservative on purpose. A postcode of `01234` and a price of `1.50` both
 * stay strings, because neither survives a round trip through `Number` intact
 * and a value that changes shape between the box and the request is a value
 * nobody can correct. Only text that reads back as exactly what was typed is
 * sent as a number, and anything wrapped in quotes is sent as a string even
 * when it looks like something else.
 */
export function parseValue(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return ""
  if (trimmed === "true") return true
  if (trimmed === "false") return false
  if (trimmed === "null") return null

  const number = Number(trimmed)
  if (Number.isFinite(number) && String(number) === trimmed) return number

  if (/^["[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Half-typed JSON is still text. Refusing it would block the call over a
      // value the endpoint may well accept as the string it is.
      return trimmed
    }
  }
  return trimmed
}

/**
 * The other direction: a value already sent, back into the box it came from.
 *
 * A string that `parseValue` would read as something else comes back quoted,
 * so re-running a call sends what the last one sent rather than a number where
 * there was a string.
 */
function formatValue(value: unknown): string {
  if (value === null) return "null"
  if (value === undefined) return ""
  if (typeof value === "boolean" || typeof value === "number") return String(value)
  if (typeof value === "string") {
    return parseValue(value) === value ? value : JSON.stringify(value)
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ""
  }
}

/**
 * The rows the form opens with, read off whatever the last call was given.
 *
 * This is the part that makes an undocumented source repeatable: the object it
 * was called with is the only description of its inputs anyone has, so it
 * becomes a named row per value rather than a wall of JSON to edit by hand.
 */
export function pairsFrom(sent: unknown): InputPair[] {
  if (!isRecord(sent)) return []
  return Object.entries(sent).map(([name, value]) => ({
    name,
    value: formatValue(value),
  }))
}

/** Rows → the JSON object they describe, for the box that edits them as text. */
export function objectFromPairs(pairs: InputPair[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const pair of pairs) {
    const name = pair.name.trim()
    if (!name || !pair.value.trim()) continue
    out[name] = parseValue(pair.value)
  }
  return out
}

/**
 * The rows → what gets sent, or the ones standing in the way.
 *
 * Errors are keyed by row index rather than by name, because the name is the
 * half that can be wrong. A row with a value and no name is the one real
 * mistake this form can make, and it has to be said next to the row rather
 * than swallowed — silently dropping it would send a call missing the very
 * argument someone had just typed.
 *
 * A named row left blank is OMITTED, not sent empty, for the reason
 * `coerceField` omits a blank optional field: half this catalogue answers
 * `?limit=` with a 400. An empty string that is genuinely wanted is typed as
 * `""`.
 */
export function buildPairInputs(
  pairs: InputPair[],
  method: string | null | undefined,
): { errors: Record<number, string>; built: BuiltInputs | null } {
  const errors: Record<number, string> = {}
  const inputs: Record<string, unknown> = {}
  const seen = new Set<string>()

  pairs.forEach((pair, index) => {
    const name = pair.name.trim()
    const filled = pair.value.trim().length > 0

    // An untouched row is not a mistake. The form keeps a spare one at the
    // bottom the way any list of this shape does.
    if (!name && !filled) return
    if (!name) {
      errors[index] = "Give this input a name."
      return
    }
    if (seen.has(name)) {
      errors[index] = "This name is already used above."
      return
    }
    seen.add(name)
    if (!filled) return
    inputs[name] = parseValue(pair.value)
  })

  const parts: InputParts = { path: {}, query: {}, body: {} }
  parts[defaultLocation(method)] = inputs

  return {
    errors,
    built: Object.keys(errors).length ? null : { inputs, parts },
  }
}

/* -----------------------------------------------------------------------------
   Starting from the job, not from nothing
   -------------------------------------------------------------------------- */

/**
 * Field names that mean "the thing you are searching for".
 *
 * Kept narrow on purpose, and matched whole. `url` is deliberately absent: the
 * required input of `web.page-to-text` is a URL, and dropping the sentence
 * "Read a web page as clean text" into it would produce a paid call against a
 * value that is not an address at all.
 */
const QUERY_NAMES = /^(q|query|search|search_query|searchterm|search_term|keywords?|term|topic|text|prompt|question)$/i

/**
 * The job the user typed, put into the field that is asking for it.
 *
 * This is the one prefill that is not putting words in someone's mouth.
 * `initialValues` refuses to prefill a schema's `example`, because that is the
 * PROVIDER's value and sending it as though it were chosen is how a paid call
 * returns an answer about the wrong thing. A job description is the USER's own
 * sentence, typed a moment ago, in the field that means "what are you looking
 * for" — leaving that blank for them to type again is not caution, it is a
 * form that ignores what it was already told.
 *
 * Only ever a required, single-line, free-text field, and only ever the first
 * one: a source that takes two search terms is a source where guessing which
 * gets the job is worse than asking.
 *
 * REQUIRED, and never a member of a "fill in at least one" group — though the
 * group is the form's one question and its members are often literally called
 * `query`. Because `job` is not always a job: Explore opens this same panel
 * with the SERVICE'S OWN NAME in place of a sentence (see `ServiceCard`).
 * That is harmless for the model, which is told to answer only what the job
 * actually states and a product name states nothing, and would be a disaster
 * here — the box would open holding "CrowdPull ZipRecruiter Jobs Scraper",
 * which satisfies the group, un-blocks the button and buys a scrape of the
 * scraper's own name. A required field is refused while it is empty either
 * way, so there the sentence is the better of two states.
 */
export function suggestFromJob(fields: InputField[], job: string): FieldValues {
  const text = job.trim()
  if (!text) return {}

  const target = fields.find(
    (field) =>
      field.required &&
      (field.control === "text" || field.control === "textarea") &&
      field.inputType === "text" &&
      // Asked of the name the PROVIDER used, so a `query` one level inside an
      // object is still the box the sentence belongs in.
      QUERY_NAMES.test(leafName(field)),
  )
  return target ? { [target.name]: text } : {}
}

/* -----------------------------------------------------------------------------
   The field a lookup fills in

   One endpoint in this catalogue wants an 8-digit KVK number and the person
   in front of it has a company name. The gateway already knows this: it
   publishes a PRE-STEP saying "I can resolve `kvkNummer` for €0.02", the panel
   already prices it into the button, and the footer already lists it. The form
   was the only part that had not been told, so it drew the number's own box —
   required, empty, pattern-locked — and refused the name.

   These three functions are that box, corrected: `withLookups` marks the field,
   `nameFromJob` reads the name out of the sentence the person already typed,
   and `coerceField` above stops treating a name as a malformed number.
   -------------------------------------------------------------------------- */

/**
 * The fields, with the ones a pre-step can fill marked and relabelled.
 *
 * The label leads with the NAME and keeps the identifier after it — "Name or
 * Kvk nummer". Both are true, and the order is the whole point: the name is
 * what somebody arrives holding, and a box that names only the number reads as
 * a box that only takes one.
 */
export function withLookups(
  fields: InputField[],
  steps: {
    label: string
    parameter: string | null
    shape?: string | null
    buyerPriceUsd: number
  }[],
): InputField[] {
  if (!steps.length) return fields
  const byParameter = new Map<string, LookupNote>()
  for (const step of steps) {
    if (step.parameter) {
      byParameter.set(step.parameter, {
        label: step.label,
        buyerPriceUsd: step.buyerPriceUsd,
        shape: step.shape ?? null,
      })
    }
  }
  if (!byParameter.size) return fields

  return fields.map((field) => {
    const lookup = byParameter.get(field.name)
    if (!lookup) return field
    return {
      ...field,
      label: `Name or ${field.label.toLowerCase()}`,
      lookup,
    }
  })
}

/**
 * The legal form at the end of a company's name.
 *
 * Matched case-insensitively against a token with its dots and commas taken
 * off, so `B.V.`, `BV`, `bv` and `B.V.,` are one entry. This is the anchor the
 * whole extraction hangs off: a token from this list is not a word somebody
 * used in a sentence, it is the end of a registered name.
 */
const LEGAL_FORMS = new Set([
  "bv", "nv", "vof", "cv", "cvoa", "eenmanszaak", "stichting", "vereniging",
  "cooperatie", "maatschap", "holding", "beheer", "groep", "group",
  "ltd", "limited", "plc", "llp", "llc", "inc", "incorporated", "corp",
  "corporation", "co", "company", "gmbh", "mbh", "ag", "kg", "kgaa", "ug",
  "sa", "sas", "sarl", "srl", "spa", "sl", "sp", "ab", "asa", "oy", "oyj",
  "aps", "as", "bvba", "nvsa", "se", "ou", "sro", "zoo", "doo", "dd", "ad",
  "pty", "pte", "kk", "gk",
])

/**
 * The words that hand a name over.
 *
 * "profiel VAN Mollie", "work AT Mollie", "the KVK number FOR Mollie". A
 * capitalised run straight after one of these is being named as the subject,
 * which is a far safer read than "the longest capitalised run anywhere" — the
 * latter picks up "Basis KVK" out of "Basis KVK profiel van Mollie BV" and
 * spends a lookup on it.
 */
const HANDOVER = new Set([
  // Dutch, because the flagship listing here is a Dutch register and people
  // type the job in the language they think in.
  "van", "voor", "over", "bij", "op",
  "of", "for", "about", "at", "from", "on", "in",
])

/** Tokens that are a register or a document, never the company being named. */
const NOT_A_NAME = new Set([
  "kvk", "kvki", "btw", "vat", "rsin", "sbi", "lei", "iban", "bic", "eori",
  "api", "url", "id", "uuid", "pdf", "csv", "json", "nl", "bv",
])

/** Whether a token opens a capitalised run: `Mollie`, `ASML`, `3M`. */
function capitalised(token: string): boolean {
  const bare = token.replace(/^[^\p{L}\p{N}]+/u, "")
  if (!bare) return false
  return /^\p{Lu}/u.test(bare) || /^\p{N}+\p{Lu}/u.test(bare)
}

/** A token with its punctuation and possessive taken off. */
function bareToken(token: string): string {
  return token
    .replace(/[^\p{L}\p{N}&]+$/u, "")
    .replace(/^[^\p{L}\p{N}&]+/u, "")
    .replace(/['’]s$/u, "")
}

/** The comparison form of a token: `B.V.,` → `bv`. */
function flat(token: string): string {
  return bareToken(token).replace(/[^\p{L}\p{N}]/gu, "").toLowerCase()
}

/**
 * A legal form with its own punctuation left on: `N.V.,` → `N.V.`
 *
 * `bareToken` takes trailing dots off, which is right for `Mollie,` and wrong
 * for `N.V.` — the dots are part of how the name is registered, and a register
 * search is a string match against what somebody wrote down.
 */
function bareLegalForm(token: string): string {
  return token.replace(/[,;:]+$/u, "").replace(/^[^\p{L}\p{N}]+/u, "")
}

/**
 * The company name inside a job, or null when the job does not name one.
 *
 * THREE RULES, AND NOTHING ELSE. All are traceable to words the person typed,
 * which is the standing rule of this file — a suggestion here is a value in a
 * visible box above a Confirm button, never a call, but it still leads to a
 * paid lookup and a wrong one costs somebody two cents and an answer about the
 * wrong company.
 *
 *   1. A capitalised run ending in a legal form. "Basis KVK profiel van
 *      Mollie BV" → `Mollie BV`. A legal form is not a word somebody uses by
 *      accident, so the run in front of it is a registered name.
 *   2. A capitalised word carrying a possessive. "What is Coolblue's KVK
 *      number?" → `Coolblue`.
 *   3. A capitalised run straight after a handover word. "How many people work
 *      at Mollie" → `Mollie`. "profiel van Coolblue" → `Coolblue`.
 *
 * Anything else answers null and the box stays empty, exactly as it is today.
 * Guessing more widely is how a form starts spending money on a word that
 * happened to be capitalised.
 */
export function nameFromJob(job: string): string | null {
  const tokens = job.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return null

  // Rule 1, from the right: the LAST legal form in the sentence, so "BV" in
  // "de BV van Mollie Payments BV" anchors on the one that ends a name.
  for (let i = tokens.length - 1; i >= 0; i--) {
    if (!LEGAL_FORMS.has(flat(tokens[i]))) continue
    let start = i
    while (start > 0 && capitalised(tokens[start - 1])) start--
    if (start === i) continue // A legal form with no name in front of it.
    const run = [
      ...tokens.slice(start, i).map(bareToken),
      bareLegalForm(tokens[i]),
    ].filter(Boolean)
    if (run.length) return run.join(" ")
  }

  // Rule 2: the possessive. "What is COOLBLUE'S KVK number?" — an apostrophe-s
  // on a capitalised word is somebody naming the thing they are asking about,
  // and it is the phrasing an English question falls into most naturally.
  for (const token of tokens) {
    if (!/['’]s$/u.test(token.replace(/[^\p{L}\p{N}'’]+$/u, ""))) continue
    if (!capitalised(token)) continue
    const bare = bareToken(token)
    if (bare && !NOT_A_NAME.has(bare.toLowerCase())) return bare
  }

  // Rule 3: whatever a handover word hands over.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (!HANDOVER.has(flat(tokens[i]))) continue
    let end = i + 1
    while (end < tokens.length && capitalised(tokens[end])) end++
    const run = tokens
      .slice(i + 1, end)
      .map(bareToken)
      .filter((token) => token && !NOT_A_NAME.has(token.toLowerCase()))
    if (run.length) return run.join(" ")
  }

  return null
}

/* -----------------------------------------------------------------------------
   The identifier the job spelled out

   "Basis KVK profiel van 69599084" is somebody who HAS the number. The form
   used to open with that box empty, label it for a name, and price the lookup
   that turns a name into the number they had just typed — the sentence was
   read for a company name, found none, and the eight digits sitting in it
   were never looked at. That is the one prefill nobody should have to wait
   for a model to make: the value is in the job, verbatim, in the exact format
   the field publishes.
   -------------------------------------------------------------------------- */

/**
 * The format an identifier field publishes, as something a token can be held
 * against — or null where the field is not asking for a fixed-width value.
 *
 * TWO SOURCES, THE PROVIDER'S FIRST. The schema's own `pattern` where it is
 * fixed-width (`^[0-9]{8}$`); failing that, the shape the gateway declares on
 * the lookup that fills the field (`digits:8`), which says the same thing in
 * a smaller vocabulary. Either way it is a published fact about the field,
 * not a rule of ours.
 *
 * FIXED WIDTH IS THE WHOLE SAFETY OF THIS. A KVK number, an RSIN, a postcode,
 * a branch number all have one, and a token of exactly that width in a
 * sentence is that identifier and nothing else. A pattern that can stretch
 * (`^[0-9]+$`, `^[a-z]+$`) fits "7" from "the last 7 days" and every word in
 * the job; reading those in would be a form guessing, and a guess here is a
 * paid call about the wrong thing.
 */
function identifierFormat(field: InputField): RegExp | null {
  const published = field.pattern && fixedWidth(field.pattern) ? field.pattern : null
  const source = published ?? shapePattern(field.lookup?.shape)
  if (!source) return null
  try {
    return new RegExp(source)
  } catch {
    // A pattern this browser cannot compile is the provider's problem. The
    // box stays empty, exactly as it did before this existed.
    return null
  }
}

/**
 * Whether a pattern pins its match to one width: anchored at both ends, with
 * nothing in it that lets the match grow or branch.
 *
 * Judged on the pattern's text rather than by parsing it, and conservatively:
 * `+`, `*`, `?`, `|`, `.`, groups and any `{n,m}` range are refused. `\.` is
 * refused along with the wildcard it escapes, which loses nothing worth
 * having.
 */
function fixedWidth(pattern: string): boolean {
  if (!pattern.startsWith("^") || !pattern.endsWith("$")) return false
  if (/[+*?|.()]/.test(pattern)) return false
  return !/\{[^}]*,[^}]*\}/.test(pattern)
}

/** The gateway's `digits:8`, as the pattern it stands for. Null for the rest
 *  of a vocabulary this file does not know. */
function shapePattern(shape: string | null | undefined): string | null {
  if (!shape) return null
  const [kind, size] = shape.split(":")
  const width = Number(size)
  if (kind !== "digits" || !Number.isInteger(width) || width <= 0) return null
  return `^[0-9]{${width}}$`
}

/**
 * Whether a value already IS the identifier a field asks for.
 *
 * The question `askingFor` has to answer about a lookup field. A company name
 * in it is a guess about to be spent resolving, and stays a question; the
 * number itself — typed, or read out of the job — is the answer, no lookup
 * runs, and it folds into "here is what will be sent" like any other value.
 */
export function holdsIdentifier(field: InputField, value: FieldValue | undefined): boolean {
  if (typeof value !== "string") return false
  const format = identifierFormat(field)
  return format !== null && format.test(value.trim())
}

/**
 * The tokens of a job an identifier could be.
 *
 * Split on whitespace, with the punctuation a sentence hangs on a token taken
 * off — "69599084," and "(69599084)" are the number — and kept only where a
 * digit is in it. A word is never an identifier, whatever width it happens to
 * have: `^[a-zA-Z]$` is a real KVK pattern (a house letter) and "a" is a real
 * word.
 */
function identifierTokens(job: string): string[] {
  return job
    .split(/\s+/)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => token && /\p{N}/u.test(token))
}

/**
 * The one token in the job that fits this field's format, or null.
 *
 * ONE. Two different eight-digit runs in a sentence asking for one KVK number
 * is a sentence that has not said which, and taking the first would be a
 * paid call about the wrong company. The same run written twice is one.
 */
function identifierIn(field: InputField, tokens: string[]): string | null {
  const format = identifierFormat(field)
  if (!format) return null
  const fits = new Set(tokens.filter((token) => format.test(token)))
  if (fits.size !== 1) return null
  const [token] = fits
  return token
}

/* -----------------------------------------------------------------------------
   Filling in the rest of the form from the same sentence

   THE RULE, and it is the one that keeps this from being a liability: a
   suggestion is only ever made from something the job SAID. Nothing here
   invents a plausible value, copies a provider's example, or picks the first
   option because a field looked empty — every value below is traceable to a
   word the user typed or to a number the gateway read out of that sentence and
   published in `interpretation`. A wrong guess here is not a blank form, it is
   a PAID CALL against the wrong parameters.
   -------------------------------------------------------------------------- */

/** What the gateway understood about the job, as far as a form cares. */
export interface JobReading {
  /** The job as typed. */
  job: string
  /**
   * The freshness window the gateway read out of the sentence, in days.
   *
   * `interpretation.inferred_recency_days` — already parsed, already on the
   * response, and free. "last week" is 7 here long before any form is drawn.
   */
  recencyDays?: number | null
}

/** Field names that mean "which country or region". */
const REGION_NAMES = /^(country|country_code|region|market|geo|location|locale)$/i

/** Field names that mean "which language". */
const LANGUAGE_NAMES = /^(lang|language|language_code|hl|lr)$/i

/** Field names that mean "how far back", counted in days. */
const WINDOW_NAMES =
  /^(days?|recency|recency_days|days_back|last_days|window|timeframe|time_range|period|age|max_age|max_age_days|since_days)$/i

/** Field names that mean the start of a range. */
const FROM_NAMES = /^(from|start|start_date|since|after|begin|date_from|published_after)$/i

/** Field names that mean the end of a range. */
const TO_NAMES = /^(to|end|end_date|until|before|date_to|published_before)$/i

/**
 * Everything the job can fill in, without asking anyone.
 *
 * Five kinds of suggestion, in descending order of how certain each is:
 *
 *   1. The search field gets the job. Certain — it is the user's own sentence.
 *   2. An identifier the job spelled out: a token that fits the fixed-width
 *      format a field publishes, or the shape the gateway declares for the
 *      lookup that fills it. "KVK profiel van 69599084" against `^[0-9]{8}$`.
 *      Certain — the person typed the number, and it fits nothing else.
 *   3. An enum option whose own value appears in the job as a whole word.
 *      "as csv" against `format: [json, csv, xml]`. Certain, because the user
 *      typed the value the provider published.
 *   4. An enum of two-letter codes where the job names the COUNTRY or the
 *      LANGUAGE those codes stand for. "the Netherlands" against
 *      `country: [nl, de, fr]` is `nl`. Resolved through `Intl.DisplayNames`
 *      rather than a table of our own, so it is every country and every
 *      language rather than the forty somebody remembered — and "Dutch" comes
 *      free, because that is what `nl` is called as a language.
 *   5. A time window from `recencyDays`, which the gateway already read. A
 *      numeric "how many days" field gets the number; a pair of date fields
 *      gets the range it describes.
 *
 * `now` is a parameter so the date arithmetic is testable. It is the only
 * non-deterministic input this function has.
 */
export function prefillFromJob(
  fields: InputField[],
  reading: JobReading,
  now: Date = new Date(),
): FieldValues {
  const job = reading.job.trim()
  if (!job) return {}

  const out: FieldValues = { ...suggestFromJob(fields, job) }
  const words = wordsIn(job)
  const tokens = identifierTokens(job)
  // Read once rather than per field: the sentence does not change, and most
  // forms have no lookup field at all.
  const named = fields.some((field) => field.lookup) ? nameFromJob(job) : null
  // An identifier goes into ONE box. Two fields publishing the same width
  // would otherwise both take the one number in the sentence, and the call
  // would carry it twice under two names.
  const claimed = new Set<string>()

  for (const field of fields) {
    if (out[field.name] !== undefined) continue

    // THE IDENTIFIER ITSELF, where the job spelled it out. "KVK profiel van
    // 69599084" holds the eight digits the field's own pattern asks for, and
    // the person who typed them is done: nothing is looked up, nothing is
    // asked. This outranks the name below, because a job that says both has
    // already said the thing the name would only have been resolved into.
    const identifier = identifierIn(
      field,
      tokens.filter((token) => !claimed.has(token)),
    )
    if (identifier !== null) {
      claimed.add(identifier)
      out[field.name] = identifier
      continue
    }

    // THE NAME GOES IN THE BOX THE LOOKUP FILLS. This is the sixth kind of
    // suggestion and the most literal of them: the person wrote the company's
    // name in the job, the field exists to be resolved from a company name,
    // and the alternative is an empty required box asking them for a register
    // number they came here to find out.
    if (field.lookup && named) {
      out[field.name] = named
      continue
    }

    const value =
      matchOption(field, job, words) ?? matchWindow(field, reading.recencyDays, now)

    if (value !== null) out[field.name] = value
  }

  return out
}

/** The job lower-cased and split on anything that is not a letter or digit. */
function wordsIn(job: string): Set<string> {
  return new Set(job.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean))
}

/**
 * The published option the job named, if it named one.
 *
 * Whole words only. A substring test would match `de` inside "identify" and
 * `us` inside "business" — both of which are ordinary words in a job
 * description and both of which would silently change which country a paid
 * call asked about.
 */
function matchOption(
  field: InputField,
  job: string,
  words: Set<string>,
): FieldValue | null {
  if (!field.options.length) return null

  // The value itself, said outright: "as csv", "in json".
  for (const option of field.options) {
    if (words.has(option.value.toLowerCase())) return option.value
  }

  // A two-letter code the job named in full. Only for fields that are ASKING
  // for a place or a language — an enum of `[id, no, se]` on a field called
  // `mode` is three ordinary words, not Indonesia, Norway and Sweden.
  const kind = REGION_NAMES.test(leafName(field))
    ? "region"
    : LANGUAGE_NAMES.test(leafName(field))
      ? "language"
      : null
  if (!kind) return null

  const haystack = job.toLowerCase()
  for (const option of field.options) {
    const name = displayName(option.value, kind)
    if (name && haystack.includes(name.toLowerCase())) return option.value
  }
  return null
}

/**
 * What a two-letter code is called, or null.
 *
 * `Intl.DisplayNames` throws a `RangeError` on anything that is not a
 * well-formed code and returns the input unchanged for a well-formed one it
 * does not know — so both have to be handled, and neither is an error worth
 * reporting: a field whose options are not codes simply gets no suggestion.
 */
function displayName(code: string, kind: "region" | "language"): string | null {
  if (code.length !== 2) return null
  try {
    const names = new Intl.DisplayNames(["en"], { type: kind })
    const name = names.of(kind === "region" ? code.toUpperCase() : code.toLowerCase())
    // `of` echoes the code back when it has no name for it.
    return name && name.toLowerCase() !== code.toLowerCase() ? name : null
  } catch {
    return null
  }
}

/**
 * The freshness window the gateway read, as this field wants it.
 *
 * Three shapes: a number of days, a start date, an end date. Nothing else —
 * a field called `timeframe` whose options are `[hour, day, week]` is already
 * handled by `matchOption` if the job said one of those words, and guessing
 * between them from a day count is exactly the invention this file refuses to
 * make.
 */
function matchWindow(
  field: InputField,
  recencyDays: number | null | undefined,
  now: Date,
): FieldValue | null {
  if (recencyDays == null || !Number.isFinite(recencyDays) || recencyDays <= 0) {
    return null
  }
  const days = Math.round(recencyDays)

  if (
    WINDOW_NAMES.test(leafName(field)) &&
    (field.inputType === "number" || field.itemType === "integer" ||
      field.itemType === "number")
  ) {
    // A window the provider will not accept is not a suggestion, it is a
    // validation error waiting on the person who did not type it.
    if (field.min != null && days < field.min) return null
    if (field.max != null && days > field.max) return null
    return String(days)
  }

  if (field.inputType === "date") {
    if (FROM_NAMES.test(leafName(field))) return isoDate(addDays(now, -days))
    if (TO_NAMES.test(leafName(field))) return isoDate(now)
  }

  return null
}

function addDays(date: Date, days: number): Date {
  const out = new Date(date.getTime())
  out.setDate(out.getDate() + days)
  return out
}

/** `YYYY-MM-DD`, which is what `<input type="date">` takes. */
function isoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/* -----------------------------------------------------------------------------
   The links a provider wrote inside a field's own note
   -------------------------------------------------------------------------- */

/**
 * One piece of a provider's `description`: either prose, or a link.
 *
 * `href` is null for prose and the absolute URL for a link, so the form can
 * render the note as one sentence with tappable parts in it rather than as a
 * paragraph with a dead URL in the middle.
 */
export interface NotePart {
  text: string
  href: string | null
}

/**
 * A provider's note, split into prose and the URLs written into it.
 *
 * WHY THIS EXISTS. Some parameters cannot be filled in from the note alone,
 * because the note does not carry the values — it carries the way to find
 * them. An events parameter whose description reads "Comma-separated event
 * slugs. These are defined events such as "stock buyback" or "analyst sell
 * rating". Browse available slugs: https://…" is the case that forced it: the
 * two quoted phrases are LABELS, not values, and typing one of them buys a
 * call the provider refuses with "None of requested events found". The only
 * thing on screen that leads to a value the endpoint accepts is the URL, and
 * it was rendered as grey text at the end of a two-line clamp — invisible on a
 * phone, and unclickable everywhere.
 *
 * Nothing here rewrites the provider's words. The sentence is returned whole,
 * in order; the URLs inside it simply become link parts.
 */
export function noteParts(description: string | null | undefined): NotePart[] {
  const text = (description ?? "").trim()
  if (!text) return []

  const parts: NotePart[] = []
  let cut = 0
  for (const match of text.matchAll(NOTE_URL)) {
    const start = match.index ?? 0
    const url = withoutSentenceTail(match[0])
    if (start > cut) parts.push({ text: text.slice(cut, start), href: null })
    parts.push({ text: url, href: url })
    cut = start + url.length
  }
  if (cut < text.length) parts.push({ text: text.slice(cut), href: null })
  return parts
}

/**
 * A URL as written in prose. Stops at whitespace and at the brackets and
 * quotes a sentence wraps a URL in; the trailing punctuation a sentence ends
 * with is taken off separately, because a full stop is legal in a path and
 * "…/slugs." is never the link the provider meant.
 */
const NOTE_URL = /https?:\/\/[^\s<>"'`)\]}]+/g

function withoutSentenceTail(url: string): string {
  return url.replace(/[.,;:!?]+$/, "")
}

/* -----------------------------------------------------------------------------
   When the source published no schema at all
   -------------------------------------------------------------------------- */

/**
 * The parameter names a provider's own description mentions.
 *
 * ---------------------------------------------------------------------------
 * Why guessing from prose is the honest option here
 * ---------------------------------------------------------------------------
 *
 * Roughly half the open x402 index publishes no `input_schema`, so the panel
 * for those endpoints has no form to draw and used to say, in effect, "we
 * don't know — press Run". For a search endpoint that is a call with no query
 * in it, and the reader is left staring at a box asking for a `Name` with
 * nothing on screen telling them what names exist.
 *
 * The names are usually right there in the sentence the provider wrote:
 * "Pass `sources` to narrow", "search by `q`", "…/web/search?q=rust". They are
 * quoted here rather than invented, which is the whole of what makes this
 * different from filling the form in with plausible-looking guesses: every
 * name this returns was written by the provider, and it is offered as a
 * SUGGESTION next to a field somebody can ignore.
 *
 * Three sources, in order of how sure they are:
 *
 *   1. a query string in an example URL — `?q=rust&sources=github`
 *   2. `code spans`, which is how a parameter is written in prose
 *   3. `name=value` written inline
 *
 * Deliberately narrow: identifier-shaped, short, lowercase-ish, and filtered
 * against words that are code-formatted in these descriptions for every reason
 * except being a parameter — `application/json`, `GET`, a bare `200`.
 */
export function parameterHints(description: string | null | undefined): string[] {
  const text = (description ?? "").trim()
  if (!text) return []

  const found: string[] = []
  const add = (raw: string) => {
    const name = raw.trim()
    if (!IDENTIFIER.test(name)) return
    if (NOT_A_PARAMETER.has(name.toLowerCase())) return
    if (found.some((seen) => seen.toLowerCase() === name.toLowerCase())) return
    found.push(name)
  }

  // 1 — every `?a=1&b=2` in the text, which is a provider showing the call.
  for (const [, query] of text.matchAll(/\?([A-Za-z0-9_[\]]+=[^\s"'`),]*)/g)) {
    for (const pair of query.split("&")) add(pair.split("=")[0] ?? "")
  }

  // 2 — code spans. `sources` in "Pass `sources` to narrow".
  for (const [, span] of text.matchAll(/`([^`]{1,32})`/g)) {
    // A span can be a whole example call rather than a name: take the name off
    // the front of `q=rust` and ignore anything with a space in it.
    add(span.includes("=") ? (span.split("=")[0] ?? "") : span)
  }

  // 3 — `name=value` written without backticks or a leading `?`.
  for (const [, name] of text.matchAll(/(?:^|[\s(])([a-z][a-z0-9_]{1,23})=[^\s,)]/gi)) {
    add(name)
  }

  // Four is a row of suggestions; a dozen is a second problem to read.
  return found.slice(0, 4)
}

/** Identifier-shaped and short enough to be a parameter rather than a phrase. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.[\]-]{0,23}$/

/**
 * Words these descriptions put in code formatting that are never a parameter:
 * verbs, content types, statuses, and the units a price is quoted in.
 */
const NOT_A_PARAMETER = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "http",
  "https",
  "json",
  "application",
  "text",
  "true",
  "false",
  "null",
  "usdc",
  "usd",
  "eur",
  "x402",
  "curl",
  "ok",
])

/**
 * The parameter as the PROVIDER named it, beside the label a person reads.
 *
 * `humanize` turns `max_results` into "Max results" so the form reads like a
 * form, and that is right — but it is a one-way transform, and the reader of
 * this panel is someone who has to know what actually goes on the wire. Shown
 * "Query", they cannot tell whether the provider wants `q`, `query`, `Query`
 * or `search_query`, and the schema that answers it is sitting right here.
 *
 * So the exact key is printed next to the label — but ONLY when the label does
 * not already say it. A field the provider calls `query` renders as "Query",
 * and the first version of this printed "Query `query` query": the label, the
 * key and the location, all the same word, on a form whose entire job is to be
 * obvious. Three identical words is not more information than one.
 *
 * The location is gone with it. Where a value goes on the wire — query string,
 * body, path — is how WE assemble the request; the person filling the form is
 * not assembling anything, and "query" as a location beside "query" as a name
 * was the worst of the three collisions.
 *
 * Set in a bordered chip rather than a terminal face — this app has no
 * monospace anywhere (`tests/no-mono.test.ts`), and the box around it is what
 * says "verbatim" instead.
 */
export function showsWireName(field: InputField): boolean {
  if (/^source[._]input[._][a-f0-9]{16,64}[._]/i.test(field.name)) return false;
  // Compared with separators and case removed, so "Max results" covers
  // `max_results` and `maxResults` — the reader has nothing left to guess.
  const flatten = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "")
  return flatten(field.name) !== flatten(field.label)
}
