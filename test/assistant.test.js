import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest, suggestForAttention, SuggestionError } from '../public/assistant.js';
import { focusText, validFocus } from '../public/focus.js';
import { blocksFor } from '../public/plugins.js';

function group(content, pieces, annotation = 'Merge') {
  return { role: 'target', documentSnapshot: content, annotation,
    ranges: pieces.map((text) => ({ start: content.indexOf(text), end: content.indexOf(text) + text.length, text })) };
}

test('one grouped merge combines selected blocks in source order and preserves every unselected gap', () => {
  const content = 'BEFORE\n\nalpha 😀\n\nKEEP BETWEEN\n\nomega\n\nAFTER';
  const focus = group(content, ['omega', 'alpha 😀']);
  const saved = structuredClone(focus);
  assert.equal(suggest({ content, prompt: 'Summary', type: 'text', focus, language: 'en' }),
    'BEFORE\n\nalpha 😀\n\nomega\n\nKEEP BETWEEN\n\n\n\nAFTER');
  assert.deepEqual(focus, saved);
  assert.equal(focusText(focus), 'alpha 😀\n\nomega');
});

test('merging structural blocks retains separators without joining unselected text or doubling blank lines', () => {
  const content = 'first 😀\n\nKEEP   MIDDLE\n\nlast';
  const blocks = blocksFor('text', content);
  const focus = { role: 'target', documentSnapshot: content, annotation: 'Merge', ranges: [blocks[0], blocks[2]].map((block) => ({ ...block, text: content.slice(block.start, block.end) })) };
  assert.equal(suggest({ content, prompt: '', type: 'text', focus }), 'first 😀\n\nlast\n\nKEEP   MIDDLE\n\n');
  const adjacent = 'first\n\nlast\n';
  const all = { role: 'target', documentSnapshot: adjacent, annotation: 'Merge', ranges: blocksFor('text', adjacent).map((block) => ({ ...block, text: adjacent.slice(block.start, block.end) })) };
  assert.equal(suggest({ content: adjacent, prompt: '', type: 'text', focus: all }), adjacent);
});

test('group instructions are applied once while spacing can transform each selected slice', () => {
  const content = 'first   \nline\n\nUNSELECTED   \n\nlast';
  const focus = group(content, ['first   \nline', 'last'], 'Add title');
  assert.equal(suggest({ content, prompt: '', type: 'markdown', focus, language: 'en' }), '# Document title\n\n' + content);
  focus.annotation = 'Tidy spacing';
  assert.equal(suggest({ content, prompt: '', type: 'text', focus, language: 'en' }), 'first\nline\n\nUNSELECTED   \n\nlast');
  focus.annotation = 'Explain relationships';
  assert.equal(suggest({ content, prompt: '', type: 'text', focus, language: 'en' }), content + '\n\n[Simulated suggestion: Explain relationships]');
  focus.annotation = 'Insert reference';
  assert.equal(suggest({ content, prompt: '', type: 'text', focus, referenceText: 'ref', language: 'en' }), content + '\n\nref');
});

test('interleaved groups edit independently without merging their bounding ranges', () => {
  const content = 'alpha\n\nbeta\n\ngamma\n\ndelta';
  const focuses = [group(content, ['alpha', 'gamma']), group(content, ['beta', 'delta'], 'Add title')];
  assert.equal(suggest({ content, prompt: '', type: 'text', focuses, language: 'en' }),
    'alpha\n\ngamma\n\nDocument title\n\nbeta\n\n\n\ndelta');
});

test('group validation rejects empty, stale, overlapping, duplicate and tampered ranges', () => {
  const content = 'alpha\n\nbeta';
  const focus = group(content, ['alpha', 'beta']);
  assert.equal(validFocus(focus, content), true);
  const malformed = [[], null, [null], [focus.ranges[0], focus.ranges[0]],
    [{ start: 0, end: 0, text: '' }], [{ start: 0, end: 5, text: 'wrong' }],
    [{ start: 1.5, end: 5, text: 'lpha' }], [{ start: 0, end: 99, text: content }]];
  for (const ranges of malformed) {
    assert.throws(() => suggest({ content, prompt: '', type: 'text', focus: { ...focus, ranges } }), { code: 'stale_focus' });
  }
  assert.throws(() => suggest({ content: content + 'changed', prompt: '', type: 'text', focus }), { code: 'stale_focus' });
  assert.throws(() => suggest({ content, prompt: '', type: 'text', focuses: [focus, group(content, ['beta'])] }), { code: 'stale_focus' });
});

