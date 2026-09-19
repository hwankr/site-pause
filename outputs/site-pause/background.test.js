import test from 'node:test';
import assert from 'node:assert/strict';

let fixtureId = 0;

async function startBackground(saved, initialTabs = [], initialUsage) {
  const listeners = {};
  const event = (name) => ({addListener(listener) {
    const previous = listeners[name];
    listeners[name] = (...args) => { previous?.(...args); return listener(...args); };
  }});
  const tabs = new Map(initialTabs.map(tab => [tab.id, {...tab}]));
  const updates = [];
  let stored = structuredClone(saved);
  let storedUsage = structuredClone(initialUsage);
  let rules = [];
  let failNextStorageWrite = false;
  let regexSupported = true;
  globalThis.chrome = {
    runtime: {
      id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}`,
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup')
    },
    storage: {session: {async get() { return {}; }, async set() {}}, local: {
      async get() { return {sitePause: structuredClone(stored), sitePauseUsage: structuredClone(storedUsage)}; },
      async set(value) {
        if (failNextStorageWrite) { failNextStorageWrite = false; throw new Error('storage unavailable'); }
        if (value.sitePause) stored = structuredClone(value.sitePause);
        if (value.sitePauseUsage) storedUsage = structuredClone(value.sitePauseUsage);
      }
    }},
    declarativeNetRequest: {
      async isRegexSupported() { return {isSupported: regexSupported}; },
      async getDynamicRules() { return structuredClone(rules); },
      async updateDynamicRules({addRules}) { rules = structuredClone(addRules); }
    },
    action: {
      async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {}
    },
    tabs: {
      onUpdated: event('updated'), onActivated: event('activated'),
      onRemoved: event('removed'), onReplaced: event('replaced'),
      async query() { return [...tabs.values()]; },
      async get(id) { return tabs.get(id); },
      async update(id, value) { updates.push({id, ...value}); Object.assign(tabs.get(id), value); }
    },
    webNavigation: {onHistoryStateUpdated: event('history')},
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: event('focus'), onRemoved: event('windowRemoved'),
      async getLastFocused() { return {focused: false}; }
    },
    idle: {setDetectionInterval() {}, async queryState() { return 'active'; }, onStateChanged: event('idle')},
    alarms: {async get() { return {}; }, async create() {}, onAlarm: event('alarm')}
  };
  const request = (message, page = 'options.html') => new Promise(resolve => {
    listeners.message(message, {id: 'test-extension', url: `chrome-extension://test-extension/${page}`}, resolve);
  });
  await import(`./background.js?test=${++fixtureId}`);
  const initial = await request({type: 'GET_STATE'});
  assert.equal(initial.ok, true);
  return {
    initial: initial.state, request, updates, tabs, listeners,
    stored: () => structuredClone(stored), rules: () => structuredClone(rules),
    failStorageWrite: () => { failNextStorageWrite = true; },
    rejectRegex: () => { regexSupported = false; }
  };
}

test('background migrates old settings and enforces the existing block list', async () => {
  const fixture = await startBackground({enabled: true, sites: ['youtube.com']}, [
    {id: 1, url: 'https://www.youtube.com/'},
    {id: 2, url: 'https://example.com/'}
  ]);
  assert.deepEqual(fixture.initial, {
    enabled: true, sites: ['youtube.com'], blockedPages: [], allowedSites: [], allowedPages: []
  });
  assert.deepEqual(fixture.updates.map(tab => tab.id), [1]);
  assert.equal(fixture.stored().enabled, true);
});

