// Built-in adapters operate on the editor's exact in-memory text. Offsets are
// JavaScript string offsets and always refer to slices of the supplied text.
export const plugins = Object.freeze([
  { id: 'markdown', type: 'markdown', extension: '.md', preview: true, blocks: 'headings', render: renderMarkdown },
  { id: 'text', type: 'text', extension: '.txt', preview: false, blocks: 'paragraphs' },
]);

export function pluginFor(type) {
  return plugins.find((plugin) => plugin.type === type) || null;
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

function* markdownBlocks(text) {
  let fence = null;
  let pending = null;
  let found = false;
  for (const line of linesOf(text)) {
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line.text);
    if (fence) {
      if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
    } else if (marker) {
      fence = { character: marker[1][0], length: marker[1].length };
    } else {
      const heading = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$/.exec(line.text);
      if (heading) {
        if (!found && text.slice(0, line.offset).trim()) {
          yield { kind: 'preamble', start: 0, end: line.offset, line: 1 };
        }
        found = true;
        if (pending) yield { ...pending, end: line.offset };
        pending = {
          kind: 'heading',
          title: heading[2].replace(/[ \t]+#+[ \t]*$/, ''),
          level: heading[1].length,
          start: line.offset,
          line: line.line,
        };
      }
    }
  }
  if (pending) yield { ...pending, end: text.length };
  if (!found) yield* paragraphs(text);
}

export function blocksFor(type, text) {
  if (typeof text !== 'string' || !pluginFor(type)) return [];
  return [...(type === 'markdown' ? markdownBlocks(text) : paragraphs(text))];
}

export function blocksPage(type, text, page = 0, pageSize = 200) {
  if (typeof text !== 'string' || !pluginFor(type)) return { blocks: [], hasNext: false };
  const offset = Math.max(0, Math.floor(page)) * pageSize;
  const blocks = [];
  let index = 0;
  for (const block of type === 'markdown' ? markdownBlocks(text) : paragraphs(text)) {
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