test('grouped reference text contains only selected slices and never becomes an edit target', () => {
  const reference = { ...group('first\n\nSECRET GAP\n\nlast', ['first', 'last'], 'Merge'), role: 'reference' };
  assert.equal(suggest({ content: 'target', prompt: 'Insert reference', type: 'text', focuses: [reference], referenceText: focusText(reference), language: 'en' }), 'target\n\nfirst\n\nlast');
});

test('multiple focused targets modify only their original ranges despite length changes', () => {
  const content = 'first\n\nkeep\n\nlast\n';
  const makeFocus = (start, end) => ({ role: 'target', start, end, text: content.slice(start, end), documentSnapshot: content });
  const focuses = [makeFocus(content.indexOf('last'), content.length), makeFocus(0, 5)];
  const after = suggest({ content, prompt: 'Add title', type: 'text', focuses, language: 'en' });
  assert.equal(after, 'Document title\n\nfirst\n\nkeep\n\nDocument title\n\nlast\n');
  assert.equal(focuses[0].start, content.indexOf('last'));
  assert.throws(() => suggest({ content, prompt: 'Add title', type: 'text', focuses: [makeFocus(0, 8), makeFocus(3, 10)] }), { code: 'stale_focus' });
  assert.throws(() => suggest({ content: content + 'changed', prompt: 'Add title', type: 'text', focuses }), { code: 'stale_focus' });
});

test('a focused target changes only its exact source range', () => {
  const content = '# 第一节\n原文\n\n# 第二节\n保留\n';
  const start = content.indexOf('# 第二节');
  const focus = { role: 'target', start, end: content.length, text: content.slice(start), documentSnapshot: content };
  const after = suggest({ content, prompt: '添加标题', type: 'markdown', focus });
  assert.equal(after, '# 第一节\n原文\n\n# 文档标题\n\n# 第二节\n保留\n');
  assert.equal(content.slice(0, start), after.slice(0, start));
});

test('a stale or mismatched focus cannot produce a modification', () => {
  const focus = { role: 'target', start: 0, end: 2, text: '原文', documentSnapshot: '原文' };
  assert.throws(() => suggest({ content: '已改', prompt: '添加标题', type: 'text', focus }),
    (error) => error instanceof SuggestionError && error.code === 'stale_focus');
  assert.throws(() => suggest({ content: '原文', prompt: '添加标题', type: 'text', focus: { ...focus, text: '不同' } }),
    (error) => error instanceof SuggestionError && error.code === 'stale_focus');
});

test('reference text is read as supplied and only the target is changed', () => {
  const content = '正文\n';
  const reference = '  引用 😀\n原文  \n';
  const after = suggest({ content, prompt: '插入参考', type: 'text', referenceText: reference });
  assert.equal(after, '正文\n\n' + reference + '\n');
  assert.equal(reference, '  引用 😀\n原文  \n');
  assert.throws(() => suggest({ content, prompt: '插入参考', type: 'text' }),
    (error) => error instanceof SuggestionError && error.code === 'reference_required');
});

test('English rules and output-size limits are explicit', () => {
  assert.equal(suggest({ content: 'Body', prompt: 'Add title', type: 'markdown', language: 'en' }), '# Document title\n\nBody');
  assert.throws(() => suggest({ content: 'x', prompt: 'Insert reference', type: 'text', referenceText: 'x'.repeat(40001) }),
    (error) => error instanceof SuggestionError && error.code === 'too_large');
});

test('each focus annotation directs only its own range and overrides the general simulated rule', () => {
  const content = 'first   \nline\n\nKEEP 😀\n\nlast';
  const focus = (start, end, annotation) => ({ role: 'target', start, end, text: content.slice(start, end), documentSnapshot: content, annotation });
  const focuses = [focus(0, 13, 'Tidy spacing'), focus(content.indexOf('last'), content.length, 'Add title')];
  const after = suggest({ content, type: 'text', prompt: 'Summary', focuses, language: 'en' });
  assert.equal(after, 'first\nline\n\nKEEP 😀\n\nDocument title\n\nlast');
  assert.equal(suggest({ content, type: 'text', prompt: '', focuses, language: 'en' }), after);
  assert.throws(() => suggest({ content: content + 'changed', type: 'text', prompt: '', focuses }), { code: 'stale_focus' });
});

test('reference focus annotations never become modification targets or replace source text', () => {
  const content = 'target';
  const focuses = [{ role: 'reference', text: 'source', annotation: 'Add title', start: 0, end: 6, documentSnapshot: 'source' }];
  assert.equal(suggest({ content, type: 'text', prompt: 'Insert reference', focuses, referenceText: 'source', language: 'en' }), 'target\n\nsource');
  assert.equal(focuses[0].annotation, 'Add title');
});

