import { blocksPage, plugins, pluginFor, supportsContext } from './plugins.js';
import { readLocalFile, localFileBlob } from './local-files.js';
import { suggestForAttention, SuggestionError } from './assistant.js';
import { focusRanges, rangesOverlap, validFocus, focusCanvasBlocks } from './focus.js';
import { translate, serverMessage } from './i18n.js';

const $ = (selector, root = document) => root.querySelector(selector);
const elements = {
  panes: $('#panes'),
  split: $('#split-toggle'),
  divider: $('#pane-divider'),
  attentionList: $('#attention-list'),
  referenceList: $('#reference-list'),
  focusList: $('#focus-list'),
  focusPicker: $('#focus-picker'),
  focusAnnotation: $('#focus-annotation'),
  setFocus: $('#set-focus'),
  prompt: $('#assistant-prompt'),
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
  theme: preferences.theme === 'dark' ? 'dark' : 'light',
  references: [],
  nextReferenceId: 1,
  attentions: [],
  focuses: [],
  nextFocusId: 1,
  focusTabId: null,
  focusBlocks: [],
  focusSelected: [],
  focusManualReview: false,
  focusPage: 0,
  focusHasNext: false,
  focusEditingId: null,
  contextRevision: 0,
  activity: [],
  nextActivityId: 1,
  pluginConfigId: null,
  pluginSettings: Object.fromEntries(plugins.map(plugin => [plugin.id, { focusMode: preferences.plugins?.[plugin.id]?.focusMode === 'selection' ? 'selection' : 'structure' }])),
  nextTabId: 1,
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

function t(key, values = {}) {
  return translate(state.language, key, values);
}

function applyTranslations(root = document) {
  for (const element of root.querySelectorAll('[data-i18n]')) element.textContent = t(element.dataset.i18n);
  for (const element of root.querySelectorAll('[data-i18n-aria]')) element.setAttribute('aria-label', t(element.dataset.i18nAria));
  for (const element of root.querySelectorAll('[data-i18n-title]')) element.title = t(element.dataset.i18nTitle);
  document.documentElement.lang = state.language;
}

function savePreferences() {
  try { localStorage.setItem('editor-preferences', JSON.stringify({ language: state.language, theme: state.theme, plugins: state.pluginSettings })); } catch { /* Settings remain active for this session. */ }
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

function tabName(tab) {
  return tab.document?.name || t('blankTab');
}

function findTab(id) {
  for (const pane of state.panes) {
    const tab = pane.tabs.find((item) => item.id === id);
    if (tab) return { pane, tab };
  }
  return null;
}

function focusProblem(focus) {
  if (!focus) return '';
  const source = focus.sourceKind === 'tab'
    ? findTab(focus.sourceId)?.tab
    : state.references.find((item) => item.id === focus.sourceId);
  if (!source) return t('focusSourceMissing');
  if (!validFocus(focus, source.content)) return t('focusStale');
  if (focus.role === 'target' && focus.sourceKind !== 'tab') return t('focusWrongTarget');
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
  closeFocusPicker();
  state.active = index;
  renderAll();
}

function makeFileItem(file, pane) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'file-item';
  button.dataset.type = file.type || 'unsupported';
  button.classList.toggle('selected', activeTab(pane)?.document?.source !== 'local' && activeTab(pane)?.document?.name === file.name);
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

function activityProblem(record) {
  if (record.applied) return '';
  if (record.contextRevision !== state.contextRevision) return t('contextChanged');
  if (record.prompt !== elements.prompt.value.trim()) return t('requestChanged');
  const referenceProblem = state.focuses.filter(focus => focus.role === 'reference').map(focusProblem).find(Boolean);
  if (referenceProblem) return referenceProblem;
  for (const edit of record.edits) {
    const tab = findTab(edit.tabId)?.tab;
    if (!tab?.document) return t('targetClosed');
    if (!state.attentions.includes(tab.id)) return t('attentionRequired');
    if (tab.content !== edit.before) return t('contentChanged');
    if (!tab.document.editable) return t('cannotEdit');
    if (tab.saving) return t('savingWait');
  }
  return record.edits.some(edit => edit.before !== edit.after) ? '' : t('noChangeNeeded');
}

function setSuggestionAvailability() {
  const hasRequest = elements.prompt.value.trim() || state.focuses.some(focus => focus.role === 'target' && focus.sourceKind === 'tab' && state.attentions.includes(focus.sourceId) && focus.annotation?.trim());
  $('#generate').disabled = !state.attentions.length || !hasRequest;
  $('#generate').title = t(!state.attentions.length ? 'attentionRequired' : 'sendRequest');
  elements.prompt.placeholder = t('requestPlaceholder');
  renderActivity();
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
  name.textContent = tabName(tab);
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
    $('.tab-name', node.entry).textContent = tabName(tab);
    node.select.setAttribute('aria-label', tabName(tab) + (dirty(tab) ? t('unsavedSuffix') : ''));
    node.select.title = t('dragTab');
    node.close.setAttribute('aria-label', t('close', { name: tabName(tab) }));
    node.close.title = t('close', { name: tabName(tab) });
    node.select.tabIndex = selected ? 0 : -1;
    node.marker.hidden = !dirty(tab);
    node.close.disabled = tab.saving;
  }
}

function renderContextActions() {
  const tab = activeTab(state.panes[state.active]);
  for (const button of document.querySelectorAll('.context-add')) {
    const kind = button.dataset.context;
    const supported = supportsContext(tab?.document?.type, kind) && (kind !== 'attention' || tab.document.editable);
    const added = kind === 'reference' ? state.references.some(item => item.sourceTabId === tab?.id) : kind === 'attention' && state.attentions.includes(tab?.id);
    button.disabled = !supported || added;
    button.title = t(!supported ? 'contextUnsupported' : added ? 'alreadyAdded' : { reference: 'addReference', attention: 'addAttention', focus: 'addFocus' }[kind]);
    if (kind === 'focus') button.setAttribute('aria-expanded', String(!elements.focusPicker.hidden));
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
    ? doc.encoding + ' · ' + (doc.newline === 'none' ? t('noNewline') : doc.newline === 'mixed' ? t('mixedNewline') : doc.newline)
    : '';
  const save = $('.save-button', root);
  save.disabled = !doc || !doc.editable || !isDirty || tab.saving;
  save.textContent = t(tab?.saving ? 'saving' : doc?.source === 'local' ? 'saveCopy' : 'save');
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
  renderFocusCanvas(pane);
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
  const hiddenDirty = !state.split && state.panes.some((item) => item.index !== state.active && item.tabs.some(dirty));
  $('.layout-dirty', elements.split).hidden = !hiddenDirty;
  elements.split.dataset.active = String(state.split);
  elements.split.setAttribute('aria-pressed', String(state.split));
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
  $('.new-tab', pane.element).addEventListener('click', () => newTab(pane));
  $('.drop-open', pane.element).addEventListener('click', () => $('.local-file-input', pane.element).click());
  $('.local-file-input', pane.element).addEventListener('change', (event) => {
    openLocalFiles(pane, [...event.target.files]);
    event.target.value = '';
  });
  pane.element.addEventListener('dragover', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    pane.element.classList.add('file-drop-target');
  });
  pane.element.addEventListener('dragleave', (event) => {
    if (!pane.element.contains(event.relatedTarget)) pane.element.classList.remove('file-drop-target');
  });
  pane.element.addEventListener('drop', (event) => {
    if (![...event.dataTransfer.types].includes('Files')) return;
    event.preventDefault();
    pane.element.classList.remove('file-drop-target');
    openLocalFiles(pane, [...event.dataTransfer.files]);
  });
  $('.refresh-files', pane.element).addEventListener('click', refreshFiles);
  $('.focus-add-selection', pane.element).addEventListener('click', addFocusSelection);
  $('.focus-review-selection', pane.element).addEventListener('click', () => {
    state.focusManualReview = !state.focusManualReview;
    renderFocusPicker();
    if (!state.focusManualReview) $('.editor-input', pane.element).focus({ preventScroll: true });
  });
  const textarea = $('.editor-input', pane.element);
  function rememberPosition() {
    const tab = activeTab(pane);
    if (!tab || tab.mode !== 'edit') return;
    const selectionChanged = tab.selectionStart !== textarea.selectionStart || tab.selectionEnd !== textarea.selectionEnd;
    tab.selectionStart = textarea.selectionStart;
    tab.selectionEnd = textarea.selectionEnd;
    tab.scrollTop = textarea.scrollTop;
    tab.scrollLeft = textarea.scrollLeft;
    if (selectionChanged && state.focusTabId === tab.id && state.focusMode === 'selection') renderFocusPicker();
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
    if (state.attentions.includes(tab.id)) state.contextRevision += 1;
    renderFocusCards();
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
    if (state.attentions.includes(tab.id)) state.contextRevision += 1;
    renderFocusCards();
    setSuggestionAvailability();
  });
  $('.edit-mode', pane.element).addEventListener('click', () => { const tab = activeTab(pane); if (tab) { tab.mode = 'edit'; renderPane(pane); renderFocusPicker(); } });
  $('.preview-mode', pane.element).addEventListener('click', () => { const tab = activeTab(pane); if (tab) { tab.mode = 'preview'; renderPane(pane); renderFocusPicker(); } });
  $('.save-button', pane.element).addEventListener('click', () => saveTab(pane, activeTab(pane)));
  elements.panes.append(fragment);
}

