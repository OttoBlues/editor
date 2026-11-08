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
  const blocks = blocksFor('markdown', source);
  assert.deepEqual(blocks.map((block) => block.kind), ['preamble', 'heading', 'heading']);
  assert.deepEqual(blocks.map((block) => block.line), [1, 3, 10]);
  assert.equal(source.slice(blocks[0].start, blocks[0].end), '前言 😀\n\n');
  assert.equal(source.slice(blocks[1].start, blocks[1].end), '# 标题\n原文\n\n\x60\x60\x60md\n# 代码内标题\n\x60\x60\x60\n\n');
  assert.equal(source.slice(blocks[2].start, blocks[2].end), '## 子标题\n结尾\n');
});

test('plain-text paragraph blocks preserve whitespace and exact offsets', () => {
  const source = '  第一段\n第二行  \n \n\t第二段 😀\n';
  const blocks = blocksFor('text', source);
  assert.deepEqual(blocks.map((block) => source.slice(block.start, block.end)), ['  第一段\n第二行  ', '\t第二段 😀']);
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
  assert.equal(paragraphs.slice(lastPage.blocks[0].start, lastPage.blocks[0].end), '段落 400');
});

test('Markdown focus modes isolate paragraphs, Mermaid diagrams, tables and code with exact Unicode offsets', () => {
  const source = '# 标题 😀\n\n正文 😀\n下一行\n\n```mermaid\nflowchart LR\n A --> B\n```\n\n| 名称 | 内容 |\n| :--- | ---: |\n| A\\|B | 示例 |\n\n~~~js\n# not a heading\n~~~\n\n尾段\n';
  const slice = (kind) => blocksFor('markdown', source, kind).map((block) => source.slice(block.start, block.end));
  assert.deepEqual(slice('paragraph'), ['正文 😀\n下一行', '尾段']);
  assert.deepEqual(slice('diagram'), ['```mermaid\nflowchart LR\n A --> B\n```']);
  assert.deepEqual(slice('table'), ['| 名称 | 内容 |\n| :--- | ---: |\n| A\\|B | 示例 |']);
  assert.deepEqual(slice('code'), ['~~~js\n# not a heading\n~~~']);
  assert.equal(blocksFor('markdown', source, 'diagram')[0].line, 6);
  assert.deepEqual(pluginFor('markdown').focusModes, ['section', 'paragraph', 'diagram', 'table', 'code', 'selection']);
  assert.deepEqual(blocksFor('text', source, 'table'), []);
});

test('fence length, unfinished fences, indentation and setext headings do not leak into other focus modes', () => {
  const source = 'Title\n=====\ntext\n\n````mermaid\n```\n# inside\n| a | b |\n| --- | --- |\n````\n\n    # indented code\n\n## End\nlast';
  assert.deepEqual(blocksFor('markdown', source).map((block) => block.title), ['Title', 'End']);
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