test('saving exceptions while enabled preserves allowed open tabs', async () => {
  const fixture = await startBackground({enabled: false, sites: ['youtube.com']}, [
    {id: 1, url: 'https://www.youtube.com/watch?v=music123&t=30'},
    {id: 2, url: 'https://www.youtube.com/watch?v=other123'},
    {id: 3, url: 'https://music.youtube.com/explore'}
  ]);
  const saved = await fixture.request({
    type: 'SAVE_RULES', sites: ['youtube.com'], blockedPages: [],
    allowedSites: ['music.youtube.com'], allowedPages: ['https://youtu.be/music123']
  });
  assert.equal(saved.ok, true);
  const enabled = await fixture.request({type: 'SET_ENABLED', enabled: true});
  assert.equal(enabled.ok, true);
  assert.deepEqual(fixture.updates.map(tab => tab.id), [2]);
  assert.equal(fixture.tabs.get(1).url, 'https://www.youtube.com/watch?v=music123&t=30');
  assert.equal(fixture.rules().filter(rule => rule.action.type === 'allow').length, 2);
});

test('page-only rules can enable blocking and legacy site saves preserve page and exception rules', async () => {
  const fixture = await startBackground({enabled: false, sites: []});
  const saved = await fixture.request({
    type: 'SAVE_RULES', sites: [], blockedPages: ['https://example.com/private'],
    allowedSites: ['music.youtube.com'], allowedPages: []
  });
  assert.equal(saved.ok, true);
  const enabled = await fixture.request({type: 'SET_ENABLED', enabled: true});
  assert.equal(enabled.ok, true);
  assert.equal(enabled.state.enabled, true);
  const legacy = await fixture.request({type: 'SAVE_SITES', sites: ['reddit.com']});
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.state.blockedPages, ['https://example.com/private']);
  assert.deepEqual(legacy.state.allowedSites, ['music.youtube.com']);
});

test('allow-only settings cannot enable blocking and removing the last block turns it off', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = await startBackground({enabled: true, sites: ['youtube.com']});
  const saved = await fixture.request({
    type: 'SAVE_RULES', sites: [], blockedPages: [], allowedSites: ['music.youtube.com'], allowedPages: []
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.enabled, false);
  assert.deepEqual(fixture.rules(), []);
  const enabled = await fixture.request({type: 'SET_ENABLED', enabled: true});
  assert.equal(enabled.ok, false);
});

test('history navigation from an allowed song to another video applies blocking', async () => {
  const fixture = await startBackground({
    enabled: true, sites: ['youtube.com'], blockedPages: [], allowedSites: [],
    allowedPages: ['https://www.youtube.com/watch?v=music123']
  }, [{id: 1, url: 'https://www.youtube.com/watch?v=music123'}]);
  assert.equal(fixture.updates.length, 0);
  assert.equal(typeof fixture.listeners.history, 'function');
  const address = 'https://www.youtube.com/watch?v=other123';
  fixture.tabs.set(1, {id: 1, url: address});
  fixture.listeners.history({tabId: 1, frameId: 2, url: address});
  await fixture.request({type: 'GET_STATE'});
  assert.equal(fixture.updates.length, 0, 'subframe changes must not redirect the tab');
  fixture.listeners.history({tabId: 1, frameId: 0, url: address});
  await fixture.request({type: 'GET_STATE'});
  assert.deepEqual(fixture.updates.map(tab => tab.id), [1]);
  assert.equal(new URLSearchParams(new URL(fixture.updates[0].url).hash.slice(1)).get('from'), address);
});

test('failed persistence rolls back network rules and keeps the prior configuration', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = await startBackground({enabled: true, sites: ['youtube.com']});
  const previousRules = fixture.rules();
  fixture.failStorageWrite();
  const saved = await fixture.request({
    type: 'SAVE_RULES', sites: ['reddit.com'], blockedPages: [], allowedSites: [], allowedPages: []
  });
  assert.equal(saved.ok, false);
  assert.deepEqual(fixture.rules(), previousRules);
  assert.deepEqual((await fixture.request({type: 'GET_STATE'})).state, fixture.initial);
});