function selectTab(pane, id) {
  if (!pane.tabs.some((tab) => tab.id === id)) return;
  closeFocusPicker();
  state.active = pane.index;
  pane.activeTabId = id;
  renderAll();
  pane.tabNodes.get(id)?.entry.scrollIntoView({ block: 'nearest', inline: 'nearest' });
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
  if (source !== target && tab.document && tab.document.source !== 'local' && target.tabs.some((item) => item.document?.source !== 'local' && item.document?.name === tab.document.name)) {
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
  closeFocusPicker();
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
  const existing = pane.tabs.find((tab) => tab.document?.source !== 'local' && tab.document?.name === name);
  if (existing) {
    if (activate) selectTab(pane, existing.id);
    return existing;
  }
  if (pane.loading) return toast(t('waitOpen'), true);
  const blankId = !activeTab(pane)?.document ? pane.activeTabId : null;
  pane.loading = true;
  renderAll();
  try {
    const doc = await api('/api/file?name=' + encodeURIComponent(name));
    return installDocument(pane, doc, blankId, activate);
  } catch (error) {
    toast(errorText(error), true);
  } finally {
    pane.loading = false;
    renderAll();
  }
}

function newTab(pane) {
  closeFocusPicker();
  const tab = { id: state.nextTabId++, document: null, content: '', base: '', mode: 'edit', saving: false, error: '' };
  pane.tabs.push(tab);
  pane.activeTabId = tab.id;
  state.active = pane.index;
  renderAll();
  pane.tabNodes.get(tab.id).select.focus();
  $('.new-tab', pane.element).scrollIntoView({ block: 'nearest', inline: 'nearest' });
  return tab;
}

function installDocument(pane, doc, blankId, activate = true) {
  const blank = pane.tabs.find((tab) => tab.id === blankId && !tab.document);
  const tab = blank || { id: state.nextTabId++ };
  Object.assign(tab, { document: doc, content: doc.content, base: doc.content, mode: 'edit', saving: false, error: '' });
  if (!blank) pane.tabs.push(tab);
  if (activate || pane.activeTabId === null) pane.activeTabId = tab.id;
  return tab;
}

async function openLocalFiles(pane, files) {
  if (!files.length) return;
  if (pane.loading) return toast(t('waitOpen'), true);
  closeFocusPicker();
  let blankId = !activeTab(pane)?.document ? pane.activeTabId : null;
  state.active = pane.index;
  pane.loading = true;
  renderAll();
  const errors = [];
  try {
    for (const file of files) {
      try {
        const doc = await readLocalFile(file);
        installDocument(pane, doc, blankId);
        blankId = null;
      } catch (error) {
        errors.push(file.name + ': ' + t(localErrors.includes(error.message) ? error.message : 'requestFailed'));
      }
    }
  } finally {
    pane.loading = false;
    renderAll();
    if (errors.length) toast(errors.join('\n'), true);
  }
}

const localErrors = ['onlyText', 'localTooLarge', 'localInvalidEncoding', 'localBinary', 'localInvalidContent', 'cannotEdit'];

function closeTab(pane, id) {
  const index = pane.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const tab = pane.tabs[index];
  if (tab.saving) return;
  if (dirty(tab) && !window.confirm(t('discard', { pane: paneName(pane), name: tab.document.name }))) return;
  for (const reference of state.references) {
    if (reference.sourceTabId === id) reference.sourcePane = pane.index;
  }
  if (state.focusTabId === id) closeFocusPicker();
  if (state.attentions.includes(id) || state.focuses.some((focus) => focus.sourceKind === 'tab' && focus.sourceId === id)) {
    state.attentions = state.attentions.filter((tabId) => tabId !== id);
    state.focuses = state.focuses.filter((focus) => focus.sourceKind !== 'tab' || focus.sourceId !== id);
    state.contextRevision += 1;
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
  if (!tab?.document || !dirty(tab) || tab.saving || !tab.document.editable) return;
  const snapshot = tab.content;
  const doc = tab.document;
  tab.saving = true;
  tab.error = '';
  renderAll();
  try {
    if (doc.source === 'local') {
      const url = URL.createObjectURL(localFileBlob(doc, snapshot));
      const link = document.createElement('a');
      link.href = url;
      link.download = doc.name;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      tab.base = snapshot;
      toast(t('copyExported', { name: doc.name }));
      return;
    }
    const result = await api('/api/file', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: doc.name, revision: doc.revision, content: snapshot }),
    });
    tab.document.revision = result.revision;
    tab.base = snapshot;
    toast(t('savedFile', { name: doc.name }));
  } catch (error) {
    if (doc.source === 'local') toast(t(localErrors.includes(error.message) ? error.message : 'requestFailed'), true);
    else { tab.error = error.message; toast(errorText(error), true); }
  } finally {
    tab.saving = false;
    renderAll();
  }
}

