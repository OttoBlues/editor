import { blocksPage, plugins, pluginFor } from './plugins.js';
import { suggest, SuggestionError } from './assistant.js';
import { translate, serverMessage } from './i18n.js';

const $ = (selector, root = document) => root.querySelector(selector);
const elements = {
  panes: $('#panes'),
  split: $('#split-toggle'),
  divider: $('#pane-divider'),
  target: $('#assistant-target'),
  attentionAccess: $('#attention-access'),
  referenceSelect: $('#reference-select'),
  referenceList: $('#reference-list'),
  addReference: $('#add-reference'),
  focusSource: $('#focus-source'),
  focusBlock: $('#focus-block'),
  focusRole: $('#focus-role'),
  setFocus: $('#set-focus'),
  focusDetail: $('#focus-detail'),
  focusInfo: $('#focus-info'),
  focusText: $('#focus-text'),
  focusWarning: $('#focus-warning'),
  prompt: $('#assistant-prompt'),
  suggestion: $('#suggestion'),
  description: $('#suggestion-description'),
  diff: $('#diff'),
  apply: $('#apply-suggestion'),
  applyNote: $('.apply-note'),
  toast: $('#toast'),
};

let preferences = {};
try { preferences = JSON.parse(localStorage.getItem('editor-preferences') || '{}') || {}; } catch { preferences = {}; }

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
  splitRatio: 0.5,
  dragging: null,
  view: 'workspace',
  language: ['zh-CN', 'en'].includes(preferences.language) ? preferences.language : 'zh-CN',
  accent: ['purple', 'blue', 'green'].includes(preferences.accent) ? preferences.accent : 'purple',
  references: [],
  nextReferenceId: 1,
  referenceLoading: false,
  focus: null,
  focusBlocks: [],
  focusPage: 0,
  focusHasNext: false,
  contextRevision: 0,
  nextTabId: 1,
  suggestion: null,
  panes: [0, 1].map((index) => ({
    index,
    tabs: [],
    activeTabId: null,
    loading: false,
    fileMenuOpen: false,
    element: null,
    tabNodes: new Map(),
    renderedTabId: null,
  })),
};

function t(key, values = {}) {
  return translate(state.language, key, values);
}

function applyTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  document.documentElement.lang = state.language;
  document.documentElement.dataset.accent = state.accent;
}

function savePreferences() {
  try { localStorage.setItem('editor-preferences', JSON.stringify({ language: state.language, accent: state.accent })); } catch { /* Settings remain active for this session. */ }
}

class ApiError extends Error {}

function errorText(error) {
  return error instanceof ApiError ? serverMessage(state.language, error.message) : error.message;
}

let toastTimer;
function toast(message, isError = false) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.hidden = false;
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, isError ? 8000 : 3500);
}

async function api(url, options = {}) {
  if (!token) throw new Error(t('noToken'));
  const headers = { 'X-Editor-Token': token, ...(options.headers || {}) };
  const response = await fetch(url, { ...options, headers });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error || t('requestFailed'));
  return result;
}

function activeTab(pane) {
  return pane.tabs.find((tab) => tab.id === pane.activeTabId) || null;
}

function findTab(id) {
  for (const pane of state.panes) {
    const tab = pane.tabs.find((item) => item.id === id);
    if (tab) return { pane, tab };
  }
  return null;
}

function focusProblem(focus, targetTab = activeTab(state.panes[state.active])) {
  if (!focus) return '';
  const source = focus.sourceKind === 'tab'
    ? findTab(focus.sourceId)?.tab
    : state.references.find((item) => item.id === focus.sourceId);
  if (!source) return t('focusSourceMissing');
  if (source.content !== focus.documentSnapshot) return t('focusStale');
  if (focus.role === 'target' && (focus.sourceKind !== 'tab' || targetTab?.id !== focus.sourceId)) return t('focusWrongTarget');
  return '';
}

function dirty(tab) {
  return Boolean(tab && tab.content !== tab.base);
}

function paneName(pane) {
  return t('pane', { n: '0' + (pane.index + 1) });
}

function setActive(index) {
  if (state.active === index) return;
  state.active = index;
  renderAll();
}