const watchedDocuments = [
  { id: 1, name: 'first.md', type: 'markdown', editable: true, content: '# A\nFirst body\n\nKeep this.' },
  { id: 2, name: 'second.txt', type: 'text', editable: true, content: 'Second body' },
  { id: 3, name: 'untouched.txt', type: 'text', editable: true, content: 'Untouched' },
];

test('intelligent editing targets all and only attention files without mutating input', () => {
  const saved = structuredClone(watchedDocuments);
  const edits = suggestForAttention({ documents: watchedDocuments, attentionIds: [2, 1, 2], prompt: 'Add title', language: 'en' });
  assert.deepEqual(edits.map(edit => edit.tabId), [2, 1]);
  assert.equal(edits[0].after, 'Document title\n\nSecond body');
  assert.equal(edits[1].after, '# Document title\n\n' + watchedDocuments[0].content);
  assert.deepEqual(watchedDocuments, saved);
  assert.throws(() => suggestForAttention({ documents: watchedDocuments, attentionIds: [], prompt: 'Add title' }), { code: 'no_attention' });
});

test('focused instructions restrict watched files and never authorize edits to unwatched files', () => {
  const makeFocus = (document, piece) => ({ ...group(document.content, [piece], 'Add title'), sourceKind: 'tab', sourceId: document.id });
  const firstFocus = makeFocus(watchedDocuments[0], 'First body');
  const unwatchedFocus = makeFocus(watchedDocuments[2], 'Untouched');
  const edits = suggestForAttention({ documents: watchedDocuments, attentionIds: [1, 2], focuses: [firstFocus, unwatchedFocus], prompt: '', language: 'en' });
  assert.equal(edits.length, 1);
  assert.equal(edits[0].after, '# A\n# Document title\n\nFirst body\n\nKeep this.');
  assert.throws(() => suggestForAttention({ documents: watchedDocuments, attentionIds: [2], focuses: [unwatchedFocus], prompt: '' }), { code: 'empty_request' });
});

test('attention plans reject missing, readonly and stale targets before exposing edits', () => {
  assert.throws(() => suggestForAttention({ documents: watchedDocuments, attentionIds: [1, 99], prompt: 'Title' }), { code: 'invalid_target' });
  assert.throws(() => suggestForAttention({ documents: watchedDocuments.map(document => ({ ...document, editable: false })), attentionIds: [1], prompt: 'Title' }), { code: 'invalid_target' });
  const stale = { ...group('Old content', ['Old']), sourceKind: 'tab', sourceId: 1 };
  assert.throws(() => suggestForAttention({ documents: watchedDocuments, attentionIds: [2, 1], focuses: [stale], prompt: 'Title' }), { code: 'stale_focus' });
});

test('references feed watched edits without turning other attention files into references', () => {
  assert.throws(() => suggestForAttention({ documents: watchedDocuments, attentionIds: [1, 2], prompt: 'Insert reference' }), { code: 'reference_required' });
  const edits = suggestForAttention({ documents: watchedDocuments, attentionIds: [2], references: ['Reference text'], prompt: 'Insert reference' });
  assert.equal(edits[0].after, 'Second body\n\nReference text');
});

test('readonly focus supplies exact reference ranges without becoming an edit target', () => {
  const source = { id: 4, name: 'readonly.md', type: 'markdown', editable: false, content: 'First excerpt\nDo not insert this gap\nLast excerpt' };
  const documents = [...watchedDocuments, source];
  const focus = { ...group(source.content, ['Last excerpt', 'First excerpt'], 'Preserve exact wording'), sourceKind: 'tab', sourceId: source.id, role: 'reference' };
  const edits = suggestForAttention({ documents, attentionIds: [2], focuses: [focus], references: ['Full snapshot'], prompt: 'Insert reference' });
  assert.deepEqual(edits.map(edit => edit.tabId), [2]);
  assert.equal(edits[0].after, 'Second body\n\nFirst excerpt\n\nLast excerpt');
  assert.equal(source.content, 'First excerpt\nDo not insert this gap\nLast excerpt');
  assert.throws(() => suggestForAttention({ documents: watchedDocuments, attentionIds: [2], focuses: [focus], prompt: 'Insert reference' }), { code: 'stale_focus' });
  assert.throws(() => suggestForAttention({ documents, attentionIds: [2], focuses: [{ ...focus, documentSnapshot: 'Old' }], prompt: 'Insert reference' }), { code: 'stale_focus' });
});