function makeIcon(name) {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.classList.add('icon');
  icon.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name);
  icon.append(use);
  return icon;
}

function renderCards(list, items, emptyKey, kind) {
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'context-empty';
    empty.textContent = t(emptyKey);
    list.append(empty);
  }
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'context-card';
    card.dataset.kind = kind;
    card.dataset.cardId = String(item.id);
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'context-open';
    open.setAttribute('aria-label', t('openContextFile', { name: item.name }));
    open.title = [item.warning, item.title || item.name].filter(Boolean).join('\n');
    const label = document.createElement('span');
    label.className = 'context-card-label';
    label.textContent = item.name;
    open.append(makeIcon(kind), label);
    open.addEventListener('click', item.open);
    card.classList.toggle('has-warning', Boolean(item.warning));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'context-remove icon-button';
    remove.setAttribute('aria-label', t({ reference: 'removeReference', attention: 'removeAttention', focus: 'removeFocus' }[kind], { name: item.name }));
    remove.title = remove.getAttribute('aria-label');
    remove.append(makeIcon('close'));
    remove.addEventListener('click', () => {
      item.remove();
      state.contextRevision += 1;
      renderAll();
    });
    card.append(open);
    if (item.edit) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'context-edit icon-button';
      edit.setAttribute('aria-label', t('editFocusNote', { name: item.name }));
      edit.title = t('editFocusNote', { name: item.name });
      edit.append(makeIcon('edit'));
      edit.addEventListener('click', () => item.edit(edit));
      card.append(edit);
    }
    card.append(remove);
    list.append(card);
  }
}

function renderReferenceCards() {
  renderCards(elements.referenceList, state.references.map((reference) => ({
    id: reference.id, name: reference.name,
    open() { return openReference(reference); },
    remove() { removeReference(reference.id); },
  })), 'noReferences', 'reference');
}

function renderAttentionCards() {
  renderCards(elements.attentionList, state.attentions.flatMap((id) => {
    const found = findTab(id);
    if (!found?.tab.document) return [];
    return [{ id, name: tabName(found.tab),
      open() { showContextTab(findTab(id)); },
      remove() { state.attentions = state.attentions.filter((item) => item !== id); },
    }];
  }), 'noAttention', 'attention');
}

function renderFocusCards() {
  renderCards(elements.focusList, state.focuses.map((focus) => ({
    id: focus.id, name: focus.sourceName,
    warning: focusProblem(focus),
    title: focusRangeLabel(focus) + '\n' + (focus.annotation || ''),
    open() { return openFocusedSource(focus); },
    edit(button) { editFocus(focus, button); },
    remove() { if (state.focusEditingId === focus.id) closeFocusPicker(); state.focuses = state.focuses.filter((item) => item.id !== focus.id); },
  })), 'noFocus', 'focus');
}