function makeFileItem(file, pane) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-item';
  button.dataset.type = file.type || 'unsupported';
  button.classList.toggle('selected', activeTab(pane)?.document.name === file.name);
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
    status.textContent = t(!file.accessible ? 'fileUnavailable' : 'unsupported');
    info.append(status);
  }
  const arrow = document.createElement('span');
  arrow.className = 'file-item-arrow';
  arrow.setAttribute('aria-hidden', 'true');
  arrow.textContent = '›';
  button.append(icon, info, arrow);
  button.addEventListener('click', () => {
    pane.fileMenuOpen = false;
    $('.file-menu', pane.element).hidden = true;
    $('.file-menu-toggle', pane.element).setAttribute('aria-expanded', 'false');
    if (!file.accessible) return toast(t('cannotOpenLink'), true);
    if (!file.type) return toast(t('onlyText'), true);
    state.active = pane.index;
    return openFile(pane, file.name);
  });
  return button;
}

function renderFiles() {
  for (const pane of state.panes) {
    if (!pane.element) continue;
    const list = $('.file-list', pane.element);
    list.replaceChildren();
    if (!state.files.length) {
      const message = document.createElement('p');
      message.className = 'list-message';
      message.textContent = t('noFiles');
      list.append(message);
    } else {
      for (const file of state.files) list.append(makeFileItem(file, pane));
    }
  }
}

async function refreshFiles() {
  try {
    const result = await api('/api/files');
    state.files = result.files;
    renderFiles();
    renderContext();
  } catch (error) {
    toast(errorText(error), true);
  }
}

function setSuggestionAvailability() {
  const suggestion = state.suggestion;
  if (!suggestion) return;
  const pane = state.panes[suggestion.paneIndex];
  const tab = pane.tabs.find((item) => item.id === suggestion.tabId);
  elements.description.hidden = state.active === suggestion.paneIndex && pane.activeTabId === suggestion.tabId;
  elements.description.textContent = t('suggestionTarget', { pane: paneName(pane), name: suggestion.name });
  let reason = '';
  if (!tab) reason = t('targetClosed');
  else if (state.active !== suggestion.paneIndex || pane.activeTabId !== suggestion.tabId) reason = t('switchBack');
  else if (tab.content !== suggestion.before) reason = t('contentChanged');
  else if (elements.prompt.value.trim() !== suggestion.prompt) reason = t('requestChanged');
  else if (suggestion.contextRevision !== state.contextRevision) reason = t('contextChanged');
  else if (focusProblem(state.focus, tab)) reason = focusProblem(state.focus, tab);
  else if (!tab.document.editable) reason = t('readonly');
  else if (tab.saving) reason = t('savingWait');
  else if (suggestion.before === suggestion.after) reason = t('noChangeNeeded');
  elements.apply.disabled = Boolean(reason);
  elements.applyNote.textContent = reason || t('notAutosaved');
}

