const $ = (selector, root = document) => root.querySelector(selector);
const elements = {
  list: $('#file-list'),
  count: $('#file-count'),
  panes: $('#panes'),
  target: $('#assistant-target'),
  prompt: $('#assistant-prompt'),
  suggestion: $('#suggestion'),
  description: $('#suggestion-description'),
  diff: $('#diff'),
  apply: $('#apply-suggestion'),
  applyNote: $('.apply-note'),
  toast: $('#toast'),
};

const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('token');
let token = fragmentToken || sessionStorage.getItem('editor-demo-token');
if (fragmentToken) {
  sessionStorage.setItem('editor-demo-token', fragmentToken);
  history.replaceState(null, '', location.pathname);
}

const state = {
  files: [],
  active: 0,
  suggestion: null,
  panes: [0, 1].map((index) => ({
    index,
    document: null,
    content: '',
    base: '',
    mode: 'edit',
    loading: false,
    saving: false,
    error: '',
    element: null,
  })),
};

let toastTimer;
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, isError ? 8000 : 3500);
}

async function api(url, options = {}) {
  if (!token) throw new Error('缺少会话令牌，请使用终端中显示的完整地址打开。');
  const headers = { 'X-Editor-Token': token, ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请稍后重试。');
  return result;
}

function dirty(pane) {
  return Boolean(pane.document && pane.content !== pane.base);
}

function paneName(pane) {
  return '编辑区 0' + (pane.index + 1);
}

function setActive(index) {
  if (state.active === index) return;
  state.active = index;
  renderAll();
}

function makeFileItem(file) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-item';
  button.dataset.type = file.type || 'unsupported';
  button.classList.toggle('selected', state.panes[state.active].document?.name === file.name);
  const icon = document.createElement('span');
  icon.className = 'file-item-icon';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-file');
  svg.append(use);
  icon.append(svg);
  const info = document.createElement('span');
  info.className = 'file-item-info';
  const name = document.createElement('strong');
  name.textContent = file.name;
  const type = document.createElement('span');
  type.textContent = !file.accessible ? '链接或不可访问' : file.type === 'markdown' ? 'Markdown 文档' : file.type === 'text' ? '纯文本文档' : '不支持的文件类型';
  info.append(name, type);
  const arrow = document.createElement('span');
  arrow.className = 'file-item-arrow';
  arrow.textContent = '›';
  button.append(icon, info, arrow);
  button.addEventListener('click', () => {
    if (!file.accessible) return toast('不能打开链接或非普通文件。', true);
    if (!file.type) return toast('演示只支持 .txt 和 .md 文件。', true);
    return openFile(state.panes[state.active], file.name);
  });
  return button;
}

function renderFiles() {
  elements.count.textContent = String(state.files.length).padStart(2, '0');
  elements.list.replaceChildren();
  if (!state.files.length) {
    const message = document.createElement('p');
    message.className = 'list-message';
    message.textContent = '没有可显示的文件。';
    elements.list.append(message);
    return;
  }
  for (const file of state.files) elements.list.append(makeFileItem(file));
}

async function refreshFiles() {
  try {
    const result = await api('/api/files');
    state.files = result.files;
    renderFiles();
  } catch (error) {
    toast(error.message, true);
  }
}

function setSuggestionAvailability() {
  const suggestion = state.suggestion;
  if (!suggestion) return;
  const pane = state.panes[suggestion.paneIndex];
  let reason = '';
  if (!pane.document || pane.document.name !== suggestion.name) reason = '目标文件已关闭，请重新生成建议。';
  else if (state.active !== suggestion.paneIndex) reason = '请先切回生成建议的编辑区。';
  else if (pane.content !== suggestion.before) reason = '文件内容已变化，请重新生成建议。';
  else if (elements.prompt.value.trim() !== suggestion.prompt) reason = '修改请求已变化，请重新生成建议。';
  else if (!pane.document.editable) reason = '当前文件为只读状态。';
  else if (pane.loading || pane.saving) reason = '请等待文件操作完成。';
  else if (suggestion.before === suggestion.after) reason = '当前内容无需按此规则修改。';
  elements.apply.disabled = Boolean(reason);
  elements.applyNote.textContent = reason || '应用后不会自动保存。';
}

