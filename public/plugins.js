// Built-in adapters operate on the editor's exact in-memory text. Offsets are
// JavaScript string offsets and always refer to slices of the supplied text.
export const plugins = Object.freeze([
  { id: 'markdown', type: 'markdown', extension: '.md', preview: true, blocks: 'structured', focusModes: Object.freeze(['structure', 'selection']), render: renderMarkdown, capabilities: Object.freeze({ reference: true, attention: true, focus: true }) },
  { id: 'text', type: 'text', extension: '.txt', preview: false, blocks: 'paragraphs', focusModes: Object.freeze(['structure', 'selection']), capabilities: Object.freeze({ reference: true, attention: true, focus: true }) },
]);

export function pluginFor(type) {
  return plugins.find((plugin) => plugin.type === type) || null;
}

export function supportsContext(type, capability) {
  return pluginFor(type)?.capabilities?.[capability] === true;
}

function* linesOf(text) {
  let offset = 0;
  let line = 1;
  while (offset < text.length) {
    const newline = text.indexOf('\n', offset);
    const end = newline < 0 ? text.length : newline;
    yield { text: text.slice(offset, end), offset, line };
    if (newline < 0) return;
    offset = newline + 1;
    line += 1;
  }
}

function* paragraphs(text) {
  if (!text) return;
  let start = null;
  let end = 0;
  let firstLine = 1;
  let emitted = false;
  for (const line of linesOf(text)) {
    if (line.text.trim()) {
      if (start === null) {
        start = line.offset;
        firstLine = line.line;
      }
      end = line.offset + line.text.length;
    } else if (start !== null) {
      emitted = true;
      yield { kind: 'paragraph', start, end, line: firstLine };
      start = null;
    }
  }
  if (start !== null) {
    emitted = true;
    yield { kind: 'paragraph', start, end, line: firstLine };
  }
  if (!emitted) yield { kind: 'document', start: 0, end: text.length, line: 1 };
}

function fenceStart(line) {
  const match = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1][0] === '\x60' && match[2].includes('\x60'))) return null;
  return { character: match[1][0], length: match[1].length, language: match[2].trim().split(/\s+/)[0].toLowerCase() };
}

function headingAt(line, next) {
  const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (atx) return { level: atx[1].length, title: (atx[2] || '').replace(/[ \t]+#+[ \t]*$/, '').trim(), lines: 1 };
  const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(next || '');
  if (underline && line.trim() && !/^(?: {4}|\t)|^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(line)) {
    return { level: underline[1][0] === '=' ? 1 : 2, title: line.trim(), lines: 2 };
  }
  return null;
}

function tableCells(line) {
  if (/^(?: {4}|\t)/.test(line)) return null;
  const value = line.trim();
  const cells = [];
  let start = 0;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === '|' && !escaped) { cells.push(value.slice(start, index).trim()); start = index + 1; }
    escaped = character === '\\' && !escaped;
  }
  if (!cells.length) return null;
  cells.push(value.slice(start).trim());
  if (!cells[0]) cells.shift();
  if (!cells.at(-1)) cells.pop();
  return cells;
}

function isTableHeader(line, next) {
  const header = tableCells(line);
  const delimiter = tableCells(next || '');
  return header?.length > 0 && header.length === delimiter?.length && delimiter.every((cell) => /^:?-+:?$/.test(cell));
}

function isRule(line) {
  return /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(line);
}