function makeTabNode(pane, tab) {
  const entry = document.createElement('div');
  entry.className = 'tab-entry';
  entry.dataset.tabId = String(tab.id);
  entry.setAttribute('role', 'presentation');
  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'tab-select';
  select.id = 'tab-' + pane.index + '-' + tab.id;
  select.setAttribute('role', 'tab');
  select.setAttribute('aria-controls', 'panel-' + pane.index);
  select.setAttribute('aria-keyshortcuts', 'Control+Shift+ArrowLeft Control+Shift+ArrowRight');
  const name = document.createElement('span');
  name.className = 'tab-name';
  name.textContent = tab.document.name;
  const marker = document.createElement('span');
  marker.className = 'tab-dirty';
  marker.setAttribute('aria-hidden', 'true');
  select.append(name, marker);
  let pointerDrag = null;
  let suppressClick = false;
  select.addEventListener('click', (event) => {
    if (suppressClick) { event.preventDefault(); return; }
    selectTab(pane, tab.id);
  });
  select.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || tab.saving) return;
    pointerDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, started: false };
    select.setPointerCapture(event.pointerId);
  });
  select.addEventListener('pointermove', (event) => {
    if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
    if (!pointerDrag.started && Math.hypot(event.clientX - pointerDrag.x, event.clientY - pointerDrag.y) >= 6) {
      pointerDrag.started = true;
      state.dragging = { paneIndex: pane.index, tabId: tab.id };
      entry.classList.add('dragging');
    }
    if (!pointerDrag.started) return;
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const target = hit?.closest('.editor-pane');
    for (const item of state.panes) item.element.classList.toggle('drop-target', item.element === target && !item.element.hidden);
    if (verticalStack()) {
      if (event.clientY < 45) window.scrollBy(0, -12);
      else if (event.clientY > window.innerHeight - 45) window.scrollBy(0, 12);
    }
  });
  select.addEventListener('pointerup', (event) => {
    if (!pointerDrag || pointerDrag.id !== event.pointerId) return;
    const started = pointerDrag.started;
    pointerDrag = null;
    if (select.hasPointerCapture(event.pointerId)) select.releasePointerCapture(event.pointerId);
    if (!started) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    const hit = document.elementFromPoint(event.clientX, event.clientY);
    const target = state.panes.find((item) => item.element === hit?.closest('.editor-pane') && !item.element.hidden);
    let index = target?.tabs.length;
    const targetEntry = hit?.closest('.tab-entry');
    if (target && targetEntry && target.element.contains(targetEntry)) {
      const targetIndex = target.tabs.findIndex((item) => item.id === Number(targetEntry.dataset.tabId));
      if (targetIndex >= 0) index = targetIndex + (event.clientX > targetEntry.getBoundingClientRect().left + targetEntry.getBoundingClientRect().width / 2 ? 1 : 0);
    }
    clearDrag();
    if (target) moveTab(pane.index, target.index, tab.id, index);
  });
  const cancelPointerDrag = () => { if (pointerDrag?.started) clearDrag(); pointerDrag = null; };
  select.addEventListener('pointercancel', cancelPointerDrag);
  select.addEventListener('lostpointercapture', cancelPointerDrag);
  select.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      const target = event.key === 'ArrowLeft' ? 0 : 1;
      if (target !== pane.index) {
        event.preventDefault();
        state.split = true;
        moveTab(pane.index, target, tab.id);
      }
      return;
    }
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
  list.setAttribute('aria-label', t('tabList', { pane: paneName(pane) }));
  for (const [id, node] of pane.tabNodes) {
    if (!pane.tabs.some((tab) => tab.id === id)) {
      node.entry.remove();
      pane.tabNodes.delete(id);
    }
  }
  for (const [index, tab] of pane.tabs.entries()) {
    let node = pane.tabNodes.get(tab.id);
    if (!node) {
      node = makeTabNode(pane, tab);
      pane.tabNodes.set(tab.id, node);
    }
    if (list.children[index] !== node.entry) list.insertBefore(node.entry, list.children[index] || null);
    const selected = pane.activeTabId === tab.id;
    node.entry.classList.toggle('selected', selected);
    node.select.setAttribute('aria-selected', String(selected));
    node.select.setAttribute('aria-label', tab.document.name + (dirty(tab) ? t('unsavedSuffix') : ''));
    node.select.title = t('dragTab');
    node.close.setAttribute('aria-label', t('close', { name: tab.document.name }));
    node.close.title = t('close', { name: tab.document.name });
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
  $('.file-menu', root).hidden = !pane.fileMenuOpen;
  $('.file-menu-toggle', root).setAttribute('aria-expanded', String(pane.fileMenuOpen));
  $('.pane-loading', root).hidden = !pane.loading;
  $('.pane-indicator', root).hidden = !state.split;
  $('.pane-indicator', root).textContent = '0' + (pane.index + 1);
  $('.pane-toolbar', root).hidden = !doc;
  $('.file-meta', root).textContent = doc
    ? doc.encoding + ' · ' + (doc.newline === 'none' ? t('noNewline') : doc.newline === 'mixed' ? t('mixedNewline') : doc.newline)
    : '';
  const save = $('.save-button', root);
  save.disabled = !doc || !doc.editable || !isDirty || tab.saving;
  save.textContent = t(tab?.saving ? 'saving' : 'save');
  const editButton = $('.edit-mode', root);
  const previewButton = $('.preview-mode', root);
  $('.mode-switch', root).hidden = !doc || !pluginFor(doc.type)?.preview;
  editButton.classList.toggle('selected', tab?.mode === 'edit');
  previewButton.classList.toggle('selected', tab?.mode === 'preview');
  const warning = $('.pane-warning', root);
  warning.textContent = tab?.error ? serverMessage(state.language, tab.error) : doc?.warning ? serverMessage(state.language, doc.warning) : '';
  warning.hidden = !warning.textContent;
  $('.empty-pane', root).hidden = Boolean(doc);
  $('.editor-input-wrap', root).hidden = !doc || tab.mode !== 'edit';
  const textarea = $('.editor-input', root);
  textarea.readOnly = !doc?.editable;
  textarea.setAttribute('aria-label', t('contentOf', { name: doc?.name || paneName(pane) }));
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
  if (!preview.hidden) pluginFor(doc.type).render(preview, tab.content);
  const paneState = $('.pane-state', root);
  paneState.classList.toggle('is-dirty', isDirty);
  paneState.textContent = !doc ? '' : t(!doc.editable ? 'readonly' : isDirty ? 'unsaved' : 'saved');
  $('.pane-stats', root).textContent = doc ? t('chars', { n: tab.content.length }) : '';
}

