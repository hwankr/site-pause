import {normalizeSites, matchesSite, buildRules} from './core.js';

const KEY = 'sitePause';
const ORIGIN = chrome.runtime.getURL('');
let state;
let queue = Promise.resolve();

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error('Site Pause:', error));
  return result;
}

async function syncRules(next) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const desired = buildRules(next, ORIGIN);
  if (JSON.stringify(existing) === JSON.stringify(desired)) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(rule => rule.id), addRules: desired
  });
}

async function updateBadge() {
  await Promise.all([
    chrome.action.setBadgeText({text: state.enabled ? 'ON' : ''}),
    chrome.action.setBadgeBackgroundColor({color: '#3182f6'}),
    chrome.action.setTitle({title: state.enabled ? `잠깐, 집중 · ${state.sites.length}개 사이트 차단 중` : '잠깐, 집중 · 차단 꺼짐'})
  ]);
}

async function ensureLoaded() {
  if (state) return;
  const saved = (await chrome.storage.local.get(KEY))[KEY];
  let sites = [];
  try { sites = normalizeSites(saved?.sites ?? []); }
  catch (error) { console.error('Saved site list was invalid:', error); }
  const restored = {enabled: saved?.enabled === true && sites.length > 0, sites};
  await syncRules(restored);
  await chrome.storage.local.set({[KEY]: restored});
  state = restored;
  await updateBadge();
}

async function blockTab(tab) {
  if (!state.enabled || !Number.isInteger(tab?.id)) return;
  const address = tab.pendingUrl || tab.url;
  const site = matchesSite(address, state.sites);
  if (!site) return;
  const target = new URL(chrome.runtime.getURL('blocked.html'));
  target.searchParams.set('site', site);
  target.hash = new URLSearchParams({from: address}).toString();
  try { await chrome.tabs.update(tab.id, {url: target.href}); }
  catch {}
}

async function enforceAllTabs() {
  if (state.enabled) await Promise.all((await chrome.tabs.query({})).map(blockTab));
}

async function commit(next) {
  const previous = state;
  await syncRules(next);
  try { await chrome.storage.local.set({[KEY]: next}); }
  catch (error) { await syncRules(previous); throw error; }
  state = next;
  await updateBadge();
  await enforceAllTabs();
  return state;
}

function isInternalPage(sender, names) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id && names.includes(url.pathname);
  } catch { return false; }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const readAllowed = isInternalPage(sender, ['/popup.html', '/options.html', '/blocked.html']);
  const writeAllowed = isInternalPage(sender, ['/popup.html', '/options.html']);
  if (!readAllowed) { respond({ok: false, error: '확장 프로그램 화면에서 사용해 주세요.'}); return false; }
  enqueue(async () => {
    await ensureLoaded();
    if (message?.type === 'GET_STATE') return state;
    if (!writeAllowed) throw new Error('도구 모음의 확장 프로그램 버튼에서 설정을 바꿔 주세요.');
    if (message?.type === 'SET_ENABLED') {
      if (typeof message.enabled !== 'boolean') throw new Error('차단 상태를 확인해 주세요.');
      if (message.enabled && state.sites.length === 0) throw new Error('차단할 사이트를 먼저 추가해 주세요.');
      return commit({...state, enabled: message.enabled});
    }
    if (message?.type === 'SAVE_SITES') {
      const sites = normalizeSites(message.sites);
      return commit({enabled: state.enabled && sites.length > 0, sites});
    }
    throw new Error('지원하지 않는 요청이에요.');
  }).then(value => respond({ok: true, state: value}), error => respond({ok: false, error: error.message || '설정을 적용하지 못했어요. 다시 시도해 주세요.'}));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url && !changeInfo.status) return;
  enqueue(async () => {
    await ensureLoaded();
    if (state.enabled) {
      try { await blockTab(await chrome.tabs.get(tabId)); } catch {}
    }
  });
});
chrome.tabs.onActivated.addListener(({tabId}) => {
  enqueue(async () => {
    await ensureLoaded();
    if (state.enabled) {
      try { await blockTab(await chrome.tabs.get(tabId)); } catch {}
    }
  });
});

function restore() { enqueue(async () => { await ensureLoaded(); await enforceAllTabs(); }); }
chrome.runtime.onInstalled.addListener(restore);
chrome.runtime.onStartup.addListener(restore);
restore();
