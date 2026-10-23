// A deliberately small Markdown renderer for model replies. Raw HTML stays
// text; links are the only external resource and require an explicit click.
const element = (tag, children, extra = {}) => ({ tag, children, ...extra });

export function safeLink(value) {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch { return null; }
}

function inline(text, depth = 0) {
  if (depth > 8) return [text];
  const parts = [];
  let buffer = '', at = 0;
  const flush = () => { if (buffer) parts.push(buffer); buffer = ''; };
  while (at < text.length) {
    if (text[at] === '\\' && /[\\`*_{}\[\]()#+.!|>-]/.test(text[at + 1] || '')) {
      buffer += text[at + 1]; at += 2; continue;
    }
    if (text[at] === '`') {
      const marker = /^`+/.exec(text.slice(at))[0], end = text.indexOf(marker, at + marker.length);
      if (end > at + marker.length) {
        flush(); parts.push(element('code', [text.slice(at + marker.length, end)]));
        at = end + marker.length; continue;
      }
    }
    if (text[at] === '[' && text[at - 1] !== '!') {
      const labelEnd = text.indexOf('](', at + 1);
      if (labelEnd !== -1) {
        let end = labelEnd + 2, balance = 1;
        for (; end < text.length; end++) {
          if (text[end] === '\\') { end++; continue; }
          if (text[end] === '(') balance++;
          if (text[end] === ')' && --balance === 0) break;
        }
        if (end < text.length) {
          const href = safeLink(text.slice(labelEnd + 2, end).trim());
          if (href) {
            flush(); parts.push(element('a', inline(text.slice(at + 1, labelEnd), depth + 1), { href }));
            at = end + 1; continue;
          }
          // Keep refused links visible in their original form.
          buffer += text.slice(at, end + 1); at = end + 1; continue;
        }
      }
    }
    const marker = text.startsWith('**', at) ? '**' : text.startsWith('__', at) ? '__'
      : text[at] === '*' ? '*' : text[at] === '_' ? '_' : null;
    if (marker && !/\s/.test(text[at + marker.length] || ' ') && !(marker.includes('_') && /\w/.test(text[at - 1] || ''))) {
      const end = text.indexOf(marker, at + marker.length);
      if (end > at + marker.length && !/\s/.test(text[end - 1]) && !(marker.includes('_') && /\w/.test(text[end + marker.length] || ''))) {
        flush(); parts.push(element(marker.length === 2 ? 'strong' : 'em', inline(text.slice(at + marker.length, end), depth + 1)));
        at = end + marker.length; continue;
      }
    }
    buffer += text[at++];
  }
  flush();
  return parts;
}

function tableCells(line) {
  const source = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  const cells = [];
  let current = '', codeMarker = '';
  for (let at = 0; at < source.length; at++) {
    if (source[at] === '\\' && at + 1 < source.length) { current += source[at] + source[++at]; continue; }
    if (source[at] === '`') {
      const marker = /^`+/.exec(source.slice(at))[0];
      if (!codeMarker) codeMarker = marker;
      else if (codeMarker === marker) codeMarker = '';
      current += marker; at += marker.length - 1; continue;
    }
    if (source[at] === '|' && !codeMarker) { cells.push(current.trim()); current = ''; }
    else current += source[at];
  }
  cells.push(current.trim());
  return cells;
}

const listItem = line => /^ {0,3}([-+*]|\d{1,9}[.)])\s+(.+)$/.exec(line);
const fence = line => /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const heading = line => /^ {0,3}(#{1,6})\s+(.+)$/.exec(line);
const tableStart = (lines, at) => lines[at]?.includes('|') && !!lines[at + 1]
  && tableCells(lines[at]).length === tableCells(lines[at + 1]).length
  && tableCells(lines[at + 1]).every(cell => /^:?-{3,}:?$/.test(cell));
const startsBlock = (lines, at) => !lines[at]?.trim() || fence(lines[at]) || heading(lines[at]) || listItem(lines[at]) || tableStart(lines, at);

export function parseMarkdown(value) {
  const lines = String(value ?? '').replace(/\r\n?/g, '\n').split('\n'), blocks = [];
  let at = 0;
  while (at < lines.length) {
    if (!lines[at].trim()) { at++; continue; }
    const code = fence(lines[at]);
    if (code) {
      const body = [], marker = code[1]; at++;
      while (at < lines.length) {
        const close = fence(lines[at]);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length && !close[2].trim()) { at++; break; }
        body.push(lines[at++]);
      }
      blocks.push(element('pre', [element('code', [body.join('\n')])])); continue;
    }
    const title = heading(lines[at]);
    if (title) { blocks.push(element(`h${title[1].length}`, inline(title[2].replace(/\s+#+\s*$/, '')))); at++; continue; }
    if (tableStart(lines, at)) {
      const headers = tableCells(lines[at]), rows = []; at += 2;
      while (at < lines.length && lines[at].trim() && lines[at].includes('|') && !fence(lines[at]) && !heading(lines[at])) {
        const cells = tableCells(lines[at++]);
        // Preserve unexpected extra cells rather than silently dropping data.
        if (cells.length > headers.length) cells.splice(headers.length - 1, cells.length, cells.slice(headers.length - 1).join(' | '));
        rows.push(element('tr', headers.map((_, index) => element('td', inline(cells[index] || '')))));
      }
      blocks.push(element('div', [element('table', [element('thead', [element('tr', headers.map(cell => element('th', inline(cell))))]), element('tbody', rows)])], { className: 'markdown-table' }));
      continue;
    }
    const first = listItem(lines[at]);
    if (first) {
      const ordered = /^\d/.test(first[1]), items = [];
      while (at < lines.length) {
        const item = listItem(lines[at]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const body = [item[2]]; at++;
        while (at < lines.length && /^\s{2,}\S/.test(lines[at]) && !startsBlock(lines, at)) body.push(lines[at++].trim());
        items.push(element('li', inline(body.join(' '))));
      }
      blocks.push(element(ordered ? 'ol' : 'ul', items, ordered ? { start: Number.parseInt(first[1], 10) } : {})); continue;
    }
    const paragraph = [lines[at++]];
    while (at < lines.length && !startsBlock(lines, at)) paragraph.push(lines[at++]);
    blocks.push(element('p', inline(paragraph.join('\n'))));
  }
  return blocks;
}

export function renderMarkdown(container, text) {
  const document = container.ownerDocument;
  const build = part => {
    if (typeof part === 'string') return document.createTextNode(part);
    const node = document.createElement(part.tag);
    if (part.tag === 'a') { node.href = part.href; node.target = '_blank'; node.rel = 'noopener noreferrer'; }
    if (part.tag === 'ol') node.start = part.start;
    if (part.className) node.className = part.className;
    node.append(...part.children.map(build));
    return node;
  };
  container.replaceChildren(...parseMarkdown(text).map(build));
  container.classList.add('markdown');
}