function renderAll() {
  elements.panes.classList.toggle('split', state.split);
  elements.panes.parentElement.classList.toggle('is-split', state.split);
  elements.divider.hidden = !state.split;
  elements.panes.style.setProperty('--split-before', state.splitRatio + 'fr');
  elements.panes.style.setProperty('--split-after', (1 - state.splitRatio) + 'fr');
  elements.divider.setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
  updateDividerOrientation();
  for (const pane of state.panes) renderPane(pane);
  const pane = state.panes[state.active];
  const tab = activeTab(pane);
  elements.target.textContent = tab ? paneName(pane) + ' · ' + tab.document.name : t('noFile');
  elements.attentionAccess.hidden = !tab;
  elements.attentionAccess.textContent = tab ? t(tab.document.editable ? 'readWrite' : 'readonly') : '';
  const hiddenDirty = !state.split && state.panes.some((item) => item.index !== state.active && item.tabs.some(dirty));
  $('.layout-label', elements.split).textContent = t(state.split ? 'single' : 'split');
  $('.layout-dirty', elements.split).hidden = !hiddenDirty;
  elements.split.dataset.active = String(state.split);
  elements.split.setAttribute('aria-label', t(state.split ? 'closeSplit' : 'openSplit') + (hiddenDirty ? ' · ' + t('hiddenDirty') : ''));
  elements.split.title = hiddenDirty ? t('hiddenDirty') : t(state.split ? 'closeSplit' : 'openSplit');
  renderFiles();
  renderContext();
  setSuggestionAvailability();
}

function makePane(pane) {
  const fragment = $('#pane-template').content.cloneNode(true);
  applyTranslations(fragment);
  pane.element = $('.editor-pane', fragment);
  $('.pane-body', pane.element).id = 'panel-' + pane.index;
  pane.element.addEventListener('pointerdown', () => setActive(pane.index));
  pane.element.addEventListener('focusin', () => setActive(pane.index));
  $('.file-menu-toggle', pane.element).addEventListener('click', () => {
    const next = !pane.fileMenuOpen;
    for (const item of state.panes) item.fileMenuOpen = false;
    pane.fileMenuOpen = next;
    renderAll();
  });
  $('.refresh-files', pane.element).addEventListener('click', refreshFiles);
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
    scheduleContextRender();
    renderFocusDetail();
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
    scheduleContextRender();
    renderFocusDetail();
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

function clearDrag() {
  state.dragging = null;
  for (const element of document.querySelectorAll('.dragging, .drop-target')) {
    element.classList.remove('dragging', 'drop-target');
  }
}

function moveTab(sourceIndex, targetIndex, id, destinationIndex = null) {
  const source = state.panes[sourceIndex];
  const target = state.panes[targetIndex];
  if (!source || !target) return false;
  const index = source.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return false;
  const tab = source.tabs[index];
  if (tab.saving) { toast(t('moveDuringSave'), true); return false; }
  if (source !== target && target.tabs.some((item) => item.document.name === tab.document.name)) {
    toast(t('duplicateTab'), true);
    renderAll();
    return false;
  }
  let destination = destinationIndex === null ? target.tabs.length : Math.max(0, Math.min(destinationIndex, target.tabs.length));
  source.tabs.splice(index, 1);
  if (source === target && destination > index) destination -= 1;
  if (source !== target && source.activeTabId === id) {
    source.activeTabId = source.tabs[Math.min(index, source.tabs.length - 1)]?.id || null;
  }
  target.tabs.splice(destination, 0, tab);
  target.activeTabId = id;
  state.active = target.index;
  if (state.suggestion?.tabId === id) state.suggestion.paneIndex = target.index;
  renderAll();
  target.tabNodes.get(id)?.select.focus();
  return true;
}

function verticalStack() {
  return window.matchMedia('(max-width: 700px)').matches;
}

function updateDividerOrientation() {
  const stacked = verticalStack();
  elements.divider.setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  elements.divider.setAttribute('aria-label', t(stacked ? 'resizeVertical' : 'resize'));
}

function setSplitRatio(value) {
  const rect = elements.panes.getBoundingClientRect();
  const size = (verticalStack() ? rect.height : rect.width) - 6;
  const minimum = Math.min(0.4, Math.max(0.2, size > 0 ? 180 / size : 0.2));
  state.splitRatio = Math.max(minimum, Math.min(1 - minimum, value));
  elements.panes.style.setProperty('--split-before', state.splitRatio + 'fr');
  elements.panes.style.setProperty('--split-after', (1 - state.splitRatio) + 'fr');
  elements.divider.setAttribute('aria-valuemin', String(Math.round(minimum * 100)));
  elements.divider.setAttribute('aria-valuemax', String(Math.round((1 - minimum) * 100)));
  elements.divider.setAttribute('aria-valuenow', String(Math.round(state.splitRatio * 100)));
}

function resizeFromPointer(event) {
  const rect = elements.panes.getBoundingClientRect();
  const stacked = verticalStack();
  const start = stacked ? rect.top : rect.left;
  const size = (stacked ? rect.height : rect.width) - 6;
  if (size > 0) setSplitRatio(((stacked ? event.clientY : event.clientX) - start) / size);
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
  if (pane.loading) return toast(t('waitOpen'), true);
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
    toast(errorText(error), true);
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
  if (dirty(tab) && !window.confirm(t('discard', { pane: paneName(pane), name: tab.document.name }))) return;
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
    toast(t('savedFile', { name: doc.name }));
  } catch (error) {
    tab.error = error.message;
    toast(errorText(error), true);
  } finally {
    tab.saving = false;
    renderAll();
  }
}

