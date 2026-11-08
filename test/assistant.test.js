import test from 'node:test';
import assert from 'node:assert/strict';
import { suggest, SuggestionError } from '../public/assistant.js';

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
