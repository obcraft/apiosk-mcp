import * as React from 'react'
import { useId, useState } from "react"
import { ChevronDown, Minus, Plus } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { Input, Label } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import {
  noteParts,
  objectFromPairs,
  oneOfGroups,
  pairsFrom,
  showsWireName,
  type FieldValue,
  type FieldValues,
  type InputField,
  type InputPair,
} from "@/lib/domain/inputs"
import type { FilledField } from "@/lib/domain/proposal"
import { cn } from "@/lib/ui/utils"

/* -----------------------------------------------------------------------------
   The form a source's own schema describes

   One control per published parameter, chosen from the schema and not from the
   field's name: an enum becomes a picker, a boolean a checkbox, an integer a
   number field with the provider's own range on it, an array a list you add
   rows to, an object a JSON box. A parameter nobody can guess the shape of is
   a parameter that gets left blank, and a blank required parameter is a paid
   call that comes back 400.
   -------------------------------------------------------------------------- */

/**
 * How much of a provider's note two clamped lines hold, near enough.
 *
 * A count of characters rather than a measurement of the box: the note is set
 * in one size everywhere, the number only decides whether an "Show more"
 * control appears, and a resize observer per field is a lot of machinery for
 * that.
 */
const NOTE_CLAMP_CHARS = 110

const CONTROL_CLASS =
  "w-full rounded-lg border bg-[color:var(--input-bg)] px-3.5 py-2.5 text-body text-foreground " +
  "outline-none transition-colors duration-150 placeholder:text-faint " +
  "focus:border-[color:var(--accent-line)] focus:ring-4 focus:ring-[color:var(--accent-wash)]"

/**
 * The fields, split into what the endpoint insists on and what it merely
 * accepts.
 *
 * NOT split by where the value goes on the wire, which is what this did first.
 * "In the address", "Query parameters", "Request body" are accurate, and they
 * are also the shape of an HTTP request — the exact class of thing this
 * product hides everywhere else. A card refuses to name the index an offer
 * came from or the chain it settles on, on the grounds that someone buying an
 * answer should never have to meet one; captioning their form with the parts
 * of a URL is the same mistake in a different place. The wire split still
 * exists and still decides how the request is built (`InputParts`) — it just
 * stopped being something a person has to read.
 *
 * Required first and always open. Optional folded away behind a count, because
 * the honest answer to "what do I have to do here" is usually "one field", and
 * a panel that opens on eight of them says the opposite before anyone has read
 * a label.
 */
