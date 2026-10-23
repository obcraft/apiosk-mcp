// Model context is a bounded view. The MCP result, embedded UI and saved
// evidence retain their original data; never send host-only metadata upstream.
export const MAX_MODEL_RESULT_BYTES = 64 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const sourceKeys = ['id', 'key', 'source_id', 'endpoint_id', 'api_id', 'name', 'origin', 'capability', 'requested_capability',
  'subject_id', 'subject_label', 'description', 'availability', 'price', 'buyer_price', 'input_values', 'missing_inputs'];

function presentation(value) {
  if (!object(value) || value.schema_version !== 'apiosk.ask.presentation.v1') return value;
  const result = { ...value };
  // These duplicate data already present in the source rows / task summaries.
  for (const key of ['raw', 'source_groups', 'searches', 'selected']) delete result[key];
  if (Array.isArray(value.sources)) result.sources = value.sources.map(source => own(source, sourceKeys));
  if (Array.isArray(value.task_presentations)) result.task_presentations = value.task_presentations.map(task => ({
    id: task.id, kind: task.kind, structuredContent: presentation(task.structuredContent),
  }));
  return result;
}

function bounded(value, path, omissions, depth = 0) {
  if (typeof value === 'string' && value.length > 6000) {
    omissions.push({ path, reason: 'long_text', total_characters: value.length });
    return value.slice(0, 6000) + '\n[Saved text continues; use the saved-result tools for the complete value.]';
  }
  if (value === null || typeof value !== 'object') return value;
  if (depth > 12) { omissions.push({ path, reason: 'nested_data' }); return '[Saved nested data omitted from model context.]'; }
  if (Array.isArray(value)) {
    if (value.length > 40) omissions.push({ path, reason: 'more_items', total_items: value.length, shown_items: 40 });
    return value.slice(0, 40).map((item, index) => bounded(item, `${path}/${index}`, omissions, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    // Raw snapshots and signed backend state are not agent input arguments.
    if (key === '_meta' || key === 'raw' || ['planning_token', 'search_id', 'discovery_id'].includes(key)
      || key === 'state' && object(item) && ('state_ref' in item || 'signature' in item)) return [];
    if (key === 'blob') { omissions.push({ path: `${path}/blob`, reason: 'binary_artifact' }); return []; }
    return [[key, bounded(item, `${path}/${key}`, omissions, depth + 1)]];
  }));
}

export function modelResult(result) {
  const omissions = [];
  const structured = result?.structuredContent;
  let value = structured
    ? { structuredContent: bounded(presentation(structured), '/structuredContent', omissions), isError: !!result.isError }
    : { content: bounded(result?.content || [], '/content', omissions), isError: !!result?.isError };
  const context = value.structuredContent;
  if (context && structured.approval) context.approval = structured.approval;
  const size = () => Buffer.byteLength(JSON.stringify(value));
  // Keep the exact quote and request identity even when a very large saved
  // result cannot fit. Explicitly record omissions so summaries cannot imply
  // that unseen rows were checked. The UI still receives the original result.
  if (context) {
    const protectedKeys = new Set(['request_id', 'status', 'approval', 'input_requirements', 'next_step', 'error', 'errors']);
    const candidates = Object.keys(context).filter(key => !protectedKeys.has(key))
      .sort((a, b) => Buffer.byteLength(JSON.stringify(context[b]) ?? '') - Buffer.byteLength(JSON.stringify(context[a]) ?? ''));
    for (const key of candidates) {
      if (size() <= MAX_MODEL_RESULT_BYTES - 4000) break;
      const omitted = context[key];
      if (key === 'sources' && Array.isArray(omitted)) {
        context.sources = omitted.map(source => own(source, ['id', 'key', 'source_id', 'name', 'origin', 'availability', 'price', 'buyer_price']));
      } else delete context[key];
      omissions.push({ path: `/structuredContent/${key}`, reason: 'context_budget', ...(Array.isArray(omitted) ? { total_items: omitted.length } : {}) });
    }
  }
  if (omissions.length) value.model_context = {
    incomplete_view: true, omissions: omissions.slice(0, 30),
    note: 'This is a bounded model view. The embedded UI and saved MCP evidence retain the complete original result. Do not infer facts from omitted values. Use apiosk_sources for exact input schemas or apiosk_evidence/apiosk_result_page for additional saved evidence; do not repurchase.',
  };
  // Generic non-Ask tools can also return oversized content. Return an explicit
  // context error instead of sending an invalid provider request.
  if (size() > MAX_MODEL_RESULT_BYTES) return JSON.stringify({
    isError: true, request_id: structured?.request_id, status: structured?.status,
    approval: structured?.approval,
    model_context: { incomplete_view: true, reason: 'result_too_large', note: 'The full result remains in the embedded UI and saved evidence. Request a narrower saved-data view before summarizing.' },
  });
  return JSON.stringify(value);
}
