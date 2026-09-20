import { MAX_SITES, SHORT_FORM_FEATURES, normalizeSites, normalizePages, normalizeRuleLists, hasBlockingRules, matchesSite, matchesShortForm } from './core.js';
import { request, observeState, showMessage } from './shared-ui.js';
import { siteName } from './site-labels.js';
import { createSiteIcon } from './site-icons.js';

const byId = (id) => document.getElementById(id);
const input = byId('site-input');
const form = byId('add-form');
const actionInputs = [...document.querySelectorAll('input[name="rule-action"]')];
const scopeButton = byId('scope-button');
const scopeMenu = byId('scope-menu');
const scopePicker = scopeButton.closest('.scope-picker');
const scopeOptions = [...scopeMenu.querySelectorAll('[data-scope]')];
const list = byId('site-list');
const add = byId('add-button');
const save = byId('save-button');
const toggle = byId('toggle-button');
const quickButtons = [...document.querySelectorAll('.quick-buttons [data-site]')];
const shortFormInputs = [...document.querySelectorAll('input[data-short-form]')];
document.querySelectorAll('[data-service-icon]').forEach(element => {
  element.replaceWith(createSiteIcon(element.dataset.serviceIcon));
});
let currentState = null;
let initialized = false;
let saving = false;
let toggling = false;
let selectedScope = 'site';
const ruleKinds = {
  sites: { label: '사이트 차단', page: false, allow: false },
  blockedPages: { label: '페이지 차단', page: true, allow: false },
  allowedSites: { label: '사이트 허용', page: false, allow: true },
  allowedPages: { label: '페이지 허용', page: true, allow: true }
};
const copyRules = (state) => ({
  ...Object.fromEntries(Object.keys(ruleKinds).map((kind) => [kind, [...(state[kind] || [])]])),
  ...Object.fromEntries(SHORT_FORM_FEATURES.map(({ key }) => [key, state[key] === true]))
});
const ruleEntries = (rules) => Object.keys(ruleKinds).flatMap((kind) => rules[kind].map((value) => ({ kind, value })));
let savedRules = copyRules({});
let draftRules = copyRules({});
let messageTimer;

const listsMatch = (left, right) => left.length === right.length && left.every((site, index) => site === right[index]);
const hasDraft = () => input.value.trim() !== '' || Object.keys(ruleKinds).some((kind) => !listsMatch(draftRules[kind], savedRules[kind]))
  || SHORT_FORM_FEATURES.some(({ key }) => draftRules[key] !== savedRules[key]);
const selectedAction = () => actionInputs.find((control) => control.checked).value;
const selectedKind = () => selectedAction() === 'allow'
  ? (selectedScope === 'page' ? 'allowedPages' : 'allowedSites')
  : (selectedScope === 'page' ? 'blockedPages' : 'sites');
const entryKey = (kind, value) => `${kind}\n${value}`;

function updateComposer() {
  const kind = ruleKinds[selectedKind()];
  form.dataset.action = selectedAction();
  form.dataset.scope = selectedScope;
  input.placeholder = kind.page ? '페이지 주소' : kind.allow ? 'music.youtube.com' : 'youtube.com';
  input.setAttribute('aria-label', `${kind.allow ? '허용' : '차단'}할 ${kind.page ? '페이지' : '사이트'} 주소`);
}

function closeScopeMenu(returnFocus = false) {
  scopeMenu.hidden = true;
  scopeButton.setAttribute('aria-expanded', 'false');
  if (returnFocus && !scopeButton.disabled) scopeButton.focus();
}

function openScopeMenu() {
  if (!initialized || saving || toggling) return;
  scopeMenu.hidden = false;
  scopeButton.setAttribute('aria-expanded', 'true');
  scopeOptions.find((option) => option.dataset.scope === selectedScope).focus();
}