function showContextTab(found) {
  if (!found) return toast(t('contextSourceMissing'), true);
  setView('workspace');
  selectTab(found.pane, found.tab.id);
  found.pane.tabNodes.get(found.tab.id)?.select.focus({ preventScroll: true });
  found.pane.element.scrollIntoView({ block: 'start', inline: 'nearest' });
}

async function openReference(reference) {
  if (!reference) return toast(t('contextSourceMissing'), true);
  let found = findTab(reference.sourceTabId);
  if (!found) {
    const pane = state.panes[reference.sourcePane];
    if (reference.document.source === 'local') {
      if (pane.loading) return toast(t('waitOpen'), true);
      // A closed browser file can be restored from its reference snapshot.
      // Keep its local identity even when a server file shares the same name.
      const blankId = !activeTab(pane)?.document ? pane.activeTabId : null;
      const tab = installDocument(pane, { ...reference.document, content: reference.content }, blankId, false);
      found = { pane, tab };
    } else {
      const candidates = [pane, ...state.panes.filter((item) => item !== pane)];
      for (const candidate of candidates) {
        const tab = candidate.tabs.find((item) => item.document?.source !== 'local' && item.document?.name === reference.name);
        if (tab) { found = { pane: candidate, tab }; break; }
      }
      if (!found) {
        const tab = await openFile(pane, reference.name, { activate: false });
        if (!tab) return;
        found = { pane, tab };
      }
    }
    reference.sourceTabId = found.tab.id;
    reference.sourcePane = found.pane.index;
  }
  showContextTab(found);
}

function removeReference(id) {
  state.references = state.references.filter((item) => item.id !== id);
  state.focuses = state.focuses.filter((focus) => focus.sourceKind !== 'reference' || focus.sourceId !== id);
}

function toggleReference(tab, pane) {
  if (!supportsContext(tab.document?.type, 'reference')) return;
  const existing = state.references.filter((item) => item.sourceTabId === tab.id);
  if (existing.length) {
    for (const reference of existing) removeReference(reference.id);
  } else {
    if (tab.content.length > 40000) return toast(t('referenceTooLarge'), true);
    state.references.push({
      id: state.nextReferenceId++, sourceTabId: tab.id, sourcePane: pane.index,
      document: { ...tab.document }, name: tab.document.name, type: tab.document.type, content: tab.content,
    });
  }
  state.contextRevision += 1;
  renderAll();
}

function toggleAttention(tab) {
  if (!supportsContext(tab.document?.type, 'attention')) return;
  if (state.attentions.includes(tab.id)) state.attentions = state.attentions.filter((id) => id !== tab.id);
  else state.attentions.push(tab.id);
  state.contextRevision += 1;
  renderAll();
}

function pickerSource() {
  const tab = findTab(state.focusTabId)?.tab;
  return tab?.document && supportsContext(tab.document.type, 'focus')
    ? { kind: 'tab', id: tab.id, name: tab.document.name, type: tab.document.type, content: tab.content, editable: tab.document.editable } : null;
}

function blockKey(block) {
  return block.start + ':' + block.end;
}

function blockLabel(block) {
  if (block.kind === 'selection') return t('selectionBlock', { line: block.line });
  if (block.kind === 'heading') return t('headingBlock', { title: block.title || t('unnamedHeading'), line: block.line });
  const key = { preamble: 'preambleBlock', document: 'documentBlock', diagram: 'diagramBlock', table: 'tableBlock', code: 'codeBlock', list: 'listBlock', quote: 'quoteBlock', rule: 'ruleBlock' }[block.kind];
  if (key) return t(key, { line: block.line });
  return t('paragraphBlock', { line: block.line });
}

function selectionBlock(source) {
  const tab = source?.kind === 'tab' ? findTab(source.id)?.tab : null;
  const start = tab?.selectionStart;
  const end = tab?.selectionEnd;
  if (tab?.mode !== 'edit' || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > tab.content.length) return null;
  return { kind: 'selection', start, end, line: tab.content.slice(0, start).split('\n').length };
}

function focusRangeLabel(focus) {
  const ranges = focusRanges(focus);
  return t('focusGroupRange', { name: focus.sourceName, n: ranges.length, count: ranges.reduce((sum, range) => sum + range.text.length, 0) }) + '\n' +
    ranges.map((range) => t('focusRange', { name: focus.sourceName, start: range.line,
      end: focus.documentSnapshot.slice(0, Math.max(range.start, range.end - 1)).split('\n').length, count: range.text.length })).join('\n');
}

function focusDraftFor(source) {
  return {
    sourceKind: source.kind, sourceId: source.id, sourceName: source.name,
    documentSnapshot: source.content,
    ranges: state.focusSelected.map((range) => ({ ...range })).sort((a, b) => a.start - b.start),
    mode: state.focusMode, page: state.focusPage,
    role: source.editable ? 'target' : 'reference',
  };
}

function focusConflict(focus) {
  const ranges = focusRanges(focus);
  const existing = state.focuses.filter((item) => item.id !== state.focusEditingId && item.sourceKind === focus.sourceKind && item.sourceId === focus.sourceId && item.documentSnapshot === focus.documentSnapshot);
  if (existing.some((item) => item.role === focus.role && focusRanges(item).length === ranges.length &&
    ranges.every((range) => focusRanges(item).some((other) => blockKey(range) === blockKey(other))))) return t('focusExists');
  if (focus.role === 'target' && existing.some((item) => item.role === 'target' &&
    focusRanges(item).some((other) => ranges.some((range) => rangesOverlap(range, other))))) return t('focusOverlap');
  return '';
}

