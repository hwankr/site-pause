import { request, observeState, showMessage } from './shared-ui.js';
import { observeUsage, formatDuration } from './usage-ui.js';

const byId = id => document.getElementById(id);
const toggle = byId('toggle-button');
const message = byId('message');
let currentState = null;
let busy = false;

function siteRow({ value, page }) {
  const row = document.createElement('div');
  row.className = 'site-row';
  const avatar = document.createElement('span');
  avatar.className = 'site-avatar';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = (page ? new URL(value).hostname : value).replace(/^www\./, '')[0].toUpperCase();
  const detail = document.createElement('span');
  detail.className = 'rule-detail';
  const kind = document.createElement('span');
  kind.className = 'rule-kind';
  kind.textContent = page ? '페이지 차단' : '사이트 차단';
  const domain = document.createElement('span');
  domain.className = 'site-domain';
  domain.textContent = value;
  domain.title = value;
  detail.append(kind, domain);
  row.append(avatar, detail);
  return row;
}

function render(state) {
  currentState = state;
  const blockRules = [
    ...state.sites.map((value) => ({ value, page: false })),
    ...(state.blockedPages || []).map((value) => ({ value, page: true }))
  ];
  const exceptionCount = (state.allowedSites || []).length + (state.allowedPages || []).length;
  document.body.dataset.enabled = String(state.enabled);
  byId('status-label').textContent = state.enabled ? '차단 중' : '꺼짐';
  byId('toggle-label').textContent = busy ? '변경 중' : state.enabled ? '차단 끄기' : '차단 켜기';
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.disabled = busy || (!state.enabled && !blockRules.length);
  byId('site-count').textContent = String(blockRules.length);
  byId('exception-count').hidden = exceptionCount === 0;
  byId('exception-count').textContent = `허용 예외 ${exceptionCount}개`;
  byId('site-list').replaceChildren(...blockRules.slice(0, 2).map(siteRow));
  byId('empty-hint').hidden = blockRules.length !== 0;
  byId('edit-label').textContent = blockRules.length || exceptionCount ? '편집' : '추가';
  byId('more-button').hidden = blockRules.length <= 2 && !exceptionCount;
  byId('more-button').textContent = exceptionCount ? '차단·허용 목록 관리' : `전체 보기 · ${blockRules.length}개`;
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

observeUsage(state => {
  document.querySelector('.popup-usage').setAttribute('aria-busy', 'false');
  byId('usage-total').textContent = formatDuration(state.totalMs);
  byId('usage-status').textContent = state.enabled ? '기록 켜짐' : '기록 일시 중지';
  byId('usage-empty').hidden = state.sites.length > 0;
  byId('usage-list').replaceChildren(...[...state.sites].sort((a, b) => b.ms - a.ms || a.host.localeCompare(b.host)).slice(0, 3).map(site => {
    const row = document.createElement('li');
    const host = document.createElement('span');
    host.textContent = site.host;
    host.title = site.host;
    const time = document.createElement('span');
    time.textContent = formatDuration(site.ms);
    row.append(host, time);
    return row;
  }));
  byId('usage-error').hidden = true;
  byId('reload-extension').hidden = true;
}, (text, code) => {
  document.querySelector('.popup-usage').setAttribute('aria-busy', 'false');
  byId('usage-status').textContent = code === 'UPDATE_REQUIRED' ? '새로고침 필요' : '불러오기 실패';
  byId('usage-error').hidden = false;
  byId('usage-error-text').textContent = text;
  byId('reload-extension').hidden = code !== 'UPDATE_REQUIRED';
});
byId('reload-extension').addEventListener('click', async () => {
  byId('reload-extension').disabled = true;
  try { await chrome.runtime.reload(); }
  catch (error) {
    byId('usage-error-text').textContent = error.message || '새로고침하지 못했어요. 확장 프로그램 관리 화면에서 다시 시도해 주세요.';
  } finally { byId('reload-extension').disabled = false; }
});