function selectScope(scope) {
  selectedScope = scope;
  const selected = scopeOptions.find((option) => option.dataset.scope === scope);
  const label = selected.querySelector('span').textContent;
  byId('scope-label').textContent = label;
  scopeButton.setAttribute('aria-label', `적용 범위: ${label}`);
  scopeOptions.forEach((option) => option.setAttribute('aria-selected', String(option === selected)));
  updateComposer();
  input.removeAttribute('aria-invalid');
  saveMessage('');
  closeScopeMenu(true);
}

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
  actionInputs.forEach((control) => { control.disabled = !initialized || busy; });
  scopeButton.disabled = !initialized || busy;
  scopeOptions.forEach((option) => { option.disabled = !initialized || busy; });
  if (!initialized || busy) closeScopeMenu();
  add.disabled = !initialized || busy || !input.value.trim();
  save.disabled = !initialized || busy || !dirty;
  save.textContent = saving ? '저장 중' : '저장';
  byId('draft-status').hidden = !dirty;
  byId('draft-status').classList.toggle('is-dirty', dirty);
  toggle.disabled = !initialized || busy || (!currentState.enabled && !hasBlockingRules(savedRules));
  shortFormInputs.forEach((control) => {
    control.checked = draftRules[control.dataset.shortForm];
    control.disabled = !initialized || busy;
  });
  renderShortFormNotices();
  quickButtons.forEach((button) => {
    const added = draftRules[button.dataset.ruleKind || 'sites'].includes(button.dataset.site);
    button.dataset.added = String(added);
    button.disabled = !initialized || busy || added;
  });
  list.querySelectorAll('button').forEach((button) => { button.disabled = busy; });
}

function renderShortFormNotices() {
  for (const feature of SHORT_FORM_FEATURES) {
    const notice = byId(`${feature.key}-notice`);
    let text = '';
    if (draftRules[feature.key]) {
      const fullSiteAllowed = matchesSite(`https://${feature.site}/`, draftRules.allowedSites);
      const featurePath = feature.key === 'youtubeShorts' ? 'shorts' : 'reels';
      const partialSiteAllowed = draftRules.allowedSites.some((site) => site.endsWith(`.${feature.site}`)
        && matchesShortForm(`https://${site}/${featurePath}/`, draftRules)?.key === feature.key);
      const fullSiteBlocked = matchesSite(`https://${feature.site}/`, draftRules.sites);
      if (fullSiteAllowed) text = `사이트 허용 규칙(${fullSiteAllowed})이 우선해 ${feature.label} 차단이 적용되지 않아요.`;
      else if (partialSiteAllowed) text = '허용한 하위 사이트에서는 쇼츠·릴스 차단이 적용되지 않아요.';
      else if (fullSiteBlocked) text = `사이트 전체 차단 규칙(${fullSiteBlocked})이 있어 일반 영상·게시물도 차단돼요.`;
    }
    notice.textContent = text;
    notice.hidden = !text;
  }
}

function renderList(newEntries = new Set()) {
  const entries = ruleEntries(draftRules);
  list.replaceChildren(...entries.map(({ kind, value }) => {
    const rule = ruleKinds[kind];
    const row = document.createElement('li');
    row.className = `site-row${newEntries.has(entryKey(kind, value)) ? ' is-new' : ''}`;
    const avatar = createSiteIcon(value);
    avatar.classList.add('site-avatar');
    const detail = document.createElement('span');
    detail.className = 'rule-detail';
    const badge = document.createElement('span');
    badge.className = `rule-kind${rule.allow ? ' is-allow' : ''}`;
    badge.textContent = rule.label;
    const domain = document.createElement('span');
    domain.className = 'site-domain';
    domain.textContent = rule.page ? value : siteName(value);
    domain.title = value;
    detail.append(badge, domain);
    const remove = document.createElement('button');
    remove.className = 'remove-button icon-button';
    remove.type = 'button';
    remove.dataset.site = value;
    remove.dataset.ruleKind = kind;
    remove.setAttribute('aria-label', `${rule.label} ${value} 삭제`);
    remove.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    row.append(avatar, detail, remove);
    return row;
  }));
  byId('empty-state').hidden = entries.length > 0;
  byId('saved-count').textContent = `${entries.length}개`;
  byId('saved-count').setAttribute('aria-label', `차단·허용 규칙 ${entries.length}개, 최대 ${MAX_SITES}개`);
}

function render(state) {
  const incomingRules = copyRules(state);
  let listChanged = !initialized;
  // A different tab can save while this page has a draft. Preserve fields the
  // user changed, while incorporating incoming edits to untouched fields.
  for (const kind of Object.keys(ruleKinds)) {
    if (!initialized || listsMatch(draftRules[kind], savedRules[kind])) {
      listChanged ||= !listsMatch(draftRules[kind], incomingRules[kind]);
      draftRules[kind] = [...incomingRules[kind]];
    }
  }
  for (const { key } of SHORT_FORM_FEATURES) {
    if (!initialized || draftRules[key] === savedRules[key]) draftRules[key] = incomingRules[key];
  }
  currentState = state;
  savedRules = incomingRules;
  if (listChanged) renderList();
  initialized = true;
  document.body.dataset.enabled = String(state.enabled);
  byId('toggle-label').textContent = toggling ? '변경 중' : state.enabled ? '차단 중' : '차단 꺼짐';
  toggle.title = state.enabled ? '차단 끄기' : '차단 켜기';
  toggle.setAttribute('aria-checked', String(state.enabled));
  updateControls();
}

