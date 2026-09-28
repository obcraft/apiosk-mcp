// The App's versioned answer blocks (answer_schema_version 2): data tables,
// bar charts and the generic fallback that renders any other kind as facts
// (app/src/lib/domain/answer-blocks-view.ts, components/ask/answer-blocks).
// Every Fact arrives resolved by the gateway; the card only displays, sorts
// and filters it. Keep in sync with the App.
export function isBlocksAnswer(analysis) { return !!analysis && (analysis.answer_schema_version ?? 1) >= 2 && Array.isArray(analysis.blocks); }
export function factOrigin(fact, collection, rowIndex, relativePointer) {
  if (fact?.result_ref && fact.pointer) return { result_ref: fact.result_ref, pointer: fact.pointer };
  if (collection && rowIndex != null && relativePointer) return { result_ref: collection.result_ref, pointer: collection.rows_pointer + '/' + rowIndex + relativePointer };
  return null;
}
/** Sorts the complete selected set, nulls last in both directions, before paging. */
export function sortTableRows(columns, rows, sort) {
  const index = sort ? columns.findIndex(c => c.id === sort.column_id) : -1;
  if (index < 0) return rows;
  const direction = sort.direction === 'asc' ? 1 : -1, key = row => row?.cells?.[index]?.value ?? null;
  return [...rows].sort((a, b) => {
    const av = key(a), bv = key(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return typeof av === 'number' && typeof bv === 'number' ? (av - bv) * direction : String(av).localeCompare(String(bv)) * direction;
  });
}
export function filterTableRows(rows, query) {
  const q = String(query || '').trim().toLowerCase();
  return q ? rows.filter(row => (row?.cells || []).some(cell => cell?.value != null && String(cell.value).toLowerCase().includes(q))) : rows;
}
/** Fixed over every selected bar, so revealing more never rescales. */
export function barScale(block) {
  if (block.scale) return block.scale;
  const values = (block.bars || []).map(bar => typeof bar.fact?.value === 'number' ? bar.fact.value : null).filter(v => v != null);
  return { min: Math.min(0, ...values), max: Math.max(0, ...values) };
}
export function rankingScopeLabel(scope) {
  return scope === 'total_available' ? 'ranked across every available result' : scope === 'fetched' ? 'ranked across every fetched result' : 'ranked across the selected results';
}
function blockLabelOf(label, fact, id) { return label ? label : fact?.value != null ? String(fact.value) : id; }
/** Any kind's facts as labelled rows; unknown kinds render through this. */
export function blockFacts(block) {
  const list = value => Array.isArray(value) ? value : [];
  switch (block.kind) {
    case 'summary': return list(block.conclusion?.facts).map((fact, i) => ({ label: 'Fact ' + (i + 1), fact }));
    case 'data_table': return list(block.rows).flatMap((row, ri) => list(block.columns).map((column, ci) => ({ label: column.label, fact: row.cells?.[ci], collection: block.collection, rowIndex: row.row_index ?? ri, relativePointer: column.pointer })));
    case 'comparison': return list(block.rows).flatMap(row => list(row.cells).map((fact, i) => ({ label: row.label + ' — ' + (block.entities?.[i]?.label ?? ''), fact })));
    case 'kpi': return list(block.cards).flatMap(card => [{ label: card.label, fact: card.fact }, ...(card.change ? [{ label: card.label + ' (baseline)', fact: card.change.baseline }] : [])]);
    case 'line_chart': return list(block.series).flatMap(series => list(series.points).map((point, pi) => ({ label: series.label + ' — ' + (point.period?.key ?? point.period?.value ?? ''), fact: point.fact ?? null, collection: series.collection, rowIndex: point.row_index ?? pi, relativePointer: series.value_pointer })));
    case 'bar_chart': return list(block.bars).map((bar, bi) => ({ label: blockLabelOf(bar.label, bar.label_fact, 'Bar ' + (bi + 1)), fact: bar.fact ?? null, collection: block.collection, rowIndex: bar.row_index ?? bi, relativePointer: block.value_pointer }));
    case 'map': return list(block.features).flatMap(feature => list(feature.facts).map(lf => ({ label: blockLabelOf(feature.label, feature.label_fact, feature.id) + ' — ' + lf.label, fact: lf.fact ?? null, collection: block.collection, rowIndex: feature.row_index })));
    case 'timeline': return list(block.events).flatMap(event => [
      { label: blockLabelOf(event.label, event.label_fact, event.id) + ' — date', fact: event.date ?? null, collection: block.collection, rowIndex: event.row_index, relativePointer: block.date_pointer },
      ...list(event.facts).map(lf => ({ label: blockLabelOf(event.label, event.label_fact, event.id) + ' — ' + lf.label, fact: lf.fact ?? null, collection: block.collection, rowIndex: event.row_index }))]);
    case 'profile': return [
      ...(block.name ? [{ label: 'Name', fact: block.name }] : []),
      ...list(block.identifiers).map(lf => ({ label: lf.label, fact: lf.fact ?? null })),
      ...(block.status ? [{ label: block.status.label, fact: block.status.fact ?? null }] : []),
      ...list(block.attributes).map(lf => ({ label: lf.label, fact: lf.fact ?? null }))];
    case 'relationship': return list(block.edges).flatMap(edge => list(edge.evidence).map((fact, i) => ({ label: edge.label + ' (' + (i + 1) + ')', fact })));
    default: return [];
  }
}

// ---- DOM, run inside the card only --------------------------------------------
function renderAnswerBlocks(analysis) {
  const wrap = el('div', 'answer-blocks');wrap.setAttribute('aria-label', 'Answer data');
  // A narrative block is the observations, already shown as the answer text.
  for (const block of analysis.blocks) if (block && block.kind !== 'narrative') wrap.append(block.kind === 'data_table' ? dataTableBlock(block, analysis) : block.kind === 'bar_chart' ? barChartBlock(block, analysis) : genericBlock(block, analysis));
  return wrap.children.length ? wrap : null;
}
function blockFactValue(fact) {
  if (!fact || fact.value == null) return el('span', 'body-muted', 'Unknown');
  const value = answerValue(fact.value, fact.field ?? '', fact.currency?.value != null ? String(fact.currency.value) : null, 'nl-NL');
  const labels = { estimated: 'Estimated', provisional: 'Provisional', revised: 'Revised', rounded: 'Rounded', confidential: 'Confidential' };
  if (!fact.flags?.length) return el('span', 'fact-value', value);
  const span = el('span', 'fact-value');span.append(el('span', '', value));
  for (const flag of fact.flags) span.append(el('span', 'fact-flag', labels[flag?.kind] || text(flag?.kind)));
  return span;
}
function blockFactSource(fact, sourceIndex, collection, rowIndex, relativePointer) {
  const origin = factOrigin(fact, collection, rowIndex, relativePointer);
  if (!origin) return fact?.derivation_id ? el('span', 'fact-source', 'Calculated') : null;
  const entry = (sourceIndex || []).find(s => s.result_ref === origin.result_ref);
  return el('span', 'fact-source', (entry?.name ?? entry?.provider ?? 'Source') + ' · ' + origin.pointer);
}
function blockCell(fact, sourceIndex, collection, rowIndex, relativePointer) {
  const td = el('td'), source = blockFactSource(fact, sourceIndex, collection, rowIndex, relativePointer);
  td.append(blockFactValue(fact));if (source) td.append(source);
  return td;
}
function blockTable(label, headings, rows) {
  const region = el('div', 'block-table-wrap'), table = el('table', 'block-table'), head = el('tr'), thead = el('thead'), tbody = el('tbody');
  region.setAttribute('role', 'region');region.setAttribute('aria-label', label);region.tabIndex = 0;
  for (const heading of headings) { const th = el('th', '', heading);th.setAttribute('scope', 'col');head.append(th); }
  thead.append(head);tbody.append(...rows);table.append(thead, tbody);region.append(table);
  return region;
}
function blockMore(label, onClick) { const b = el('button', 'quiet', label);b.type = 'button';b.onclick = () => { onClick();window.apiosk.resize(); };return b; }
function dataTableBlock(block, analysis) {
  const s = el('section', 'answer-block'), columns = block.columns || [], all = block.rows || [], sourceIndex = analysis?.source_index || [];
  const counts = el('p', 'meta'), region = el('div'), more = el('div'), controls = el('div', 'block-controls'), field = el('input', 'block-filter'), toggles = el('fieldset', 'block-columns');
  const hidden = new Set(columns.filter(c => c.hidden).map(c => c.id)), sorted = sortTableRows(columns, all, block.sort);
  let shown = 20, query = '';
  s.setAttribute('aria-label', block.title ?? 'Data table');if (block.title) s.append(el('h3', '', block.title));
  field.type = 'search';field.placeholder = 'Filter rows';field.setAttribute('aria-label', 'Filter rows');
  const draw = () => {
    const filtered = filterTableRows(sorted, query), visible = columns.filter(c => !hidden.has(c.id)), coverage = block.coverage;
    counts.textContent = (coverage ? coverage.selected + ' selected · ' + coverage.fetched + ' fetched' + (coverage.total_available !== undefined ? ' · ' + coverage.total_available + ' total available' : '') : all.length + ' rows') + (filtered.length !== all.length ? ' · ' + filtered.length + ' match the filter' : '');
    region.replaceChildren(visible.length ? blockTable((block.title ?? 'Data table') + ' table', visible.map(c => c.label), filtered.slice(0, shown).map((row, ri) => {
      const tr = el('tr');
      for (const column of visible) tr.append(blockCell(row.cells?.[columns.indexOf(column)], sourceIndex, block.collection, row.row_index ?? ri, column.pointer));
      return tr;
    })) : el('p', 'meta', 'Every column is hidden.'));
    more.replaceChildren(...(shown < filtered.length ? [blockMore('Show more rows (' + (filtered.length - shown) + ' remaining)', () => { shown += 20;draw(); })] : []));
  };
  field.oninput = () => { query = field.value;shown = 20;draw();window.apiosk.resize(); };
  toggles.append(el('legend', 'sr-only', 'Columns shown'));
  for (const column of columns) {
    const option = el('label'), box = el('input');box.type = 'checkbox';box.checked = !hidden.has(column.id);
    box.onchange = () => { box.checked ? hidden.delete(column.id) : hidden.add(column.id);draw();window.apiosk.resize(); };
    option.append(box, el('span', '', column.label));toggles.append(option);
  }
  controls.append(field, toggles);s.append(counts, controls, region, more);draw();
  return s;
}
function barChartBlock(block, analysis) {
  const figure = el('figure', 'answer-block bar-chart'), bars = block.bars || [], scale = barScale(block), range = (scale.max - scale.min) || 1, zero = (0 - scale.min) / range * 100;
  const caption = el('figcaption', '', block.title ?? block.value_label), list = el('div', 'bar-list'), more = el('div');
  if (block.ranking) caption.append(el('span', 'meta block-note', (block.ranking.direction === 'desc' ? 'Highest first, ' : 'Lowest first, ') + rankingScopeLabel(block.ranking.scope) + '.'));
  figure.setAttribute('aria-label', block.title ?? block.value_label ?? 'Chart');
  let shown = 10;
  const draw = () => {
    list.replaceChildren(...bars.slice(0, shown).map((bar, i) => {
      const value = typeof bar.fact?.value === 'number' ? bar.fact.value : null, end = value == null ? zero : (value - scale.min) / range * 100;
      const name = bar.label ?? (bar.label_fact?.value != null ? String(bar.label_fact.value) : 'Bar ' + (i + 1));
      const row = el('div', 'bar-row'), line = el('div', 'bar-line'), source = blockFactSource(bar.fact, analysis?.source_index, block.collection, bar.row_index ?? i, block.value_pointer);
      line.append(el('span', 'bar-label', (bar.rank != null ? '#' + bar.rank + ' ' : '') + name), blockFactValue(bar.fact));
      row.append(line, answerBar(zero, value == null ? null : end));if (source) row.append(source);
      return row;
    }));
    more.replaceChildren(...(shown < bars.length ? [blockMore('Show more bars (' + (bars.length - shown) + ' remaining)', () => { shown += 10;draw(); })] : []));
  };
  figure.append(caption, list, more);draw();
  return figure;
}
function answerBar(zero, end) {
  const track = el('div', 'bar-track'), axis = el('span', 'bar-zero');
  track.setAttribute('aria-hidden', 'true');axis.setAttribute('style', 'left:' + zero + '%');track.append(axis);
  if (end != null) { const fill = el('span', 'bar-fill');fill.setAttribute('style', 'left:' + Math.min(zero, end) + '%;width:' + Math.abs(end - zero) + '%');track.append(fill); }
  return track;
}
function genericBlock(block, analysis) {
  const rows = blockFacts(block), title = block.title ?? String(block.kind || 'block').replace('_', ' '), s = el('section', 'answer-block');
  s.setAttribute('aria-label', title);s.append(el('h3', 'block-kind', title));
  if (!rows.length) { s.append(el('p', 'meta', 'No details to show for this ' + String(block.kind || 'block').replace('_', ' ') + '.'));return s; }
  s.append(blockTable(title + ' facts', ['Field', 'Value', 'Source'], rows.map(row => {
    const tr = el('tr'), value = el('td'), source = el('td'), origin = blockFactSource(row.fact, analysis?.source_index, row.collection, row.rowIndex, row.relativePointer);
    value.append(blockFactValue(row.fact));if (origin) source.append(origin);tr.append(el('td', '', row.label), value, source);
    return tr;
  })));
  return s;
}

export const V2_CARD_BLOCKS = [
  isBlocksAnswer, factOrigin, sortTableRows, filterTableRows, barScale, rankingScopeLabel, blockLabelOf, blockFacts,
  renderAnswerBlocks, blockFactValue, blockFactSource, blockCell, blockTable, blockMore, dataTableBlock, barChartBlock, answerBar, genericBlock,
].map(fn => fn.toString()).join('\n');
