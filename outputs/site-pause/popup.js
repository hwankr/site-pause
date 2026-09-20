import { request, observeState, showMessage } from './shared-ui.js';
import { observeUsage, formatDuration } from './usage-ui.js';
import { SHORT_FORM_FEATURES, blockingRuleCount } from './core.js';
import { siteName } from './site-labels.js';
import { createSiteIcon } from './site-icons.js';

const byId = id => document.getElementById(id);
const toggle = byId('toggle-button');
const message = byId('message');
let currentState = null;
let busy = false;
const USAGE_COLORS = ['#6879d9', '#8eada2', '#d4ab90'];

function siteRow({ value, page, feature }) {
  const row = document.createElement('div');
  row.className = 'site-row';
  const host = feature?.site || (page ? new URL(value).hostname : value);
  const emblem = createSiteIcon(feature ? host : value);
  const domain = document.createElement('span');
  domain.className = 'site-domain';
  domain.textContent = feature || page ? value : siteName(value);
  domain.title = value;
  row.append(emblem, domain);
  return row;
}

function render(state) {
  currentState = state;
  const blockRules = [
    ...SHORT_FORM_FEATURES.filter(({ key }) => state[key]).map((feature) => ({ value: feature.label, feature })),
    ...state.sites.map((value) => ({ value, page: false })),
    ...(state.blockedPages || []).map((value) => ({ value, page: true }))
  ];
  const exceptionCount = (state.allowedSites || []).length + (state.allowedPages || []).length;
  document.body.dataset.enabled = String(state.enabled);
  byId('status-label').textContent = state.enabled ? '차단 중' : '차단 꺼짐';
  byId('toggle-label').textContent = busy ? '변경 중' : state.enabled ? '차단 끄기' : '차단 켜기';
  toggle.title = byId('toggle-label').textContent;
  toggle.setAttribute('aria-checked', String(state.enabled));
  toggle.disabled = busy || (!state.enabled && !blockRules.length);
  byId('site-count').textContent = String(blockingRuleCount(state));
  byId('site-list').replaceChildren(...blockRules.slice(0, 2).map(siteRow));
  byId('empty-hint').hidden = blockRules.length !== 0;
  byId('edit-label').textContent = blockRules.length || exceptionCount ? '편집' : '추가';
  byId('more-button').hidden = blockRules.length <= 2;
  byId('more-button').textContent = `전체 보기 · ${blockRules.length}개`;
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
  byId('usage-total').replaceChildren(...formatDuration(state.totalMs).split(/(\d+)/).filter(Boolean).map(part => {
    const span = document.createElement('span');
    span.className = /^\d+$/.test(part) ? 'usage-number' : 'usage-unit';
    span.textContent = part;
    return span;
  }));
  byId('usage-empty').hidden = state.sites.length > 0;
  const topSites = [...state.sites].sort((a, b) => b.ms - a.ms || a.host.localeCompare(b.host)).slice(0, 3);
  const segments = topSites.map((site, index) => ({...site, color: USAGE_COLORS[index]}));
  const remaining = Math.max(0, state.totalMs - topSites.reduce((sum, site) => sum + site.ms, 0));
  if (remaining > 0) segments.push({host: '그 외', ms: remaining, color: '#e4e4e0'});
  byId('usage-distribution').hidden = state.totalMs <= 0;
  byId('usage-distribution').replaceChildren(...segments.map(segment => {
    const bar = document.createElement('span');
    bar.style.flexGrow = String(segment.ms);
    bar.style.backgroundColor = segment.color;
    bar.title = `${siteName(segment.host)} · ${formatDuration(segment.ms)}`;
    return bar;
  }));
  byId('usage-list').replaceChildren(...topSites.map(site => {
    const row = document.createElement('li');
    const host = document.createElement('span');
    host.className = 'popup-usage-site';
    host.title = site.host;
    const name = document.createElement('span');
    name.className = 'popup-usage-name';
    name.textContent = siteName(site.host);
    host.append(createSiteIcon(site.host), name);
    const time = document.createElement('span');
    time.textContent = formatDuration(site.ms);
    row.append(host, time);
    return row;
  }));
  byId('usage-error').hidden = true;
  byId('reload-extension').hidden = true;
}, (text, code) => {
  document.querySelector('.popup-usage').setAttribute('aria-busy', 'false');
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
