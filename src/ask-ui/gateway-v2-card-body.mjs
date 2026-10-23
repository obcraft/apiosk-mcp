// The App's answer reader (app/src/components/discover/answer-view.tsx and
// app/src/lib/ui/answer.ts), for the card. A source result is drawn as what it
// is: records as rows, a record's name as its heading, links live, prose as
// prose. Nothing is summarised or dropped; the readable view contains no JSON.
// Rules are by key name and shape, never by value. Keep in sync with the App.
const BODY_NOISE_KEYS = new Set(["id", "uuid", "guid", "objectid", "key", "slug", "hash", "etag", "checksum", "signature", "nonce", "cursor", "pagetoken", "nextpagetoken", "page", "pagenumber", "pagina", "pagesize", "perpage", "resultsperpage", "resultatenperpagina", "offset", "hasmore", "hasnext", "hasnextpage", "nextpage", "prevpage", "previouspage", "contenttype", "mimetype", "charset", "encoding", "statuscode", "httpstatus", "requestid", "traceid", "correlationid", "apiversion", "schemaversion", "typename"]);
const BODY_LINK_OBJECT_KEYS = new Set(["href", "rel", "type", "title", "name", "method", "templated", "hreflang", "profile", "deprecation"]);
const BODY_ENVELOPE_KEYS = new Set(["data", "result", "results", "response", "payload", "body", "content", "items", "records", "rows", "list", "output", "value", "values", "fields", "opendatafields"]);
const BODY_NAME_KEYS = ["sourcename", "name", "title", "headline", "label", "provider", "symbol"];
const BODY_IMAGE_KEYS = ["sourceimg", "image", "img", "logo", "icon", "avatar", "thumbnail", "picture"];
const BODY_LINK_KEYS = ["weburl", "url", "link", "href", "website", "site"];