function addFocusSelection() {
  const source = pickerSource();
  const block = selectionBlock(source);
  if (!source || !block) return;
  if (state.focusSelected.some((range) => rangesOverlap(range, block))) return toast(t('focusSelectionOverlap'), true);
  state.focusSelected.push({ ...block, text: source.content.slice(block.start, block.end) });
  renderFocusPicker();
}

function toggleFocusBlock(block) {
  const source = pickerSource();
  if (!source || source.content !== state.focusPickerSnapshot) return renderFocusPicker();
  const existing = state.focusSelected.find((range) => blockKey(range) === blockKey(block));
  if (existing) state.focusSelected = state.focusSelected.filter((range) => range !== existing);
  else {
    if (state.focusSelected.some((range) => rangesOverlap(range, block))) return toast(t('focusSelectionOverlap'), true);
    state.focusSelected.push({ ...block, text: source.content.slice(block.start, block.end) });
  }
  renderFocusPicker();
}

function renderFocusCanvas(pane) {
  if (!pane.element) return;
  const root = pane.element;
  const view = $('.focus-block-view', root);
  const tools = $('.focus-selection-tools', root);
  const tab = activeTab(pane);
  const active = !elements.focusPicker.hidden && tab?.id === state.focusTabId;
  view.hidden = true;
  tools.hidden = true;
  root.classList.remove('selecting-text');
  if (!active) return;
  const source = pickerSource();
  if (!source) return;
  $('.empty-pane', root).hidden = true;
  const manual = state.focusMode === 'selection';
  const selected = state.focusSelected;
  const showBlocks = !manual || state.focusManualReview;
  tools.hidden = !manual;
  root.classList.toggle('selecting-text', manual);
  $('.editor-input-wrap', root).hidden = showBlocks;
  $('.markdown-preview', root).hidden = true;
  $('.mode-switch', root).hidden = true;
  if (manual) {
    const block = selectionBlock(pickerSource());
    $('.focus-add-selection', root).disabled = !block || state.focusSelected.some((range) => rangesOverlap(range, block));
    $('.focus-add-selection', root).hidden = state.focusManualReview;
    $('.focus-review-selection', root).textContent = t(state.focusManualReview ? 'focusContinueSelection' : 'focusReviewSelection');
    $('.focus-selection-count', root).textContent = t('focusSelectedCount', { n: selected.length });
  }
  if (!showBlocks) return;
  view.hidden = false;
  // Page only the structural view; manual selection still exposes all text.
  // Selections crossing a page edge stay whole and can be cancelled there.
  const candidates = manual ? [] : state.focusBlocks;
  let start = 0;
  let end = source.content.length;
  if (!manual && candidates.length) {
    start = candidates[0].start;
    end = candidates.at(-1).end;
    const visible = selected.filter((range) => rangesOverlap(range, { start, end }));
    start = Math.min(start, ...visible.map((range) => range.start));
    end = Math.max(end, ...visible.map((range) => range.end));
  }
  const blocks = focusCanvasBlocks(source.content, candidates, selected, start, end);
  const key = blocks.map((block) => blockKey(block) + ':' + block.kind).join('|') + ':' + state.language + ':' + source.kind + ':' + source.name;
  if (pane.focusCanvasKey !== key || pane.focusCanvasSnapshot !== source.content) {
    const focusedKey = view.contains(document.activeElement) ? document.activeElement.dataset.range : null;
    const scrollTop = view.scrollTop;
    view.replaceChildren();
    if (source.kind === 'reference') {
      const label = document.createElement('p');
      label.className = 'focus-source-label';
      label.textContent = t('focusSnapshotSource', { name: source.name });
      view.append(label);
    }
    for (const block of blocks) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'focus-source-block';
      button.dataset.range = blockKey(block);
      button.title = blockLabel(block);
      button.setAttribute('aria-label', button.title);
      const marker = document.createElement('span');
      marker.className = 'focus-block-marker';
      marker.setAttribute('aria-hidden', 'true');
      const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icon.classList.add('icon');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-check');
      icon.append(use);
      marker.append(icon);
      const text = document.createElement('span');
      text.className = 'focus-block-text';
      text.textContent = source.content.slice(block.start, block.end);
      button.append(marker, text);
      button.addEventListener('click', () => toggleFocusBlock(block));
      view.append(button);
    }
    if (!blocks.length) {
      const empty = document.createElement('p');
      empty.className = 'focus-hint';
      empty.textContent = t(manual ? 'focusNoSelection' : 'noBlocks');
      view.prepend(empty);
    }
    pane.focusCanvasKey = key;
    pane.focusCanvasSnapshot = source.content;
    view.scrollTop = scrollTop;
    if (focusedKey) [...view.querySelectorAll('[data-range]')].find((button) => button.dataset.range === focusedKey)?.focus({ preventScroll: true });
  }
  for (const button of view.querySelectorAll('[data-range]')) {
    button.setAttribute('aria-pressed', String(selected.some((range) => blockKey(range) === button.dataset.range)));
  }
  const location = state.focusTabId + ':' + state.focusMode + ':' + state.focusPage;
  if (pane.focusCanvasLocation !== location) {
    const first = blocks[0];
    const button = first && [...view.querySelectorAll('[data-range]')].find((item) => item.dataset.range === blockKey(first));
    view.scrollTop = button ? Math.max(0, button.offsetTop - 20) : 0;
    pane.focusCanvasLocation = location;
  }
}

