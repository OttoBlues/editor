import { plugins } from './plugins.js';

const maxFileBytes = 2 * 1024 * 1024;

// Dropped files stay in the browser and never resolve against server files.
export async function readLocalFile(file) {
  const type = plugins.find((plugin) => file.name.toLowerCase().endsWith(plugin.extension))?.type;
  if (!type) throw new Error('onlyText');
  if (file.size > maxFileBytes) throw new Error('localTooLarge');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > maxFileBytes) throw new Error('localTooLarge');
  const hasBom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(hasBom ? bytes.subarray(3) : bytes);
  } catch {
    throw new Error('localInvalidEncoding');
  }
  if (content.includes('\0')) throw new Error('localBinary');
  const endings = new Set(content.match(/\r\n|\r|\n/g) || []);
  const ending = endings.values().next().value || '\n';
  const mixed = endings.size > 1;
  return {
    name: file.name, type, source: 'local',
    content: content.replace(/\r\n|\r/g, '\n'),
    encoding: hasBom ? 'UTF-8 BOM' : 'UTF-8', hasBom, ending,
    newline: mixed ? 'mixed' : !endings.size ? 'none' : ending === '\r\n' ? 'CRLF' : ending === '\r' ? 'CR' : 'LF',
    editable: !mixed,
    warning: mixed ? '文件包含混合换行，演示仅提供查看，避免保存时改变原始格式。' : null,
  };
}

export function localFileBlob(document, content) {
  if (!document.editable) throw new Error('cannotEdit');
  if (/[\r\0]/u.test(content) || new TextDecoder().decode(new TextEncoder().encode(content)) !== content) throw new Error('localInvalidContent');
  const blob = new Blob([(document.hasBom ? '\ufeff' : '') + content.replace(/\n/g, document.ending)], { type: 'text/plain;charset=utf-8' });
  if (blob.size > maxFileBytes) throw new Error('localTooLarge');
  return blob;
}