function renderReferenceControls() {
  const previous = elements.referenceSelect.value;
  elements.referenceSelect.replaceChildren(new Option(t('chooseReference'), ''));
  for (const pane of state.panes) {
    for (const tab of pane.tabs) {
      elements.referenceSelect.add(new Option(t('editorOption', { name: tab.document.name, pane: paneName(pane) }), 'tab:' + tab.id));
    }
  }
  for (const file of state.files) {
    if (file.type && file.accessible) elements.referenceSelect.add(new Option(t('diskOption', { name: file.name }), 'file:' + file.name));
  }
  if ([...elements.referenceSelect.options].some((option) => option.value === previous)) elements.referenceSelect.value = previous;
  elements.addReference.disabled = state.referenceLoading || elements.referenceSelect.options.length <= 1;
  elements.addReference.textContent = t(state.referenceLoading ? 'referenceLoading' : 'add');

  const expanded = new Set([...elements.referenceList.querySelectorAll('details[open]')].map((item) => item.dataset.referenceId));
  elements.referenceList.replaceChildren();
  if (!state.references.length) {
    const empty = document.createElement('p');
    empty.className = 'context-empty';
    empty.textContent = t('noReferences');
    elements.referenceList.append(empty);
    return;
  }
  for (const reference of state.references) {
    const row = document.createElement('div');
    row.className = 'reference-row';
    const details = document.createElement('details');
    details.dataset.referenceId = String(reference.id);
    details.open = expanded.has(String(reference.id));
    const summary = document.createElement('summary');
    const sourceLabel = referenceLabel(reference);
    summary.textContent = sourceLabel;
    const meta = document.createElement('div');
    meta.className = 'reference-meta';
    meta.textContent = t(reference.origin === 'editor' ? 'editorSnapshot' : 'referenceSnapshot');
    const preview = document.createElement('pre');
    preview.textContent = reference.content;
    details.append(summary, meta, preview);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'reference-remove';
    remove.setAttribute('aria-label', t('removeReference', { name: sourceLabel }));
    remove.title = t('removeReference', { name: sourceLabel });
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.classList.add('icon');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-close');
    icon.append(use);
    remove.append(icon);
    remove.addEventListener('click', () => {
      state.references = state.references.filter((item) => item.id !== reference.id);
      if (state.focus?.sourceKind === 'reference' && state.focus.sourceId === reference.id) state.focus = null;
      state.contextRevision += 1;
      renderAll();
    });
    row.append(details, remove);
    elements.referenceList.append(row);
  }
}