export function bodyIsRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
export function bodyIsUrl(value) { return /^https?:\/\/\S+$/i.test(String(value).trim()); }
export function bodyIsImageUrl(value) { return /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(String(value).trim()); }
export function bodyAsDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2})?/.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
export function bodyLabel(key) {
  const words = String(key).replace(/^_+/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : String(key);
}
export function bodyHost(url) { try { return new URL(url).host; } catch { return url; } }
function bodyFlatten(key) { return String(key).replace(/[\s_-]+/g, "").toLowerCase(); }
export function isNoiseKey(key) {
  if (BODY_NOISE_KEYS.has(bodyFlatten(key))) return true;
  const bare = String(key).replace(/^_+/, "");
  return /[_\-\s](id|ids|uuid|guid|key|hash|token|checksum)$/i.test(bare) || /[a-z0-9](Id|Ids|UUID|Uuid|GUID|Guid|Key|Hash|Token|Checksum)$/.test(bare);
}
export function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (bodyIsRecord(value)) return Object.keys(value).length === 0;
  return false;
}
function isLinkObject(value) {
  if (!bodyIsRecord(value)) return false;
  const keys = Object.keys(value).map(bodyFlatten);
  return keys.includes("href") && keys.every(key => BODY_LINK_OBJECT_KEYS.has(key));
}
export function isLinkPlumbing(value) {
  if (isLinkObject(value)) return true;
  if (Array.isArray(value)) return value.length > 0 && value.every(isLinkObject);
  if (bodyIsRecord(value)) { const values = Object.values(value); return values.length > 0 && values.every(inner => isLinkPlumbing(inner)); }
  return false;
}
/** Plumbing out, but never emptied: a record of only identifiers is drawn whole. */
export function withoutPlumbing(record) {
  const kept = Object.entries(record).filter(([key, value]) => !isNoiseKey(key) && !isEmptyValue(value) && !isLinkPlumbing(value));
  return kept.length ? Object.fromEntries(kept) : record;
}
/** Peel `{ data: ... }`-style envelopes while exactly one meaningful key remains. */
export function unwrapEnvelope(value, limit = 4) {
  let current = value;
  for (let i = 0; i < limit; i++) {
    if (!bodyIsRecord(current)) return current;
    const entries = Object.entries(current).filter(([key, inner]) => !isNoiseKey(key) && !isEmptyValue(inner) && !isLinkPlumbing(inner));
    if (entries.length !== 1 || !BODY_ENVELOPE_KEYS.has(bodyFlatten(entries[0][0]))) return current;
    current = entries[0][1];
  }
  return current;
}
function readPair(item) {
  if (!bodyIsRecord(item)) return null;
  let key = null, value, hasValue = false, children = null;
  for (const [name, inner] of Object.entries(item)) {
    const flat = bodyFlatten(name);
    if (key === null && ["key", "name", "field"].includes(flat) && typeof inner === "string") { key = inner.trim(); continue; }
    if (!hasValue && ["value", "val"].includes(flat)) { value = inner; hasValue = true; continue; }
    if (children === null && Array.isArray(inner)) { children = inner; continue; }
    return null;
  }
  if (!key || (!hasValue && children === null)) return null;
  if (children !== null && children.length > 0) { const nested = pairsToRecord(children); return nested === null ? null : [key, nested]; }
  return [key, hasValue ? value : null];
}
/** A list of `{ key, value }` pairs is one record, e.g. KVK annual accounts. */
export function pairsToRecord(items) {
  if (!items.length) return null;
  const held = new Map();
  for (const item of items) {
    const pair = readPair(item);
    if (!pair) return null;
    if (held.has(pair[0])) held.get(pair[0]).push(pair[1]); else held.set(pair[0], [pair[1]]);
  }
  return Object.fromEntries([...held].map(([key, values]) => [key, values.length === 1 ? values[0] : values]));
}
export function isProse(value) {
  const text = String(value).trim();
  return !!text && !bodyIsUrl(text) && (text.includes("\n") || text.length > 180);
}
/** Headings, paragraphs, bullets and numbered lists; no inline markup. */
export function readBlocks(text) {
  const blocks = [];
  let paragraph = [], items = [], listKind = null;
  const endParagraph = () => { if (paragraph.length) blocks.push({ kind: "paragraph", text: paragraph.join("\n") }); paragraph = []; };
  const endList = () => { if (listKind && items.length) blocks.push({ kind: listKind, items }); items = []; listKind = null; };
  for (const line of String(text).replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) { endParagraph(); endList(); continue; }
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) { endParagraph(); endList(); blocks.push({ kind: "heading", text: heading[2], level: Math.min(heading[1].length, 3) }); continue; }
    const bullet = /^ {0,3}[-*•]\s+(.+)$/.exec(line), numbered = /^ {0,3}\d{1,3}[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? "bullets" : "numbers";
      endParagraph(); if (listKind !== kind) endList(); listKind = kind; items.push((bullet || numbered)[1].trim()); continue;
    }
    endList(); paragraph.push(line.trimEnd());
  }
  endParagraph(); endList();
  return blocks;
}

