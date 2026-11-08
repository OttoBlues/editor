import test from 'node:test';
import assert from 'node:assert/strict';
import { pluginFor } from '../public/plugins.js';

// A minimal DOM records the actual renderer's node tree without dependencies.
class Node {
  constructor(tag = null, text = '') { this.tag = tag; this.children = []; this.text = text; this.dataset = {}; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; this.text = ''; }
  set textContent(text) { this.text = String(text); this.children = []; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
}
globalThis.document = { createElement: tag => new Node(tag), createTextNode: text => new Node(null, text) };
globalThis.location = { origin: 'http://127.0.0.1:4173' };
function descendants(node, tag) { return node.children.flatMap(child => [...(child.tag === tag ? [child] : []), ...descendants(child, tag)]); }
function render(text) { const root = new Node('div'); pluginFor('markdown').render(root, text); return root; }

test('preview renders tables with headings, cell alignment and nested emphasis/code', () => {
  const source = '## Sample report\n\nLimit: **\x60max(3%, 7)\x60**.\n\n| Metric | Value | Note |\n|---|---:|:---:|\n| **Sample** | **80%** | *review* |\n| Second | 7 | \x60a_b\x60 |\n\nAfter table';
  const root = render(source);
  assert.equal(descendants(root, 'table').length, 1);
  assert.equal(descendants(root, 'tr').length, 3);
  assert.deepEqual(descendants(root, 'th').map(cell => [cell.textContent, cell.className, cell.scope]), [['Metric', 'align-left', 'col'], ['Value', 'align-right', 'col'], ['Note', 'align-center', 'col']]);
  assert.equal(descendants(descendants(root, 'strong')[0], 'code').length, 1);
  assert.equal(descendants(root, 'strong')[0].textContent, 'max(3%, 7)');
  assert.equal(descendants(root, 'h2')[0].textContent, 'Sample report');
  assert.equal(root.children.at(-1).textContent, 'After table');
  assert.deepEqual(descendants(root, 'td').map(cell => cell.textContent), ['Sample', '80%', 'review', 'Second', '7', 'a_b']);
});

test('table bodies preserve escaped pipes, empty cells, Unicode and database identifiers', () => {
  const root = render('| 标题 | Identifier |\n| --- | --- |\n| 甲\\|乙 | demo_count_total |\n| | **\x60code\\|value\x60** |\n| short |\n| one | two | ignored |');
  const cells = descendants(root, 'td');
  assert.deepEqual(cells.map(cell => cell.textContent), ['甲|乙', 'demo_count_total', '', 'code\\|value', 'short', '', 'one', 'two']);
  assert.equal(descendants(root, 'em').length, 0);
});

test('pipe-containing formulas stay prose unless a valid table delimiter follows', () => {
  const root = render('| A - B | / A <= limit\n| A - B | <= minimum\n\nHeading\n=======\n\nAnother | value\nplain text');
  assert.equal(descendants(root, 'table').length, 0);
  assert.equal(descendants(root, 'h1')[0].textContent, 'Heading');
  assert.match(root.textContent, /\| A - B \| \/ A <= limit/);
});

test('fences, indented code, nested lists, block quotes and hard breaks retain structure', () => {
  const source = '~~~~ js\n# literal heading\n~~~\n~~~~\n\n    <b>literal code</b>\n\n3. Three\n   - Nested\n4. Four\n\n> **Quote**\n>\n> More\n\nLine  \nbreak\n\n~~old~~ and __strong__ and _italic_';
  const root = render(source);
  assert.deepEqual(descendants(root, 'pre').map(node => node.textContent), ['# literal heading\n~~~', '<b>literal code</b>']);
  assert.equal(descendants(root, 'ol')[0].start, 3);
  assert.equal(descendants(descendants(root, 'ol')[0], 'ul').length, 1);
  assert.equal(descendants(root, 'blockquote').length, 1);
  assert.equal(descendants(root, 'br').length, 1);
  assert.equal(descendants(root, 'del')[0].textContent, 'old');
});

test('preview keeps raw HTML and images inert and rejects executable and local links', () => {
  const root = render('<script>alert(1)</script>\n\n![image](https://example.invalid/pixel.png)\n\n[bad](javascript:evil) [data](data:text/html,unsafe) [local](C:/private/demo.html) [safe](https://example.invalid/report)');
  assert.equal(descendants(root, 'script').length, 0);
  assert.equal(descendants(root, 'img').length, 0);
  assert.match(root.textContent, /<script>alert\(1\)<\/script>/);
  const links = descendants(root, 'a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.invalid/report');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.deepEqual(descendants(root, 'span').map(node => node.textContent), ['bad', 'data', 'local']);
});
