const $ = (selector, root = document) => root.querySelector(selector);
const elements = {
  list: $('#file-list'),
  panes: $('#panes'),
  split: $('#split-toggle'),
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
  split: false,
  nextTabId: 1,
  suggestion: null,
  panes: [0, 1].map((index) => ({
    index,
    tabs: [],
    activeTabId: null,
    loading: false,
    element: null,
    tabNodes: new Map(),
    renderedTabId: null,
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

function activeTab(pane) {
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) || null;
}

function dirty(tab) {
  return Boolean(tab && tab.content !== tab.base);
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
  button.classList.toggle('selected', activeTab(state.panes[state.active])?.document.name === file.name);
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
  info.append(name);
  if (!file.accessible || !file.type) {
    const status = document.createElement('span');
    status.textContent = !file.accessible ? '链接或不可访问' : '不支持的文件类型';
    info.append(status);
  }
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
  const tab = pane.tabs.find((item) => item.id === suggestion.tabId);
  elements.description.hidden = state.active === suggestion.paneIndex && pane.activeTabId === suggestion.tabId;
  let reason = '';
  if (!tab) reason = '目标文件已关闭，请重新生成建议。';
  else if (state.active !== suggestion.paneIndex || pane.activeTabId !== suggestion.tabId) reason = '请先切回生成建议的标签页。';
  else if (tab.content !== suggestion.before) reason = '文件内容已变化，请重新生成建议。';
  else if (elements.prompt.value.trim() !== suggestion.prompt) reason = '修改请求已变化，请重新生成建议。';
  else if (!tab.document.editable) reason = '当前文件为只读状态。';
  else if (tab.saving) reason = '请等待文件保存完成。';
  else if (suggestion.before === suggestion.after) reason = '当前内容无需按此规则修改。';
  elements.apply.disabled = Boolean(reason);
  elements.applyNote.textContent = reason || '应用后不会自动保存。';
}

function makeTabNode(pane, tab) {
  const entry = document.createElement('div');
  entry.className = 'tab-entry';
  entry.setAttribute('role', 'presentation');
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'tab-select';
  select.id = 'tab-' + pane.index + '-' + tab.id;
  select.setAttribute('role', 'tab');
  select.setAttribute('aria-controls', 'panel-' + pane.index);
  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = tab.document.name;
  const marker = document.createElement('span');
  marker.className = 'tab-dirty';
  marker.setAttribute('aria-hidden', 'true');
  select.append(name, marker);
  select.addEventListener('click', () => selectTab(pane, tab.id));
  select.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = pane.tabs.findIndex((item) => item.id === tab.id);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? pane.tabs.length - 1 :
      (index + (event.key === 'ArrowRight' ? 1 : -1) + pane.tabs.length) % pane.tabs.length;
    selectTab(pane, pane.tabs[next].id);
    pane.tabNodes.get(pane.tabs[next].id).select.focus();
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.setAttribute('aria-label', '关闭 ' + tab.document.name);
  close.title = '关闭 ' + tab.document.name;
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('icon');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-close');
  icon.append(use);
  close.append(icon);
  close.addEventListener('click', () => closeTab(pane, tab.id));
  entry.append(select, close);
  return { entry, select, marker, close };
}

function renderTabs(pane) {
  const list = $('.tab-list', pane.element);
  list.setAttribute('aria-label', paneName(pane) + '标签页');
  for (const [id, node] of pane.tabNodes) {
    if (!pane.tabs.some((tab) => tab.id === id)) {
      node.entry.remove();
      pane.tabNodes.delete(id);
    }
  }
  for (const tab of pane.tabs) {
    let node = pane.tabNodes.get(tab.id);
    if (!node) {
      node = makeTabNode(pane, tab);
      pane.tabNodes.set(tab.id, node);
      list.append(node.entry);
    }
    const selected = pane.activeTabId === tab.id;
    node.entry.classList.toggle('selected', selected);
    node.select.setAttribute('aria-selected', String(selected));
    node.select.setAttribute('aria-label', tab.document.name + (dirty(tab) ? '，未保存' : ''));
    node.select.tabIndex = selected ? 0 : -1;
    node.marker.hidden = !dirty(tab);
    node.close.disabled = tab.saving;
  }
}

function renderPane(pane) {
  const root = pane.element;
  const tab = activeTab(pane);
  const doc = tab?.document;
  const isDirty = dirty(tab);
  root.hidden = !state.split && pane.index !== state.active;
  root.classList.toggle('active', pane.index === state.active);
  root.setAttribute('aria-label', paneName(pane));
  renderTabs(pane);
  $('.pane-loading', root).hidden = !pane.loading;
  $('.pane-indicator', root).hidden = !state.split;
  $('.pane-indicator', root).textContent = '0' + (pane.index + 1);
  $('.pane-toolbar', root).hidden = !doc;
  $('.file-meta', root).textContent = doc
    ? doc.encoding + ' · ' + (doc.newline === 'none' ? '无换行' : doc.newline === 'mixed' ? '混合换行' : doc.newline)
    : '';
  const save = $('.save-button', root);
  save.disabled = !doc || !doc.editable || !isDirty || tab.saving;
  save.textContent = tab?.saving ? '保存中' : '保存';
  const editButton = $('.edit-mode', root);
  const previewButton = $('.preview-mode', root);
  $('.mode-switch', root).hidden = !doc || doc.type !== 'markdown';
  editButton.classList.toggle('selected', tab?.mode === 'edit');
  previewButton.classList.toggle('selected', tab?.mode === 'preview');
  const warning = $('.pane-warning', root);
  warning.textContent = tab?.error || doc?.warning || '';
  warning.hidden = !warning.textContent;
  $('.empty-pane', root).hidden = Boolean(doc);
  $('.editor-input-wrap', root).hidden = !doc || tab.mode !== 'edit';
  const textarea = $('.editor-input', root);
  textarea.readOnly = !doc?.editable;
  textarea.setAttribute('aria-label', (doc?.name || paneName(pane)) + ' 的内容');
  if (textarea.value !== (tab?.content || '')) textarea.value = tab?.content || '';
  if (pane.renderedTabId !== (tab?.id || null)) {
    textarea.setSelectionRange(tab?.selectionStart || 0, tab?.selectionEnd || 0);
    textarea.scrollTop = tab?.scrollTop || 0;
    textarea.scrollLeft = tab?.scrollLeft || 0;
    pane.renderedTabId = tab?.id || null;
  }
  const panel = $('.pane-body', root);
  if (tab) panel.setAttribute('aria-labelledby', 'tab-' + pane.index + '-' + tab.id);
  else panel.removeAttribute('aria-labelledby');
  const preview = $('.markdown-preview', root);
  preview.hidden = !doc || tab.mode !== 'preview';
  if (!preview.hidden) renderMarkdown(preview, tab.content);
  const paneState = $('.pane-state', root);
  paneState.classList.toggle('is-dirty', isDirty);
  paneState.textContent = !doc ? '' : !doc.editable ? '只读' : isDirty ? '● 未保存的更改' : '已保存';
  $('.pane-stats', root).textContent = doc ? tab.content.length + ' 字符' : '';
}

function renderAll() {
  elements.panes.classList.toggle('split', state.split);
  elements.panes.parentElement.classList.toggle('is-split', state.split);
  for (const pane of state.panes) renderPane(pane);
  const pane = state.panes[state.active];
  const tab = activeTab(pane);
  elements.target.textContent = tab ? paneName(pane) + ' · ' + tab.document.name : '尚未选择文件';
  const hiddenDirty = !state.split && state.panes.some((item) => item.index !== state.active && item.tabs.some(dirty));
  $('.layout-label', elements.split).textContent = state.split ? '单栏' : '分栏';
  $('.layout-dirty', elements.split).hidden = !hiddenDirty;
  elements.split.dataset.active = String(state.split);
  elements.split.setAttribute('aria-label', (state.split ? '切换到单栏' : '打开分栏') + (hiddenDirty ? '，隐藏的编辑区有未保存的更改' : ''));
  elements.split.title = hiddenDirty ? '隐藏的编辑区有未保存的更改' : state.split ? '切换到单栏' : '打开分栏';
  renderFiles();
  setSuggestionAvailability();
}

function makePane(pane) {
  const fragment = $('#pane-template').content.cloneNode(true);
  pane.element = $('.editor-pane', fragment);
  $('.pane-body', pane.element).id = 'panel-' + pane.index;
  pane.element.addEventListener('pointerdown', () => setActive(pane.index));
  pane.element.addEventListener('focusin', () => setActive(pane.index));
  const textarea = $('.editor-input', pane.element);
  function rememberPosition() {
    const tab = activeTab(pane);
    if (!tab || tab.mode !== 'edit') return;
    tab.selectionStart = textarea.selectionStart;
    tab.selectionEnd = textarea.selectionEnd;
    tab.scrollTop = textarea.scrollTop;
    tab.scrollLeft = textarea.scrollLeft;
  }
  for (const event of ['select', 'keyup', 'click', 'scroll']) textarea.addEventListener(event, rememberPosition);
  textarea.addEventListener('input', () => {
    const tab = activeTab(pane);
    if (!tab) return;
    tab.content = textarea.value;
    tab.error = '';
    rememberPosition();
    renderPane(pane);
    setSuggestionAvailability();
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || textarea.readOnly) return;
    event.preventDefault();
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    textarea.setRangeText('  ', start, end, 'end');
    const tab = activeTab(pane);
    if (!tab) return;
    tab.content = textarea.value;
    tab.error = '';
    rememberPosition();
    renderPane(pane);
    setSuggestionAvailability();
  });
  $('.edit-mode', pane.element).addEventListener('click', () => { const tab = activeTab(pane); if (tab) { tab.mode = 'edit'; renderPane(pane); } });
  $('.preview-mode', pane.element).addEventListener('click', () => { const tab = activeTab(pane); if (tab) { tab.mode = 'preview'; renderPane(pane); } });
  $('.save-button', pane.element).addEventListener('click', () => saveTab(pane, activeTab(pane)));
  elements.panes.append(fragment);
}

function selectTab(pane, id) {
  if (!pane.tabs.some((tab) => tab.id === id)) return;
  state.active = pane.index;
  pane.activeTabId = id;
  renderAll();
}

function toggleSplit() {
  if (state.split) {
    const current = state.panes[state.active];
    const other = state.panes[1 - state.active];
    if (!current.tabs.length && other.tabs.length) state.active = other.index;
    state.split = false;
  } else {
    state.split = true;
    const other = state.panes[1 - state.active];
    if (!other.tabs.length) state.active = other.index;
  }
  renderAll();
}

async function openFile(pane, name, { activate = true } = {}) {
  const existing = pane.tabs.find((tab) => tab.document.name === name);
  if (existing) return activate ? selectTab(pane, existing.id) : undefined;
  if (pane.loading) return toast('请等待文件打开。', true);
  pane.loading = true;
  renderAll();
  try {
    const doc = await api('/api/file?name=' + encodeURIComponent(name));
    const tab = {
      id: state.nextTabId++,
      document: doc,
      content: doc.content,
      base: doc.content,
      mode: 'edit',
      saving: false,
      error: '',
    };
    pane.tabs.push(tab);
    if (activate || pane.activeTabId === null) pane.activeTabId = tab.id;
  } catch (error) {
    toast(error.message, true);
  } finally {
    pane.loading = false;
    renderAll();
  }
}

function closeTab(pane, id) {
  const index = pane.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tab = pane.tabs[index];
  if (tab.saving) return;
  if (dirty(tab) && !window.confirm(paneName(pane) + '的「' + tab.document.name + '」有未保存的更改。确定丢弃这些更改吗？')) return;
  if (state.suggestion?.tabId === id) {
    state.suggestion = null;
    elements.suggestion.hidden = true;
  }
  const wasActive = pane.activeTabId === id;
  pane.tabs.splice(index, 1);
  if (wasActive) pane.activeTabId = pane.tabs[Math.min(index, pane.tabs.length - 1)]?.id || null;
  renderAll();
  if (wasActive) {
    const next = pane.tabNodes.get(pane.activeTabId);
    if (next) next.select.focus();
    else pane.element.focus();
  }
}

async function saveTab(pane, tab) {
  if (!tab || !dirty(tab) || tab.saving || !tab.document.editable) return;
  const snapshot = tab.content;
  const doc = tab.document;
  tab.saving = true;
  tab.error = '';
  renderAll();
  try {
    const result = await api('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: doc.name, revision: doc.revision, content: snapshot }),
    });
    tab.document.revision = result.revision;
    tab.base = snapshot;
    toast('已保存「' + doc.name + '」。');
  } catch (error) {
    tab.error = error.message;
    toast(error.message, true);
  } finally {
    tab.saving = false;
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
  const tab = activeTab(pane);
  const prompt = elements.prompt.value.trim();
  if (!tab) return toast('请先在当前编辑区打开文件。', true);
  if (!tab.document.editable) return toast('当前文件为只读状态，不能应用修改。', true);
  if (!prompt) { elements.prompt.focus(); return toast('请先输入希望如何修改。', true); }
  if (tab.content.length > 40000 || tab.content.split('\n').length > 400) {
    return toast('模拟建议支持不超过 4 万字符、400 行的文档。', true);
  }
  const after = simulate(tab.content, prompt, tab.document.type);
  state.suggestion = { paneIndex: pane.index, tabId: tab.id, name: tab.document.name, before: tab.content, after, prompt };
  elements.description.textContent = '建议目标：' + paneName(pane) + ' · ' + tab.document.name;
  renderDiff(tab.content, after);
  elements.suggestion.hidden = false;
  setSuggestionAvailability();
}

function applySuggestion() {
  const suggestion = state.suggestion;
  if (!suggestion || elements.apply.disabled) return;
  const pane = state.panes[suggestion.paneIndex];
  const tab = pane.tabs.find((item) => item.id === suggestion.tabId);
  if (state.active !== suggestion.paneIndex || pane.activeTabId !== suggestion.tabId || !tab ||
    tab.content !== suggestion.before || !tab.document.editable || tab.saving) return;
  tab.content = suggestion.after;
  tab.mode = 'edit';
  tab.error = '';
  state.suggestion = null;
  elements.suggestion.hidden = true;
  renderAll();
  toast('模拟建议已应用到' + paneName(pane) + '，请检查后手动保存。');
}

for (const pane of state.panes) makePane(pane);
$('#refresh-files').addEventListener('click', refreshFiles);
elements.split.addEventListener('click', toggleSplit);
$('#generate').addEventListener('click', generateSuggestion);
elements.apply.addEventListener('click', applySuggestion);
elements.prompt.addEventListener('input', setSuggestionAvailability);
for (const button of document.querySelectorAll('[data-prompt]')) {
  button.addEventListener('click', () => { elements.prompt.value = button.dataset.prompt; setSuggestionAvailability(); elements.prompt.focus(); });
}
window.addEventListener('beforeunload', (event) => {
  if (state.panes.some((pane) => pane.tabs.some(dirty))) {
    event.preventDefault();
    event.returnValue = '';
  }
});

renderAll();
await refreshFiles();
const markdown = state.files.find((file) => file.type === 'markdown' && file.accessible);
const text = state.files.find((file) => file.type === 'text' && file.accessible);
if (markdown) await openFile(state.panes[0], markdown.name);
if (text) await openFile(state.panes[0], text.name, { activate: !markdown });
