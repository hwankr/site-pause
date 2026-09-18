import { normalizeSites } from './core.js';
import { request, observeState, showMessage } from './shared-ui.js';

const byId = (id) => document.getElementById(id);
const input = byId('site-input');
const list = byId('site-list');
const add = byId('add-button');
const save = byId('save-button');
const toggle = byId('toggle-button');
const quickButtons = [...document.querySelectorAll('.quick-buttons [data-site]')];
let currentState = null;
let initialized = false;
let saving = false;
let toggling = false;
let savedSites = [];
let draftSites = [];
let messageTimer;

const listsMatch = (left, right) => left.length === right.length && left.every((site, index) => site === right[index]);
const hasDraft = () => input.value.trim() !== '' || !listsMatch(draftSites, savedSites);

function saveMessage(text, kind = 'error') {
  clearTimeout(messageTimer);
  showMessage(byId('save-message'), text, kind);
  if (text && kind !== 'error') {
    messageTimer = setTimeout(() => showMessage(byId('save-message'), ''), 2500);
  }
}

function updateControls() {
  const busy = saving || toggling;
  const dirty = hasDraft();
  input.disabled = !initialized || busy;
  add.disabled = !initialized || busy || !input.value.trim();
  save.disabled = !initialized || busy || !dirty;
  save.textContent = saving ? '저장 중' : '저장';
  byId('draft-status').hidden = !dirty;
  byId('draft-status').classList.toggle('is-dirty', dirty);
  toggle.disabled = !initialized || busy || (!currentState.enabled && !currentState.sites.length);
  quickButtons.forEach((button) => {
    button.disabled = !initialized || busy || draftSites.includes(button.dataset.site);
  });
  list.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}

function renderList() {
  list.replaceChildren(...draftSites.map((site) => {
    const row = document.createElement('li');
    row.className = 'site-row';
    const avatar = document.createElement('span');
    avatar.className = 'site-avatar';
    avatar.textContent = site.charAt(0).toUpperCase();
    avatar.setAttribute('aria-hidden', 'true');
    const domain = document.createElement('span');
    domain.className = 'site-domain';
    domain.textContent = site;
    domain.title = site;
    const remove = document.createElement('button');
    remove.className = 'remove-button icon-button';
    remove.type = 'button';
    remove.dataset.site = site;
    remove.setAttribute('aria-label', `${site} 삭제`);
    remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    row.append(avatar, domain, remove);
    return row;
  }));
  byId('empty-state').hidden = draftSites.length > 0;
  byId('saved-count').textContent = String(draftSites.length);
  byId('saved-count').setAttribute('aria-label', `차단 목록 ${draftSites.length}개`);
}

function render(state) {
  const preserveDraft = initialized && hasDraft();
  currentState = state;
  savedSites = [...state.sites];
  if (!preserveDraft) {
    draftSites = [...savedSites];
    renderList();
  }
  initialized = true;
  document.body.dataset.enabled = String(state.enabled);
  byId('toggle-label').textContent = toggling ? '변경 중' : state.enabled ? '켜짐' : '꺼짐';
  toggle.setAttribute('aria-checked', String(state.enabled));
  updateControls();
}

function stageSites(value, clearInput = false) {
  try {
    const entries = normalizeSites(value);
    if (!entries.length) return false;
    const nextSites = normalizeSites([...draftSites, ...entries]);
    const duplicatesOnly = listsMatch(nextSites, draftSites);
    draftSites = nextSites;
    if (clearInput) input.value = '';
    input.removeAttribute('aria-invalid');
    renderList();
    updateControls();
    saveMessage(duplicatesOnly ? '이미 추가된 사이트' : '', 'info');
    return true;
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    saveMessage(error.message);
    input.focus();
    return false;
  }
}

const observer = observeState(render, (text) => saveMessage(text));

input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  updateControls();
  saveMessage('');
});

input.addEventListener('paste', (event) => {
  const text = event.clipboardData?.getData('text');
  if (!text || !/[\r\n]/.test(text)) return;
  event.preventDefault();
  input.setRangeText(text.replace(/[\r\n]+/g, ' '), input.selectionStart, input.selectionEnd, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

byId('add-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!initialized || saving || toggling) return;
  stageSites(input.value, true);
  input.focus();
});

quickButtons.forEach((button) => button.addEventListener('click', () => {
  if (!initialized || saving || toggling) return;
  stageSites(button.dataset.site);
}));

list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-site]');
  if (!button || saving || toggling) return;
  const index = draftSites.indexOf(button.dataset.site);
  draftSites = draftSites.filter((site) => site !== button.dataset.site);
  renderList();
  updateControls();
  saveMessage('');
  const remainingButtons = [...list.querySelectorAll('button')];
  (remainingButtons[Math.min(index, remainingButtons.length - 1)] || input).focus();
});

save.addEventListener('click', async () => {
  if (!currentState || saving || toggling) return;
  if (input.value.trim() && !stageSites(input.value, true)) return;
  const submittedSites = [...draftSites];
  saving = true;
  updateControls();
  saveMessage('');
  try {
    const state = await request('SAVE_SITES', { sites: submittedSites });
    savedSites = [...state.sites];
    draftSites = [...state.sites];
    renderList();
    observer.accept(state);
    saveMessage('저장 완료', 'success');
  } catch (error) {
    saveMessage(error.message);
  } finally {
    saving = false;
    updateControls();
  }
});

toggle.addEventListener('click', async () => {
  if (!currentState || toggling || saving) return;
  const enabled = !currentState.enabled;
  toggling = true;
  render(currentState);
  showMessage(byId('toggle-message'), '');
  try {
    observer.accept(await request('SET_ENABLED', { enabled }));
  } catch (error) {
    showMessage(byId('toggle-message'), error.message);
  } finally {
    toggling = false;
    render(currentState);
  }
});