async function addReference() {
  const key = elements.referenceSelect.value;
  if (!key) return toast(t('noReferenceSelection'), true);
  if (state.references.some((item) => item.key === key)) return toast(t('referenceExists'), true);
  if (state.referenceLoading) return;
  state.referenceLoading = true;
  renderReferenceControls();
  try {
    let doc;
    let origin;
    let sourcePane = null;
    if (key.startsWith('tab:')) {
      const source = findTab(Number(key.slice(4)));
      if (!source) throw new Error(t('focusSourceMissing'));
      doc = { ...source.tab.document, content: source.tab.content };
      sourcePane = source.pane.index;
      origin = 'editor';
    } else if (key.startsWith('file:')) {
      doc = await api('/api/file?name=' + encodeURIComponent(key.slice(5)));
      origin = 'disk';
    } else {
      throw new Error(t('noReferenceSelection'));
    }
    state.references.push({ id: state.nextReferenceId++, key, origin, sourcePane, name: doc.name, type: doc.type, content: doc.content, revision: doc.revision });
    state.contextRevision += 1;
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    state.referenceLoading = false;
    renderAll();
  }
}

function referenceLabel(reference) {
  const origin = reference.origin === 'editor'
    ? paneName(state.panes[reference.sourcePane]) + ' · ' + t('editorSource')
    : t('diskSource');
  return reference.name + ' · ' + origin;
}

function focusSources() {
  const tab = activeTab(state.panes[state.active]);
  const sources = tab ? [{ kind: 'tab', id: tab.id, name: tab.document.name, type: tab.document.type, content: tab.content, editable: tab.document.editable }] : [];
  for (const reference of state.references) sources.push({ kind: 'reference', id: reference.id, name: referenceLabel(reference), type: reference.type, content: reference.content, editable: false });
  return sources;
}

function sourceValue(source) {
  return source.kind + ':' + source.id;
}

function blockLabel(block, index) {
  if (block.kind === 'heading') return t('headingBlock', { title: block.title, line: block.line });
  if (block.kind === 'preamble') return t('preambleBlock', { line: block.line });
  if (block.kind === 'document') return t('documentBlock', { line: block.line });
  return t('paragraphBlock', { n: state.focusPage * 200 + index + 1, line: block.line });
}

function renderFocusPicker() {
  const previousSource = elements.focusSource.value;
  const previousBlock = elements.focusBlock.value;
  const sources = focusSources();
  elements.focusSource.replaceChildren();
  if (!sources.length) elements.focusSource.add(new Option(t('noFocusSource'), ''));
  for (const source of sources) {
    elements.focusSource.add(new Option(t(source.kind === 'tab' ? 'currentFile' : 'referenceFile', { name: source.name }), sourceValue(source)));
  }
  if (sources.some((source) => sourceValue(source) === previousSource)) elements.focusSource.value = previousSource;
  const source = sources.find((item) => sourceValue(item) === elements.focusSource.value);
  if (state.focusPickerSource !== (source ? sourceValue(source) : '') || state.focusPickerSnapshot !== source?.content) state.focusPage = 0;
  let page = source ? blocksPage(source.type, source.content, state.focusPage) : { blocks: [], hasNext: false };
  if (state.focusPage > 0 && !page.blocks.length) {
    state.focusPage = 0;
    page = blocksPage(source.type, source.content, state.focusPage);
  }
  state.focusBlocks = page.blocks;
  state.focusHasNext = page.hasNext;
  state.focusPickerSource = source ? sourceValue(source) : '';
  state.focusPickerSnapshot = source?.content;
  elements.focusBlock.replaceChildren();
  if (!state.focusBlocks.length) elements.focusBlock.add(new Option(t('noBlocks'), ''));
  for (const [index, block] of state.focusBlocks.entries()) {
    elements.focusBlock.add(new Option(blockLabel(block, index), block.start + ':' + block.end));
  }
  if ([...elements.focusBlock.options].some((option) => option.value === previousBlock)) elements.focusBlock.value = previousBlock;
  const targetOption = elements.focusRole.querySelector('option[value="target"]');
  targetOption.disabled = !source || source.kind !== 'tab' || !source.editable;
  if (source && targetOption.disabled && elements.focusRole.value === 'target') elements.focusRole.value = 'reference';
  elements.focusSource.disabled = !sources.length;
  elements.focusBlock.disabled = !state.focusBlocks.length;
  elements.focusRole.disabled = !state.focusBlocks.length;
  elements.setFocus.disabled = !state.focusBlocks.length;
  $('#focus-pages').hidden = state.focusPage === 0 && !state.focusHasNext;
  $('#focus-page').textContent = t('pageNumber', { n: state.focusPage + 1 });
  $('#focus-previous').disabled = state.focusPage === 0;
  $('#focus-next').disabled = !state.focusHasNext;
}

