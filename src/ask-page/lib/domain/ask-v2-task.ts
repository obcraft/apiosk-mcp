import type { GatewayV2Action, GatewayV2Response } from "./gateway-v2"

/**
 * A saved gateway task, opened in Ask at `/?task=<id>`. The rules here are
 * what the task view and the purchase panel both read from a task's view:
 * which decision it waits for, whether this page may act on it, and the exact
 * request a gateway-issued action is sent back with.
 */

/** The shape of a task id in a link (the gateway's task UUID). */
const TASK_ID = /^[0-9a-f-]{36}$/i

/** A task id from a URL parameter, or undefined when it is not one. */
export function taskIdFrom(value: unknown): string | undefined {
  return typeof value === "string" && TASK_ID.test(value) ? value : undefined
}

/** Where a saved task opens: Ask's task view. */
export function taskHref(id: string): string {
  return `/?task=${encodeURIComponent(id)}`
}

const TERMINAL_STATUSES = ["cancelled", "succeeded", "partial", "failed", "unsupported"]

/** Finished, with no worker or analysis still writing to it. */
export function isTerminal(view: GatewayV2Response | null | undefined): boolean {
  return Boolean(view && TERMINAL_STATUSES.includes(view.status) && !view.context_view.worker_active && !view.context_view.analyzing)
}

/**
 * A task a connected chatbot asked for. The person approves it here and only
 * watches: the chatbot's card runs it with its own connection's consent, and
 * the gateway never starts a worker for it. This page must never run a step.
 */
export function isApprovalOnly(view: GatewayV2Response | null | undefined): boolean {
  return view?.context_view.execution_owner === "connected_agent"
}

/** The displayed quote is the one authorised. */
export function isAuthorized(view: GatewayV2Response | null | undefined): boolean {
  return Boolean(view?.billing?.authorization_active && view.billing.quote_ref === view.proposal?.quote_ref)
}

/** An older revision of the same task, which must not replace a newer one on screen. */
export function isStale(next: GatewayV2Response, previous: GatewayV2Response | null | undefined): boolean {
  return Boolean(previous?.state && next.state?.state_ref === previous.state.state_ref && Number(next.state?.revision) < Number(previous.state.revision))
}

export interface TaskActions {
  /** Starts or resumes the approved plan: its quoted step, or a stopped server task's poll. */
  run?: GatewayV2Action
  supply?: GatewayV2Action
  select?: GatewayV2Action
  poll?: GatewayV2Action
  cancel?: GatewayV2Action
  readResult?: GatewayV2Action
  retryAnalysis: GatewayV2Action[]
}

/** The gateway-issued actions of a view, by what they do. */
export function taskActions(view: GatewayV2Response | null | undefined): TaskActions {
  const actions = view?.next_actions ?? []
  const find = (kind: string) => actions.find(action => action.kind === kind)
  const server = view?.context_view.execution_mode === "server"
  return {
    run: find("execute_quoted_step") ?? (server && !view?.context_view.worker_active ? find("poll") : undefined),
    supply: find("supply_input"),
    select: find("select_entity"),
    poll: find("poll"),
    cancel: find("cancel"),
    readResult: find("read_result"),
    retryAnalysis: actions.filter(action => action.kind === "retry_analysis"),
  }
}

/** Readable copy for a technical input label; the gateway action stays literal. */
export function taskInputLabel(action: GatewayV2Action): string {
  const field = /^Provide\s+([a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+)$/.exec(action.label)?.[1]
  if (!field) return action.label
  const title = action.input_schema.properties?.value?.title?.trim()
  if (title && !title.includes(field) && !/source_input\.[a-z0-9]+\./i.test(title)) return title
  if (field === "location.single_building_href") return "Building record URL"
  const name = field.split(".").at(-1) ?? field
  const known: Record<string, string> = { ticker: "Stock ticker", kvknummer: "KVK number", companies_house: "Companies House number", q: field === "geo.input.q" ? "Address" : "Search query" }
  if (known[name]) return known[name]
  return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").split(/\s+/).map((word, index) => {
    const lower = word.toLowerCase()
    if (lower === "href") return "URL"
    if (["id", "url", "vat", "kvk", "bag", "iban", "bic"].includes(lower)) return lower.toUpperCase()
    return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
  }).join(" ")
}

/** A typed value for a `supply_input` action, as its schema declares it. */
export function suppliedValue(action: GatewayV2Action, raw: string): string | number | boolean {
  const type = action.input_schema.properties?.value?.type
  return type === "integer" || type === "number" ? Number(raw) : type === "boolean" ? raw === "true" : raw
}

/** The `/v2/execute` body for one gateway-issued action; its id is its idempotency key. */
export function executeBody(view: GatewayV2Response, action: GatewayV2Action, input: unknown = null) {
  return {
    request_id: crypto.randomUUID(), action_id: action.action_id,
    idempotency_key: action.action_id, state: view.state,
    quote_ref: view.proposal?.quote_ref ?? null, input,
  }
}

const SOURCE_ERROR_CODES = ["incomplete_source", "incomplete_selection", "dependency_failed", "missing_source_fact"]

/** Errors that describe what a source returned, kept with the details rather than shown as alerts. */
export function sourceErrors(view: GatewayV2Response | null | undefined): GatewayV2Response["errors"] {
  return view?.errors.filter(item => SOURCE_ERROR_CODES.includes(item.code)) ?? []
}

/** The next page of a paged saved result, when there is one. */
export function resultPage(result: unknown): { result_ref: unknown; next_offset: number } | null {
  if (!result || typeof result !== "object" || !("next_offset" in result) || !("result_ref" in result)) return null
  return typeof result.next_offset === "number" ? { result_ref: result.result_ref, next_offset: result.next_offset } : null
}

/** Human-readable facts that tell two candidates apart; a source's record slug is not one. */
export function candidateDetail(facts: { type: string; value: unknown }[] | undefined): string {
  const shown = (facts ?? []).filter(fact => /kvk|registration|city|country|lei/i.test(fact.type) && !/slug/i.test(fact.type))
    .map(fact => `${/kvk/i.test(fact.type) ? "KVK " : ""}${String(fact.value)}`)
  return [...new Set(shown)].join(" · ")
}