// ---- DOM, run inside the card only (uses the card's el/text/window.apiosk) ----
function answerBody(value) {
  const body = unwrapEnvelope(displayData(value)), wrap = el("div", "answer-body");
  if (bodyIsRecord(body) && Array.isArray(body.value) && Object.keys(body).some(key => key.startsWith("@odata."))) {
    const { value: records, ...metadata } = body, meta = el("details", "body-meta");
    meta.append(el("summary", "", "Source metadata"), bodyFields(metadata, 0)); meta.ontoggle = () => window.apiosk.resize();
    wrap.append(bodyNode(records, 0), meta); return wrap;
  }
  wrap.append(bodyNode(body, 0)); return wrap;
}
function bodyMuted(value) { return el("span", "body-muted", value); }
function bodyNode(value, depth) {
  if (value === null || value === undefined) return bodyMuted("null");
  if (typeof value === "string") return isProse(value) ? bodyProse(value) : bodyScalar(value);
  if (typeof value === "number" || typeof value === "boolean") return el("span", "body-number", String(value));
  if (Array.isArray(value)) return bodyList(value, depth);
  if (bodyIsRecord(value)) return bodyFields(value, depth);
  return bodyMuted("not shown");
}
function bodyTableColumns(items) {
  if (items.length < 2 || !items.every(bodyIsRecord)) return null;
  const columns = Object.keys(items[0]);
  if (!columns.length || columns.length > 10 || columns.some(key => BODY_NAME_KEYS.includes(key.toLowerCase()) || BODY_IMAGE_KEYS.includes(key.toLowerCase()))) return null;
  return items.every(item => Object.keys(item).length === columns.length && columns.every(key => Object.hasOwn(item, key) && !bodyIsRecord(item[key]) && !Array.isArray(item[key]) && !(typeof item[key] === "string" && isProse(item[key])))) ? columns : null;
}
function bodyList(items, depth) {
  if (!items.length) return bodyMuted("Empty list.");
  const spelled = pairsToRecord(items);
  if (spelled) return bodyFields(spelled, depth);
  const scalars = items.every(item => !bodyIsRecord(item) && !Array.isArray(item));
  if (scalars && items.some(item => typeof item === "string" && isProse(item))) {
    const list = el("ul", "body-bullets");
    for (const item of items) { const li = el("li"); li.append(el("span", "body-dot", "•"), typeof item === "string" ? el("span", "body-prose-item", item) : bodyNode(item, depth + 1)); list.append(li); }
    return list;
  }
  if (scalars) { const list = el("ul", "body-chips"); for (const item of items) { const li = el("li"); li.append(bodyNode(item, depth + 1)); list.append(li); } return list; }
  const wrap = el("div", "body-list"), columns = bodyTableColumns(items);
  const draw = all => {
    const shown = all ? items : items.slice(0, 20), rest = items.length - shown.length, parts = [];
    if (columns) {
      const region = el("div", "body-table-wrap"), table = el("table", "body-table"), head = el("tr"), thead = el("thead"), tbody = el("tbody");
      region.setAttribute("role", "region"); region.setAttribute("aria-label", "Result records"); region.tabIndex = 0;
      table.append(el("caption", "", items.length + " results"));
      for (const key of columns) { const th = el("th", "", bodyLabel(key)); th.setAttribute("scope", "col"); head.append(th); }
      thead.append(head);
      for (const item of shown) { const tr = el("tr"); for (const key of columns) { const td = el("td"); td.append(bodyNode(item[key], depth + 1)); tr.append(td); } tbody.append(tr); }
      table.append(thead, tbody); region.append(table); parts.push(region);
    } else {
      const list = el("ol", "body-records");
      for (const item of shown) { const li = el("li"); li.append(bodyIsRecord(item) ? bodyRecord(item, depth + 1) : bodyNode(item, depth + 1)); list.append(li); }
      parts.push(el("p", "body-count", items.length + (items.length === 1 ? " result" : " results")), list);
    }
    if (rest > 0) { const more = el("button", "body-more", "Show " + rest + " more"); more.type = "button"; more.onclick = () => { draw(true); window.apiosk.resize(); }; parts.push(more); }
    wrap.replaceChildren(...parts);
  };
  draw(false);
  return wrap;
}
function bodyRecord(record, depth) {
  const entries = Object.entries(withoutPlumbing(record)), wrap = el("div", "body-record");
  const nameKey = entries.find(([key, value]) => typeof value === "string" && BODY_NAME_KEYS.includes(key.toLowerCase()));
  const imageKey = entries.find(([key, value]) => typeof value === "string" && BODY_IMAGE_KEYS.includes(key.toLowerCase()) && bodyIsUrl(value));
  const linkKey = entries.find(([key, value]) => typeof value === "string" && BODY_LINK_KEYS.includes(key.toLowerCase()) && bodyIsUrl(value));
  const rest = entries.filter(([key]) => key !== nameKey?.[0] && key !== imageKey?.[0]);
  if (nameKey || imageKey) {
    const head = el("div", "body-record-head"), copy = el("div", "body-record-copy");
    if (imageKey) head.append(bodyThumb(imageKey[1]));
    if (nameKey) copy.append(el("p", "body-record-name", nameKey[1]));
    if (linkKey) copy.append(bodyLink(linkKey[1], bodyHost(linkKey[1])));
    head.append(copy); wrap.append(head);
  }
  if (rest.length) wrap.append(bodyFields(Object.fromEntries(rest), depth));
  return wrap;
}
function bodyFields(record, depth) {
  const entries = Object.entries(withoutPlumbing(record));
  if (!entries.length) return bodyMuted("Nothing in it.");
  const grid = rows => {
    const dl = el("dl", "body-fields");
    for (const [key, value] of rows) {
      const row = el("div", "result-row"), dd = el("dd", "value");
      dd.append(depth >= 8 && (bodyIsRecord(value) || Array.isArray(value)) ? bodyMuted(bodySummarise(value)) : bodyNode(value, depth >= 8 ? depth : depth + 1));
      row.append(el("dt", "key", bodyLabel(key)), dd); dl.append(row);
    }
    return dl;
  };
  if (depth >= 8) return grid(entries);
  const wrap = el("div", "body-group");
  const flat = entries.filter(([, value]) => !bodyIsRecord(value) && !Array.isArray(value) && !(typeof value === "string" && isProse(value)));
  if (flat.length) wrap.append(grid(flat));
  const prose = entries.filter(([, value]) => typeof value === "string" && isProse(value)), nested = entries.filter(([, value]) => bodyIsRecord(value) || Array.isArray(value));
  for (const [key, value] of [...prose, ...nested]) {
    const part = el("section", "body-section");
    part.append(el("h4", "", bodyLabel(key)), typeof value === "string" ? bodyProse(value) : bodyNode(value, depth + 1));
    wrap.append(part);
  }
  return wrap;
}
function bodyProse(value) {
  const blocks = readBlocks(value), wrap = el("div", "body-prose");
  if (!blocks.length) return bodyMuted("empty");
  for (const block of blocks) {
    if (block.kind === "heading") { wrap.append(el("p", "body-prose-heading", block.text)); continue; }
    if (block.kind === "paragraph") { wrap.append(el("p", "", block.text)); continue; }
    const list = el(block.kind === "numbers" ? "ol" : "ul");
    for (const item of block.items) list.append(el("li", "", item));
    wrap.append(list);
  }
  return wrap;
}
function bodyScalar(value) {
  const trimmed = value.trim();
  if (!trimmed) return bodyMuted("empty");
  if (bodyIsUrl(trimmed)) {
    if (!bodyIsImageUrl(trimmed)) return bodyLink(trimmed, trimmed);
    const wrap = el("div", "body-image"); wrap.append(bodyThumb(trimmed), bodyLink(trimmed, trimmed)); return wrap;
  }
  const when = bodyAsDate(trimmed);
  if (when) { const span = el("span", "", when); span.title = trimmed; return span; }
  return el("span", "body-text", trimmed);
}
function bodyThumb(src) {
  const img = el("img", "body-thumb"); img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
  img.onerror = () => img.remove(); img.src = src; return img;
}
function bodyLink(href, label) {
  const a = el("a", "body-link", label); a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
  a.onclick = event => { event?.preventDefault?.(); void window.apiosk.openLink(href); };
  return a;
}
function bodySummarise(value) {
  if (Array.isArray(value)) return value.length + (value.length === 1 ? " item" : " items");
  const count = Object.keys(value).length;
  return count + (count === 1 ? " detail" : " details");
}

const CONSTANTS = { BODY_NOISE_KEYS, BODY_LINK_OBJECT_KEYS, BODY_ENVELOPE_KEYS };
export const V2_CARD_BODY = [
  ...Object.entries(CONSTANTS).map(([name, set]) => `const ${name}=new Set(${JSON.stringify([...set])});`),
  `const BODY_NAME_KEYS=${JSON.stringify(BODY_NAME_KEYS)},BODY_IMAGE_KEYS=${JSON.stringify(BODY_IMAGE_KEYS)},BODY_LINK_KEYS=${JSON.stringify(BODY_LINK_KEYS)};`,
  bodyIsRecord, bodyIsUrl, bodyIsImageUrl, bodyAsDate, bodyLabel, bodyHost, bodyFlatten, isNoiseKey, isEmptyValue, isLinkObject, isLinkPlumbing,
  withoutPlumbing, unwrapEnvelope, readPair, pairsToRecord, isProse, readBlocks,
  answerBody, bodyMuted, bodyNode, bodyTableColumns, bodyList, bodyRecord, bodyFields, bodyProse, bodyScalar, bodyThumb, bodyLink, bodySummarise,
].map(value => typeof value === "function" ? value.toString() : value).join("\n");
