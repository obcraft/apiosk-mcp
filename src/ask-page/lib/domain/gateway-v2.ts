// App types and exact money formatting; the embedded reader has no account transport.
import { microToCentsUp } from '@/lib/ui/money-display'

import type { AnswerPresentation } from './answer-presentation'

import type { AnswerExtension, LegacyPresentationStub } from './answer-blocks'

import type { SourceUsageNotice } from './source-usage-notice'

import type { AskV2SourceSelectionContext } from './ask-v2-source-selection'


import type { CapabilityIntake } from "./capability-intake"


interface GatewayV2State {
  schema_version: "2"; state_ref: string; revision: number; expires_at: string
  focus: { entity_refs: string[]; goal_refs: string[] }; state_token: string
}

export type GatewayV2Status = "ready" | "needs_input" | "needs_selection" | "requires_approval" | "running" | "cancelled" | "succeeded" | "partial" | "unsupported" | "state_conflict" | "failed"

export interface GatewayV2Action {
  action_id: string; kind: string; label: string; requires_authorization: boolean
  input_schema: {
    type?: string
    properties?: { value?: { type?: string; title?: string; description?: string }; entity_ref?: { enum?: string[] } }
    /** `upload_document`: what the file is read for, the workflow it starts, and the files accepted. */
    "x-purpose"?: string; "x-workflow"?: string; "x-accept"?: string; "x-max-bytes"?: number
  }
}

export interface GatewayV2Turn {
  question: string
  reply: string | null
  /** `billing` is the cost of the turn that bought its results, once a saved-results follow-up replaced the task's quote. */
  output?: { proposal: GatewayV2Response["proposal"]; result_ref?: string | null; result?: unknown; results?: unknown[]; report?: GatewayV2Report | null; analysis?: GatewayV2Analysis | null; billing?: GatewayV2Response["billing"] } | null
}

export interface GatewayV2Report { format: "pdf"; filename: string; download_path: string; expires_at: number; evidence_download_path?: string }

export interface GatewayV2SupplierVerdict {
  decision: "hold" | "review" | "ok"
  label: string
  headline: string
  language: "nl" | "en"
  reasons: string[]
  supplier: { name: string | null; kvk_number: string | null; vat_number: string | null; iban_masked: string | null; domain: string | null }
  checks: { id: string; label: string; status: "pass" | "warn" | "fail" | "unknown"; detail: string; source: string | null; evidence: { result_ref: string; pointer: string; value: unknown }[] }[]
}

export interface GatewayV2IntakeRecovery {
  question: string
  stage: "parsing" | "planning"
  message: string
  context_delta: Record<string, unknown>
}

/** Optional publisher excerpts saved with the answer, outside its primary evidence. */
export interface GatewayV2SupportingNews {
  publisher: string
  title: string
  summary: string
  url: string
  published_at: string
  feed_url: string
}

/**
 * Version 2 adds `AnswerExtension` (backlog #55): all its keys are additive
 * and absent on a v1 analysis, so they are optional here. Use
 * `isBlocksAnswer` (`answer-blocks-view.ts`) to check `answer_schema_version`
 * and narrow `blocks` before reading it.
 */
export interface GatewayV2Analysis extends Partial<AnswerExtension> {
  status: string
  method?: string
  analysis_model?: string
  presentation?: AnswerPresentation | LegacyPresentationStub | null
  follow_up_question?: string | null
  /** `supplier_payment_check` carries a `verdict` that replaces the observation text. */
  kind?: string
  verdict?: GatewayV2SupplierVerdict | null
  supporting_news?: GatewayV2SupportingNews[]
  company_context?: import('./subject-context').SubjectContext[]
  limitations: string[]
  observations: { text: string; evidence: { result_ref: string; pointer: string; field?: string; value: string | number | boolean; subject?: { label?: string }; source?: { name?: string } }[] }[]
}

export interface GatewayV2Response {
  billing?: { workspace?: {workspace_id:string;name?:string;organisation_name?:string}; authorization_active?: boolean; quote_ref?: string | null; status: string; funding_source: string; currency: string; unit: string; provider_cost: string | null; apiosk_fee: string | null; fee_percent?: number; total_charged: string; reserved: string; balance_available: string | null; executions: { execution_id: string; receipt_ref: string | null; status: string; total_charged: string }[] } | null
  protocol_version: "2"; request_id: string; status: GatewayV2Status; state: GatewayV2State | null
  context_view: { static_price?: boolean; requote?: { previous_quote_ref: string; changed: boolean }; source_selection?: AskV2SourceSelectionContext; analysis_upgrade?: { current_output_quote_ref?: string | null; model_id?: string; models?: { id: string; name: string; max_total_atomic: string; description?: string }[]; compute_only?: boolean; model: string; max_total_atomic: string; provider: string; can_choose: boolean; enabled: boolean; output_quotes: string[]; status?: string }; coverage_notices?: string[]; intake_recovery?: GatewayV2IntakeRecovery | null; capability_intake?: CapabilityIntake | null; execution_mode?: string; worker_active?: boolean; events_path?: string; result_refs?: string[]; results?: unknown[]; report?: GatewayV2Report | null; analysis?: GatewayV2Analysis | null; analyzing?: boolean; cooldown?: { until: string; message: string }; single_call_mode?: boolean; research_paused?: boolean; related_services?: { service_ref: string; entity_ref: string; title: string; provider: string; subject: string; total_atomic: string }[]; conversation?: GatewayV2Turn[]; upload_request?: { purpose: string; workflow?: string; accept: string; max_bytes: number } | null; result_is_historical?: boolean; execution_enabled?: boolean; execution_owner?: string; entities?: { entity_ref: string; label: string }[]; candidates?: { entity_ref: string; label: string; facts?: { type: string; value: unknown }[] }[]; candidates_note?: string | null }
  proposal: { label: string; quote_ref: string; max_total_atomic: string; currency: string; expires_at: string; approval_url: string; steps: string[]; step_details?: { kind?: "compute"; number: number; title: string; max_total_atomic?: string; currency?: string; conditional?: boolean; condition?: string | null; subject?: string; error?: { message?: string }; status?: "pending" | "running" | "completed" | "failed" | "cancelled" | "paused"; source: { name: string; slug: string; usage_notice?: SourceUsageNotice | null; directory_slug?: string; directory_name?: string; logo_url?: string | null; url?: string | null }; dependencies: { step: number; field: string; label: string }[] }[] } | null
  next_actions: GatewayV2Action[]; result: unknown; errors: { code: string; message: string }[]; retry_after_ms?: number
}

export function formatMicroUsd(value: string): string {
  if (!/^\d+$/.test(value)) throw new Error("Invalid amount")
  const n = BigInt(value)
  // Amounts paid or approved: at cents, never shown below what can be charged.
  if (n > 0n && n < 10_000n) return "< 0.01 USD"
  const cents = microToCentsUp(n)
  return `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")} USD`
}


/** What a non-2xx gateway response said, for callers that act on its code or body. */
export interface GatewayV2Rejection { status: number; code: string | null; body: Record<string, unknown> }
export const formatAtomicUsdc = formatMicroUsd
export async function gatewayV2Request<T>(..._args: unknown[]): Promise<T> { throw new Error('Use the saved MCP request to read this result.') }
