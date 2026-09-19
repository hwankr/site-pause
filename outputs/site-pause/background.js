import {normalizeSites, normalizeRuleLists, hasBlockingRules, getBlockedRule, buildRules} from './core.js';
import {createUsageTracker} from './usage-tracker.js';

const usage = createUsageTracker(chrome);
usage.start();

const KEY = 'sitePause';
const CAPABILITIES = {usage: true, usageFilters: true};
const ORIGIN = chrome.runtime.getURL('');
let state;
let queue = Promise.resolve();
const supportedPatterns = new Set();

function enqueue(task) {
  const result = queue.then(task);
  queue = result.catch(error => console.error('Site Pause:', error));
  return result;
}

async function syncRules(next) {
  // Validate even while disabled so saving never leaves a rule that cannot be enabled.
  const candidates = buildRules({...next, enabled: true}, ORIGIN);
  for (const rule of candidates) {
    const regex = rule.condition.regexFilter;
    if (!regex || supportedPatterns.has(regex)) continue;
    const result = await chrome.declarativeNetRequest.isRegexSupported({regex, isCaseSensitive: true});
    if (!result.isSupported) throw new Error('페이지 주소가 너무 복잡해 적용할 수 없어요. 불필요한 주소 매개변수를 지우고 다시 저장해 주세요.');
    supportedPatterns.add(regex);
  }
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const desired = next.enabled ? candidates : [];
  if (JSON.stringify(existing) === JSON.stringify(desired)) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map(rule => rule.id), addRules: desired
  });
}

async function updateBadge() {
  await Promise.all([
    chrome.action.setBadgeText({text: state.enabled ? 'ON' : ''}),
    chrome.action.setBadgeBackgroundColor({color: '#3182f6'}),
    chrome.action.setTitle({title: state.enabled ? `잠깐, 집중 · ${state.sites.length + state.blockedPages.length}개 차단 규칙 적용 중` : '잠깐, 집중 · 차단 꺼짐'})
  ]);
}

async function ensureLoaded() {
  if (state) return;
  const saved = (await chrome.storage.local.get(KEY))[KEY];
  let lists = normalizeRuleLists({});
  try { lists = normalizeRuleLists(saved); }
  catch (error) { console.error('Saved site list was invalid:', error); }
  const restored = {enabled: saved?.enabled === true && hasBlockingRules(lists), ...lists};
  await syncRules(restored);
  await chrome.storage.local.set({[KEY]: restored});
  state = restored;
  await updateBadge();
}

async function blockTab(tab) {
  if (!state.enabled || !Number.isInteger(tab?.id)) return;
  const address = tab.pendingUrl || tab.url;
  if (!getBlockedRule(address, state)) return;
  const site = new URL(address).hostname;
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
  if (['GET_USAGE', 'SET_USAGE_ENABLED', 'CLEAR_USAGE'].includes(message?.type)) {
    if (!isInternalPage(sender, ['/popup.html', '/options.html', '/usage.html'])) {
      respond({ok: false, error: '확장 프로그램 화면에서 사용해 주세요.'});
      return false;
    }
    enqueue(async () => {
      await ensureLoaded();
      return usage.request(message, state);
    }).then(value => respond({ok: true, state: value}),
      error => respond({ok: false, error: error.message || '사용 시간을 불러오지 못했어요.'}));
    return true;
  }
  const readAllowed = isInternalPage(sender, ['/popup.html', '/options.html', '/blocked.html', '/usage.html']);
  const writeAllowed = isInternalPage(sender, ['/popup.html', '/options.html']);
  if (!readAllowed) { respond({ok: false, error: '확장 프로그램 화면에서 사용해 주세요.'}); return false; }
  enqueue(async () => {
    await ensureLoaded();
    if (message?.type === 'GET_STATE') return state;
    if (!writeAllowed) throw new Error('도구 모음의 확장 프로그램 버튼에서 설정을 바꿔 주세요.');
    if (message?.type === 'SET_ENABLED') {
      if (typeof message.enabled !== 'boolean') throw new Error('차단 상태를 확인해 주세요.');
      if (message.enabled && !hasBlockingRules(state)) throw new Error('차단할 사이트나 페이지를 먼저 추가해 주세요.');
      return commit({...state, enabled: message.enabled});
    }
    if (message?.type === 'SAVE_SITES') {
      const sites = normalizeSites(message.sites);
      const lists = normalizeRuleLists({...state, sites});
      return commit({enabled: state.enabled && hasBlockingRules(lists), ...lists});
    }
    if (message?.type === 'SAVE_RULES') {
      const lists = normalizeRuleLists(message);
      return commit({enabled: state.enabled && hasBlockingRules(lists), ...lists});
    }
    throw new Error('지원하지 않는 요청이에요.');
  }).then(value => respond({ok: true, state: value, capabilities: CAPABILITIES}),
    error => respond({ok: false, error: error.message || '설정을 적용하지 못했어요. 다시 시도해 주세요.', capabilities: CAPABILITIES}));
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

// YouTube and other apps can change pages without a new main-frame request.
chrome.webNavigation.onHistoryStateUpdated.addListener(({tabId, frameId}) => {
  if (frameId !== 0) return;
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