let focusAnchor = null;
function openFocusPicker(tab, button) {
  if (!supportsContext(tab.document?.type, 'focus')) return;
  if (!elements.focusPicker.hidden && state.focusTabId === tab.id) return closeFocusPicker(true);
  closeFocusPicker();
  state.focusTabId = tab.id;
  state.focusPage = 0;
  state.focusMode = state.pluginSettings[pluginFor(tab.document.type).id].focusMode;
  state.focusPickerSnapshot = tab.content;
  focusAnchor = button;
  elements.focusPicker.hidden = false;
  elements.focusAnnotation.value = '';
  const selection = selectionBlock({ kind: 'tab', id: tab.id });
  if (selection && state.focusMode === 'selection') state.focusSelected = [{ ...selection, text: tab.content.slice(selection.start, selection.end) }];
  renderFocusPicker();
  elements.focusAnnotation.focus({ preventScroll: true });
}

function editFocus(focus, button) {
  const found = findTab(focus.sourceId);
  if (!found) return toast(t('focusSourceMissing'), true);
  showContextTab(found);
  state.focusTabId = found.tab.id;
  state.focusEditingId = focus.id;
  state.focusSelected = focusRanges(focus).map(range => ({ ...range }));
  state.focusPage = focus.page || 0;
  state.focusMode = state.pluginSettings[pluginFor(found.tab.document.type).id].focusMode;
  state.focusManualReview = state.focusMode === 'selection';
  state.focusPickerSnapshot = focus.documentSnapshot;
  focusAnchor = button;
  elements.focusPicker.hidden = false;
  elements.focusAnnotation.value = focus.annotation || '';
  renderFocusPicker();
  elements.focusAnnotation.focus({ preventScroll: true });
}

function dockFocusPicker() {
  if (elements.focusPicker.hidden) return;
  const pane = findTab(state.focusTabId)?.pane;
  if (!pane) return;
  const content = $('.pane-content', pane.element);
  if (elements.focusPicker.parentElement !== content) content.append(elements.focusPicker);
  for (const item of state.panes) {
    item.element.classList.toggle('has-focus', item === pane);
    item.element.classList.toggle('focus-compact', item === pane && item.element.clientWidth < 620);
  }
  renderContextActions();
}

function closeFocusPicker(restoreFocus = false) {
  elements.focusPicker.hidden = true;
  const returnTarget = focusAnchor?.isConnected ? focusAnchor : $('#add-focus');
  focusAnchor = null;
  state.focusTabId = null;
  state.focusEditingId = null;
  state.focusSelected = [];
  state.focusBlocks = [];
  state.focusManualReview = false;
  state.focusPickerSnapshot = null;
  for (const pane of state.panes) if (pane.element) {
    pane.focusCanvasLocation = '';
    pane.element.classList.remove('has-focus', 'focus-compact');
    renderPane(pane);
  }
  renderContextActions();
  if (restoreFocus) returnTarget?.focus({ preventScroll: true });
}

function renderFocusPicker() {
  if (elements.focusPicker.hidden) return;
  const source = pickerSource();
  if (!source || (state.focusEditingId && !state.focuses.some(focus => focus.id === state.focusEditingId))) return closeFocusPicker();
  const sourceChanged = state.focusPickerSnapshot !== source.content;
  if (sourceChanged) {
    state.focusSelected = [];
    state.focusPage = 0;
    state.focusPickerSnapshot = source.content;
  }
  if (state.focusMode === 'selection') findTab(source.id).tab.mode = 'edit';
  const page = state.focusMode === 'selection' ? { blocks: [], hasNext: false } : blocksPage(source.type, source.content, state.focusPage);
  state.focusBlocks = page.blocks;
  state.focusHasNext = page.hasNext;
  $('#focus-title').textContent = t(state.focusEditingId ? 'editFocus' : 'addFocus');
  $('#focus-range').textContent = t('focusSelectedCount', { n: state.focusSelected.length });
  $('#focus-range').title = state.focusSelected.length ? focusRangeLabel(focusDraftFor(source)) : '';
  $('#focus-pages').hidden = state.focusMode === 'selection' || (state.focusPage === 0 && !page.hasNext);
  $('#focus-page').textContent = t('pageNumber', { n: state.focusPage + 1 });
  $('#focus-previous').disabled = state.focusPage === 0;
  $('#focus-next').disabled = !page.hasNext;
  const annotation = elements.focusAnnotation.value.trim();
  const problem = sourceChanged ? t('focusStale') : state.focusSelected.length ? focusConflict(focusDraftFor(source)) : '';
  $('#focus-error').textContent = problem;
  $('#focus-error').hidden = !problem;
  elements.focusAnnotation.placeholder = t('focusNotePlaceholder');
  elements.setFocus.disabled = !state.focusSelected.length || !annotation || annotation.length > 2000 || Boolean(problem);
  elements.setFocus.setAttribute('aria-label', t(state.focusEditingId ? 'saveFocus' : 'createFocus'));
  elements.setFocus.title = t(state.focusEditingId ? 'saveFocus' : 'createFocus');
  dockFocusPicker();
  for (const pane of state.panes) renderFocusCanvas(pane);
}

async function openFocusedSource(focus) {
  let found;
  if (focus.sourceKind === 'reference') {
    const reference = state.references.find((item) => item.id === focus.sourceId);
    if (!reference) return toast(t('contextSourceMissing'), true);
    await openReference(reference);
    found = findTab(reference.sourceTabId);
  } else {
    found = findTab(focus.sourceId);
    showContextTab(found);
  }
  if (!found) return;
  if (found.tab.content !== focus.documentSnapshot) return toast(t('focusSnapshotNotice'), true);
  // A textarea cannot represent disjoint highlights. Show all exact ranges in
  // the content view and the group's shared instructions instead.
  editFocus(focus, elements.focusList.querySelector('[data-card-id="' + focus.id + '"] .context-edit'));
  const view = $('.focus-block-view', found.pane.element);
  view.querySelector('[aria-pressed="true"]')?.scrollIntoView({ block: 'nearest' });
}

