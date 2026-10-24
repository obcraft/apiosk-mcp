import { gatewayV2Request, type GatewayV2Response } from './gateway-v2'
import { executeBody } from './ask-v2-task'

export const SAVED_RESULT_PAGE_LIMIT = 64
export const SAVED_RESULT_CHARACTER_LIMIT = 512_000
const PAGE_CHARACTERS = 8000
const record = (value: unknown): Record<string, unknown> | null => value != null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

/** Same saved payload, current server metadata. A compact refresh must not
 * overwrite corrections with cached coverage or discard an already read body. */
export function refreshSavedResult(cached: unknown, fresh: unknown): unknown {
  const previous = record(cached), current = record(fresh)
  if (!previous?.result_ref || previous.result_ref !== current?.result_ref) return fresh
  const merged = {...previous, ...current}
  if (Object.hasOwn(previous, 'data') && !Object.hasOwn(current, 'data')) {
    merged.data = previous.data
    delete merged.encoding; delete merged.text; delete merged.next_offset
  }
  return merged
}
export type SavedResultPages = { resultRef: string; text: string; offset: number; pages: number; complete?: Record<string, unknown> }
export type ReadSavedResultPage = (resultRef: string, offset: number, signal: AbortSignal) => Promise<unknown>

export function savedResultLimit(pages: SavedResultPages): boolean {
  return !pages.complete && (pages.pages >= SAVED_RESULT_PAGE_LIMIT || pages.offset >= SAVED_RESULT_CHARACTER_LIMIT)
}

/** Offsets count Unicode characters in Gateway, not JavaScript UTF-16 units. */
export function appendSavedResultPage(previous: SavedResultPages, page: unknown, requestedOffset: number): SavedResultPages {
  const value = record(page)
  if (previous.complete || savedResultLimit(previous) || requestedOffset !== previous.offset) throw new Error('Saved result reading limit or offset reached.')
  if (!value || value.result_ref !== previous.resultRef || value.encoding !== 'json_text' || typeof value.text !== 'string') throw new Error('The saved result page did not match this source.')
  const length = Array.from(value.text).length
  const offset = requestedOffset + length
  if (!length || length > PAGE_CHARACTERS || offset > SAVED_RESULT_CHARACTER_LIMIT || (value.next_offset !== null && value.next_offset !== offset)) throw new Error('The saved result page has an invalid continuation.')
  const next = { ...previous, text: previous.text + value.text, offset, pages: previous.pages + 1 }
  if (value.next_offset === null) {
    let complete: Record<string, unknown> | null = null
    try { complete = record(JSON.parse(next.text)) } catch { /* Keep earlier pages available for retry. */ }
    if (!complete || complete.result_ref !== previous.resultRef || !Object.prototype.hasOwnProperty.call(complete, 'data')) throw new Error('The complete saved result could not be read.')
    return { ...next, complete }
  }
  return next
}

export function initialSavedResultPages(result: unknown): SavedResultPages | null {
  const value = record(result)
  if (value?.encoding !== 'json_text' || typeof value.result_ref !== 'string' || !value.result_ref) return null
  const empty = { resultRef: value.result_ref, text: '', offset: 0, pages: 0 }
  try { return appendSavedResultPage(empty, value, 0) } catch { return empty }
}

/** Only a server-issued read action: never a purchase, poll or execution loop. */
export async function readSavedResultPage(view: GatewayV2Response | null, resultRef: string, offset: number, signal: AbortSignal): Promise<unknown> {
  const action = view?.next_actions.find(item => item.action_id === resultRef && item.kind === 'read_result' && item.requires_authorization === false)
  if (!view?.state || !action || !Number.isSafeInteger(offset) || offset < 0 || offset >= SAVED_RESULT_CHARACTER_LIMIT) throw new Error('This saved result is not available to read. Reopen the task to refresh it.')
  const response = await gatewayV2Request<GatewayV2Response>('/v2/execute', { ...executeBody(view, action, { offset }), quote_ref: null }, signal)
  if (signal.aborted) throw new DOMException('Read cancelled', 'AbortError')
  if (response.state?.state_ref !== view.state.state_ref || response.status === 'state_conflict' || Number(response.state.revision) < Number(view.state.revision)) throw new Error('The task changed. Reopen it before continuing this saved result.')
  // A task can retain source/analysis errors while this saved read succeeds.
  // The result identity and page envelope, not sibling task errors, decide whether it is usable.
  if (record(response.result)?.result_ref !== resultRef) throw new Error('The saved result page did not match this source.')
  return response.result
}
