import { sourceCurrency } from './source-value-format.mjs';
import { answerValue, answerValueContext } from './gateway-v2-card-answer-text.mjs';
// The App's answer tables for version-1 analyses: `analysis.presentation`
// (table, comparison, chart) and, without one, only the records and fields the
// saved answer cites. Never a dump of a provider's raw rows
// (app/src/lib/domain/answer-presentation.ts). Keep in sync with the App.
export function presentationTable(p, results = [], locale = 'en-US') {
  const columns = Array.isArray(p.columns) ? p.columns : [], rows = Array.isArray(p.rows) ? p.rows : [];
  const currencyColumn = columns.findIndex(c => /^(currency|valuta)$/i.test(String(c?.value)));
  return {
    title: p.title, columns: columns.map(c => String(c?.value)), rows: rows.map(r => (r || []).map(c => c?.value)), locale,
    displayRows: rows.map(row => (row || []).map((cell, i) => {
      if (!cell || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(String(cell.value))) return cell?.value;
      const context = cell.result_ref && cell.pointer ? answerValueContext({ result_ref: cell.result_ref, pointer: cell.pointer }, results) : null;
      return answerValue(cell.value, context?.field || String(columns[i]?.value), context?.currency ?? sourceCurrency(row[currencyColumn]?.value), locale);
    })),
    note: p.returned_count !== undefined ? rows.length + ' selected from ' + p.returned_count + ' returned records. This is not necessarily the complete search.' : 'Based on saved source data. Missing values are unknown.',
  };
}
function presentationEvidence(row, field, value) {
  if (!row.has(field)) { row.set(field, value);return; }
  const previous = row.get(field);
  if (previous !== value) row.set(field, [...new Set([...(Array.isArray(previous) ? previous : [previous]), value])]);
}
export function legacyAnswerTables(question, results, analysis) {
  if (analysis?.presentation || !analysis?.observations?.length || !/\b(overzicht|tabel|table|overview|list|lijst|welke|which|vergelijk|compare|comparison)\b/i.test(question || '')) return [];
  const record = v => v && typeof v === 'object' && !Array.isArray(v) ? v : {}, groups = new Map();
  for (const evidence of analysis.observations.flatMap(o => o?.evidence || [])) {
    const doc = (results || []).map(record).find(d => d.result_ref === evidence?.result_ref), pointer = String(evidence?.pointer || '');
    if (!doc || !pointer.startsWith('/data/')) continue;
    const parts = pointer.split('/').slice(1).map(p => p.replaceAll('~1', '/').replaceAll('~0', '~'));
    let node = { ...doc, data: doc.data ?? doc.preview_data }, groupPath = '', rowPath = '', field = parts.slice(1).join(' / '), rowRecord = {};
    for (let i = 0; i < parts.length; i++) {
      if (Array.isArray(node) && /^(0|[1-9]\d*)$/.test(parts[i])) { groupPath = JSON.stringify(parts.slice(0, i));rowPath = JSON.stringify(parts.slice(0, i + 1));field = parts.slice(i + 1).join(' / ');rowRecord = record(node[Number(parts[i])]);break; }
      node = record(node)[parts[i]];
    }
    const key = JSON.stringify([evidence.result_ref, groupPath]);
    let group = groups.get(key);
    if (!group) { const source = record(doc.source), subject = record(doc.subject);group = { name: String(subject.label ?? source.name ?? source.provider ?? 'Answer'), columns: [], rows: new Map() };groups.set(key, group); }
    if (!rowPath) {
      group.columns = ['Field', 'Source value'];
      const row = group.rows.get(pointer) ?? new Map([['Field', field]]);
      presentationEvidence(row, 'Source value', evidence.value);group.rows.set(pointer, row);continue;
    }
    let row = group.rows.get(rowPath);
    if (!row) { row = new Map();group.rows.set(rowPath, row); }
    if (!group.columns.includes(field)) group.columns.push(field);
    presentationEvidence(row, field, evidence.value);
    const link = rowRecord.url ?? record(rowRecord.link).href ?? record(record(rowRecord._links).self).href;
    if (typeof link === 'string' && /^https?:\/\//i.test(link)) { if (!group.columns.includes('Source')) group.columns.push('Source');row.set('Source', link); }
  }
  const humanize = label => label.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ');
  const tables = [...groups.values()].map(g => ({ title: g.name, columns: g.columns.map(humanize), rows: [...g.rows.values()].map(r => g.columns.map(c => r.get(c))), note: 'Only records and fields cited in this saved answer. Full source data is available in Details.' }));
  if (/\b(vergelijk|compare|comparison)\b/i.test(question) && tables.length > 1 && tables.every(t => t.columns[0] === 'Field') && new Set(tables.map(t => t.title)).size === tables.length) {
    const fields = [...new Set(tables.flatMap(t => t.rows.map(r => String(r[0]))))];
    return [{ title: 'Comparison', columns: ['Feature', ...tables.map(t => t.title)], rows: fields.map(f => [humanize(f), ...tables.map(t => t.rows.find(r => r[0] === f)?.[1])]), note: 'Only facts cited in the saved answer. Missing values are unknown; retain differences in units and reporting periods.' }];
  }
  return tables;
}

// ---- DOM, run inside the card only --------------------------------------------
function renderAnswerPresentation(question, results, analysis) {
  const p = analysis?.presentation, tables = p && typeof p === 'object' && 'title' in p ? [presentationTable(p, results, answerLocale(question, analysis))] : legacyAnswerTables(question, results, analysis);
  if (!tables.length) return null;
  const wrap = el('div', 'answer-blocks');wrap.setAttribute('aria-label', 'Answer data');
  for (const table of tables) wrap.append(selectedTable(table, p?.kind === 'chart'));
  return wrap;
}
function selectedTable(table, chart) {
  const wrap = el('div', 'answer-table');let shown = 10;
  const draw = () => {
    const visible = { ...table, rows: table.rows.slice(0, shown) }, parts = [], figure = chart ? presentationChart(visible, table) : null;
    if (figure) parts.push(figure);
    parts.push(sourceTable(visible));
    if (shown < table.rows.length) parts.push(blockMore('Show more selected rows (' + (table.rows.length - shown) + ' remaining)', () => { shown += 10;draw(); }));
    if (shown > 10) parts.push(blockMore('Show fewer rows', () => { shown = 10;draw(); }));
    wrap.replaceChildren(...parts);
  };
  draw();
  return wrap;
}
function presentationChart(table, scale) {
  const points = t => t.rows.filter(r => typeof r[0] === 'string' && typeof r[1] === 'number' && Number.isFinite(r[1]));
  const shown = points(table);
  if (!shown.length || shown.length !== table.rows.length) return null;
  const all = points(scale).map(r => r[1]), min = Math.min(0, ...all), max = Math.max(0, ...all), range = max - min || 1, zero = (0 - min) / range * 100;
  const figure = el('figure', 'answer-block bar-chart');figure.setAttribute('aria-label', table.title + ' chart');
  figure.append(el('figcaption', '', table.title + ' · ' + table.columns[1]));
  shown.forEach(([label, value], i) => {
    const row = el('div', 'bar-row'), line = el('div', 'bar-line');
    line.append(el('span', 'bar-label', label), el('span', 'fact-value', String(table.displayRows?.[i]?.[1] ?? new Intl.NumberFormat(table.locale ?? 'nl-NL', { maximumFractionDigits: 10 }).format(value))));
    row.append(line, answerBar(zero, (value - min) / range * 100));figure.append(row);
  });
  return figure;
}
function presentationCell(value, key, locale = 'nl-NL') {
  if (value == null || value === '') return el('span', '', '—');
  if (Array.isArray(value)) { const list = el('ul', 'cell-list');for (const item of value) { const li = el('li');li.append(presentationCell(item, key, locale));list.append(li); }return list; }
  if (typeof value === 'number' || typeof value === 'string' && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return el('span', '', answerValue(value, key, null, locale));
  if (typeof value === 'boolean') return el('span', '', value ? 'Yes' : 'No');
  if (typeof value !== 'string') return el('span', '', JSON.stringify(displayData(value, key)));
  if (/^https?:\/\//i.test(value)) { try { const url = new URL(value);if (!url.username && !url.password) { const link = bodyLink(url.href, 'Open source ↗');link.title = url.href;link.setAttribute('aria-label', 'Open source: ' + url.hostname);return link; } } catch {} }
  return el('span', '', formatDisplayText(value, key));
}
function sourceTable(table) {
  const s = el('section', 'answer-block');s.setAttribute('aria-label', table.title);
  s.append(el('h3', '', table.title), el('p', 'meta', table.rows.length + ' rows shown' + (table.total !== undefined ? ' · ' + new Intl.NumberFormat('nl-NL').format(table.total) + ' total matches' : '') + '. ' + table.note));
  if (!table.rows.length) { s.append(el('p', '', 'No records returned.'));return s; }
  const link = row => { for (const value of row.slice(1)) { if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;try { const url = new URL(value);if (!url.username && !url.password) return url.href; } catch {} }return null; };
  const region = blockTable(table.title + ' table', table.columns, table.rows.map((row, i) => {
    const tr = el('tr'), href = typeof row[0] === 'string' && !/^https?:\/\//i.test(row[0]) ? link(row) : null;
    row.forEach((value, j) => {
      const td = el('td'), shown = table.displayRows?.[i]?.[j] ?? value, cell = presentationCell(shown, j === 0 || table.columns[j] !== 'Source value' ? table.columns[j] : String(row[0]), table.locale);
      td.append(j === 0 && href ? bodyLink(href, cell.textContent) : cell);tr.append(td);
    });
    return tr;
  }));
  if (table.columns.length > 3) region.querySelector('table')?.setAttribute('style', 'min-width:' + table.columns.length * 150 + 'px');
  s.append(region);
  return s;
}

export const V2_CARD_PRESENTATION = [
  presentationTable, presentationEvidence, legacyAnswerTables, renderAnswerPresentation, selectedTable, presentationChart, presentationCell, sourceTable,
].map(fn => fn.toString()).join('\n');