function renderContext() {
  renderReferenceCards();
  renderAttentionCards();
  renderFocusPicker();
  renderFocusCards();
  renderContextActions();
}

let contextTimer;
function scheduleContextRender() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(renderContext, 120);
}

function setFocus() {
  const source = pickerSource();
  if (!source || !state.focusSelected.length || elements.setFocus.disabled) return;
  if (state.focusPickerSnapshot !== source.content) { renderFocusPicker(); return; }
  const draft = { ...focusDraftFor(source), annotation: elements.focusAnnotation.value.trim() };
  const problem = focusProblem(draft) || focusConflict(draft);
  if (problem) { renderFocusPicker(); return toast(problem, true); }
  if (!draft.annotation || draft.annotation.length > 2000) return;
  const editingId = state.focusEditingId;
  if (editingId) {
    if (!state.focuses.some((focus) => focus.id === editingId)) return closeFocusPicker();
    state.focuses = state.focuses.map((focus) => focus.id === editingId ? { ...draft, id: editingId } : focus);
  } else {
    state.focuses.push({ ...draft, id: state.nextFocusId++ });
  }
  state.contextRevision += 1;
  const anchor = focusAnchor;
  closeFocusPicker();
  renderAll();
  if (anchor?.isConnected) anchor.focus();
  else if (editingId) elements.focusList.querySelector('[data-card-id="' + editingId + '"] .context-edit')?.focus();
}

function addDiffRow(container, kind, text) {
  const row = document.createElement('div');
  row.className = 'diff-row ' + kind;
  row.textContent = (kind === 'added' ? '+ ' : kind === 'removed' ? '− ' : '  ') + text;
  container.append(row);
}

function renderDiff(container, before, after) {
  container.replaceChildren();
  if (before === after) return addDiffRow(container, 'context', t('noChanges'));
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  if (prefix > 2) addDiffRow(container, 'context', '…');
  for (const line of oldLines.slice(Math.max(0, prefix - 2), prefix)) addDiffRow(container, 'context', line);
  for (const line of oldLines.slice(prefix, oldLines.length - suffix)) addDiffRow(container, 'removed', line);
  for (const line of newLines.slice(prefix, newLines.length - suffix)) addDiffRow(container, 'added', line);
  for (const line of oldLines.slice(oldLines.length - suffix, oldLines.length - suffix + Math.min(suffix, 2))) addDiffRow(container, 'context', line);
  if (suffix > 2) addDiffRow(container, 'context', '…');
}

function renderActivity() {
  const replies = $('#model-replies');
  const history = $('#change-history');
  // Preserve expanded diffs while editing the request or updating file state.
  const expanded = new Set([...history.querySelectorAll('details[open]')].map(item => item.dataset.change));
  const existing = new Set([...history.querySelectorAll('details')].map(item => item.dataset.change));
  replies.replaceChildren(); history.replaceChildren();
  function empty(container, key) { const p = document.createElement('p'); p.className = 'context-empty'; p.textContent = t(key); container.append(p); }
  if (!state.activity.length) { empty(replies, 'noReplies'); empty(history, 'noTrackedChanges'); return; }
  for (const record of [...state.activity].reverse()) {
    const reply = document.createElement('article'); reply.className = 'model-reply';
    const time = document.createElement('time'); time.dateTime = record.createdAt; time.textContent = new Date(record.createdAt).toLocaleTimeString(state.language, { hour: '2-digit', minute: '2-digit' });
    const request = document.createElement('p'); request.className = 'reply-request'; request.textContent = record.prompt || t('focusInstructions');
    const content = document.createElement('p'); content.textContent = record.error ? t(record.error) : t('demoReply', { n: record.edits.filter(edit => edit.before !== edit.after).length });
    reply.append(time, request, content); replies.append(reply);
    if (!record.edits?.length) continue;
    const batch = document.createElement('article'); batch.className = 'change-batch'; batch.dataset.batch = record.id;
    for (const [index, edit] of record.edits.entries()) {
      const details = document.createElement('details'); details.className = 'change-entry'; details.dataset.change = record.id + ':' + index;
      details.open = expanded.has(details.dataset.change) || (!existing.has(details.dataset.change) && record === state.activity.at(-1));
      const summary = document.createElement('summary');
      const name = document.createElement('span'); name.textContent = edit.name;
      const status = document.createElement('span'); status.className = 'change-status';
      const current = findTab(edit.tabId)?.tab;
      status.textContent = t(record.applied ? !current ? 'trackedClosed' : current.content !== edit.after ? 'trackedEdited' : current.base === edit.after ? 'trackedSaved' : 'trackedApplied' : edit.before === edit.after ? 'noChanges' : activityProblem(record) ? 'trackedExpired' : 'trackedPending');
      summary.append(name, status);
      const diff = document.createElement('div'); diff.className = 'diff'; diff.setAttribute('aria-label', t('diff'));
      renderDiff(diff, edit.before, edit.after);
      details.append(summary, diff); batch.append(details);
    }
    if (!record.applied && record.edits.some(edit => edit.before !== edit.after)) {
      const reason = activityProblem(record);
      const apply = document.createElement('button'); apply.type = 'button'; apply.className = 'apply-button'; apply.textContent = t('applyAttention'); apply.disabled = Boolean(reason); apply.addEventListener('click', () => applySuggestion(record));
      const note = document.createElement('p'); note.className = 'apply-note'; note.textContent = reason || t('notAutosaved');
      batch.append(apply, note);
    }
    history.append(batch);
  }
  if (!history.children.length) empty(history, 'noTrackedChanges');
}

