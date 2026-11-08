import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { messages, translate, serverMessage } from '../public/i18n.js';

test('both interface languages cover the same settings and interaction messages', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages['zh-CN']).sort());
  for (const key of Object.keys(messages.en)) {
    const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(messages.en[key]), placeholders(messages['zh-CN'][key]), key);
  }
  assert.equal(translate('en', 'pane', { n: '02' }), 'Pane 02');
  assert.equal(translate('zh-CN', 'pane', { n: '02' }), '编辑区 02');
  assert.match(serverMessage('en', '文件已在其他位置修改，未覆盖磁盘内容。请先备份当前编辑，再重新打开文件。'), /not overwritten/);
});

test('every static interface translation key exists in both languages', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const match of html.matchAll(/data-i18n(?:-aria|-title)?="([^"]+)"/g)) {
    assert.ok(Object.hasOwn(messages['zh-CN'], match[1]), match[1]);
    assert.ok(Object.hasOwn(messages.en, match[1]), match[1]);
  }
});