function isListItem(line) {
  return /^ {0,3}(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.test(line) && !isRule(line);
}

// Recognize top-level source blocks without rendering HTML or executing diagrams.
// Two-line lookahead keeps pagination bounded even for large documents.
function* markdownParts(text) {
  const iterator = linesOf(text);
  const buffer = [];
  function peek(index = 0) {
    while (buffer.length <= index) {
      const next = iterator.next();
      if (next.done) return null;
      buffer.push(next.value);
    }
    return buffer[index];
  }
  function take() { const line = peek(); buffer.shift(); return line; }
  const isBoundary = (line) => fenceStart(line) || isListItem(line) || isRule(line) || /^ {0,3}(?:#{1,6}(?:[ \t]|$)|>)/.test(line);
  while (peek()) {
    const first = peek();
    if (!first.text.trim()) { take(); continue; }
    const fence = fenceStart(first.text);
    if (fence) {
      let last = take();
      while (peek()) {
        last = take();
        const closing = /^ {0,3}(\x60{3,}|~{3,})[ \t]*$/.exec(last.text);
        if (closing && closing[1][0] === fence.character && closing[1].length >= fence.length) break;
      }
      yield { kind: fence.language === 'mermaid' ? 'diagram' : 'code', language: fence.language, start: first.offset, end: last.offset + last.text.length, line: first.line };
      continue;
    }
    if (/^(?: {4}|\t)/.test(first.text)) {
      let last = take();
      while (peek() && (/^(?: {4}|\t)/.test(peek().text) || !peek().text.trim())) {
        const line = take();
        if (line.text.trim()) last = line;
      }
      yield { kind: 'code', start: first.offset, end: last.offset + last.text.length, line: first.line };
      continue;
    }
    if (isRule(first.text)) {
      take();
      yield { kind: 'rule', start: first.offset, end: first.offset + first.text.length, line: first.line };
      continue;
    }
    if (isListItem(first.text)) {
      let last = take();
      let separated = false;
      // Keep adjacent items, nested items and indented continuations together.
      // Blank separators are included only if another list line follows.
      while (peek()) {
        const line = peek();
        if (!line.text.trim()) { take(); separated = true; continue; }
        if (isRule(line.text)) break;
        if (!isListItem(line.text) && !/^(?: {2,}|\t)/.test(line.text) &&
          (separated || isBoundary(line.text) || headingAt(line.text, peek(1)?.text) || isTableHeader(line.text, peek(1)?.text))) break;
        last = take();
        separated = false;
      }
      yield { kind: 'list', start: first.offset, end: last.offset + last.text.length, line: first.line };
      continue;
    }
    if (/^ {0,3}>/.test(first.text)) {
      let last = take();
      while (peek() && /^ {0,3}>/.test(peek().text)) last = take();
      yield { kind: 'quote', start: first.offset, end: last.offset + last.text.length, line: first.line };
      continue;
    }
    const heading = headingAt(first.text, peek(1)?.text);
    if (heading) {
      let last = take();
      if (heading.lines === 2) last = take();
      yield { kind: 'heading', title: heading.title, level: heading.level, start: first.offset, end: last.offset + last.text.length, line: first.line };
      continue;
    }
    if (isTableHeader(first.text, peek(1)?.text)) {
      take();
      let last = take();
      while (peek()?.text.trim() && tableCells(peek().text) && !isBoundary(peek().text) && !headingAt(peek().text, peek(1)?.text)) last = take();
      yield { kind: 'table', start: first.offset, end: last.offset + last.text.length, line: first.line };
      continue;
    }
    let last = take();
    while (peek()?.text.trim() && !isBoundary(peek().text) && !headingAt(peek().text, peek(1)?.text) && !isTableHeader(peek().text, peek(1)?.text)) last = take();
    yield { kind: 'paragraph', start: first.offset, end: last.offset + last.text.length, line: first.line };
  }
}

function* aggregatedMarkdown(text) {
  let pending = null;
  for (const block of markdownParts(text)) {
    // Only the prose immediately following a heading belongs to that heading.
    // Lists, tables, diagrams and code remain independent selectable units.
    if (pending?.kind === 'heading' && block.kind === 'paragraph') {
      pending.end = block.end;
      continue;
    }
    if (pending) yield pending;
    pending = { ...block };
  }
  if (pending) yield pending;
}

function* coveredBlocks(text, blocks) {
  let pending = null;
  for (const block of blocks) {
    if (pending) yield { ...pending, end: block.start };
    pending = { ...block, start: pending ? block.start : 0, line: pending ? block.line : 1 };
  }
  if (pending) yield { ...pending, end: text.length };
  else if (text.length) yield { kind: 'document', start: 0, end: text.length, line: 1 };
}

function* markdownBlocks(text) {
  let pending = null;
  let found = false;
  for (const block of markdownParts(text)) {
    if (block.kind !== 'heading') continue;
    if (!found && text.slice(0, block.start).trim()) {
      yield { kind: 'preamble', start: 0, end: block.start, line: 1 };
    }
    found = true;
    if (pending) yield { ...pending, end: block.start };
    pending = block;
  }
  if (pending) yield { ...pending, end: text.length };
  if (!found) yield* paragraphs(text);
}

function* documentBlocks(type, text, kind) {
  if (kind === 'structure') {
    yield* coveredBlocks(text, type === 'text' ? paragraphs(text) : aggregatedMarkdown(text));
    return;
  }
  if (type === 'text') { if (['section', 'paragraph'].includes(kind)) yield* paragraphs(text); return; }
  if (kind === 'section') { yield* markdownBlocks(text); return; }
  for (const block of markdownParts(text)) if (block.kind === kind) yield block;
}

export function blocksFor(type, text, kind = 'structure') {
  if (typeof text !== 'string' || !pluginFor(type)) return [];
  return [...documentBlocks(type, text, kind)];
}

export function blocksPage(type, text, page = 0, pageSize = 200, kind = 'structure') {
  if (typeof text !== 'string' || !pluginFor(type)) return { blocks: [], hasNext: false };
  const offset = Math.max(0, Math.floor(page)) * pageSize;
  const blocks = [];
  let index = 0;
  for (const block of documentBlocks(type, text, kind)) {
    if (index >= offset) {
      if (blocks.length === pageSize) return { blocks, hasNext: true };
      blocks.push(block);
    }
    index += 1;
  }
  return { blocks, hasNext: false };
}

function appendInline(parent, text) {
  const pattern = /!?\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|\x60[^\x60\n]+\x60|\*[^*\n]+\*/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(position, match.index)));
    const part = match[0];
    let child;
    if (part.startsWith('![')) {
      child = document.createTextNode(part);
    } else if (part.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      try {
        const url = new URL(link[2], location.origin);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('unsupported URL');
        child = document.createElement('a');
        child.href = url.href;
        child.target = '_blank';
        child.rel = 'noopener noreferrer';
        child.textContent = link[1];
      } catch {
        child = document.createTextNode(part);
      }
    } else {
      const isStrong = part.startsWith('**');
      const isCode = part.startsWith('\x60');
      child = document.createElement(isStrong ? 'strong' : isCode ? 'code' : 'em');
      child.textContent = part.slice(isStrong ? 2 : 1, isStrong ? -2 : -1);
    }
    parent.append(child);
    position = match.index + part.length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}