function renderPane(pane) {
  const root = pane.element;
  const doc = pane.document;
  const isDirty = dirty(pane);
  root.classList.toggle('active', pane.index === state.active);
  root.dataset.type = doc?.type || '';
  $('.pane-index', root).textContent = paneName(pane);
  $('.filename', root).textContent = doc?.name || '未打开文件';
  $('.file-meta', root).textContent = doc
    ? (doc.type === 'markdown' ? 'Markdown' : '纯文本') + ' · ' + doc.encoding + ' · ' + (doc.newline === 'none' ? '无换行' : doc.newline === 'mixed' ? '混合换行' : doc.newline)
    : '从文件列表选择';
  $('.dirty-dot', root).hidden = !isDirty;
  $('.close-pane', root).disabled = !doc || pane.loading || pane.saving;
  const save = $('.save-button', root);
  save.disabled = !doc || !doc.editable || !isDirty || pane.loading || pane.saving;
  save.textContent = pane.saving ? '保存中' : '保存';
  const editButton = $('.edit-mode', root);
  const previewButton = $('.preview-mode', root);
  editButton.disabled = !doc;
  editButton.classList.toggle('selected', pane.mode === 'edit');
  previewButton.hidden = !doc || doc.type !== 'markdown';
  previewButton.classList.toggle('selected', pane.mode === 'preview');
  $('.type-label', root).textContent = doc ? (doc.type === 'markdown' ? 'MARKDOWN' : 'PLAIN TEXT') : '';
  const warning = $('.pane-warning', root);
  warning.textContent = pane.error || doc?.warning || '';
  warning.hidden = !warning.textContent;
  $('.empty-pane', root).hidden = Boolean(doc);
  $('.editor-input-wrap', root).hidden = !doc || pane.mode !== 'edit';
  const textarea = $('.editor-input', root);
  textarea.readOnly = !doc?.editable || pane.loading;
  textarea.setAttribute('aria-label', (doc?.name || paneName(pane)) + ' 的内容');
  if (textarea.value !== pane.content) textarea.value = pane.content;
  const preview = $('.markdown-preview', root);
  preview.hidden = !doc || pane.mode !== 'preview';
  if (!preview.hidden) renderMarkdown(preview, pane.content);
  const paneState = $('.pane-state', root);
  paneState.classList.toggle('is-dirty', isDirty);
  paneState.textContent = pane.loading ? '正在打开…' : !doc ? '等待打开文件' : !doc.editable ? '只读' : isDirty ? '● 未保存的更改' : '已保存';
  $('.pane-stats', root).textContent = doc ? pane.content.length + ' 字符' : '';
}

function renderAll() {
  for (const pane of state.panes) renderPane(pane);
  const active = state.panes[state.active];
  elements.target.textContent = active.document ? paneName(active) + ' · ' + active.document.name : '尚未选择文件';
  renderFiles();
  setSuggestionAvailability();
}

function makePane(pane) {
  const fragment = $('#pane-template').content.cloneNode(true);
  pane.element = $('.editor-card', fragment);
  pane.element.addEventListener('pointerdown', () => setActive(pane.index));
  pane.element.addEventListener('focusin', () => setActive(pane.index));
  const textarea = $('.editor-input', pane.element);
  textarea.addEventListener('input', () => {
    pane.content = textarea.value;
    pane.error = '';
    renderPane(pane);
    setSuggestionAvailability();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || textarea.readOnly) return;
    event.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.setRangeText('  ', start, end, 'end');
    pane.content = textarea.value;
    pane.error = '';
    renderPane(pane);
    setSuggestionAvailability();
  });
  $('.edit-mode', pane.element).addEventListener('click', () => { pane.mode = 'edit'; renderPane(pane); });
  $('.preview-mode', pane.element).addEventListener('click', () => { pane.mode = 'preview'; renderPane(pane); });
  $('.save-button', pane.element).addEventListener('click', () => savePane(pane));
  $('.close-pane', pane.element).addEventListener('click', () => closePane(pane));
  elements.panes.append(fragment);
}

function confirmDiscard(pane) {
  return !dirty(pane) || window.confirm(paneName(pane) + '的「' + pane.document.name + '」有未保存的更改。确定丢弃这些更改吗？');
}

function clearSuggestionForPane(pane) {
  if (state.suggestion?.paneIndex !== pane.index) return;
  state.suggestion = null;
  elements.suggestion.hidden = true;
}

