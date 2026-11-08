import { blocksPage, plugins, pluginFor, supportsContext } from './plugins.js';
import { readLocalFile, localFileBlob } from './local-files.js';
import { suggest, SuggestionError } from './assistant.js';
import { focusRanges, rangesOverlap, validFocus, focusText } from './focus.js';
import { translate, serverMessage } from './i18n.js';

const $ = (selector, root = document) => root.querySelector(selector);
const elements = {
  panes: $('#panes'),
  split: $('#split-toggle'),
  divider: $('#pane-divider'),
  target: $('#assistant-target'),
  attentionList: $('#attention-list'),
  referenceList: $('#reference-list'),
  focusList: $('#focus-list'),
  focusPicker: $('#focus-picker'),
  focusSource: $('#focus-source'),
  focusMode: $('#focus-mode'),
  focusRole: $('#focus-role'),
  focusAnnotation: $('#focus-annotation'),
  focusContinue: $('#focus-continue'),
  setFocus: $('#set-focus'),
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
  focusStep: 1,
  focusDraft: null,
  focusEditingId: null,
  contextRevision: 0,
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
  try { localStorage.setItem('editor-preferences', JSON.stringify({ language: state.language, theme: state.theme })); } catch { /* Settings remain active for this session. */ }
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

function relevantFocuses(tab) {
  return state.focuses.filter((focus) => focus.role === 'reference' || focus.sourceId === tab?.id);
}

function contextProblem(tab) {
  if (state.focuses.some((focus) => focus.role === 'target') && !state.focuses.some((focus) => focus.role === 'target' && focus.sourceId === tab?.id)) return t('focusWrongTarget');
  return relevantFocuses(tab).map((focus) => focusProblem(focus)).find(Boolean) || '';
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
  else if (contextProblem(tab)) reason = contextProblem(tab);
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
  for (const button of root.querySelectorAll('[data-context]')) {
    const capability = button.dataset.context;
    const supported = supportsContext(doc?.type, capability);
    if (capability === 'focus') {
      button.disabled = !supported;
      button.setAttribute('aria-label', t('addFocus'));
      button.title = t(supported ? 'addFocus' : 'contextUnsupported');
      button.setAttribute('aria-expanded', String(!elements.focusPicker.hidden && focusAnchor === button));
      continue;
    }
    const added = capability === 'reference' ? state.references.some((item) => item.sourceTabId === tab?.id) : state.attentions.includes(tab?.id);
    button.disabled = !supported;
    button.classList.toggle('is-added', added);
    button.setAttribute('aria-pressed', String(added));
    const label = t(added ? { reference: 'removeReference', attention: 'removeAttention' }[capability] : { reference: 'addReference', attention: 'addAttention' }[capability], { name: doc?.name || '' });
    button.setAttribute('aria-label', label);
    button.title = supported ? label : t('contextUnsupported');
  }
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
  const pane = state.panes[state.active];
  const tab = activeTab(pane);
  elements.target.textContent = tab?.document ? t('editingTarget', { name: paneName(pane) + ' · ' + tabName(tab) }) : t('noFile');
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
  for (const button of pane.element.querySelectorAll('[data-context]')) {
    button.addEventListener('click', () => {
      const tab = activeTab(pane);
      if (!supportsContext(tab?.document?.type, button.dataset.context)) return;
      if (button.dataset.context === 'reference') toggleReference(tab, pane);
      if (button.dataset.context === 'attention') toggleAttention(tab);
      if (button.dataset.context === 'focus') openFocusPicker(tab, button);
    });
  }
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
    if (selectionChanged && state.focusTabId === tab.id && state.focusStep === 1 && elements.focusMode.value === 'selection') renderFocusPicker();
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

function focusSources() {
  const tab = findTab(state.focusTabId)?.tab;
  const sources = tab?.document && supportsContext(tab.document.type, 'focus')
    ? [{ kind: 'tab', id: tab.id, name: tab.document.name, type: tab.document.type, content: tab.content, editable: tab.document.editable }] : [];
  for (const reference of state.references) {
    if (supportsContext(reference.type, 'focus')) sources.push({ kind: 'reference', id: reference.id, name: reference.name, type: reference.type, content: reference.content, editable: false });
  }
  return sources;
}

function sourceValue(source) {
  return source.kind + ':' + source.id;
}

function blockKey(block) {
  return block.start + ':' + block.end;
}

function blockLabel(block) {
  if (block.kind === 'selection') return t('selectionBlock', { line: block.line });
  if (block.kind === 'heading') return t('headingBlock', { title: block.title || t('unnamedHeading'), line: block.line });
  const key = { preamble: 'preambleBlock', document: 'documentBlock', diagram: 'diagramBlock', table: 'tableBlock', code: 'codeBlock' }[block.kind];
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
    mode: elements.focusMode.value, page: state.focusPage,
    role: source.kind === 'tab' && source.editable ? elements.focusRole.value : 'reference',
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

function pickerSource() {
  return focusSources().find((item) => sourceValue(item) === elements.focusSource.value);
}

function addFocusSelection() {
  const source = pickerSource();
  const block = selectionBlock(source);
  if (!source || !block || state.focusStep !== 1) return;
  if (state.focusSelected.some((range) => rangesOverlap(range, block))) return toast(t('focusSelectionOverlap'), true);
  state.focusSelected.push({ ...block, text: source.content.slice(block.start, block.end) });
  renderFocusPicker();
}

function toggleFocusBlock(block) {
  if (state.focusStep !== 1) return;
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
  const secondStep = state.focusStep === 2;
  const source = secondStep && state.focusDraft ? {
    kind: state.focusDraft.sourceKind, name: state.focusDraft.sourceName, content: state.focusDraft.documentSnapshot,
  } : pickerSource();
  if (!source) return;
  $('.empty-pane', root).hidden = true;
  const manual = !secondStep && elements.focusMode.value === 'selection';
  const selected = secondStep ? focusRanges(state.focusDraft) : state.focusSelected;
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
  // Keep selected blocks across modes/pages; hide candidates that overlap them.
  const candidates = manual ? [] : state.focusBlocks;
  const blocks = [...selected, ...candidates.filter((block) => !selected.some((range) => rangesOverlap(range, block)))].sort((a, b) => a.start - b.start);
  const key = blocks.map(blockKey).join('|') + ':' + state.language + ':' + source.kind + ':' + source.name;
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
    let offset = 0;
    function gap(end) {
      if (end <= offset) return;
      const text = document.createElement('pre');
      text.className = 'focus-gap';
      text.textContent = source.content.slice(offset, end);
      view.append(text);
    }
    for (const block of blocks) {
      gap(block.start);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'focus-source-block';
      button.dataset.range = blockKey(block);
      button.title = blockLabel(block);
      button.setAttribute('aria-label', button.title);
      button.textContent = source.content.slice(block.start, block.end);
      button.addEventListener('click', () => toggleFocusBlock(block));
      view.append(button);
      offset = block.end;
    }
    gap(source.content.length);
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
    button.setAttribute('aria-disabled', String(secondStep));
  }
  const location = state.focusPickerSource + ':' + elements.focusMode.value + ':' + state.focusPage + ':' + state.focusStep;
  if (pane.focusCanvasLocation !== location) {
    const first = secondStep ? selected[0] : candidates[0] || selected[0];
    const button = first && [...view.querySelectorAll('[data-range]')].find((item) => item.dataset.range === blockKey(first));
    view.scrollTop = button ? Math.max(0, button.offsetTop - 20) : 0;
    pane.focusCanvasLocation = location;
  }
}

let focusAnchor = null;
function openFocusPicker(tab, button) {
  if (!supportsContext(tab.document?.type, 'focus')) return;
  if (!elements.focusPicker.hidden && state.focusTabId === tab.id && !state.focusEditingId) return closeFocusPicker(true);
  closeFocusPicker();
  state.focusTabId = tab.id;
  state.focusStep = 1;
  state.focusPage = 0;
  focusAnchor = button;
  elements.focusPicker.hidden = false;
  elements.focusSource.replaceChildren(new Option(tabName(tab), 'tab:' + tab.id));
  const selection = selectionBlock({ kind: 'tab', id: tab.id });
  const mode = selection ? 'selection' : pluginFor(tab.document.type).focusModes[0];
  elements.focusMode.replaceChildren(new Option('', mode));
  elements.focusAnnotation.value = '';
  elements.focusRole.value = tab.document.editable ? 'target' : 'reference';
  button.setAttribute('aria-expanded', 'true');
  renderFocusPicker();
  if (selection) { addFocusSelection(); state.focusManualReview = true; renderFocusPicker(); }
  elements.focusMode.focus({ preventScroll: true });
}

function editFocus(focus, button) {
  const found = focus.sourceKind === 'tab' ? findTab(focus.sourceId) : findTab(activeTab(state.panes[state.active])?.id);
  if (!found) return toast(t('focusSourceMissing'), true);
  showContextTab(found);
  state.focusTabId = found.tab.id;
  state.focusStep = 2;
  state.focusEditingId = focus.id;
  state.focusDraft = { ...focus, ranges: focusRanges(focus).map((range) => ({ ...range })) };
  state.focusSelected = state.focusDraft.ranges.map((range) => ({ ...range }));
  state.focusPage = focus.page || 0;
  focusAnchor = button;
  elements.focusPicker.hidden = false;
  elements.focusSource.replaceChildren(new Option(focus.sourceName, focus.sourceKind + ':' + focus.sourceId));
  elements.focusMode.replaceChildren(new Option('', focus.mode));
  state.focusPickerSource = focus.sourceKind + ':' + focus.sourceId;
  state.focusPickerSnapshot = focus.documentSnapshot;
  state.focusPickerMode = focus.mode;
  state.focusBlocks = [...state.focusSelected];
  elements.focusRole.value = focus.role;
  elements.focusAnnotation.value = focus.annotation || '';
  renderFocusPicker();
  elements.focusAnnotation.focus({ preventScroll: true });
}

function positionFocusPicker() {
  if (elements.focusPicker.hidden) return;
  const pane = findTab(state.focusTabId)?.pane;
  const inline = window.innerWidth <= 900;
  elements.focusPicker.classList.toggle('focus-inline', inline);
  if (inline && pane) {
    if (elements.focusPicker.parentElement !== pane.element) pane.element.insertBefore(elements.focusPicker, $('.pane-footer', pane.element));
    elements.focusPicker.style.left = '';
    elements.focusPicker.style.top = '';
    elements.focusPicker.style.width = '';
  } else {
    if (elements.focusPicker.parentElement !== document.body) document.body.append(elements.focusPicker);
    const assistant = $('.assistant-panel').getBoundingClientRect();
    elements.focusPicker.style.width = Math.max(244, assistant.width - 16) + 'px';
    const box = elements.focusPicker.getBoundingClientRect();
    elements.focusPicker.style.left = Math.max(8, Math.min(assistant.left + 8, window.innerWidth - box.width - 8)) + 'px';
    elements.focusPicker.style.top = Math.max(8, Math.min(assistant.top + 16, window.innerHeight - box.height - 8)) + 'px';
  }
}

function closeFocusPicker(restoreFocus = false) {
  elements.focusPicker.hidden = true;
  focusAnchor?.setAttribute('aria-expanded', 'false');
  const returnTarget = focusAnchor?.isConnected ? focusAnchor : state.focusEditingId
    ? elements.focusList.querySelector('[data-card-id="' + state.focusEditingId + '"] .context-edit') : null;
  focusAnchor = null;
  state.focusTabId = null;
  state.focusDraft = null;
  state.focusEditingId = null;
  state.focusStep = 1;
  state.focusSelected = [];
  state.focusBlocks = [];
  state.focusManualReview = false;
  state.focusPickerSource = '';
  state.focusPickerSnapshot = null;
  state.focusPickerMode = '';
  for (const pane of state.panes) if (pane.element) { pane.focusCanvasLocation = ''; renderPane(pane); }
  if (restoreFocus) returnTarget?.focus({ preventScroll: true });
}

function renderFocusPicker() {
  if (elements.focusPicker.hidden) return;
  if (state.focusEditingId && !state.focuses.some((focus) => focus.id === state.focusEditingId)) return closeFocusPicker();
  const secondStep = state.focusStep === 2;
  $('#focus-title').textContent = t(state.focusEditingId ? 'editFocus' : 'addFocus');
  $('#focus-range-step').hidden = secondStep;
  $('#focus-note-step').hidden = !secondStep;
  $('#focus-back').hidden = !secondStep;
  elements.focusContinue.hidden = secondStep;
  elements.setFocus.hidden = !secondStep;
  elements.setFocus.textContent = t(state.focusEditingId ? 'saveFocus' : 'createFocus');
  elements.focusAnnotation.placeholder = t('focusNotePlaceholder');
  for (const [id, step] of [['#focus-step-range', 1], ['#focus-step-note', 2]]) {
    if (state.focusStep === step) $(id).setAttribute('aria-current', 'step');
    else $(id).removeAttribute('aria-current');
  }
  const sources = focusSources();
  const error = $('#focus-error');
  error.textContent = '';
  error.hidden = true;
  if (secondStep) {
    const draft = state.focusDraft;
    const source = sources.find((item) => item.kind === draft.sourceKind && item.id === draft.sourceId);
    const targetOption = elements.focusRole.querySelector('option[value="target"]');
    targetOption.disabled = source?.kind !== 'tab' || !source.editable;
    if (targetOption.disabled) elements.focusRole.value = 'reference';
    const annotation = elements.focusAnnotation.value.trim();
    const problem = focusProblem(draft) || focusConflict({ ...draft, role: elements.focusRole.value }) || (annotation.length > 2000 ? t('focusNoteTooLong') : '');
    error.textContent = problem;
    error.hidden = !problem;
    elements.setFocus.disabled = Boolean(problem) || !annotation;
    $('#focus-range').textContent = t('focusGroupRange', { name: draft.sourceName, n: draft.ranges.length, count: draft.ranges.reduce((sum, range) => sum + range.text.length, 0) });
    $('#focus-range').title = focusRangeLabel(draft);
  } else {
    const previousSource = elements.focusSource.value;
    const previousMode = elements.focusMode.value;
    elements.focusSource.replaceChildren(...sources.map((source) => new Option(t(source.kind === 'tab' ? 'currentFile' : 'referenceFile', { name: source.name }), sourceValue(source))));
    if (sources.some((source) => sourceValue(source) === previousSource)) elements.focusSource.value = previousSource;
    const source = pickerSource();
    const modes = (pluginFor(source?.type)?.focusModes || []).filter((mode) => mode !== 'selection' || source.kind === 'tab');
    const modeKeys = { section: 'focusModeSection', paragraph: 'focusModeParagraph', diagram: 'focusModeDiagram', table: 'focusModeTable', code: 'focusModeCode', selection: 'focusModeSelection' };
    elements.focusMode.replaceChildren(...modes.map((mode) => new Option(t(modeKeys[mode]), mode)));
    if (modes.includes(previousMode)) elements.focusMode.value = previousMode;
    const mode = elements.focusMode.value;
    const sourceChanged = state.focusPickerSource !== (source ? sourceValue(source) : '') || state.focusPickerSnapshot !== source?.content;
    if (sourceChanged) { state.focusSelected = []; state.focusManualReview = false; }
    if (sourceChanged || state.focusPickerMode !== mode) state.focusPage = 0;
    if (mode === 'selection' && source?.kind === 'tab') findTab(source.id).tab.mode = 'edit';
    const page = source && mode !== 'selection' ? blocksPage(source.type, source.content, state.focusPage, 200, mode) : { blocks: [], hasNext: false };
    state.focusBlocks = page.blocks;
    state.focusHasNext = page.hasNext;
    state.focusPickerSource = source ? sourceValue(source) : '';
    state.focusPickerSnapshot = source?.content;
    state.focusPickerMode = mode;
    elements.focusSource.disabled = !sources.length;
    elements.focusMode.disabled = !modes.length;
    elements.focusContinue.disabled = !source || !state.focusSelected.length;
    $('#focus-mode-hint').textContent = t(mode === 'selection' ? 'focusSelectionHint' : mode === 'section' ? 'focusSectionHint' : 'focusBlockHint');
    $('.focus-legend').hidden = mode === 'selection' && !state.focusManualReview;
    $('#focus-pages').hidden = mode === 'selection' || (state.focusPage === 0 && !page.hasNext);
    $('#focus-page').textContent = t('pageNumber', { n: state.focusPage + 1 });
    $('#focus-previous').disabled = state.focusPage === 0;
    $('#focus-next').disabled = !page.hasNext;
    $('#focus-range').textContent = t('focusSelectedCount', { n: state.focusSelected.length });
    $('#focus-range').title = source && state.focusSelected.length ? focusRangeLabel(focusDraftFor(source)) : '';
  }
  for (const pane of state.panes) renderFocusCanvas(pane);
  positionFocusPicker();
}

function continueFocus() {
  const source = pickerSource();
  if (!source || state.focusPickerSource !== sourceValue(source) || state.focusPickerSnapshot !== source.content) {
    renderFocusPicker();
    return toast(t('focusStale'), true);
  }
  if (!state.focusSelected.length) return toast(t('chooseBlock'), true);
  state.focusDraft = focusDraftFor(source);
  state.focusStep = 2;
  renderFocusPicker();
  elements.focusAnnotation.focus({ preventScroll: true });
}

function returnToFocusRange() {
  state.focusStep = 1;
  state.focusManualReview = elements.focusMode.value === 'selection';
  renderFocusPicker();
  elements.focusMode.focus({ preventScroll: true });
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
}

let contextTimer;
function scheduleContextRender() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(renderContext, 120);
}

function setFocus() {
  if (state.focusStep !== 2 || !state.focusDraft) return;
  const draft = { ...state.focusDraft, role: elements.focusRole.value, annotation: elements.focusAnnotation.value.trim() };
  const source = focusSources().find((item) => item.kind === draft.sourceKind && item.id === draft.sourceId);
  const problem = focusProblem(draft) || focusConflict(draft);
  if (problem) { renderFocusPicker(); return toast(problem, true); }
  if (!source || !supportsContext(source.type, 'focus')) return toast(t('chooseBlock'), true);
  if (draft.role === 'target' && (source.kind !== 'tab' || !source.editable)) return toast(t('cannotEdit'), true);
  if (!draft.annotation || draft.annotation.length > 2000) {
    elements.focusAnnotation.focus();
    return toast(t(draft.annotation ? 'focusNoteTooLong' : 'focusAnnotationRequired'), true);
  }
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
  if (!tab?.document) return toast(t('openFirst'), true);
  if (!tab.document.editable) return toast(t('cannotEdit'), true);
  const focuses = relevantFocuses(tab);
  if (!prompt && !focuses.some((focus) => focus.role === 'target' && focus.annotation?.trim())) { elements.prompt.focus(); return toast(t('enterRequest'), true); }
  const problem = contextProblem(tab);
  if (problem) return toast(problem, true);
  const referenceBlocks = focuses.filter((focus) => focus.role === 'reference').map(focusText);
  const references = referenceBlocks.length ? referenceBlocks : state.references.map((reference) => reference.content);
  if (!references.length) {
    for (const id of state.attentions) {
      const source = findTab(id)?.tab;
      if (source?.document && source.id !== tab.id) references.push(source.content);
    }
  }
  const referenceText = references.length ? references.join('\n\n') : null;
  let after;
  try {
    after = suggest({ content: tab.content, prompt, type: tab.document.type, focuses, referenceText, language: state.language });
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
    state.contextRevision !== suggestion.contextRevision || contextProblem(tab)) return;
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
  const path = event.composedPath();
  if (elements.focusPicker.hidden || path.includes(elements.focusPicker) || path.includes(focusAnchor)) return;
  const sourcePane = findTab(state.focusTabId)?.pane.element;
  if (!path.includes(sourcePane)) closeFocusPicker();
}, true);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeFocusPicker(true);
});
window.addEventListener('resize', positionFocusPicker);
window.addEventListener('scroll', positionFocusPicker, true);
new ResizeObserver(positionFocusPicker).observe(elements.focusPicker);
// Prevent a drop outside the editor from navigating away from unsaved work.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (event) => {
  if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
});
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => setView(button.dataset.view));
$('#language-select').addEventListener('change', (event) => { state.language = event.target.value; updatePreferences(); });
for (const input of document.querySelectorAll('input[name="theme"]')) {
  input.addEventListener('change', () => { if (input.checked) { state.theme = input.value; updatePreferences(); } });
}
elements.focusSource.addEventListener('change', renderFocusPicker);
elements.focusMode.addEventListener('change', renderFocusPicker);
elements.focusRole.addEventListener('change', renderFocusPicker);
elements.focusAnnotation.addEventListener('input', renderFocusPicker);
elements.focusContinue.addEventListener('click', continueFocus);
$('#focus-back').addEventListener('click', returnToFocusRange);
for (const id of ['#focus-close', '#focus-cancel']) $(id).addEventListener('click', () => closeFocusPicker(true));
$('#focus-previous').addEventListener('click', () => { if (state.focusPage > 0) { state.focusPage -= 1; renderFocusPicker(); } });
$('#focus-next').addEventListener('click', () => { if (state.focusHasNext) { state.focusPage += 1; renderFocusPicker(); } });
elements.setFocus.addEventListener('click', setFocus);
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
