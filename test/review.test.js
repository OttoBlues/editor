import test from 'node:test';
import assert from 'node:assert/strict';
import { compareLines, mapReviewOffset, resolveEdit } from '../public/assistant.js';

test('comparison separates modifications, insertions, deletions and unchanged islands', () => {
  const before = 'header\nold\nkeep\ndelete\nend\n';
  const after = 'header\nnew\nkeep\nend\nadded\n';
  const rows = compareLines(before, after);
  assert.equal(rows.map(row => row.left?.text || '').join(''), before);
  assert.equal(rows.map(row => row.right?.text || '').join(''), after);
  assert.equal(rows.find(row => row.left?.text === 'old\n').left.kind, 'modified');
  assert.equal(rows.find(row => row.right?.text === 'new\n').right.kind, 'modified');
  assert.equal(rows.find(row => row.left?.text === 'keep\n').left.kind, 'context');
  assert.equal(rows.find(row => row.left?.text === 'delete\n').left.kind, 'removed');
  assert.equal(rows.find(row => row.right?.text === 'added\n').right.kind, 'added');
});

test('comparison round-trips empty documents, blank lines, Unicode and terminal newlines', () => {
  for (const before of ['', '\n', '原文😀\n\n尾行', 'a\nb\na\n', '<script>alert(1)</script>']) {
    for (const after of ['', '\n\n', '新文😀\n', 'a\nc\na\n', '<img src=x>']) {
      const rows = compareLines(before, after);
      assert.equal(rows.map(row => row.left?.text || '').join(''), before);
      assert.equal(rows.map(row => row.right?.text || '').join(''), after);
    }
  }
});

test('caret follows preserved text, changed lengths, inserted headers and deleted lines', () => {
  assert.equal(mapReviewOffset('body\nlast', 'title\nbody\nlast', 2), 8);
  assert.equal(mapReviewOffset('body', 'title\nbody', 4), 10);
  assert.equal(mapReviewOffset('a\nremove\nz', 'a\nz', 5), 2);
  assert.equal(mapReviewOffset('abc old xyz', 'abc newer xyz', 10), 12);
});

function tab(id, content) { return { id, content, base: content, document: { editable: true }, saving: false }; }
function edit(id, before, after) { return { tabId: id, before, after, status: 'pending' }; }

test('apply and discard resolve files independently and applying does not save', () => {
  const first = tab(1, 'first'), second = tab(2, 'second');
  const a = edit(1, 'first', 'new first'), b = edit(2, 'second', 'new second');
  assert.equal(resolveEdit(a, first, 'apply', [1, 2]), true);
  assert.equal(first.content, 'new first'); assert.equal(first.base, 'first');
  assert.equal(second.content, 'second'); assert.equal(b.status, 'pending');
  assert.equal(resolveEdit(b, second, 'discard', [1, 2]), true);
  assert.equal(second.content, 'second'); assert.equal(b.status, 'discarded');
  assert.equal(resolveEdit(b, second, 'apply', [1, 2]), false);
});

test('stale, closed, readonly and unwatched targets are never overwritten', () => {
  for (const setup of [
    () => [tab(1, 'other'), [1], 'contentChanged'],
    () => [null, [1], 'targetClosed'],
    () => [tab(2, 'old'), [1, 2], 'targetClosed'],
    () => [{ ...tab(1, 'old'), document: { editable: false } }, [1], 'cannotEdit'],
    () => [tab(1, 'old'), [], 'attentionRequired'],
  ]) {
    const [document, attention, problem] = setup(); const change = edit(1, 'old', 'new');
    const original = document?.content;
    assert.equal(resolveEdit(change, document, 'apply', attention), false);
    assert.equal(document?.content, original); assert.equal(change.status, 'expired'); assert.equal(change.problem, problem);
  }
  const saving = { ...tab(1, 'old'), saving: true }, change = edit(1, 'old', 'new');
  assert.equal(resolveEdit(change, saving, 'apply', [1]), false);
  assert.equal(change.status, 'pending'); assert.equal(saving.content, 'old');
});