async function openFile(pane, name) {
  if (pane.loading || pane.saving || !confirmDiscard(pane)) return;
  pane.loading = true;
  renderAll();
  try {
    const doc = await api('/api/file?name=' + encodeURIComponent(name));
    clearSuggestionForPane(pane);
    pane.document = doc;
    pane.content = doc.content;
    pane.base = doc.content;
    pane.mode = 'edit';
    pane.error = '';
  } catch (error) {
    toast(error.message, true);
  } finally {
    pane.loading = false;
    renderAll();
  }
}

function closePane(pane) {
  if (pane.loading || pane.saving || !confirmDiscard(pane)) return;
  clearSuggestionForPane(pane);
  pane.document = null;
  pane.content = '';
  pane.base = '';
  pane.mode = 'edit';
  pane.error = '';
  renderAll();
}

async function savePane(pane) {
  if (!pane.document || !dirty(pane) || pane.saving || pane.loading || !pane.document.editable) return;
  const snapshot = pane.content;
  const doc = pane.document;
  pane.saving = true;
  pane.error = '';
  renderAll();
  try {
    const result = await api('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: doc.name, revision: doc.revision, content: snapshot }),
    });
    pane.document.revision = result.revision;
    pane.base = snapshot;
    toast('已保存「' + doc.name + '」。');
  } catch (error) {
    pane.error = error.message;
    toast(error.message, true);
  } finally {
    pane.saving = false;
    renderAll();
  }
}

function appendInline(parent, text) {
  const pattern = /!?\[[^\]]+\]\([^)]+\)|\*\*[^*\n]+\*\*|\x60[^\x60\n]+\x60|\*[^*\n]+\*/g;
  let position = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(position, match.index)));
    const part = match[0];
    let child;
    if (part.startsWith('![')) {
      child = document.createTextNode(part);
    } else if (part.startsWith('[')) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
      try {
        const url = new URL(link[2], location.origin);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) throw new Error('unsupported URL');
        child = document.createElement('a');
        child.href = url.href;
        child.target = '_blank';
        child.rel = 'noopener noreferrer';
        child.textContent = link[1];
      } catch {
        child = document.createTextNode(part);
      }
    } else {
      const isStrong = part.startsWith('**');
      const isCode = part.startsWith('\x60');
      child = document.createElement(isStrong ? 'strong' : isCode ? 'code' : 'em');
      child.textContent = part.slice(isStrong ? 2 : 1, isStrong ? -2 : -1);
    }
    parent.append(child);
    position = match.index + part.length;
  }
  parent.append(document.createTextNode(text.slice(position)));
}

function renderMarkdown(container, text) {
  container.replaceChildren();
  const lines = text.split('\n');
  let index = 0;
  const isSpecial = (line) => /^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?|\x60\x60\x60|(?:---+|\*\*\*+)\s*$)/.test(line);
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^\s{0,3}\x60\x60\x60/.test(line)) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}\x60\x60\x60/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = document.createElement('pre');
      const child = document.createElement('code');
      child.textContent = code.join('\n');
      pre.append(child);
      container.append(pre);
      continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      const child = document.createElement('h' + heading[1].length);
      appendInline(child, heading[2]);
      container.append(child);
      index += 1;
      continue;
    }
    if (/^\s{0,3}(?:---+|\*\*\*+)\s*$/.test(line)) {
      container.append(document.createElement('hr'));
      index += 1;
      continue;
    }
    const bullet = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(line);
    if (bullet) {
      const ordered = /^\d/.test(bullet[1]);
      const list = document.createElement(ordered ? 'ol' : 'ul');
      while (index < lines.length) {
        const item = /^\s{0,3}([-*+]|\d+[.)])\s+(.+)$/.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const child = document.createElement('li');
        appendInline(child, item[2]);
        list.append(child);
        index += 1;
      }
      container.append(list);
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote = [];
      while (index < lines.length && /^\s{0,3}>/.test(lines[index])) quote.push(lines[index++].replace(/^\s{0,3}>\s?/, ''));
      const block = document.createElement('blockquote');
      const paragraph = document.createElement('p');
      appendInline(paragraph, quote.join(' '));
      block.append(paragraph);
      container.append(block);
      continue;
    }
    const paragraphLines = [line];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isSpecial(lines[index])) paragraphLines.push(lines[index++]);
    const paragraph = document.createElement('p');
    appendInline(paragraph, paragraphLines.join(' '));
    container.append(paragraph);
  }
}

