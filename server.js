import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { constants, promises as fs } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const projectDir = path.dirname(fileURLToPath(import.meta.url));
const maxFileBytes = 2 * 1024 * 1024;
// JSON can escape one byte of text as six ASCII bytes (for example, \u0001).
const maxRequestBytes = maxFileBytes * 6 + 4096;
const sampleNames = ['welcome.md', 'notes.txt'];
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/plugins.js', ['plugins.js', 'text/javascript; charset=utf-8']],
  ['/local-files.js', ['local-files.js', 'text/javascript; charset=utf-8']],
  ['/assistant.js', ['assistant.js', 'text/javascript; charset=utf-8']],
  ['/i18n.js', ['i18n.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function equalPath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 240 &&
    name !== '.' && name !== '..' && !/[\\/\u0000-\u001f\u007f]/u.test(name) &&
    !name.startsWith('.') && path.basename(name) === name;
}

function fileType(name) {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.md') return 'markdown';
  if (extension === '.txt') return 'text';
  return null;
}

function revision(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeFile(bytes) {
  if (bytes.length > maxFileBytes) throw new HttpError(413, '文件超过 2 MB，演示暂时无法打开。');
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    throw new HttpError(422, '文件不是有效的 UTF-8 文本，演示无法安全编辑。');
  }
  if (text.includes('\0')) throw new HttpError(422, '文件包含二进制内容，演示无法安全编辑。');
  const kinds = new Set(text.match(/\r\n|\r|\n/g) || []);
  const mixed = kinds.size > 1;
  const ending = kinds.size === 0 ? '' : [...kinds][0];
  return {
    content: text.replace(/\r\n|\r/g, '\n'),
    encoding: hasBom ? 'UTF-8 BOM' : 'UTF-8',
    newline: mixed ? 'mixed' : ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : ending === '\n' ? 'LF' : 'none',
    editable: !mixed,
    warning: mixed ? '文件包含混合换行，演示仅提供查看，避免保存时改变原始格式。' : null,
    hasBom,
    ending,
  };
}

async function prepareDataDirectory(dataDir, samplesDir) {
  await fs.mkdir(dataDir, { recursive: true });
  const info = await fs.lstat(dataDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('本地数据目录不能是符号链接或其他类型的文件。');
  const realDataDir = await fs.realpath(dataDir);
  // Only create missing copies. Existing local content always wins.
  for (const name of sampleNames) {
    try {
      await fs.copyFile(path.join(samplesDir, name), path.join(realDataDir, name), constants.COPYFILE_EXCL);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  return realDataDir;
}

async function checkedPath(dataDir, name) {
  if (!validName(name)) throw new HttpError(400, '文件名无效。');
  if (!fileType(name)) throw new HttpError(415, '演示只支持 .txt 和 .md 文件。');
  const candidate = path.join(dataDir, name);
  let info;
  try {
    info = await fs.lstat(candidate);
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(404, '文件不存在，可能已被移除。');
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) throw new HttpError(403, '不能打开链接或非普通文件。');
  const realFile = await fs.realpath(candidate);
  if (!equalPath(path.dirname(realFile), dataDir)) throw new HttpError(403, '文件不在演示目录内。');
  return candidate;
}

async function readDocument(dataDir, name) {
  const candidate = await checkedPath(dataDir, name);
  // O_NOFOLLOW is not available on Windows; lstat and realpath checks still reject
  // ordinary links and junctions before opening. See README for the local boundary.
  const handle = await fs.open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let bytes;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new HttpError(403, '只能打开普通文件。');
    if (stat.size > maxFileBytes) throw new HttpError(413, '文件超过 2 MB，演示暂时无法打开。');
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const decoded = decodeFile(bytes);
  return { ...decoded, name, type: fileType(name), revision: revision(bytes) };
}

function publicDocument(document) {
  const { hasBom, ending, ...result } = document;
  return result;
}

async function requestJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    throw new HttpError(415, '请求必须使用 JSON。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxRequestBytes) throw new HttpError(413, '请求内容过大。');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求 JSON 无效。');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function hasToken(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function createEditorServer({ dataDir = path.join(projectDir, 'local-data'), samplesDir = path.join(projectDir, 'samples'), token = randomBytes(32).toString('hex') } = {}) {
  const realDataDir = await prepareDataDirectory(dataDir, samplesDir);
  const pending = new Map();

  async function serialize(name, work) {
    const previous = pending.get(name) || Promise.resolve();
    const current = previous.catch(() => {}).then(work);
    pending.set(name, current);
    try {
      return await current;
    } finally {
      if (pending.get(name) === current) pending.delete(name);
    }
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const address = server.address();
      const host = `127.0.0.1:${address.port}`;
      const origin = `http://${host}`;
      if (req.headers.host !== host) throw new HttpError(403, '请求主机无效。');
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        if (!hasToken(req.headers['x-editor-token'], token)) throw new HttpError(401, '会话无效，请使用终端中显示的地址重新打开。');
        if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, '请求来源无效。');
        if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') throw new HttpError(403, '请求来源无效。');

        if (url.pathname === '/api/files' && req.method === 'GET') {
          const entries = await fs.readdir(realDataDir, { withFileTypes: true });
          const files = entries.filter((entry) => validName(entry.name) && (entry.isFile() || entry.isSymbolicLink()))
            .map((entry) => ({ name: entry.name, type: fileType(entry.name), accessible: entry.isFile() && !entry.isSymbolicLink() }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
          return sendJson(res, 200, { files });
        }
        if (url.pathname === '/api/file' && req.method === 'GET') {
          return sendJson(res, 200, publicDocument(await readDocument(realDataDir, url.searchParams.get('name'))));
        }
        if (url.pathname === '/api/file' && req.method === 'PUT') {
          const input = await requestJson(req);
          if (!input || !validName(input.name) || typeof input.content !== 'string' ||
            typeof input.revision !== 'string' || !/^[a-f0-9]{64}$/.test(input.revision) || /[\r\0]/u.test(input.content)) {
            throw new HttpError(400, '保存参数无效。');
          }
          if (Buffer.from(input.content, 'utf8').toString('utf8') !== input.content) {
            throw new HttpError(422, '内容包含无法无损保存的 Unicode 字符，请检查后重试。');
          }
          const canonical = await fs.realpath(await checkedPath(realDataDir, input.name));
          const lockKey = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          const result = await serialize(lockKey, async () => {
            const current = await readDocument(realDataDir, input.name);
            if (current.revision !== input.revision) throw new HttpError(409, '文件已在其他位置修改，未覆盖磁盘内容。请先备份当前编辑，再重新打开文件。');
            if (!current.editable) throw new HttpError(422, current.warning);
            const normalized = input.content.replace(/\n/g, current.ending || '\n');
            const contents = Buffer.from(`${current.hasBom ? '\ufeff' : ''}${normalized}`, 'utf8');
            if (contents.length > maxFileBytes) throw new HttpError(413, '文件超过 2 MB，无法保存。');
            const temp = path.join(realDataDir, `.editor-${randomBytes(16).toString('hex')}.tmp`);
            try {
              await fs.writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
              const latest = await readDocument(realDataDir, input.name);
              if (latest.revision !== input.revision) throw new HttpError(409, '文件已在其他位置修改，未覆盖磁盘内容。请先备份当前编辑，再重新打开文件。');
              await fs.rename(temp, await checkedPath(realDataDir, input.name));
            } finally {
              await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
            }
            return { revision: revision(contents) };
          });
          return sendJson(res, 200, result);
        }
        throw new HttpError(404, '接口不存在。');
      }
      if (req.method !== 'GET' || !staticFiles.has(url.pathname)) throw new HttpError(404, '页面不存在。');
      const [filename, contentType] = staticFiles.get(url.pathname);
      const contents = await fs.readFile(path.join(projectDir, 'public', filename));
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      return res.end(contents);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : '读取或保存失败，请确认文件可访问后重试。';
      if (!res.headersSent) return sendJson(res, status, { error: message });
      res.destroy();
    }
  });
  return { server, token };
}

if (process.argv[1] && equalPath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url))) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是 0 到 65535 之间的整数。');
  const { server, token } = await createEditorServer();
  server.on('error', (error) => {
    console.error(`无法启动本地服务：${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`编辑器已启动，请在浏览器打开：\nhttp://127.0.0.1:${server.address().port}/#token=${token}\n按 Ctrl+C 停止服务。`);
  });
}
