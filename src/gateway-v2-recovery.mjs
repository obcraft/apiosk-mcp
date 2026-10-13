import { createHash } from "node:crypto";
// Gateway task errors are nested. Keep their recovery envelope while exposing
// the server's safe diagnostic to older host cards that only read message.
export function gatewayFailure(result, taskRef) {
 const diagnostic = result?.errors?.find(error => typeof error?.message === 'string');
 return { ...result,
  ...(diagnostic && { error_code: diagnostic.code, message: diagnostic.message }),
  ...((taskRef || result?.state?.state_ref) && { recover_task_ref: taskRef || result.state.state_ref }),
 };
}
// Scope a free planning retry to the complete input. Paid action keys stay untouched.
export function planningRetryId(body) {
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const hex=createHash('sha256').update('apiosk-discover-conflict-v1:'+JSON.stringify(canonical(body))).digest('hex');
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
}

export const CLARIFICATION_GUIDANCE = 'The task needs an actual missing detail. With a supply_input or upload action, ask only for its requested value; otherwise show the clarification in context_view.conversation (the last reply). Wait for the user’s actual answer. Never invent agreement or submit an answer on their behalf. Continue with their answer and the saved state, omitting request_id. A response request_id identifies the earlier input; do not copy it into changed input.';
export const UNSUPPORTED_GUIDANCE = 'No automatic plan is ready. If context_view.capability_intake.matches contains sources, show those sources with their actual availability and scope; do not claim that they cover the whole request. Otherwise show the returned no-results message exactly. Do not ask for generic extra context or create a clarification when there is no specific missing input. Do not substitute a catalog browse or promise an approval for this outcome.';