function simulate(content, prompt, type) {
  if (/空行|整理/.test(prompt)) {
    return content.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n');
  }
  if (/标题/.test(prompt)) {
    return (type === 'markdown' ? '# 文档标题\n\n' : '文档标题\n\n') + content;
  }
  if (/摘要|总结/.test(prompt)) {
    return (type === 'markdown' ? '## 摘要\n\n这里是一段待完善的摘要。\n\n' : '摘要：这里是一段待完善的摘要。\n\n') + content;
  }
  return content.replace(/\n*$/, '') + '\n\n[模拟建议：' + prompt.replace(/\s+/g, ' ').trim() + ']\n';
}

function addDiffRow(kind, text) {
  const row = document.createElement('div');
  row.className = 'diff-row ' + kind;
  row.textContent = (kind === 'added' ? '+ ' : kind === 'removed' ? '− ' : '  ') + text;
  elements.diff.append(row);
}

function renderDiff(before, after) {
  elements.diff.replaceChildren();
  if (before === after) {
    addDiffRow('context', '没有产生修改。');
    return;
  }
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  if (prefix > 2) addDiffRow('context', '…');
  for (const line of oldLines.slice(Math.max(0, prefix - 2), prefix)) addDiffRow('context', line);
  for (const line of oldLines.slice(prefix, oldLines.length - suffix)) addDiffRow('removed', line);
  for (const line of newLines.slice(prefix, newLines.length - suffix)) addDiffRow('added', line);
  for (const line of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(suffix, 2))) addDiffRow('context', line);
  if (suffix > 2) addDiffRow('context', '…');
}

function generateSuggestion() {
  const pane = state.panes[state.active];
  const prompt = elements.prompt.value.trim();
  if (!pane.document) return toast('请先在当前编辑区打开文件。', true);
  if (!pane.document.editable) return toast('当前文件为只读状态，不能应用修改。', true);
  if (!prompt) { elements.prompt.focus(); return toast('请先输入希望如何修改。', true); }
  if (pane.content.length > 40000 || pane.content.split('\n').length > 400) {
    return toast('模拟建议支持不超过 4 万字符、400 行的文档。', true);
  }
  const after = simulate(pane.content, prompt, pane.document.type);
  state.suggestion = { paneIndex: pane.index, name: pane.document.name, before: pane.content, after, prompt };
  elements.description.textContent = '针对 ' + paneName(pane) + ' · ' + pane.document.name + ' 的规则演示。绿色为新增，红色为移除。';
  renderDiff(pane.content, after);
  elements.suggestion.hidden = false;
  setSuggestionAvailability();
}

function applySuggestion() {
  const suggestion = state.suggestion;
  if (!suggestion || elements.apply.disabled) return;
  const pane = state.panes[suggestion.paneIndex];
  if (state.active !== suggestion.paneIndex || !pane.document || pane.document.name !== suggestion.name ||
    pane.content !== suggestion.before || !pane.document.editable) return;
  pane.content = suggestion.after;
  pane.mode = 'edit';
  pane.error = '';
  state.suggestion = null;
  elements.suggestion.hidden = true;
  renderAll();
  toast('模拟建议已应用到' + paneName(pane) + '，请检查后手动保存。');
}

for (const pane of state.panes) makePane(pane);
$('#refresh-files').addEventListener('click', refreshFiles);
$('#generate').addEventListener('click', generateSuggestion);
elements.apply.addEventListener('click', applySuggestion);
elements.prompt.addEventListener('input', setSuggestionAvailability);
for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => { elements.prompt.value = button.dataset.prompt; setSuggestionAvailability(); elements.prompt.focus(); });
}
window.addEventListener('beforeunload', (event) => {
  if (state.panes.some(dirty)) {
    event.preventDefault();
    event.returnValue = '';
  }
});

renderAll();
await refreshFiles();
const markdown = state.files.find((file) => file.type === 'markdown' && file.accessible);
const text = state.files.find((file) => file.type === 'text' && file.accessible);
await Promise.all([
  markdown ? openFile(state.panes[0], markdown.name) : Promise.resolve(),
  text ? openFile(state.panes[1], text.name) : Promise.resolve(),
]);
