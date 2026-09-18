import { request, observeState, showMessage, makeChip } from './shared-ui.js';

const byId = (id) => document.getElementById(id);
const toggle = byId('toggle-button');
const message = byId('message');
let currentState = null;
let busy = false;

function render(state) {
  currentState = state;
  document.body.dataset.enabled = String(state.enabled);
  byId('status-label').textContent = state.enabled ? '차단 중 · ON' : '차단 꺼짐 · OFF';
  byId('hero-description').textContent = state.enabled
    ? '딴길은 잠시 닫아 두었어요. 하던 공부를 이어가세요.'
    : state.sites.length ? '준비되면 차단을 켜고, 나만의 공부를 시작해요.' : '방해되는 사이트를 고르고, 집중할 때 켜세요.';
  byId('toggle-label').textContent = busy ? '변경하는 중…' : state.enabled ? '사이트 차단 끄기' : '사이트 차단 켜기';
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.disabled = busy || (!state.enabled && !state.sites.length);
  byId('activation-note').hidden = state.enabled;
  byId('site-count').textContent = String(state.sites.length);
  const chips = byId('site-chips');
  chips.replaceChildren(...state.sites.slice(0, 3).map(makeChip));
  if (state.sites.length > 3) chips.append(makeChip(`+${state.sites.length - 3}개`));
  byId('empty-hint').hidden = state.sites.length !== 0;
  byId('settings-button').firstChild.textContent = state.sites.length ? '편집 ' : '사이트 추가 ';
}

const observer = observeState(render, (text) => showMessage(message, text));
toggle.addEventListener('click', async () => {
  if (!currentState || busy) return;
  const enabled = !currentState.enabled;
  busy = true;
  render(currentState);
  showMessage(message, '');
  try {
    observer.accept(await request('SET_ENABLED', { enabled }));
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    busy = false;
    if (currentState) render(currentState);
  }
});
byId('settings-button').addEventListener('click', async () => {
  try { await chrome.runtime.openOptionsPage(); }
  catch (error) { showMessage(message, error.message); }
});
