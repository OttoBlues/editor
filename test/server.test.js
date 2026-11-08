import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { once } from 'node:events';
import { createEditorServer } from '../server.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-demo-test-'));
  const dataDir = path.join(root, 'data');
  const instance = await createEditorServer({ dataDir });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  const origin = 'http://127.0.0.1:' + instance.server.address().port;
  t.after(async () => {
    await new Promise((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function request(url, options = {}) {
    const headers = { 'X-Editor-Token': instance.token, ...(options.headers || {}) };
    return fetch(origin + url, { ...options, headers });
  }
  async function document(name) {
    const response = await request('/api/file?name=' + encodeURIComponent(name));
    assert.equal(response.status, 200);
    return response.json();
  }
  async function save(name, content, revision) {
    return request('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: origin },
      body: JSON.stringify({ name, content, revision }),
    });
  }
  return { root, dataDir, instance, origin, request, document, save };
}

test('serves the interface and protects local APIs from unauthorized browser origins and hosts', async (t) => {
  const f = await fixture(t);
  const page = await fetch(f.origin + '/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await page.text(), /模拟助手/);
  for (const module of ['/plugins.js', '/assistant.js', '/i18n.js']) {
    const response = await fetch(f.origin + module);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/javascript/);
  }
  assert.equal((await fetch(f.origin + '/api/files')).status, 401);
  assert.equal((await f.request('/api/files', { headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await f.request('/api/files', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => {
    const request = http.get(f.origin + '/api/files', {
      headers: { Host: 'attacker.example:' + f.instance.server.address().port, 'X-Editor-Token': f.instance.token },
    }, (response) => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(badHostStatus, 403);
  const result = await (await f.request('/api/files')).json();
  assert.deepEqual(result.files.map((file) => file.name).sort(), ['notes.txt', 'welcome.md']);
});

test('preserves UTF-8 BOM and CRLF on save, and does not overwrite local copies on restart', async (t) => {
  const f = await fixture(t);
  const name = 'format.txt';
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n第二行\r\n')]);
  await fs.writeFile(path.join(f.dataDir, name), original);
  const doc = await f.document(name);
  assert.equal(doc.content, '第一行\n第二行\n');
  assert.equal(doc.encoding, 'UTF-8 BOM');
  assert.equal(doc.newline, 'CRLF');
  assert.equal((await f.save(name, '第一行\n更新后\n', doc.revision)).status, 200);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, name)),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('第一行\r\n更新后\r\n')]));

  await fs.writeFile(path.join(f.dataDir, 'double-bom.txt'), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('文字'),
  ]));
  const doubleBom = await f.document('double-bom.txt');
  assert.equal(doubleBom.content, '\ufeff文字');
  assert.equal((await f.save('double-bom.txt', doubleBom.content + '！', doubleBom.revision)).status, 200);
  assert.deepEqual(await fs.readFile(path.join(f.dataDir, 'double-bom.txt')), Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from('文字！'),
  ]));

  await fs.writeFile(path.join(f.dataDir, 'notes.txt'), '保留的本地内容');
  await createEditorServer({ dataDir: f.dataDir });
  assert.equal(await fs.readFile(path.join(f.dataDir, 'notes.txt'), 'utf8'), '保留的本地内容');
});

test('rejects stale saves from another window or an external edit', async (t) => {
  const f = await fixture(t);
  const first = await f.document('notes.txt');
  const second = await f.document('notes.txt');
  assert.equal((await f.save('notes.txt', '窗口一保存', first.revision)).status, 200);
  assert.equal((await f.save('notes.txt', '窗口二保存', second.revision)).status, 409);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'notes.txt'), 'utf8'), '窗口一保存');

  const current = await f.document('notes.txt');
  await fs.writeFile(path.join(f.dataDir, 'notes.txt'), '外部修改');
  const conflict = await f.save('notes.txt', '不能覆盖', current.revision);
  assert.equal(conflict.status, 409);
  assert.match((await conflict.json()).error, /未覆盖/);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'notes.txt'), 'utf8'), '外部修改');
});

