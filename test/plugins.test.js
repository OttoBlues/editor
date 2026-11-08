import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksFor, blocksPage, pluginFor, supportsContext } from '../public/plugins.js';

test('context actions require an explicit plugin capability', () => {
  for (const capability of ['reference', 'attention', 'focus']) {
    assert.equal(supportsContext('markdown', capability), true);
    assert.equal(supportsContext('text', capability), true);
    assert.equal(supportsContext('python', capability), false);
    assert.equal(supportsContext(undefined, capability), false);
  }
  assert.equal(supportsContext('markdown', 'unknown'), false);
});

test('Markdown sections retain exact source ranges and ignore headings inside fences', () => {
  const source = '前言 😀\n\n# 标题\n原文\n\n' + '\x60\x60\x60md\n# 代码内标题\n\x60\x60\x60\n\n## 子标题\n结尾\n';
  const blocks = blocksFor('markdown', source, 'section');
  assert.deepEqual(blocks.map((block) => block.kind), ['preamble', 'heading', 'heading']);
  assert.deepEqual(blocks.map((block) => block.line), [1, 3, 10]);
  assert.equal(source.slice(blocks[0].start, blocks[0].end), '前言 😀\n\n');
  assert.equal(source.slice(blocks[1].start, blocks[1].end), '# 标题\n原文\n\n\x60\x60\x60md\n# 代码内标题\n\x60\x60\x60\n\n');
  assert.equal(source.slice(blocks[2].start, blocks[2].end), '## 子标题\n结尾\n');
});

test('plain-text paragraph blocks preserve whitespace and exact offsets', () => {
  const source = '  第一段\n第二行  \n \n\t第二段 😀\n';
  const blocks = blocksFor('text', source);
  assert.deepEqual(blocks.map((block) => source.slice(block.start, block.end)), ['  第一段\n第二行  \n \n', '\t第二段 😀\n']);
  assert.deepEqual(blocks.map((block) => block.line), [1, 4]);
});

test('heading-free Markdown falls back to paragraphs; unsupported and empty inputs have no blocks', () => {
  assert.equal(blocksFor('markdown', '一段\n\n二段').length, 2);
  assert.deepEqual(blocksFor('text', ''), []);
  assert.deepEqual(blocksFor('python', 'def f(): pass'), []);
  assert.equal(pluginFor('text').extension, '.txt');
  assert.equal(pluginFor('markdown').preview, true);
  assert.equal(typeof pluginFor('markdown').render, 'function');
});

test('large documents expose bounded pages while preserving section boundaries', () => {
  const source = Array.from({ length: 205 }, (_, index) => '# 标题 ' + index + '\n正文 ' + index + '\n').join('');
  const first = blocksPage('markdown', source, 0);
  const second = blocksPage('markdown', source, 1);
  assert.equal(first.blocks.length, 200);
  assert.equal(first.hasNext, true);
  assert.equal(second.blocks.length, 5);
  assert.equal(second.hasNext, false);
  assert.equal(source.slice(first.blocks[199].start, first.blocks[199].end), '# 标题 199\n正文 199\n');
  assert.equal(source.slice(second.blocks[0].start, second.blocks[0].end), '# 标题 200\n正文 200\n');
  const paragraphs = Array.from({ length: 405 }, (_, index) => '段落 ' + index).join('\n\n');
  const lastPage = blocksPage('text', paragraphs, 2);
  assert.equal(lastPage.blocks.length, 5);
  assert.equal(paragraphs.slice(lastPage.blocks[0].start, lastPage.blocks[0].end), '段落 400\n\n');
});

test('Markdown focus modes isolate paragraphs, Mermaid diagrams, tables and code with exact Unicode offsets', () => {
  const source = '# 标题 😀\n\n正文 😀\n下一行\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n| 名称 | 内容 |\n| :--- | ---: |\n| A\\|B | 示例 |\n\n~~~js\n# not a heading\n~~~\n\n尾段\n';
  const slice = (kind) => blocksFor('markdown', source, kind).map((block) => source.slice(block.start, block.end));
  assert.deepEqual(slice('paragraph'), ['正文 😀\n下一行', '尾段']);
  assert.deepEqual(slice('diagram'), ['```mermaid\nflowchart LR\n A --> B\n```']);
  assert.deepEqual(slice('table'), ['| 名称 | 内容 |\n| :--- | ---: |\n| A\\|B | 示例 |']);
  assert.deepEqual(slice('code'), ['~~~js\n# not a heading\n~~~']);
  assert.equal(blocksFor('markdown', source, 'diagram')[0].line, 6);
  assert.deepEqual(pluginFor('markdown').focusModes, ['structure', 'selection']);
  assert.deepEqual(pluginFor('text').focusModes, ['structure', 'selection']);
  assert.deepEqual(blocksFor('text', source, 'table'), []);
});

test('fence length, unfinished fences, indentation and setext headings do not leak into other focus modes', () => {
  const source = 'Title\n=====\ntext\n\n````mermaid\n```\n# inside\n| a | b |\n| --- | --- |\n````\n\n    # indented code\n\n## End\nlast';
  assert.deepEqual(blocksFor('markdown', source, 'section').map((block) => block.title), ['Title', 'End']);
  assert.deepEqual(blocksFor('markdown', source, 'table'), []);
  const diagram = blocksFor('markdown', source, 'diagram')[0];
  assert.equal(source.slice(diagram.start, diagram.end), '````mermaid\n```\n# inside\n| a | b |\n| --- | --- |\n````');
  const code = blocksFor('markdown', source, 'code')[0];
  assert.equal(source.slice(code.start, code.end), '    # indented code');
  const unfinished = 'before\n\n~~~mermaid\nA --> B\n';
  assert.equal(blocksFor('markdown', unfinished, 'diagram')[0].end, unfinished.length - 1);
  assert.deepEqual(blocksFor('markdown', '| not\\|a table |\n| --- | --- |\n', 'table'), []);
});

