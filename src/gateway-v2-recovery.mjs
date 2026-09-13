import { createHash } from "node:crypto";
// Scope a free planning retry to the complete input. Paid action keys stay untouched.
export function planningRetryId(body) {
 const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
 const hex=createHash('sha256').update('apiosk-discover-conflict-v1:'+JSON.stringify(canonical(body))).digest('hex');
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-8'+hex.slice(17,20)+'-'+hex.slice(20,32);
}

export const CLARIFICATION_GUIDANCE = 'The task is waiting for the user. Show the clarification in context_view.conversation (the last reply), then wait for their actual answer. Never invent agreement or submit an answer on their behalf. Continue with their answer and the saved state, omitting request_id. A response request_id identifies the earlier input; do not copy it into changed input.';
