import { request, observeState, showMessage } from './shared-ui.js';

const byId = (id) => document.getElementById(id);
const input = byId('sites-input');
const save = byId('save-button');
const toggle = byId('toggle-button');
const quickButtons = [...document.querySelectorAll('[data-site]')];
let currentState = null;
let initialized = false;
let saving = false;
let toggling = false;
let savedText = '';

function updateDraft() {
  const dirty = input.value !== savedText;
  byId('draft-status').textContent = dirty ? '아직 저장하지 않은 변경 사항이 있어요.' : '저장한 목록만 적용돼요.';
  byId('draft-status').classList.toggle('is-dirty', dirty);
}

function render(state) {
  currentState = state;
  document.body.dataset.enabled = String(state.enabled);
  const replaceDraft = !initialized || input.value === savedText;
  savedText = state.sites.join('\n');
  if (replaceDraft) input.value = savedText;
  if (!initialized) {
    input.disabled = false;
    quickButtons.forEach((button) => { button.disabled = false; });
    initialized = true;
  }
  updateDraft();
  byId('saved-count').textContent = `${state.sites.length}개 저장됨`;
  byId('control-description').textContent = state.enabled
    ? `차단 중 · 저장한 ${state.sites.length}개 사이트는 잠시 닫아 둘게요.`
    : state.sites.length ? '차단 꺼짐 · 지금은 모든 사이트를 이용할 수 있어요.' : '차단할 사이트를 먼저 추가하고 목록을 저장해 주세요.';
  byId('toggle-label').textContent = toggling ? '변경하는 중…' : state.enabled ? '차단 끄기 · ON' : '차단 켜기 · OFF';
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.disabled = saving || toggling || (!state.enabled && !state.sites.length);
  save.disabled = saving || toggling;
  save.textContent = saving ? '저장하는 중…' : '목록 저장';
  byId('activation-note').hidden = state.enabled;
}

const observer = observeState(render, (text) => showMessage(byId('save-message'), text));
input.addEventListener('input', () => {
  updateDraft();
  showMessage(byId('save-message'), '');
});

quickButtons.forEach((button) => button.addEventListener('click', () => {
  const site = button.dataset.site;
  const entries = input.value.split(/[\n,]+/).map((value) => value.trim()).filter(Boolean);
  const hasSite = entries.some((value) => {
    try { return new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`).hostname.replace(/^www\./, '') === site; }
    catch { return value === site; }
  });
  if (!hasSite) input.value = `${input.value.trim()}${input.value.trim() ? '\n' : ''}${site}`;
  updateDraft();
  showMessage(byId('save-message'), hasSite ? '이미 목록에 있는 사이트예요.' : '추가했어요. 목록을 저장하면 적용됩니다.', 'info');
  input.focus();
}));

save.addEventListener('click', async () => {
  if (!currentState || saving || toggling) return;
  const draft = input.value;
  saving = true;
  render(currentState);
  showMessage(byId('save-message'), '');
  try {
    const state = await request('SAVE_SITES', { sites: draft });
    savedText = state.sites.join('\n');
    if (input.value === draft) input.value = savedText;
    observer.accept(state);
    updateDraft();
    showMessage(byId('save-message'), state.enabled ? '저장했어요. 변경한 목록으로 바로 차단합니다.' : '목록을 저장했어요.', 'success');
  } catch (error) {
    showMessage(byId('save-message'), error.message);
  } finally {
    saving = false;
    if (currentState) render(currentState);
  }
});

toggle.addEventListener('click', async () => {
  if (!currentState || toggling || saving) return;
  const enabled = !currentState.enabled;
  toggling = true;
  render(currentState);
  showMessage(byId('toggle-message'), '');
  try { observer.accept(await request('SET_ENABLED', { enabled })); }
  catch (error) { showMessage(byId('toggle-message'), error.message); }
  finally {
    toggling = false;
    if (currentState) render(currentState);
  }
});