export function InputFieldset({
  fields,
  values,
  errors,
  onChange,
  disabled,
  lookups = {},
  justFilled,
  idPrefix = "",
  showTechnicalNames = true,
  compact = false,
}: {
  fields: InputField[]
  values: FieldValues
  /** Shown per field. Empty until the first attempt to run. */
  errors: Record<string, string>
  onChange: (name: string, value: FieldValue) => void
  disabled?: boolean
  /**
   * The fields a value has just ARRIVED in, rather than been typed into.
   *
   * A sentence dropped into `IntentFill` can put values in six boxes at once,
   * several of them below the fold and one of them inside a section that is
   * folded away. Told nothing, the reader presses the button and the form
   * looks exactly as it did — so each of those boxes flashes once, which is
   * the difference between "it worked" and "did it work?".
   *
   * A LIST AND NOT A FLAG PER FIELD, because it is cleared as a whole a second
   * later: the class it drives is a one-shot animation, and a field that kept
   * it would be permanently announcing an event from a minute ago.
   */
  justFilled?: string[]
  /**
   * APIOSK'S own sentence under a field, keyed by field name.
   *
   * Exactly one thing goes here today and it is the thing the KVK form could
   * not say: this box takes an 8-digit register number, and if you type a
   * company name instead a paid lookup turns it into one first. The provider's
   * `description` does mention it — buried at the end of a sentence about
   * national register numbers, in the voice of a schema — and every reader who
   * had a name and not a number had to infer from it that the form was for
   * them. Kept separate from `description` because that field is the
   * PROVIDER'S words and this is ours; they are set in different type for the
   * same reason.
   */
  lookups?: Record<string, string>
  /**
   * Keeps element ids unique when several forms share a page (Ask prices a
   * few sources at once, and two of them may both ask for `company.name`).
   */
  idPrefix?: string
  /** Keep API parameter names out of the buyer form while preserving its labels. */
  compact?: boolean
  showTechnicalNames?: boolean
}) {
  /*
   * THREE SECTIONS, NOT TWO.
   *
   * A one-of group — "give me a KVK number, or a name, or a place" — is a
   * question the form must ask, but none of its members is required on its
   * own. Split on `required` alone and every member falls into the folded
   * "optional settings" section, which is how KVK's search came to be a form
   * with nothing on it. So the groups are lifted out first and drawn at the
   * top, where the question they answer is the reason somebody opened this.
   */
  const groups = oneOfGroups(fields)
  const grouped = new Set<string>()
  for (const members of groups.values()) {
    for (const member of members) grouped.add(member.name)
  }
  const required = fields.filter((field) => field.required && !grouped.has(field.name))
  const optional = fields.filter((field) => !field.required && !grouped.has(field.name))

  const [expanded, setExpanded] = useState(false)
  // A bad value inside a folded section is a message nobody can see, on a
  // submit button that refuses to work for a reason that is off screen. The
  // section opens itself rather than waiting to be found.
  const optionalHasError = optional.some((field) => errors[field.name])
  const showOptional = expanded || optionalHasError

  const rows = (list: InputField[]) =>
    list.map((field) => (
      <FieldRow
        key={field.name}
        field={field}
        lookup={lookups[field.name] ?? null}
        value={values[field.name]}
        error={errors[field.name]}
        onChange={(next) => onChange(field.name, next)}
        disabled={disabled}
        justFilled={justFilled?.includes(field.name)}
        idPrefix={idPrefix}
        showTechnicalNames={showTechnicalNames}
      />
    ))

  return (
    <div className={compact ? "space-y-2" : "space-y-3"}>
      {[...groups].map(([name, members]) => (
        <fieldset key={name} className="rounded-lg border border-border bg-background-2 px-3 pb-3">
          {/* The heading is the whole reason the block has a border: without a
              line saying so, three boxes in a row read as three things to
              fill in rather than three ways to answer one. */}
          <legend className="px-1 text-tiny font-medium text-muted">
            Fill in at least one
          </legend>
          <div className="space-y-3">{rows(members)}</div>
        </fieldset>
      ))}

      {required.length ? (
        <div className="space-y-3">
          {rows(required)}
        </div>
      ) : null}

      {optional.length ? (
        <div className={required.length ? compact ? "pt-1" : "border-t border-border pt-3" : undefined}>
          <button
            type="button"
            onClick={() => setExpanded((open) => !open)}
            aria-expanded={showOptional}
            aria-controls={`${idPrefix}optional-fields`}
            className="flex w-full items-center gap-1.5 py-0.5 text-tiny text-muted transition-colors duration-150 hover:text-foreground"
          >
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "size-3 transition-transform duration-150",
                showOptional && "rotate-180",
              )}
            />
            {showOptional ? "Hide" : "Show"} {optional.length} optional{" "}
            {optional.length === 1 ? "setting" : "settings"}
          </button>

          {/* Kept in the DOM and hidden, not unmounted: a half-filled optional
              field that someone folds away and unfolds again should still hold
              what they typed. */}
          <div
            id={`${idPrefix}optional-fields`}
            hidden={!showOptional}
            className={cn("space-y-3", showOptional && "mt-3")}
          >
            {rows(optional)}
          </div>
        </div>
      ) : null}

      {required.length === 0 && optional.length === 0 && groups.size === 0 ? (
        // This source PUBLISHED that it needs nothing, which is a fact and not
        // a gap — the gap is `UnknownInputs`, one component down, and the two
        // must never share a sentence.
        <p className="text-tiny text-faint">
          This one needs nothing from you.
        </p>
      ) : null}
    </div>
  )
}

/* -----------------------------------------------------------------------------
   The same values, read rather than filled in
   -------------------------------------------------------------------------- */

/**
 * What Apiosk worked out, as a sentence somebody reads before confirming.
 *
 * The proposal's honesty half. A card that says "this source, this price,
 * confirm" and keeps the arguments to itself is a button pressed blind — so
 * every value that was filled in from the job is on screen, in the reader's
 * own words, above the button that spends money on it.
 *
 * NOT A FORM, and that is the whole difference between this and
 * `InputFieldset`. Boxes invite editing, and a column of six filled boxes is
 * the API form this flow exists to replace: it asks somebody to check work
 * they did not do and had no reason to doubt. Text asks them to read one line.
 * `onEdit` is the way back to the form for the reader who does doubt it, and
 * it is one quiet link rather than a control per value.
 *
 * WHAT IS LISTED IS WHAT CAME FROM THE JOB, AND NOTHING ELSE. For a while the
 * proposal dropped the list altogether and kept only the link, because on a
 * real pick the column read `Lang en`, `Option pool pct 10`, `Structure
 * priced` — eight schema defaults nobody chose, stacked between the source
 * and the button. That was the right complaint and the wrong cure: it also
 * hid the query, the country and the window Apiosk had read out of the
 * sentence, which are exactly the values a buyer wants to glance at before
 * confirming. So the caller hands over the values it READ and the number it
 * left at the provider's default (see `isProviderDefault`), the former are
 * printed and the latter are counted, and the link opens both.
 *
 * The wire name is never here. `query`, `gl` and `tbs` are on Advanced details
 * with the endpoint they belong to; this prints the label the schema gave and
 * the value that will be sent.
 */