let renderedFocus = null;
function renderFocusDetail() {
  const focus = state.focus;
  elements.focusDetail.hidden = !focus;
  if (!focus) { renderedFocus = null; return; }
  const reference = focus.sourceKind === 'reference' ? state.references.find((item) => item.id === focus.sourceId) : null;
  elements.focusInfo.textContent = t('focusReady', {
    role: t(focus.role === 'target' ? 'focusTarget' : 'focusReference'),
    source: reference ? referenceLabel(reference) : focus.sourceName,
    line: focus.line,
  });
  if (renderedFocus !== focus) {
    elements.focusText.textContent = focus.text;
    renderedFocus = focus;
  }
  const problem = focusProblem(focus);
  elements.focusWarning.textContent = problem;
  elements.focusWarning.hidden = !problem;
}

function renderContext() {
  renderReferenceControls();
  renderFocusPicker();
  renderFocusDetail();
}

let contextTimer;
function scheduleContextRender() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(() => { renderFocusPicker(); renderFocusDetail(); }, 120);
}

function setFocus() {
  const source = focusSources().find((item) => sourceValue(item) === elements.focusSource.value);
  if (source && (state.focusPickerSource !== sourceValue(source) || state.focusPickerSnapshot !== source.content)) {
    renderFocusPicker();
    return toast(t('focusStale'), true);
  }
  const block = state.focusBlocks.find((item) => item.start + ':' + item.end === elements.focusBlock.value);
  if (!source || !block) return toast(t('chooseBlock'), true);
  const role = elements.focusRole.value;
  if (role === 'target' && source.kind !== 'tab') return toast(t('focusMustBeCurrent'), true);
  if (role === 'target' && !source.editable) return toast(t('cannotEdit'), true);
  state.focus = {
    sourceKind: source.kind,
    sourceId: source.id,
    sourceName: source.kind === 'reference' ? state.references.find((item) => item.id === source.id)?.name || source.name : source.name,
    documentSnapshot: source.content,
    start: block.start,
    end: block.end,
    text: source.content.slice(block.start, block.end),
    line: block.line,
    role,
  };
  state.contextRevision += 1;
  renderFocusDetail();
  setSuggestionAvailability();
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
    addDiffRow('context', t('noChanges'));
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
  if (!tab) return toast(t('openFirst'), true);
  if (!tab.document.editable) return toast(t('cannotEdit'), true);
  if (!prompt) { elements.prompt.focus(); return toast(t('enterRequest'), true); }
  const problem = focusProblem(state.focus, tab);
  if (problem) return toast(problem, true);
  const referenceText = state.focus?.role === 'reference' ? state.focus.text : state.references[0]?.content ?? null;
  let after;
  try {
    after = suggest({ content: tab.content, prompt, type: tab.document.type, focus: state.focus, referenceText, language: state.language });
  } catch (error) {
    if (!(error instanceof SuggestionError)) throw error;
    return toast(t(error.code === 'reference_required' ? 'referenceRequired' : error.code === 'stale_focus' ? 'focusStale' : error.code === 'too_large' ? 'tooLarge' : 'requestFailed'), true);
  }
  state.suggestion = { paneIndex: pane.index, tabId: tab.id, name: tab.document.name, before: tab.content, after, prompt, contextRevision: state.contextRevision };
  elements.description.textContent = t('suggestionTarget', { pane: paneName(pane), name: tab.document.name });
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
    tab.content !== suggestion.before || !tab.document.editable || tab.saving ||
    state.contextRevision !== suggestion.contextRevision || focusProblem(state.focus, tab)) return;
  tab.content = suggestion.after;
  tab.mode = 'edit';
  tab.error = '';
  state.suggestion = null;
  elements.suggestion.hidden = true;
  renderAll();
  toast(t('applied', { pane: paneName(pane) }));
}

function renderPlugins() {
  const list = $('#plugin-list');
  list.replaceChildren();
  for (const plugin of plugins) {
    const row = document.createElement('div');
    row.className = 'plugin-row';
    const info = document.createElement('div');
    const name = document.createElement('h3');
    name.textContent = t(plugin.id === 'markdown' ? 'markdownPlugin' : 'textPlugin');
    const features = document.createElement('p');
    features.textContent = t(plugin.id === 'markdown' ? 'markdownFeatures' : 'textFeatures');
    info.append(name, features);
    const status = document.createElement('span');
    status.className = 'plugin-status';
    status.textContent = t('builtin');
    row.append(info, status);
    list.append(row);
  }
}