function stageRules(value, clearInput = false, kind = selectedKind()) {
  try {
    const normalize = ruleKinds[kind].page ? normalizePages : normalizeSites;
    const entries = normalize(value);
    if (!entries.length) return false;
    const nextRules = normalizeRuleLists({ ...draftRules, [kind]: normalize([...draftRules[kind], ...entries]) });
    const duplicatesOnly = listsMatch(nextRules[kind], draftRules[kind]);
    const newEntries = new Set(nextRules[kind].filter((entry) => !draftRules[kind].includes(entry)).map((entry) => entryKey(kind, entry)));
    draftRules = nextRules;
    if (clearInput) input.value = '';
    input.removeAttribute('aria-invalid');
    renderList(newEntries);
    updateControls();
    saveMessage(duplicatesOnly ? '이미 추가된 규칙이에요.' : '', 'info');
    return true;
  } catch (error) {
    input.setAttribute('aria-invalid', 'true');
    saveMessage(error.message);
    input.focus();
    return false;
  }
}

const observer = observeState(render, (text) => saveMessage(text));
updateComposer();

actionInputs.forEach((control) => control.addEventListener('change', () => {
  updateComposer();
  input.removeAttribute('aria-invalid');
  saveMessage('');
}));

scopeButton.addEventListener('click', () => {
  if (scopeMenu.hidden) openScopeMenu();
  else closeScopeMenu(true);
});

scopeButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    openScopeMenu();
  } else if (event.key === 'Escape') {
    closeScopeMenu();
  }
});

scopeMenu.addEventListener('keydown', (event) => {
  const index = scopeOptions.indexOf(document.activeElement);
  let nextIndex;
  if (event.key === 'ArrowDown') nextIndex = (index + 1) % scopeOptions.length;
  else if (event.key === 'ArrowUp') nextIndex = (index + scopeOptions.length - 1) % scopeOptions.length;
  else if (event.key === 'Home') nextIndex = 0;
  else if (event.key === 'End') nextIndex = scopeOptions.length - 1;
  else if (event.key === 'Escape') {
    event.preventDefault();
    closeScopeMenu(true);
    return;
  } else if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
    event.preventDefault();
    selectScope(scopeOptions[index].dataset.scope);
    return;
  }
  if (nextIndex !== undefined) {
    event.preventDefault();
    scopeOptions[nextIndex].focus();
  }
});

scopeOptions.forEach((option) => option.addEventListener('click', () => {
  if (!initialized || saving || toggling) return;
  selectScope(option.dataset.scope);
}));

scopePicker.addEventListener('focusout', (event) => {
  if (!scopePicker.contains(event.relatedTarget)) closeScopeMenu();
});

document.addEventListener('pointerdown', (event) => {
  if (!scopePicker.contains(event.target)) closeScopeMenu();
});

input.addEventListener('input', () => {
  input.removeAttribute('aria-invalid');
  updateControls();
  saveMessage('');
});

shortFormInputs.forEach((control) => control.addEventListener('change', () => {
  if (!initialized || saving || toggling) return;
  draftRules = { ...draftRules, [control.dataset.shortForm]: control.checked };
  updateControls();
  saveMessage('');
}));

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
  stageRules(input.value, true);
  input.focus();
});

quickButtons.forEach((button) => button.addEventListener('click', () => {
  if (!initialized || saving || toggling) return;
  stageRules(button.dataset.site, false, button.dataset.ruleKind || 'sites');
}));

list.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-site]');
  if (!button || saving || toggling) return;
  const kind = button.dataset.ruleKind;
  const index = ruleEntries(draftRules).findIndex((entry) => entry.kind === kind && entry.value === button.dataset.site);
  draftRules = { ...draftRules, [kind]: draftRules[kind].filter((value) => value !== button.dataset.site) };
  renderList();
  updateControls();
  saveMessage('');
  const remainingButtons = [...list.querySelectorAll('button')];
  (remainingButtons[Math.min(index, remainingButtons.length - 1)] || input).focus();
});

save.addEventListener('click', async () => {
  if (!currentState || saving || toggling) return;
  if (input.value.trim() && !stageRules(input.value, true)) return;
  const submittedRules = copyRules(draftRules);
  saving = true;
  updateControls();
  saveMessage('');
  try {
    const state = await request('SAVE_RULES', submittedRules);
    savedRules = copyRules(state);
    draftRules = copyRules(state);
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