function generateSuggestion() {
  if ($('#generate').disabled) return;
  const prompt = elements.prompt.value.trim();
  const record = { id: state.nextActivityId++, prompt, createdAt: new Date().toISOString(), contextRevision: state.contextRevision, edits: [], applied: false };
  const documents = state.panes.flatMap(pane => pane.tabs.filter(tab => tab.document).map(tab => ({ id: tab.id, name: tab.document.name, type: tab.document.type, editable: tab.document.editable, content: tab.content })));
  try {
    record.edits = suggestForAttention({ documents, attentionIds: state.attentions, focuses: state.focuses, references: state.references.map(reference => reference.content), prompt, language: state.language });
  } catch (error) {
    if (!(error instanceof SuggestionError)) throw error;
    record.error = ({ no_attention: 'attentionRequired', invalid_target: 'cannotEdit', empty_request: 'enterRequest', reference_required: 'referenceRequired', stale_focus: 'focusStale', too_large: 'tooLarge' })[error.code] || 'requestFailed';
  }
  state.activity.push(record);
  setSuggestionAvailability();
}

function applySuggestion(record) {
  if (record.applied || activityProblem(record)) return setSuggestionAvailability();
  closeFocusPicker();
  for (const edit of record.edits) {
    const tab = findTab(edit.tabId).tab;
    tab.content = edit.after; tab.mode = 'edit'; tab.error = '';
  }
  record.applied = true;
  state.contextRevision += 1;
  renderAll();
  toast(t('appliedAttention', { n: record.edits.filter(edit => edit.before !== edit.after).length }));
}

function renderPlugins() {
  const list = $('#plugin-list');
  list.replaceChildren();
  for (const plugin of plugins) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'plugin-row'; row.dataset.plugin = plugin.id;
    const info = document.createElement('div');
    const name = document.createElement('h3'); name.textContent = t(plugin.id === 'markdown' ? 'markdownPlugin' : 'textPlugin');
    const features = document.createElement('p'); features.textContent = t(plugin.id === 'markdown' ? 'markdownFeatures' : 'textFeatures');
    info.append(name, features);
    row.append(makeIcon('plugins'), info, makeIcon('arrow'));
    row.addEventListener('click', () => { state.pluginConfigId = plugin.id; renderPlugins(); });
    list.append(row);
  }
  const plugin = plugins.find(item => item.id === state.pluginConfigId);
  $('#plugin-overview').hidden = Boolean(plugin);
  $('#plugin-config').hidden = !plugin;
  if (plugin) {
    $('#plugin-config-title').textContent = t(plugin.id === 'markdown' ? 'markdownPlugin' : 'textPlugin');
    $('#plugin-config-description').textContent = t(plugin.id === 'markdown' ? 'markdownFeatures' : 'textFeatures');
    $('#plugin-focus-mode').value = state.pluginSettings[plugin.id].focusMode;
  }
}

function setView(view) {
  state.view = view;
  for (const name of ['workspace', 'plugins', 'models', 'settings']) {
    $('#' + name + '-view').hidden = name !== view;
    const button = document.querySelector('[data-view="' + name + '"]');
    button.classList.toggle('active', name === view);
    if (name === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  closeFocusPicker();
  renderAll();
}

function updatePreferences() {
  document.documentElement.dataset.theme = state.theme;
  savePreferences();
  applyTranslations();
  for (const pane of state.panes) if (pane.element) applyTranslations(pane.element);
  $('#language-select').value = state.language;
  const theme = document.querySelector('input[name="theme"][value="' + state.theme + '"]');
  if (theme) theme.checked = true;
  renderPlugins();
  renderAll();
  renderActivity();
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
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFocusPicker(true);
});
window.addEventListener('resize', dockFocusPicker);
const focusLayoutObserver = new ResizeObserver(dockFocusPicker);
for (const pane of state.panes) focusLayoutObserver.observe(pane.element);
// Prevent a drop outside the editor from navigating away from unsaved work.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => {
  if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('#language-select').addEventListener('change', (event) => { state.language = event.target.value; updatePreferences(); });
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', () => { if (input.checked) { state.theme = input.value; updatePreferences(); } });
}
elements.focusAnnotation.addEventListener('input', renderFocusPicker);
$('#focus-close').addEventListener('click', () => closeFocusPicker(true));
$('#focus-previous').addEventListener('click', () => { if (state.focusPage > 0) { state.focusPage -= 1; renderFocusPicker(); } });
$('#focus-next').addEventListener('click', () => { if (state.focusHasNext) { state.focusPage += 1; renderFocusPicker(); } });
elements.setFocus.addEventListener('click', setFocus);
$('#generate').addEventListener('click', generateSuggestion);
elements.prompt.addEventListener('input', setSuggestionAvailability);
function sendOnEnter(event, send) {
  if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  send();
}
elements.prompt.addEventListener('keydown', event => sendOnEnter(event, generateSuggestion));
elements.focusAnnotation.addEventListener('keydown', event => sendOnEnter(event, setFocus));
for (const button of document.querySelectorAll('.context-add')) button.addEventListener('click', () => {
  const pane = state.panes[state.active];
  const tab = activeTab(pane);
  if (!tab?.document || button.disabled) return;
  if (button.dataset.context === 'reference') toggleReference(tab, pane);
  if (button.dataset.context === 'attention') toggleAttention(tab);
  if (button.dataset.context === 'focus') openFocusPicker(tab, button);
});
$('#plugin-back').addEventListener('click', () => { state.pluginConfigId = null; renderPlugins(); });
$('#plugin-focus-mode').addEventListener('change', event => {
  if (!state.pluginConfigId) return;
  state.pluginSettings[state.pluginConfigId].focusMode = event.target.value;
  savePreferences();
});
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
