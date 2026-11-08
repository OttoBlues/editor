import test from 'node:test';
import assert from 'node:assert/strict';
import { readLocalFile, localFileBlob } from '../public/local-files.js';

test('local files preserve Unicode, BOM and line endings when exporting edits', async () => {
  for (const ending of ['\n', '\r\n', '\r']) {
    const doc = await readLocalFile(new File(['\ufeff# 虚构示例 😀' + ending + '正文' + ending], 'sample.MD'));
    assert.equal(doc.type, 'markdown');
    assert.equal(doc.source, 'local');
    assert.equal(doc.content, '# 虚构示例 😀\n正文\n');
    assert.equal(doc.hasBom, true);
    const bytes = new Uint8Array(await localFileBlob(doc, doc.content + '修改\n').arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(new TextDecoder().decode(bytes), '# 虚构示例 😀' + ending + '正文' + ending + '修改' + ending);
  }
});

test('local files reject unsupported, binary, malformed and oversized input', async () => {
  for (const [file, error] of [
    [new File(['text'], 'sample.py'), 'onlyText'],
    [new File(['a\0b'], 'sample.txt'), 'localBinary'],
    [new File([new Uint8Array([0xff, 0xfe])], 'sample.txt'), 'localInvalidEncoding'],
    [new File(['x'.repeat(2 * 1024 * 1024 + 1)], 'sample.txt'), 'localTooLarge'],
  ]) await assert.rejects(readLocalFile(file), { message: error });
});

test('mixed line endings are read-only; empty files and no-newline files remain editable', async () => {
  const mixed = await readLocalFile(new File(['a\r\nb\nc'], 'mixed.txt'));
  assert.equal(mixed.editable, false);
  assert.throws(() => localFileBlob(mixed, 'changed'), { message: 'cannotEdit' });
  const empty = await readLocalFile(new File([], 'empty.txt'));
  assert.equal(empty.editable, true);
  assert.equal(empty.newline, 'none');
  assert.equal(await localFileBlob(empty, 'new\ntext').text(), 'new\ntext');
  assert.throws(() => localFileBlob(empty, '\ud800'), { message: 'localInvalidContent' });
  assert.throws(() => localFileBlob(empty, '😀'.repeat(600000)), { message: 'localTooLarge' });
});