test('typed focus pagination counts only the requested block kind', () => {
  const source = Array.from({ length: 205 }, (_, index) => '# Header\n\n```mermaid\nA' + index + ' --> B\n```\n\n').join('');
  const first = blocksPage('markdown', source, 0, 200, 'diagram');
  const second = blocksPage('markdown', source, 1, 200, 'diagram');
  assert.equal(first.blocks.length, 200);
  assert.equal(first.hasNext, true);
  assert.equal(second.blocks.length, 5);
  assert.equal(second.hasNext, false);
  assert.match(source.slice(second.blocks[0].start, second.blocks[0].end), /A200 --> B/);
});

function assertCoverage(source, blocks) {
  let position = 0;
  for (const block of blocks) {
    assert.equal(block.start, position);
    assert.ok(block.end > block.start);
    assert.equal(block.line, source.slice(0, block.start).split('\n').length);
    position = block.end;
  }
  assert.equal(position, source.length);
  assert.equal(blocks.map((block) => source.slice(block.start, block.end)).join(''), source);
}

test('structural focus combines heading prose, whole lists, explanation and diagram into four blocks', () => {
  const parts = ['# 标题 😀\n正文说明\n\n', '- 列表项一\n- 列表项二\n\n', '下面是流程说明。\n\n', '```mermaid\nflowchart LR\n A --> B\n```\n'];
  const source = parts.join('');
  const blocks = blocksFor('markdown', source);
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'list', 'paragraph', 'diagram']);
  assert.deepEqual(blocks.map((block) => source.slice(block.start, block.end)), parts);
  assertCoverage(source, blocks);
});

test('structural lists include nested and continued items without swallowing following prose', () => {
  const source = '# Intro\n\nFirst paragraph.\n\nSecond paragraph.\n\n- one\ncontinued line\n  - nested\n\n- two\n\nExplanation.\n\n1. first\n2. second\n\nEnd.';
  const blocks = blocksFor('markdown', source);
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'list', 'paragraph', 'list', 'paragraph']);
  assert.match(source.slice(blocks[0].start, blocks[0].end), /Second paragraph/);
  assert.equal(source.slice(blocks[1].start, blocks[1].end), '- one\ncontinued line\n  - nested\n\n- two\n\n');
  assert.equal(source.slice(blocks[2].start, blocks[2].end), 'Explanation.\n\n');
  assertCoverage(source, blocks);
});

test('tables stop before explanatory prose and all other Markdown remains selectable', () => {
  const source = '\n\nSetext 😀\n========\nIntro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\nTable explanation.\n\n> quoted\n> continuation\n\n---\n\n~~~js\n# in code\n~~~\n\n    indented code\n\n<custom>unknown syntax</custom>\n\n<!-- unfinished comment\n\nTail  \n\n';
  const blocks = blocksFor('markdown', source);
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'table', 'paragraph', 'quote', 'rule', 'code', 'code', 'paragraph', 'paragraph', 'paragraph']);
  assert.equal(source.slice(blocks[1].start, blocks[1].end), '| A | B |\n| --- | --- |\n| 1 | 2 |\n');
  assertCoverage(source, blocks);
});

test('all whitespace, unfinished syntax, mixed structures and Unicode round-trip without gaps', () => {
  for (const type of ['markdown', 'text']) {
    for (const source of ['', ' \n\t\n', '\n\n未知 😀 text\n\n', '~~~mermaid\nA --> B\n', '# A\n## B\n\n', '-\n- [ ] task\n\n', '***\n___\n- - -\n']) {
      assertCoverage(source, blocksFor(type, source));
    }
  }
  const parts = ['# Title\nText 😀\n\n', '- a\n- b\n\n', '| A |\n| --- |\n| 1 |\n', 'Explanation\n\n', '```mermaid\nA --> B\n```\n', ':::unknown\n\n', '> quote\n\n'];
  for (let offset = 0; offset < parts.length; offset += 1) {
    const source = '\n' + Array.from({ length: 80 }, (_, index) => parts[(index + offset) % parts.length]).join('') + '\n\t';
    assertCoverage(source, blocksFor('markdown', source));
  }
});

test('mixed structural pagination partitions every character and does not filter types', () => {
  const unit = '# Heading\nText 😀\n\n- a\n- b\n\nFlow explanation\n\n```mermaid\nA --> B\n```\n';
  const source = unit.repeat(103);
  const pages = [0, 1, 2].map((page) => blocksPage('markdown', source, page));
  assert.deepEqual(pages.map((page) => page.blocks.length), [200, 200, 12]);
  assert.deepEqual(pages.map((page) => page.hasNext), [true, true, false]);
  assert.deepEqual(pages[0].blocks.slice(0, 4).map((block) => block.kind), ['heading', 'list', 'paragraph', 'diagram']);
  assertCoverage(source, pages.flatMap((page) => page.blocks));
});