test('concurrent saves for the same version cannot silently overwrite one another', async (t) => {
  const f = await fixture(t);
  const doc = await f.document('notes.txt');
  const responses = await Promise.all([
    f.save('notes.txt', '第一份', doc.revision),
    f.save('notes.txt', '第二份', doc.revision),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.ok(['第一份', '第二份'].includes(await fs.readFile(path.join(f.dataDir, 'notes.txt'), 'utf8')));
  if (process.platform === 'win32') {
    const current = await f.document('notes.txt');
    const aliases = await Promise.all([
      f.save('notes.txt', '小写路径', current.revision),
      f.save('NOTES.TXT', '大写路径', current.revision),
    ]);
    assert.deepEqual(aliases.map((response) => response.status).sort(), [200, 409]);
  }
});

test('accepts valid files whose JSON representation is much larger than their UTF-8 bytes', async (t) => {
  const f = await fixture(t);
  const doc = await f.document('notes.txt');
  const content = '\u0001'.repeat(900 * 1024);
  assert.equal((await f.save('notes.txt', content, doc.revision)).status, 200);
  assert.equal((await fs.stat(path.join(f.dataDir, 'notes.txt'))).size, content.length);
});

test('allows viewing mixed newlines but refuses to save them, and rejects invalid UTF-8', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.dataDir, 'mixed.md'), 'a\r\nb\nc');
  const mixed = await f.document('mixed.md');
  assert.equal(mixed.newline, 'mixed');
  assert.equal(mixed.editable, false);
  assert.equal((await f.save('mixed.md', 'a\nb\nc', mixed.revision)).status, 422);
  assert.equal(await fs.readFile(path.join(f.dataDir, 'mixed.md'), 'utf8'), 'a\r\nb\nc');
  await fs.writeFile(path.join(f.dataDir, 'invalid.txt'), Buffer.from([0xff, 0xfe, 0x61]));
  assert.equal((await f.request('/api/file?name=invalid.txt')).status, 422);
});

test('rejects traversal, unsupported file types, invalid save input and oversized files', async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'secret.txt'), 'not accessible');
  await fs.writeFile(path.join(f.dataDir, 'other.js'), 'not supported');
  await fs.writeFile(path.join(f.dataDir, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61));
  assert.equal((await f.request('/api/file?name=' + encodeURIComponent('../secret.txt'))).status, 400);
  assert.equal((await f.request('/api/file?name=' + encodeURIComponent('..\\secret.txt'))).status, 400);
  assert.equal((await f.request('/api/file?name=other.js')).status, 415);
  assert.equal((await f.request('/api/file?name=large.txt')).status, 413);
  assert.equal((await f.request('/api/file?name=missing.txt')).status, 404);
  assert.equal((await f.request('/api/file', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '../secret.txt', revision: 'a'.repeat(64), content: 'x' }),
  })).status, 400);
  const doc = await f.document('notes.txt');
  assert.equal((await f.save('notes.txt', '\ud800', doc.revision)).status, 422);
  assert.equal((await f.document('notes.txt')).revision, doc.revision);
  assert.equal(await fs.readFile(path.join(f.root, 'secret.txt'), 'utf8'), 'not accessible');
});

test('refuses a symbolic link inside the demo directory', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.txt');
  await fs.writeFile(outside, 'outside');
  try {
    await fs.symlink(outside, path.join(f.dataDir, 'linked.txt'), 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('当前系统不允许创建测试符号链接。');
    throw error;
  }
  assert.equal((await f.request('/api/file?name=linked.txt')).status, 403);
});

test('refuses a linked local-data directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'editor-demo-link-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  const link = path.join(root, 'linked-data');
  await fs.mkdir(target);
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('当前系统不允许创建测试目录链接。');
    throw error;
  }
  await assert.rejects(createEditorServer({ dataDir: link }), /不能是符号链接/);
});
