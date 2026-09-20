// Served only by the local preview server. The packaged extension never loads
// this adapter, and demo settings never touch Chrome extension storage.
import {normalizeSites, normalizeRuleLists, hasBlockingRules} from '/core.js';
import {localDateKey, normalizeUsage, summarizeUsage} from '/usage-core.js';
import {filterUsageData} from '/usage-filter.js';

const PREVIEW_KEY = 'site-pause-preview-v1';
const RULES_KEY = 'sitePause';
const USAGE_KEY = 'sitePauseUsage';
const CAPABILITIES = Object.freeze({usage: true, usageFilters: true, shortForm: true});
const listeners = new Set();
const copy = value => structuredClone(value);

function demoState() {
  const days = {};
  const today = new Date();
  today.setHours(12, 0, 0, 0);
  for (let offset = 0; offset < 30; offset++) {
    const day = new Date(today);
    day.setDate(day.getDate() - offset);
    // Relative dates keep the preview useful on any day, while the arithmetic
    // makes the same day's demo deterministic across reloads and open tabs.
    const minutes = {
      'youtube.com': 42 + (offset * 17) % 65,
      'github.com': 34 + (offset * 11) % 48,
      'instagram.com': 18 + (offset * 7) % 38,
      'x.com': 12 + (offset * 13) % 29,
      'notion.so': 24 + (offset * 5) % 41,
      'music.youtube.com': 6 + (offset * 19) % 26
    };
    days[localDateKey(day.getTime())] = Object.fromEntries(
      Object.entries(minutes).map(([host, value]) => [host, value * 60000])
    );
  }
  return {
    [RULES_KEY]: {
      enabled: true,
      ...normalizeRuleLists({
        sites: ['x.com'],
        allowedSites: ['music.youtube.com'],
        youtubeShorts: true,
        instagramReels: true
      })
    },
    [USAGE_KEY]: {enabled: true, days}
  };
}

function normalizeStore(value) {
  if (!value || typeof value !== 'object' || !value[RULES_KEY] || !value[USAGE_KEY]) {
    throw new Error('미리보기 데이터 형식을 확인해 주세요.');
  }
  const lists = normalizeRuleLists(value[RULES_KEY]);
  return {
    [RULES_KEY]: {enabled: value[RULES_KEY].enabled === true && hasBlockingRules(lists), ...lists},
    [USAGE_KEY]: normalizeUsage(value[USAGE_KEY])
  };
}

function readStore() {
  try {
    const saved = localStorage.getItem(PREVIEW_KEY);
    if (saved) return normalizeStore(JSON.parse(saved));
  } catch {
    // A stale or manually edited demo must not leave the design preview blank.
  }
  const initial = demoState();
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(initial));
  return initial;
}

let snapshot = readStore();

function notifyChanges(previous, next) {
  const changes = {};
  for (const key of [RULES_KEY, USAGE_KEY]) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      changes[key] = {oldValue: copy(previous[key]), newValue: copy(next[key])};
    }
  }
  if (!Object.keys(changes).length) return;
  queueMicrotask(() => {
    for (const listener of listeners) {
      try { listener(copy(changes), 'local'); }
      catch (error) { console.error('Site Pause preview listener:', error); }
    }
  });
}

function writeStore(next) {
  const previous = snapshot;
  localStorage.setItem(PREVIEW_KEY, JSON.stringify(next));
  snapshot = copy(next);
  notifyChanges(previous, next);
}

window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || (event.key !== PREVIEW_KEY && event.key !== null)) return;
  const previous = snapshot;
  snapshot = readStore();
  notifyChanges(previous, snapshot);
});

function handleMessage(message) {
  const store = readStore();
  const state = store[RULES_KEY];
  const type = message?.type;
  let result;
  if (['GET_USAGE', 'SET_USAGE_ENABLED', 'CLEAR_USAGE'].includes(type)) {
    const days = message.days ?? 1;
    const filter = message.filter ?? 'all';
    if (![1, 7, 30].includes(days)) throw new Error('조회 기간을 확인해 주세요.');
    if (!['all', 'blocked'].includes(filter)) throw new Error('사이트 필터를 확인해 주세요.');
    if (type === 'SET_USAGE_ENABLED' && typeof message.enabled !== 'boolean') {
      throw new Error('사용 시간 기록 상태를 확인해 주세요.');
    }
    if (type === 'SET_USAGE_ENABLED') store[USAGE_KEY].enabled = message.enabled;
    if (type === 'CLEAR_USAGE') store[USAGE_KEY].days = {};
    if (type !== 'GET_USAGE') writeStore(store);
    const now = Date.now();
    result = {...summarizeUsage(filterUsageData(store[USAGE_KEY], filter, state, now), days, now), filter};
  } else if (type === 'GET_STATE') {
    result = state;
  } else if (type === 'SET_ENABLED') {
    if (typeof message.enabled !== 'boolean') throw new Error('차단 상태를 확인해 주세요.');
    if (message.enabled && !hasBlockingRules(state)) {
      throw new Error('차단할 사이트·페이지를 추가하거나 쇼츠·릴스 차단을 켜 주세요.');
    }
    result = {...state, enabled: message.enabled};
    writeStore({...store, [RULES_KEY]: result});
  } else if (type === 'SAVE_SITES' || type === 'SAVE_RULES') {
    const lists = normalizeRuleLists(type === 'SAVE_SITES'
      ? {...state, sites: normalizeSites(message.sites)}
      : {...state, ...message});
    result = {enabled: state.enabled && hasBlockingRules(lists), ...lists};
    writeStore({...store, [RULES_KEY]: result});
  } else {
    throw new Error('지원하지 않는 요청이에요.');
  }
  return {ok: true, state: copy(result), capabilities: CAPABILITIES};
}

const runtime = {
  id: 'site-pause-local-preview',
  async sendMessage(message) {
    try { return handleMessage(message); }
    catch (error) {
      return {ok: false, error: error.message || '미리보기 설정을 적용하지 못했어요.', capabilities: CAPABILITIES};
    }
  },
  async openOptionsPage() { window.location.assign('/options.html'); },
  reload() { window.location.reload(); },
  getURL(path = '') { return new URL(path.replace(/^\/+/, ''), `${window.location.origin}/`).href; }
};

const storage = {
  onChanged: {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); }
  },
  local: {
    async get(keys = null) {
      const store = readStore();
      if (keys === null) return copy(store);
      const requested = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result = {};
      for (const key of requested) {
        if (Object.hasOwn(store, key)) result[key] = copy(store[key]);
        else if (keys && !Array.isArray(keys) && typeof keys === 'object') result[key] = copy(keys[key]);
      }
      return result;
    },
    async set(values) {
      const store = readStore();
      for (const key of Object.keys(values)) {
        if (![RULES_KEY, USAGE_KEY].includes(key)) throw new Error('지원하지 않는 미리보기 저장 키예요.');
      }
      writeStore(normalizeStore({...store, ...values}));
    }
  }
};

// Chrome exposes some native window.chrome properties on ordinary web pages;
// supply only the extension APIs needed by the UI without replacing those.
const chromeApi = window.chrome || {};
chromeApi.runtime = runtime;
chromeApi.storage = storage;
window.chrome = chromeApi;
window.sitePausePreview = Object.freeze({
  reset() {
    const next = demoState();
    writeStore(next);
    return copy(next);
  }
});