export function FilledValues({
  filled,
  defaults = 0,
  onEdit,
  disabled,
}: {
  /** The values read from the job. Printed, one line each. */
  filled: FilledField[]
  /** How many more settings were left at the provider's own default. Counted,
   *  never listed — the form behind `onEdit` is where they are. */
  defaults?: number
  /** Open the whole form. Omitted where there is nothing to open. */
  onEdit?: () => void
  disabled?: boolean
}) {
  if (filled.length === 0 && defaults === 0) return null

  return (
    <div className="space-y-1.5">
      {filled.length ? (
        <dl className="space-y-1" aria-label="Filled in from what you asked">
          {filled.map(({ field, text }) => (
            <div key={field.name} className="flex gap-2 text-body">
              {/* A fixed column, so a stack of these reads as a list of answers
                  rather than as ragged prose. Truncated on both halves: a job
                  pasted into a search field can be a paragraph, and a proposal
                  that grows to the height of one is a proposal nobody scrolls
                  past to reach the button. */}
              <dt className="w-24 shrink-0 truncate text-muted sm:w-28">{field.label}</dt>
              <dd className="min-w-0 flex-1 truncate text-foreground" title={text}>
                {text}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-tiny text-muted">
        {defaults > 0 ? (
          // One counted line, so a reader knows the list above is not the
          // whole request without having to read the part that is not theirs.
          <span className="text-faint">
            {defaults === 1
              ? "One more setting at the provider's default."
              : `${defaults} more settings at the provider's defaults.`}
          </span>
        ) : null}
        {onEdit ? (
          <button
            type="button"
            onClick={onEdit}
            disabled={disabled}
            className="underline underline-offset-2 transition-colors duration-150 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            Change what Apiosk filled in
          </button>
        ) : null}
      </p>
    </div>
  )
}

/**
 * One field: its name, its control, the provider's own note about it, and the
 * one sentence saying why it cannot be sent as it stands.
 *
 * A checkbox is laid out the other way round — control first, label beside it —
 * because a lone checkbox under a heading reads as a heading with a stray box
 * under it, and nobody can tell what it turns on.
 */
function FieldRow({
  field,
  value,
  error,
  onChange,
  disabled,
  lookup = null,
  justFilled = false,
  idPrefix = "",
  showTechnicalNames = true,
}: {
  field: InputField
  value: FieldValue | undefined
  error?: string
  onChange: (value: FieldValue) => void
  disabled?: boolean
  /** Apiosk's own sentence under this field. See `InputFieldset`'s `lookups`. */
  lookup?: string | null
  /** Whether a value has just arrived in this box. See `justFilled` above. */
  justFilled?: boolean
  idPrefix?: string
  showTechnicalNames?: boolean
}) {
  const id = `${idPrefix}field-${field.name}`
  /*
   * THE LABEL IS THE PARAMETER, ALWAYS.
   *
   * It used to be a question Apiosk wrote — "What do you want to search for?"
   * over KVK's `naam` — chosen from a verb in the service's name and put in
   * front of the field on any form with exactly one required input. The idea
   * was that a reader should not have to decode a schema. What it did instead
   * was hide the only fact that makes a form checkable against the provider's
   * own documentation: WHICH PARAMETER this box fills.
   *
   * That matters here more than in most products, because everything else on
   * the screen names the real thing — the technical details list `naam*`, the
   * provider's docs call it `naam`, and the error that comes back names it too.
   * A box labelled with a question matches none of them, so a person comparing
   * the form to the docs cannot tell whether the field they need is even on
   * screen.
   *
   * The provider's own `description` sits under the box and is where the prose
   * belongs. The label is the parameter, spelled the way the schema spells it.
   */
  const label = field.label
  const described = [
    field.description ? `${id}-note` : null,
    lookup ? `${id}-lookup` : null,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ")

  if (field.control === "boolean") {
    return (
      <div data-input-field={field.name} className={cn("space-y-1", justFilled && "filled-in")}>
        <div className="flex items-start gap-2.5">
          <Checkbox
            id={id}
            className="mt-0.5"
            checked={value === true}
            disabled={disabled}
            aria-describedby={described || undefined}
            onChange={(e) => onChange(e.currentTarget.checked)}
          />
          <label htmlFor={id} className="text-body text-foreground">
            {label}
            <Required required={field.required} />
            {showTechnicalNames && <WireName field={field} />}
          </label>
        </div>
        <Note id={`${id}-note`} text={field.description} className="pl-6" />
        <LookupNote id={`${id}-lookup`} text={lookup} className="pl-6" />
        <FieldError id={`${id}-error`} text={error} className="pl-6" />
      </div>
    )
  }

  return (
    <div data-input-field={field.name} className={cn("space-y-1", justFilled && "filled-in")}>
      <Label htmlFor={id}>
        {label}
        <Required required={field.required} />
        {showTechnicalNames && <WireName field={field} />}
      </Label>

      <Control
        id={id}
        field={field}
        value={value}
        invalid={Boolean(error)}
        describedBy={described || undefined}
        onChange={onChange}
        disabled={disabled}
      />

      <Note id={`${id}-note`} text={field.description} />
      <LookupNote id={`${id}-lookup`} text={lookup} />
      <FieldError id={`${id}-error`} text={error} />
    </div>
  )
}

/**
 * Apiosk saying what this box will do with a value the schema did not describe.
 *
 * ABOVE the provider's note in weight and below it in the reading order, which
 * is the compromise the two sentences need: the provider's words stay first
 * because they define the field, and ours are the ones someone stuck on the
 * field needs, so they get the accent rather than the grey. Rendered as its
 * own element and not appended to `description` so nothing can mistake it for
 * something the provider published.
 */
function LookupNote({
  id,
  text,
  className,
}: {
  id: string
  text: string | null
  className?: string
}) {
  if (!text) return null
  return (
    <p id={id} className={cn("text-tiny text-accent", className)}>
      {text}
    </p>
  )
}


function WireName({ field }: { field: InputField }) {
  if (!showsWireName(field)) return null
  return (
    <code className="ml-2 rounded-sm border border-border bg-surface-soft px-1 py-px align-middle text-tiny font-normal not-italic text-muted">
      {field.name}
    </code>
  )
}

/**
 * The required mark, and nothing at all for an optional field.
 *
 * An "optional" tag next to every second label was noise the moment optional
 * fields moved into their own section — the section title already says it, and
 * repeating it per row makes the required ones harder to pick out rather than
 * easier.
 */
function Required({ required }: { required: boolean }) {
  if (!required) return null
  return (
    <span className="ml-0.5 text-accent" aria-label="required">
      *
    </span>
  )
}

/**
 * The provider's own words about a field, and the links inside them.
 *
 * TWO LINES BY DEFAULT, whatever the provider wrote. A few of these notes run
 * to a paragraph, and a paragraph under a field is a form where the reading is
 * bigger than the filling in.
 *
 * WHAT THE CLAMP USED TO SWALLOW. On the notes that end in a link — "…defined
 * events such as "stock buyback" or "analyst sell rating". Browse available
 * slugs: https://…" — the two lines held the examples and cut the URL. The
 * examples in prose like that are LABELS, and a person who copies one buys a
 * call the provider refuses; the link is the only thing on screen that leads
 * to a value the endpoint accepts, and it was both invisible and dead. So the
 * URLs are anchors, and a note that carries one — or that is long enough for
 * the clamp to be hiding a sentence — can be unfolded in place.
 *
 * The `title` still holds the whole of it, so a hover and a screen reader get
 * everything without unfolding.
 */
function Note({
  id,
  text,
  className,
}: {
  id: string
  text: string | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  if (!text) return null

  const parts = noteParts(text)
  // Unfoldable on a link, or on prose long enough that two lines of this type
  // on a phone cannot be all of it. A short note gets no control, because a
  // "More" that reveals nothing is a control that teaches people to ignore it.
  const unfoldable = parts.some((part) => part.href) || text.length > NOTE_CLAMP_CHARS

  return (
    <div className={cn("space-y-0.5", className)}>
      <p
        id={id}
        title={text}
        className={cn("text-tiny text-faint", !open && "line-clamp-2")}
      >
        {parts.map((part, index) =>
          part.href ? (
            <a
              key={index}
              href={part.href}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-muted underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
            >
              {part.text}
            </a>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </p>

      {unfoldable ? (
        <button
          type="button"
          onClick={() => setOpen((shown) => !shown)}
          aria-expanded={open}
          aria-controls={id}
          className="text-tiny text-muted underline underline-offset-2 transition-colors duration-150 hover:text-foreground"
        >
          {open ? "Show less" : "Show more"}
        </button>
      ) : null}
    </div>
  )
}

function FieldError({
  id,
  text,
  className,
}: {
  id: string
  text?: string
  className?: string
}) {
  if (!text) return null
  return (
    <p id={id} role="alert" className={cn("text-tiny text-danger", className)}>
      {text}
    </p>
  )
}

/** The control itself, chosen by `field.control` and nothing else. */
function Control({
  id,
  field,
  value,
  invalid,
  describedBy,
  onChange,
  disabled,
}: {
  id: string
  field: InputField
  value: FieldValue | undefined
  invalid: boolean
  describedBy?: string
  onChange: (value: FieldValue) => void
  disabled?: boolean
}) {
  const border = invalid ? "border-danger-border" : "border-border-2"
  const shared = {
    id,
    disabled,
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
  }

  switch (field.control) {
    case "select":
      return (
        <Select
          {...shared}
          className={cn(invalid && "border-danger-border")}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value)}
        >
          {/* Always offered, even on a required field. A select that opens
              already holding the first option is a select that submits a
              choice nobody made. */}
          <option value="">{field.required ? "Choose one…" : "Leave unset"}</option>
          {field.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.value}
            </option>
          ))}
        </Select>
      )

    case "multiselect": {
      const chosen = Array.isArray(value) ? value : []
      return (
        <div
          role="group"
          // The label above is a `<label for>` pointing at an id no single
          // element here carries, so the group names itself.
          aria-label={field.label}
          aria-describedby={describedBy}
          className="flex flex-wrap gap-1.5"
        >
          {field.options.map((option) => {
            const on = chosen.includes(option.value)
            return (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                aria-pressed={on}
                onClick={() =>
                  onChange(
                    on
                      ? chosen.filter((entry) => entry !== option.value)
                      : [...chosen, option.value],
                  )
                }
                className={cn(
                  "rounded-base border px-2 py-1 text-body transition-colors duration-150",
                  on
                    ? "border-[color:var(--accent-line)] bg-accent-wash text-accent"
                    : "border-border-2 bg-surface text-muted hover:bg-hover hover:text-foreground",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                )}
              >
                {option.value}
              </button>
            )
          })}
        </div>
      )
    }

    case "list": {
      // At least one row, always. An empty list control is a control with
      // nothing to click, and "add the first entry" is not a step worth making
      // someone take on a field they were asked to fill in.
      const entries = Array.isArray(value) && value.length ? value : [""]
      const replace = (index: number, next: string) =>
        onChange(entries.map((entry, i) => (i === index ? next : entry)))

      return (
        <div className="space-y-1.5" aria-describedby={describedBy}>
          {entries.map((entry, index) => (
            <div key={index} className="flex gap-1.5">
              <Input
                id={index === 0 ? id : undefined}
                disabled={disabled}
                aria-label={`${field.label} ${index + 1}`}
                aria-invalid={invalid || undefined}
                inputMode={field.itemType === "string" ? undefined : "numeric"}
                placeholder={index === 0 ? (field.placeholder ?? undefined) : undefined}
                className={cn(invalid && "border-danger-border")}
                value={entry}
                onChange={(e) => replace(index, e.currentTarget.value)}
              />
              <button
                type="button"
                disabled={disabled || entries.length === 1}
                aria-label={`Remove ${field.label} ${index + 1}`}
                onClick={() => onChange(entries.filter((_, i) => i !== index))}
                className="flex size-11 shrink-0 items-center justify-center rounded-lg border border-border-2 text-faint transition-colors duration-150 hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Minus className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange([...entries, ""])}
            className="flex items-center gap-1 text-tiny text-muted transition-colors duration-150 hover:text-foreground"
          >
            <Plus className="size-3" aria-hidden="true" />
            Add another
          </button>
        </div>
      )
    }

    case "json":
      return (
        <textarea
          {...shared}
          rows={4}
          spellCheck={false}
          placeholder={field.placeholder ?? '{ }'}
          className={cn(CONTROL_CLASS, border, "resize-y leading-6")}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )

    case "textarea":
      return (
        <textarea
          {...shared}
          rows={1}
          placeholder={field.placeholder ?? undefined}
          className={cn(CONTROL_CLASS, border, "min-h-11 resize-none overflow-hidden leading-6 [field-sizing:content]")}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )

    default:
      return (
        <Input
          {...shared}
          type={field.inputType}
          // The provider's own range, on the control — so a stepper stops
          // where the endpoint stops rather than where the browser guesses.
          min={field.min ?? undefined}
          max={field.max ?? undefined}
          step={field.control === "number" ? (field.step ?? "any") : undefined}
          placeholder={field.placeholder ?? undefined}
          className={cn(invalid && "border-danger-border")}
          value={typeof value === "string" ? value : ""}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
      )
  }
}

/**
 * What a source that published no schema shows instead of a form.
 *
 * The honest position, said in one sentence, and then a way through it.
 *
 * What was here was a Name/Value pair of boxes, an "Add another" and an "Edit
 * as JSON" — the first thing somebody saw on the top result of their first
 * search, because the top result is open on arrival and a good half of this
 * catalogue publishes nothing about its inputs. It asked a person who had
 * typed "convert 100 USD to EUR" to know that this endpoint calls its
 * parameter `from` rather than `base`, `source` or `currency_from`. Nobody
 * knows that. WE do not know it — that is what "no schema" means — and a form
 * whose first field asks for the name of a field is a form asking the reader
 * to do the guessing on our behalf.
 *
 * So the panel says what is true, and — this is the part that was missing —
 * WHAT TO DO ABOUT IT. "No schema, so nothing to fill in. Run it as it is."
 * was accurate and told nobody anything: it left a reader in front of a search
 * endpoint with no query in it, an "Advanced" fold, and a box asking for a
 * `Name` with nothing on screen saying what names exist or what happens to one
 * once it is typed.
 *
 * Three sentences replace it, and each one is a thing the reader can act on:
 *
 *   - press Run, because a call that comes back 400 names what it wanted and
 *     IS REFUNDED IN FULL — trying is how you find out, and it is free;
 *   - the names the provider's own description mentions, offered as chips
 *     that fill a row in (see `parameterHints`) — quoted, never invented;
 *   - where a name actually goes, spelled out with this endpoint's own method
 *     and path: on a GET it is `?name=value` on the URL, on a POST it is a key
 *     in the JSON body. That sentence is the answer to "what do I put here",
 *     and the preview under the rows shows the request being built as it is
 *     typed.
 *
 * The rows still open by themselves in the two cases where they are not a
 * guess: a repeat, where they hold what the last call actually sent, and a
 * failed attempt, where a message is attached to a row somebody has to be able
 * to see.
 */
export function UnknownInputs({
  pairs,
  errors,
  onChange,
  disabled,
  /** Whether the rows opened on a previous call rather than empty. */
  seeded = false,
  /** `GET`, `POST` — where a name lands, and half the preview line. */
  method,
  /** The endpoint as a person reads it, for the preview. */
  endpoint,
  /** Names the provider's description mentions. See `parameterHints`. */
  hints = [],
  /** Whether the rows on screen were proposed rather than typed or repeated.
   *  See `useProposedPairs`. Cleared by the first edit. */
  proposed = false,
}: {
  pairs: InputPair[]
  errors: Record<number, string>
  onChange: (pairs: InputPair[]) => void
  disabled?: boolean
  seeded?: boolean
  method?: string | null
  endpoint?: string | null
  hints?: string[]
  proposed?: boolean
}) {
  const id = useId()
  /**
   * The reader's own choice about this fold, or null until they make one.
   *
   * Not a plain `useState(seeded)`, because the default has to be allowed to
   * change after mount: a proposal arrives a second or two later (see
   * `useProposedPairs`), and a suggestion folded away behind "Technical
   * details" is a suggestion nobody reads — the whole reason for making one is
   * that the reader could not have written it themselves. Holding the CHOICE
   * rather than the state is what lets the default move without reopening a
   * fold somebody has deliberately closed.
   */
  const [chosen, setChosen] = useState<boolean | null>(null)
  // Same rule as the optional section above: a message inside a folded
  // section is a submit button refusing for a reason nobody can see.
  const show =
    (chosen ?? (seeded || proposed)) || Object.keys(errors).length > 0

  const named = new Set(pairs.map((pair) => pair.name.trim().toLowerCase()))
  const unused = hints.filter((hint) => !named.has(hint.toLowerCase()))

  /** A suggestion, taken. Fills the first empty row rather than always adding
   *  one, so clicking two chips does not leave a blank row between them. */
  function takeHint(name: string) {
    const rows = pairs.length ? pairs : [{ name: "", value: "" }]
    const blank = rows.findIndex((row) => !row.name.trim() && !row.value.trim())
    onChange(
      blank === -1
        ? [...rows, { name, value: "" }]
        : rows.map((row, i) => (i === blank ? { name, value: "" } : row)),
    )
    setChosen(true)
  }

  return (
    <div className="space-y-2.5">
      {/* SHORT, and secondary. This is not the message of the card — the card
          says "press Run" — but it is the difference between a reader who
          knows why there is no form and one who thinks the page is broken. */}
      <div className="space-y-1">
        <p className="text-tiny text-faint">
          {seeded
            ? "This source never said what it needs. These are the values the last one was given."
            : proposed
              ? "This source never said what it needs. These names are a guess from its own description and your question — check them before running."
              : "This source never said what it needs, so there is no form to draw."}
        </p>
        {/* WHAT IS NOT HERE ANY MORE: "Run it as it is — if it needs something,
            the answer says what, and a call that fails is refunded in full."
            True, and an invitation to spend money in order to find out what a
            service requires. A refund makes that cost nothing; it does not make
            it a reasonable thing to ask somebody to do. Explore now keeps a
            service in this state out of the normal flow entirely and offers no
            button on it at all (see `lib/domain/services`), so the only readers
            who reach these words arrived from a literal search and can see for
            themselves that nothing was published. */}
      </div>

      {/* The provider's own words, mined for parameter names. Only ever shown
          when the description actually contained some — an empty row of
          suggestions is a promise this cannot keep. */}
      {unused.length ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-tiny text-faint">Names it mentions:</span>
          {unused.map((hint) => (
            <button
              key={hint}
              type="button"
              disabled={disabled}
              onClick={() => takeHint(hint)}
              className="rounded-base border border-border-2 bg-surface px-1.5 py-0.5 text-tiny text-muted transition-colors duration-150 hover:border-[color:var(--accent-line)] hover:text-foreground disabled:opacity-50"
            >
              {hint}
            </button>
          ))}
        </div>
      ) : null}

      <div className="border-t border-border pt-2.5">
        <button
          type="button"
          onClick={() => setChosen(!show)}
          aria-expanded={show}
          aria-controls={id}
          className="flex w-full items-center gap-1.5 py-0.5 text-tiny text-muted transition-colors duration-150 hover:text-foreground"
        >
          <ChevronDown
            aria-hidden="true"
            className={cn("size-3 transition-transform duration-150", show && "rotate-180")}
          />
          {/* One label, in both states — the chevron already says which way
              this is folded. The same two words every other technical fold in
              the app wears, so a reader learns the disclosure once. */}
          Technical details
        </button>

        {/* Hidden rather than unmounted, so values typed into it survive
            being folded away — and so the panel's own close does not lose
            them either. */}
        <div id={id} hidden={!show} className={cn(show && "mt-3 space-y-3")}>
          <p className="text-tiny text-faint">{whereNamesGo(method)}</p>

          <FreeformInputs
            pairs={pairs}
            errors={errors}
            onChange={onChange}
            disabled={disabled}
          />

          <RequestPreview method={method} endpoint={endpoint} pairs={pairs} />
        </div>
      </div>
    </div>
  )
}

/** Where a name/value pair actually ends up, in this endpoint's own terms. */
function whereNamesGo(method?: string | null): string {
  const verb = (method ?? "").toUpperCase()
  if (verb === "GET" || verb === "HEAD" || verb === "DELETE" || !verb) {
    return "Each name is added to the URL as a query parameter: a name of q and a value of rust is sent as ?q=rust. Names come from the provider's own documentation; nothing here invents them."
  }
  return `Each name becomes a key in the JSON body of the ${verb}: a name of q and a value of rust is sent as {"q": "rust"}. Names come from the provider's own documentation; nothing here invents them.`
}

/**
 * The request as it stands, rebuilt on every keystroke.
 *
 * The one thing that turns "Name / Value" from an abstraction into something a
 * person can check: they can see their own words land in a URL, and see that
 * an empty row changes nothing. It shows the endpoint alone before anything is
 * typed, which is also the answer to "what happens if I just press Run".
 */
function RequestPreview({
  method,
  endpoint,
  pairs,
}: {
  method?: string | null
  endpoint?: string | null
  pairs: InputPair[]
}) {
  if (!endpoint) return null

  const verb = (method ?? "GET").toUpperCase()
  const filled = pairs.filter((pair) => pair.name.trim())
  const body = verb !== "GET" && verb !== "HEAD" && verb !== "DELETE"

  const query = filled
    .map(
      (pair) =>
        `${encodeURIComponent(pair.name.trim())}=${encodeURIComponent(pair.value.trim())}`,
    )
    .join("&")

  return (
    <div className="rounded-md border border-border bg-background-2 px-2.5 py-2">
      <p className="text-tiny text-faint">This will call</p>
      <p className="mt-0.5 break-all text-tiny text-foreground">
        <span className="font-medium">{verb}</span> {endpoint}
        {!body && query ? `?${query}` : ""}
      </p>
      {body && filled.length ? (
        <p className="mt-1 break-all text-tiny text-foreground">
          {JSON.stringify(objectFromPairs(filled))}
        </p>
      ) : null}
    </div>
  )
}

/**
 * The rows themselves: a name and a value per input, and a JSON view of the
 * same rows.
 *
 * A named row per input, not an object typed into a textarea. The JSON box
 * this replaces asked someone buying an answer to write valid JSON on a phone,
 * with a trailing comma between them and a call they had already been quoted a
 * price for — and it asked it in the one case where the product knows least,
 * so the person least helped by it was the one most likely to be shown it.
 *
 * Rows are seeded from whatever the last call was given, so a repeat is a form
 * with the values already in it rather than a blank box. When there is nothing
 * to seed from, the rows are empty and the names are the reader's to supply,
 * which is the honest position: nobody knows what this endpoint takes.
 *
 * The JSON view is kept as a second view of the same rows, because pasting an
 * example out of a provider's docs is a real way to fill this in, and because
 * a value that is genuinely an object has to be typed somewhere.
 */
export function FreeformInputs({
  pairs,
  errors,
  onChange,
  disabled,
}: {
  pairs: InputPair[]
  /** Keyed by row index. Empty until the first attempt to run. */
  errors: Record<number, string>
  onChange: (pairs: InputPair[]) => void
  disabled?: boolean
}) {
  // Non-null while the JSON view is open, and it holds the text being typed —
  // which is not always parseable, so the rows cannot be the only state. Rows
  // stay the source of truth: every keystroke that parses writes back to them,
  // and closing the view keeps whatever last did.
  const [json, setJson] = useState<string | null>(null)
  const [jsonError, setJsonError] = useState<string | null>(null)

  const rows = pairs.length ? pairs : [{ name: "", value: "" }]

  const set = (index: number, patch: Partial<InputPair>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))

  function openJson() {
    const object = objectFromPairs(rows)
    setJson(Object.keys(object).length ? JSON.stringify(object, null, 2) : "")
    setJsonError(null)
  }

  function editJson(text: string) {
    setJson(text)
    const trimmed = text.trim()
    if (!trimmed) {
      setJsonError(null)
      onChange([{ name: "", value: "" }])
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      setJsonError("Not valid JSON yet.")
      return
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setJsonError('Give an object, like {"url": "https://example.com"}.')
      return
    }
    setJsonError(null)
    onChange(pairsFrom(parsed))
  }

  if (json !== null) {
    return (
      <div className="space-y-1.5">
        <Label htmlFor="inputs-json">Inputs as JSON</Label>
        <textarea
          id="inputs-json"
          rows={5}
          spellCheck={false}
          disabled={disabled}
          autoFocus
          aria-invalid={Boolean(jsonError) || undefined}
          placeholder={'{\n  "url": "https://example.com"\n}'}
          className={cn(
            CONTROL_CLASS,
            jsonError ? "border-danger-border" : "border-border-2",
            "resize-y leading-6",
          )}
          value={json}
          onChange={(e) => editJson(e.currentTarget.value)}
        />
        <FieldError id="inputs-json-error" text={jsonError ?? undefined} />
        <button
          type="button"
          onClick={() => setJson(null)}
          className="text-tiny text-muted transition-colors duration-150 hover:text-foreground"
        >
          Back to fields
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {rows.map((row, index) => (
        <div key={index} className="space-y-1">
          {/* The name reads as the label it is, and edits as the field it also
              is. Two identical boxes stacked on a phone is the layout this
              replaces: nothing on screen said which one was the name. */}
          <div className="flex items-center gap-1.5">
            <Input
              aria-label={`Input ${index + 1} name`}
              // "Name, like url" — which read as "a name resembling a URL",
              // and was the first thing on screen in a panel whose whole
              // problem is that nobody knows what the names are. The example
              // was doing no work either: the sentence directly above already
              // spells one out end to end ("a name of q and a value of rust is
              // sent as ?q=rust"), so the box only has to say what belongs in
              // it.
              placeholder="Parameter name"
              disabled={disabled}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-invalid={errors[index] ? true : undefined}
              className={cn(
                // `leading-6` re-stated: a later font-size drops the line
                // height the base class set, and this row sits beside a value
                // box that keeps it.
                "h-8 rounded-md border-transparent bg-transparent px-1.5 text-body font-medium text-heading",
                "hover:border-border-2",
                "focus:border-[color:var(--accent-line)] focus:bg-[color:var(--input-bg)]",
                errors[index] && "border-danger-border",
              )}
              value={row.name}
              onChange={(e) => set(index, { name: e.currentTarget.value })}
            />
            <button
              type="button"
              disabled={disabled || rows.length === 1}
              aria-label={`Remove input ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-faint transition-colors duration-150 hover:bg-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Minus className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          <Input
            aria-label={`Input ${index + 1} value`}
            placeholder="Value"
            disabled={disabled}
            value={row.value}
            onChange={(e) => set(index, { value: e.currentTarget.value })}
          />

          <FieldError id={`input-${index}-error`} text={errors[index]} />
        </div>
      ))}

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChange([...rows, { name: "", value: "" }])}
          className="flex items-center gap-1 text-tiny text-muted transition-colors duration-150 hover:text-foreground"
        >
          <Plus className="size-3" aria-hidden="true" />
          Add another
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={openJson}
          className="text-tiny text-muted transition-colors duration-150 hover:text-foreground"
        >
          Edit as JSON
        </button>
      </div>

      <p className="text-tiny text-faint">
        Values are sent as text, unless one reads as a number, true or false.
      </p>
    </div>
  )
}
