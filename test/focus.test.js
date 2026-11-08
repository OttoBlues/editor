import test from 'node:test';
import assert from 'node:assert/strict';
import { blocksFor } from '../public/plugins.js';
import { focusCanvasBlocks, validFocus } from '../public/focus.js';

function assertPartition(source, blocks, start = 0, end = source.length) {
  let offset = start;
  for (const block of blocks) {
    assert.equal(block.start, offset);
    assert.ok(block.end > block.start);
    assert.equal(block.line, source.slice(0, block.start).split('\n').length);
    offset = block.end;
  }
  assert.equal(offset, end);
  assert.equal(blocks.map((block) => source.slice(block.start, block.end)).join(''), source.slice(start, end));
}

test('partial manual ranges leave both sides of each automatic block selectable', () => {
  const source = '# Heading 😀\nBefore selected after\n\n- one\n- two\n\nFinal';
  const candidates = blocksFor('markdown', source);
  const start = source.indexOf('selected');
  const selection = { kind: 'selection', start, end: start + 8, text: 'selected' };
  const blocks = focusCanvasBlocks(source, candidates, [selection]);
  assertPartition(source, blocks);
  assert.equal(blocks[1].text, 'selected');
  assert.ok(blocks.some((block) => block.start === selection.end && block.end === candidates[0].end));
  assert.equal(validFocus({ documentSnapshot: source, ranges: blocks.map((block) => ({ ...block, text: source.slice(block.start, block.end) })) }, source), true);
});

test('manual selections across automatic boundaries stay exact with no missing text', () => {
  const source = '# Header\nBody\n\n- first\n- second\n\nDescription\n\n~~~mermaid\nA --> B\n~~~';
  const candidates = blocksFor('markdown', source);
  const selected = [{ kind: 'selection', start: 4, end: 21 }, { kind: 'selection', start: 26, end: 43 }];
  const blocks = focusCanvasBlocks(source, candidates, selected);
  assertPartition(source, blocks);
  for (const range of selected) assert.ok(blocks.some((block) => block.start === range.start && block.end === range.end));
  assertPartition(source, focusCanvasBlocks(source, candidates, selected.slice(1)));
  assert.deepEqual(focusCanvasBlocks(source, candidates, []), candidates);
});

test('manual review includes selectable fallback blocks and whitespace around all selections', () => {
  const source = 'before 😀 chosen between chosen after\n';
  const selected = [{ kind: 'selection', start: 10, end: 16 }, { kind: 'selection', start: 25, end: 31 }];
  const blocks = focusCanvasBlocks(source, [], selected);
  assert.equal(blocks.length, 5);
  assertPartition(source, blocks);
  assertPartition(source, focusCanvasBlocks(source, [], []));
  assert.deepEqual(focusCanvasBlocks('', [], []), []);
  assertPartition(' \n\t', focusCanvasBlocks(' \n\t', [], []));
});

test('paged views cover the visible interval and keep selections beyond it out of view', () => {
  const source = 'first\n\nsecond\n\nthird\n\nlast';
  const candidates = blocksFor('text', source);
  const selected = [candidates[0], candidates[3]];
  const page = candidates.slice(1, 3);
  const blocks = focusCanvasBlocks(source, page, selected, page[0].start, page.at(-1).end);
  assert.deepEqual(blocks, page);
  assertPartition(source, blocks, page[0].start, page.at(-1).end);
  const crossing = { kind: 'selection', start: 4, end: 11 };
  const expanded = focusCanvasBlocks(source, page, [crossing], crossing.start, page.at(-1).end);
  assertPartition(source, expanded, crossing.start, page.at(-1).end);
  assert.equal(expanded[0].start, crossing.start);
  assert.equal(expanded[0].end, crossing.end);
});