function renderMarkdown(container, text) {
  container.replaceChildren();
  const lines = text.split('\n');
  let index = 0;
  const isSpecial = (line) => /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?|\x60\x60\x60|(?:---+|\*\*\*+)\s*$)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^\s{0,3}\x60\x60\x60/.test(line)) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}\x60\x60\x60/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const child = document.createElement('code');
      child.textContent = code.join('\n');
      pre.append(child);
      container.append(pre);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const child = document.createElement('h' + heading[1].length);
      appendInline(child, heading[2]);
      container.append(child);
      index += 1;
      continue;
    }
    if (/^\s{0,3}(?:---+|\*\*\*+)\s*$/.test(line)) {
      container.append(document.createElement('hr'));
      index += 1;
      continue;
    }
    const bullet = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      const ordered = /^\d/.test(bullet[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const child = document.createElement('li');
        appendInline(child, item[2]);
        list.append(child);
        index += 1;
      }
      container.append(list);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      const block = document.createElement('blockquote');
      const paragraph = document.createElement('p');
      appendInline(paragraph, quote.join(' '));
      block.append(paragraph);
      container.append(block);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isSpecial(lines[index])) paragraphLines.push(lines[index++]);
    const paragraph = document.createElement('p');
    appendInline(paragraph, paragraphLines.join(' '));
    container.append(paragraph);
  }
}
