import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdown, renderMarkdown, safeLink } from '../dev/public/markdown.mjs';

const walk = parts => parts.flatMap(part => typeof part === 'string' ? [] : [part, ...walk(part.children)]);
const plain = parts => parts.map(part => typeof part === 'string' ? part : plain(part.children)).join('');

test('an assistant company reply renders headings, emphasis, lists and its data table', () => {
  const reply = '**ASML** makes *lithography* systems.\n\n### Core business\n\n| Aspect | Details |\n| --- | --- |\n| Product | **EUV** tools |\n| Count | 0 |\n\n- Evidence is _saved_\n- Review the `source_id`\n\n3. Open sources\n4. Review total';
  const parsed = parseMarkdown(reply), nodes = walk(parsed);
  assert.deepEqual(parsed.map(part => part.tag), ['p', 'h3', 'div', 'ul', 'ol']);
  assert.deepEqual(nodes.filter(node => node.tag === 'strong').map(node => plain(node.children)), ['ASML', 'EUV']);
  assert.deepEqual(nodes.filter(node => node.tag === 'em').map(node => plain(node.children)), ['lithography', 'saved']);
  assert.deepEqual(nodes.filter(node => node.tag === 'td').map(node => plain(node.children)), ['Product', 'EUV tools', 'Count', '0']);
  assert.equal(parsed.at(-1).start, 3);
  assert.equal(plain(nodes.find(node => node.tag === 'code').children), 'source_id');
});

test('raw HTML and fenced code stay inert text, including event handlers and scripts', () => {
  const payload = '<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>\n\n```html\n<a href="javascript:alert(3)">unsafe</a>\n```';
  const parsed = parseMarkdown(payload);
  assert.deepEqual(walk(parsed).map(node => node.tag), ['p', 'p', 'pre', 'code']);
  assert.match(plain(parsed), /<img src=x onerror=alert\(1\)>/);
  assert.match(plain(parsed), /<script>alert\(2\)<\/script>/);
  assert.equal(plain(parsed.at(-1).children), '<a href="javascript:alert(3)">unsafe</a>');
});

test('links allow explicit safe protocols, preserve refused targets and handle URL parentheses', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///private/file', '//example.com', 'https://name:password@example.com']) assert.equal(safeLink(url), null);
  const parsed = parseMarkdown('[Source](https://example.com/report_(one)) [email](mailto:hello@example.com) [unsafe](javascript:alert(1))');
  const links = walk(parsed).filter(node => node.tag === 'a');
  assert.deepEqual(links.map(link => link.href), ['https://example.com/report_(one)', 'mailto:hello@example.com']);
  assert.match(plain(parsed), /\[unsafe\]\(javascript:alert\(1\)\)/);
});

test('table cells preserve escaped pipes, code pipes and unexpected extra values', () => {
  const parsed = parseMarkdown('| A | B |\n| :--- | ---: |\n| left\\|right | `a|b` |\n| false | missing | extra |');
  const values = walk(parsed).filter(node => node.tag === 'td').map(node => plain(node.children));
  assert.deepEqual(values, ['left|right', 'a|b', 'false', 'missing | extra']);
});

test('plain identifiers and incomplete Markdown remain readable', () => {
  const value = 'source_id and another_id cost 0; false stays false.\n**unfinished';
  assert.equal(plain(parseMarkdown(value)), value);
  assert.deepEqual(parseMarkdown(''), []);
  assert.equal(plain(parseMarkdown('~~~js\nconst value = 0;')), 'const value = 0;');
});

test('DOM rendering uses only elements and text nodes, and protects new-window links', () => {
  const created = [];
  const doc = { createTextNode: text => ({ text }), createElement: tag => {
    assert.ok(['div', 'p', 'strong', 'a'].includes(tag));
    const node = { tag, ownerDocument: doc, children: [], classes: new Set(),
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      set innerHTML(_) { throw new Error('HTML parsing must never be used'); } };
    node.classList = { add: value => node.classes.add(value) };
    created.push(node); return node;
  } };
  const container = doc.createElement('div');
  renderMarkdown(container, '**Result** <img src=x> [source](https://example.com)');
  assert.equal(container.classes.has('markdown'), true);
  const link = created.find(node => node.tag === 'a');
  assert.equal(link.href, 'https://example.com/');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.ok(created.find(node => node.tag === 'p').children.some(node => node.text?.includes('<img src=x>')));
});