test('unsupported Chrome page regex is rejected before saving even while blocking is off', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = await startBackground({enabled: false, sites: ['youtube.com']});
  fixture.rejectRegex();
  const saved = await fixture.request({
    type: 'SAVE_RULES', sites: ['youtube.com'], blockedPages: [], allowedSites: [],
    allowedPages: ['https://www.youtube.com/watch?v=music123']
  });
  assert.equal(saved.ok, false);
  assert.deepEqual(fixture.stored(), fixture.initial);
  assert.deepEqual(fixture.rules(), []);
  assert.deepEqual((await fixture.request({type: 'GET_STATE'})).state, fixture.initial);
});

test('usage controls are independent of blocking and only available to internal management pages', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fixture = await startBackground({enabled: true, sites: ['youtube.com']});
  for (const page of ['popup.html', 'options.html', 'usage.html']) {
    const state = await fixture.request({type: 'GET_STATE'}, page);
    assert.equal(state.ok, true);
    assert.equal(state.capabilities.usage, true);
    assert.equal(state.capabilities.usageFilters, true);
    const result = await fixture.request({type: 'GET_USAGE', days: 7}, page);
    assert.equal(result.ok, true);
    assert.equal(result.state.daily.length, 7);
  }
  for (const type of ['GET_USAGE', 'SET_USAGE_ENABLED', 'CLEAR_USAGE']) {
    assert.equal((await fixture.request({type, enabled: false}, 'blocked.html')).ok, false);
    const external = await new Promise(resolve => fixture.listeners.message({type},
      {id: 'test-extension', url: 'https://example.com/'}, resolve));
    assert.equal(external.ok, false);
  }
  const paused = await fixture.request({type: 'SET_USAGE_ENABLED', enabled: false}, 'usage.html');
  assert.equal(paused.ok, true);
  assert.equal(paused.state.enabled, false);
  assert.deepEqual((await fixture.request({type: 'GET_STATE'})).state, fixture.initial);
  assert.ok(fixture.rules().length > 0, 'pausing recording must leave blocking on');
  assert.equal((await fixture.request({type: 'GET_USAGE', days: 365})).ok, false);
  assert.equal((await fixture.request({type: 'GET_USAGE', filter: 'unknown'})).ok, false);
  assert.equal((await fixture.request({type: 'SET_USAGE_ENABLED', enabled: 'false'})).ok, false);
  assert.equal((await fixture.request({type: 'SET_ENABLED', enabled: false}, 'usage.html')).ok, false,
    'usage page can discover features without gaining permission to change blocking');
});

test('usage filters use the latest saved rules and filter every summary total consistently', async () => {
  const date = new Date();
  const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const fixture = await startBackground({enabled: false, sites: ['youtube.com'],
    blockedPages: ['https://example.test/feed'], allowedSites: ['music.youtube.com']}, [], {
    enabled: false, days: {[today]: {'youtube.com': 360000, 'music.youtube.com': 420000,
      'example.test': 480000, 'work.test': 600000, 'short.test': 300000}}
  });
  const blocked = (await fixture.request({type: 'GET_USAGE', filter: 'blocked'})).state;
  assert.equal(blocked.filter, 'blocked');
  assert.equal(blocked.minimumDailyMs, 300000);
  assert.deepEqual(blocked.sites.map(site => site.host), ['example.test', 'music.youtube.com', 'youtube.com']);
  assert.equal(blocked.totalMs, 1260000);
  assert.equal(blocked.daily[0].ms, blocked.totalMs);
  const all = (await fixture.request({type: 'GET_USAGE'})).state;
  assert.equal(all.totalMs, 1860000);
  await fixture.request({type: 'SAVE_RULES', sites: ['work.test'], blockedPages: [], allowedSites: [], allowedPages: []});
  const changed = (await fixture.request({type: 'GET_USAGE', filter: 'blocked'})).state;
  assert.deepEqual(changed.sites, [{host: 'work.test', ms: 600000}]);
  const cleared = await fixture.request({type: 'CLEAR_USAGE', filter: 'blocked'});
  assert.equal(cleared.state.filter, 'blocked');
  assert.equal((await fixture.request({type: 'GET_USAGE'})).state.totalMs, 0, 'clear deletes all usage, including hidden sites');
});
