import { formatDisplayText, formatDisplayNarrative, isLiteralField } from './display-text.mjs';
import { sourceCurrency } from './source-value-format.mjs';
import { readBlocks } from './gateway-v2-card-body.mjs';
// The App's answer text (app/src/lib/domain/gateway-v2-answer.ts and
// answer-format.ts): every observation, period headings, source notes, every
// specific limitation and the follow-up question. Display only; the saved
// analysis and its evidence stay unchanged. Keep in sync with the App.
const ANSWER_GENERIC_LIMITATIONS = new Set([
  'Some requested source calls did not return usable data. This analysis is incomplete.',
  'Some source information is unavailable. The answer uses the available results.',
  'The returned source response contains no usable records for this question. No finding can be supported from it.',
]);
const ANSWER_PERIOD_KEYS = ['fiscal_year', 'financial_year', 'year', 'fiscalYear', 'financialYear', 'period_end', 'periodEnd', 'fiscal_year_end', 'financialYearEnd', 'reporting_year', 'date_fin_exercice'];

function answerRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
export function answerLocale(question, analysis) {
  // Registry descriptions and source quotations retain their own language;
  // they must not change the answer's headings or financial number format.
  const narrative = (analysis?.observations || []).map(observation => {
    const sourceText = (observation.evidence || []).map(e => e.value)
      .filter(value => typeof value === 'string' && value.length >= 3)
      .sort((a, b) => b.length - a.length);
    return sourceText.reduce((text, value) => text.replaceAll(value, ' '), observation.text || '');
  }).join(' ');
  const detect = text => {
    const prose = String(text || '').replace(/https?:\/\/\S+|"[^"\n]*"|“[^”\n]*”/g, ' ');
    const dutch = new Set(prose.match(/\b(de|het|een|zijn|voor|van|heeft|bedraagt|volgens|toont|werden|en|is|dit|deze|wordt|met|geen|niet|kan|kun|welke|geef)\b/gi)?.map(word => word.toLowerCase()));
    const english = new Set(prose.match(/\b(the|a|an|are|for|of|has|have|according|shows|were|and|is|this|these|with|no|not|can|could|which|what|show|get)\b/gi)?.map(word => word.toLowerCase()));
    if (dutch.size >= 2 && dutch.size > english.size) return 'nl-NL';
    if (english.size >= 2 && english.size > dutch.size) return 'en-US';
    return null;
  };
  return detect(narrative) ?? detect(question) ?? 'en-US';
}
/** The App's formatSourceValue, with its locale: Dutch groups with dots. */
export function answerValue(value, key = '', currency = null, locale = 'en-US') {
  const raw = String(value ?? '');
  if (isLiteralField(key)) return raw;
  if (typeof value === 'string') value = formatDisplayText(value, key);
  const label = String(key).split('/').at(-1).replace(/[\s_.-]/g, '');
  if (/year|date|datum|code|identifier|kvk|postcode|postal|phone|iban|^(?:bouwjaar|jaar|rsin)$/i.test(label) || /(?:^id$|Id$|ID$|Number$|Nummer$)/.test(label)) return raw;
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) return formatDisplayNarrative(String(value ?? ''));
  const negative = raw.startsWith('-'), unsigned = negative ? raw.slice(1) : raw, [whole, fraction] = unsigned.split('.'), dutch = locale.startsWith('nl');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, dutch ? '.' : ',') + (fraction == null ? '' : (dutch ? ',' : '.') + fraction);
  const monetary = /^(?:(?:total|net|gross))?(Assets|Liabilities|Equity|Receivables|Cash|Property|Provisions|Share|RetainedEarnings|FinancialIncome|Income|Result|Depreciation|EmployeeBenefits|Operating|GrossMargin|Impairment|SumOfExpenses|Revenue|Profit|Turnover|Amount|Balance|Price|Cost|Tax|Bedrag|Omzet|Winst|Kosten)/i.test(label) && !/ratio|percent|rate|count|margin|sharesoutstanding|sharesissued|records|items|matches|^(?:total)?results?$/i.test(label);
  const code = monetary ? sourceCurrency(currency) : null, symbol = code && ({ EUR: '€', USD: '$', GBP: '£' }[code] || code);
  return (negative ? '-' : '') + (symbol ? symbol + ' ' : '') + grouped;
}
/** Units and periods next to the exact cited field, never from another result. */
export function answerValueContext(evidence, results) {
  const pointer = String(evidence?.pointer || ''), doc = (results || []).map(answerRecord).find(d => d.result_ref === evidence?.result_ref), parents = [];
  let node = doc && { ...doc, data: doc.data ?? doc.preview_data };
  for (const part of pointer.split('/').slice(1)) {
    if (!Array.isArray(node)) parents.unshift(answerRecord(node));
    node = node != null && typeof node === 'object' ? node[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined;
  }
  // The saved envelope currency prices the API call, not the source's data.
  const sourceParents = /^\/(?:data|preview_data)(?:\/|$)/.test(pointer) ? parents.slice(0, -1) : parents;
  const currencyOwner = sourceParents.find(p => p.currency != null || p.currencyCode != null || p.unit != null);
  const period = parents.flatMap(p => ANSWER_PERIOD_KEYS.map(k => p[k])).find(v => /^(?:19|20)\d{2}(?:-\d{2}-\d{2})?$/.test(String(v)));
  return { currency: sourceCurrency(currencyOwner), period: period == null ? null : String(period), field: String(parents[0]?.key ?? pointer.split('/').at(-1) ?? '') };
}
export function formatAnswerObservation(observation, results, locale) {
  const values = new Map(), evidence = Array.isArray(observation.evidence) ? observation.evidence : [];
  for (const item of evidence) {
    const raw = String(item?.value);
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(raw)) continue;
    const context = answerValueContext(item, results), field = item.field ?? context.field, pointer = String(item.pointer || ''), parent = pointer.slice(0, pointer.lastIndexOf('/'));
    const currency = context.currency ?? sourceCurrency(evidence.find(e => e?.result_ref === item.result_ref && e.pointer === parent + '/currency')?.value);
    const display = answerValue(item.value, field, currency, locale), previous = values.get(raw);
    values.set(raw, values.has(raw) && previous?.display !== display ? null : { display, currency });
  }
  const codes = 'EUR|USD|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK';
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_/@.:$€£+\\-])(?:(${codes}|[$€£])\\s*)?(-?(?:0|[1-9]\\d*)(?:\\.\\d+)?)(?:\\s*(${codes})(?!\\p{L}))?(?![\\p{L}\\p{N}_/@]|[.:,\\-]\\d)`, 'gu');
  return String(observation.text).replace(pattern, (match, prefix, raw, suffix) => {
    const value = values.get(raw);
    if (!value) return match;
    const explicit = prefix ?? suffix;
    if (!explicit) return value.display;
    const code = { '$': 'USD', '€': 'EUR', '£': 'GBP' }[explicit] ?? explicit;
    return value.currency && value.currency !== code ? match : answerValue(raw, 'Amount', code, locale);
  });
}
/** A heading may name only a period this observation actually cites. */
export function observationPeriod(observation, results) {
  const periods = (observation.evidence || []).flatMap(e => {
    const key = String(e?.field ?? e?.pointer ?? '').split('/').at(-1) ?? '';
    if (ANSWER_PERIOD_KEYS.some(k => k.toLowerCase() === key.toLowerCase()) && /^(?:19|20)\d{2}(?:-\d{2}-\d{2})?$/.test(String(e.value))) return [String(e.value)];
    const context = answerValueContext(e, results);
    return context.period ? [context.period] : [];
  });
  const unique = [...new Set(periods)];
  return unique.length === 1 ? unique[0] : null;
}
export function answerText(analysis, context) {
  if (!analysis) return '';
  const question = context?.question || '', results = context?.results || [], locale = answerLocale(question, analysis), nl = locale === 'nl-NL';
  const observations = (analysis.observations || []).filter(o => typeof o?.text === 'string' && o.text.trim());
  const limitations = (analysis.limitations || []).filter(text => typeof text === 'string' && text.trim() && !ANSWER_GENERIC_LIMITATIONS.has(text));
  const structured = observations.length > 1 && !/\b(one sentence|single sentence|één zin|een zin)\b/i.test(question);
  const blocks = [];
  let previousHeading = null;
  for (const observation of observations) {
    if (structured) {
      const period = observationPeriod(observation, results);
      const heading = period ? (nl ? 'Verslagperiode ' : 'Reporting period ') + period : nl ? 'Belangrijkste bevindingen' : 'Key findings';
      if (heading !== previousHeading) blocks.push('## ' + heading);
      previousHeading = heading;
    }
    blocks.push(formatAnswerObservation(observation, results, locale));
  }
  if (limitations.length) {
    if (observations.length) blocks.push('## ' + (nl ? 'Bronnen en beperkingen' : 'Source notes'));
    blocks.push(...new Set(limitations));
  }
  if (analysis.follow_up_question) blocks.push(analysis.follow_up_question);
  return blocks.length ? blocks.join('\n\n') : [...new Set((analysis.limitations || []).filter(text => typeof text === 'string'))].join('\n\n');
}
export function answerDocumentRequested(analysis, question) {
  return analysis?.presentation?.kind === 'document' || /\b(document|pdf|rapport|report|dossier)\b/i.test(question || '');
}

// ---- DOM, run inside the card only --------------------------------------------
function answerInline(node, value) {
  const parts = String(value).split(/(-?(?:[$€£]|USD|EUR|GBP|CHF|JPY|CAD|AUD|SEK|NOK|DKK)\s-?\d[\d.,]*)/g);
  if (parts.length === 1) { node.textContent = value; return node; }
  parts.forEach((part, index) => { if (part) node.append(el(index % 2 ? 'strong' : 'span', index % 2 ? 'answer-amount' : '', part)); });
  return node;
}
/** The App's StreamingReply, settled: headings, paragraphs and lists. */
function renderAnswerText(value, nameContext) {
  const wrap = el('div', 'answer-text');
  for (const block of readBlocks(formatDisplayNarrative(value, nameContext))) {
    if (block.kind === 'heading') { wrap.append(el('h3', 'answer-heading', block.text)); continue; }
    if (block.kind === 'paragraph') { wrap.append(answerInline(el('p'), block.text)); continue; }
    const list = el(block.kind === 'numbers' ? 'ol' : 'ul');
    for (const item of block.items) list.append(answerInline(el('li'), item));
    wrap.append(list);
  }
  return wrap;
}

export const V2_CARD_ANSWER_TEXT = [
  `const ANSWER_GENERIC_LIMITATIONS=new Set(${JSON.stringify([...ANSWER_GENERIC_LIMITATIONS])}),ANSWER_PERIOD_KEYS=${JSON.stringify(ANSWER_PERIOD_KEYS)};`,
  answerRecord, answerLocale, answerValue, answerValueContext, formatAnswerObservation, observationPeriod, answerText, answerDocumentRequested, answerInline, renderAnswerText,
].map(value => typeof value === 'function' ? value.toString() : value).join('\n');