function setView(view) {
  state.view = view;
  for (const name of ['workspace', 'plugins', 'settings']) {
    $('#' + name + '-view').hidden = name !== view;
    const button = document.querySelector('[data-view="' + name + '"]');
    button.classList.toggle('active', name === view);
    if (name === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  for (const pane of state.panes) pane.fileMenuOpen = false;
  renderAll();
}

function updatePreferences() {
  savePreferences();
  applyTranslations();
  for (const pane of state.panes) if (pane.element) applyTranslations(pane.element);
  $('#language-select').value = state.language;
  const accent = document.querySelector('input[name="accent"][value="' + state.accent + '"]');
  if (accent) accent.checked = true;
  renderPlugins();
  renderAll();
  if (state.suggestion) renderDiff(state.suggestion.before, state.suggestion.after);
}

for (const pane of state.panes) makePane(pane);
elements.panes.insertBefore(elements.divider, state.panes[1].element);
elements.split.addEventListener('click', toggleSplit);
elements.divider.addEventListener('pointerdown', (event) => {
  if (!state.split || event.button !== 0) return;
  event.preventDefault();
  state.resizing = true;
  elements.divider.setPointerCapture(event.pointerId);
  resizeFromPointer(event);
});
elements.divider.addEventListener('pointermove', (event) => { if (state.resizing) resizeFromPointer(event); });
elements.divider.addEventListener('pointerup', (event) => {
  state.resizing = false;
  if (elements.divider.hasPointerCapture(event.pointerId)) elements.divider.releasePointerCapture(event.pointerId);
});
elements.divider.addEventListener('pointercancel', () => { state.resizing = false; });
elements.divider.addEventListener('lostpointercapture', () => { state.resizing = false; });
elements.divider.addEventListener('keydown', (event) => {
  const negative = verticalStack() ? 'ArrowUp' : 'ArrowLeft';
  const positive = verticalStack() ? 'ArrowDown' : 'ArrowRight';
  if (![negative, positive, 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  setSplitRatio(event.key === 'Home' ? 0 : event.key === 'End' ? 1 : state.splitRatio + (event.key === positive ? 0.02 : -0.02));
});
window.addEventListener('resize', updateDividerOrientation);
document.addEventListener('click', (event) => {
  if (event.target.closest('.file-picker')) return;
  for (const pane of state.panes) {
    if (pane.fileMenuOpen) { pane.fileMenuOpen = false; renderPane(pane); }
  }
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  for (const pane of state.panes) {
    if (pane.fileMenuOpen) {
      pane.fileMenuOpen = false;
      renderPane(pane);
      $('.file-menu-toggle', pane.element).focus();
    }
  }
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('#language-select').addEventListener('change', (event) => { state.language = event.target.value; updatePreferences(); });
for (const input of document.querySelectorAll('input[name="accent"]')) {
  input.addEventListener('change', () => { if (input.checked) { state.accent = input.value; updatePreferences(); } });
}
elements.addReference.addEventListener('click', addReference);
elements.focusSource.addEventListener('change', renderFocusPicker);
$('#focus-previous').addEventListener('click', () => { if (state.focusPage > 0) { state.focusPage -= 1; renderFocusPicker(); } });
$('#focus-next').addEventListener('click', () => { if (state.focusHasNext) { state.focusPage += 1; renderFocusPicker(); } });
elements.setFocus.addEventListener('click', setFocus);
$('#clear-focus').addEventListener('click', () => { state.focus = null; state.contextRevision += 1; renderFocusDetail(); setSuggestionAvailability(); });
$('#generate').addEventListener('click', generateSuggestion);
elements.apply.addEventListener('click', applySuggestion);
elements.prompt.addEventListener('input', setSuggestionAvailability);
for (const button of document.querySelectorAll('[data-prompt-key]')) {
  button.addEventListener('click', () => { elements.prompt.value = t(button.dataset.promptKey); setSuggestionAvailability(); elements.prompt.focus(); });
}
window.addEventListener('beforeunload', (event) => {
  if (state.panes.some((pane) => pane.tabs.some(dirty))) {
    event.preventDefault();
    event.returnValue = '';
  }
});

updatePreferences();
setView('workspace');
await refreshFiles();
const markdown = state.files.find((file) => file.type === 'markdown' && file.accessible);
const text = state.files.find((file) => file.type === 'text' && file.accessible);
if (markdown) await openFile(state.panes[0], markdown.name);
if (text) await openFile(state.panes[0], text.name, { activate: !markdown });
