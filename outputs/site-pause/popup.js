import { request, observeState, showMessage } from './shared-ui.js';

const byId = id => document.getElementById(id);
const toggle = byId('toggle-button');
const message = byId('message');
let currentState = null;
let busy = false;

function siteRow(site) {
  const row = document.createElement('div');
  row.className = 'site-row';
  const avatar = document.createElement('span');
  avatar.className = 'site-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = site[0].toUpperCase();
  const domain = document.createElement('span');
  domain.className = 'site-domain';
  domain.textContent = site;
  domain.title = site;
  row.append(avatar, domain);
  return row;
}

function render(state) {
  currentState = state;
  document.body.dataset.enabled = String(state.enabled);
  byId('status-label').textContent = state.enabled ? '차단 중' : '꺼짐';
  byId('toggle-label').textContent = busy ? '변경 중' : state.enabled ? '차단 끄기' : '차단 켜기';
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.disabled = busy || (!state.enabled && !state.sites.length);
  byId('site-count').textContent = String(state.sites.length);
  byId('site-list').replaceChildren(...state.sites.slice(0, 3).map(siteRow));
  byId('empty-hint').hidden = state.sites.length !== 0;
  byId('edit-label').textContent = state.sites.length ? '편집' : '추가';
  byId('more-button').hidden = state.sites.length <= 3;
  byId('more-button').textContent = `전체 보기 · ${state.sites.length}개`;
}

const observer = observeState(render, text => showMessage(message, text));
toggle.addEventListener('click', async () => {
  if (!currentState || busy) return;
  const enabled = !currentState.enabled;
  busy = true;
  render(currentState);
  showMessage(message, '');
  try { observer.accept(await request('SET_ENABLED', { enabled })); }
  catch (error) { showMessage(message, error.message); }
  finally {
    busy = false;
    if (currentState) render(currentState);
  }
});

async function openSettings() {
  try { await chrome.runtime.openOptionsPage(); }
  catch (error) { showMessage(message, error.message); }
}
['settings-button', 'edit-button', 'more-button'].forEach(id => byId(id).addEventListener('click', openSettings));
