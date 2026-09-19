import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageTracker, MAX_GAP_MS, USAGE_ALARM, USAGE_KEY} from './usage-tracker.js';

const SESSION_KEY = 'sitePauseUsageSession';
const START = new Date(2026, 8, 19, 12).getTime();

function fixture({at = START, backing = {local: {}, session: {}}, environment} = {}) {
  const listeners = {};
  const event = name => ({addListener(fn) { (listeners[name] ??= []).push(fn); }});
  const state = environment ?? {
    focusedWindowId: 1,
    idle: 'active',
    windows: new Map([[1, {id: 1, focused: true, incognito: false, state: 'normal'}]]),
    tabs: new Map([[1, {id: 1, windowId: 1, active: true, incognito: false, url: 'https://example.com/page'}]])
  };
  let timestamp = at;
  let failWriteIn = 0;
  let writes = 0;
  let idleSeconds;
  let alarm;
  const api = {
    storage: {
      local: {
        async get(key) { return {[key]: structuredClone(backing.local[key])}; },
        async set(value) {
          if (failWriteIn > 0 && --failWriteIn === 0) throw new Error('Storage unavailable');
          writes += 1;
          Object.assign(backing.local, structuredClone(value));
        }
      },
      session: {
        async get(key) { return {[key]: backing.session[key]}; },
        async set(value) { Object.assign(backing.session, structuredClone(value)); }
      }
    },
    tabs: {
      onActivated: event('activated'), onUpdated: event('updated'),
      onRemoved: event('removed'), onReplaced: event('replaced'),
      async query({active, windowId}) {
        return [...state.tabs.values()].filter(tab => tab.active === active && tab.windowId === windowId);
      }
    },
    windows: {
      WINDOW_ID_NONE: -1, onFocusChanged: event('focus'), onRemoved: event('windowRemoved'),
      async getLastFocused() {
        return state.windows.get(state.focusedWindowId) ?? {focused: false};
      }
    },
    idle: {
      setDetectionInterval(value) { idleSeconds = value; },
      async queryState() { return state.idle; },
      onStateChanged: event('idle')
    },
    alarms: {
      async get() { return alarm; },
      async create(name, options) { alarm = {name, ...options}; },
      onAlarm: event('alarm')
    },
    runtime: {onStartup: event('startup'), onInstalled: event('installed')}
  };
  const tracker = createUsageTracker(api, () => timestamp);
  return {
    tracker, state, backing,
    advance(ms) { timestamp += ms; },
    now: () => timestamp,
    saved: () => structuredClone(backing.local[USAGE_KEY]),
    setup: () => ({idleSeconds, alarm, writes}),
    failStorageWrite(writeNumber = 1) { failWriteIn = writeNumber; },
    async emit(name, ...args) {
      for (const listener of listeners[name] ?? []) listener(...args);
      // Chrome event listeners do not return their asynchronous work. All mocked
      // APIs resolve in microtasks, which finish before the next event-loop turn.
      await new Promise(resolve => setImmediate(resolve));
    },
    async record(ms) {
      while (ms > 0) {
        const interval = Math.min(ms, 30_000);
        timestamp += interval;
        ms -= interval;
        for (const listener of listeners.alarm ?? []) listener({name: USAGE_ALARM});
        await new Promise(resolve => setImmediate(resolve));
      }
    },
    summary(days = 1) { return tracker.request({type: 'GET_USAGE', days}); }
  };
}

function total(saved, host) {
  return Object.values(saved.days).reduce((sum, sites) => sum + (host
    ? sites[host] ?? 0
    : Object.values(sites).reduce((a, b) => a + b, 0)), 0);
}

test('starts a new local session and samples only the focused active tab', async () => {
  const f = fixture();
  f.state.tabs.set(2, {id: 2, windowId: 1, active: false, url: 'https://background.example/'});
  await f.tracker.start();
  assert.equal(f.saved().enabled, true);
  assert.equal(f.setup().idleSeconds, 60);
  assert.deepEqual(f.setup().alarm, {name: USAGE_ALARM, periodInMinutes: 0.5});
  assert.equal(f.saved().checkpoint.sessionId, f.backing.session[SESSION_KEY]);
  f.advance(30_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  assert.equal(total(f.saved(), 'example.com'), 30_000);
  assert.equal(total(f.saved(), 'background.example'), 0);
  const saved = f.saved();
  f.advance(5_000);
  await f.emit('alarm', {name: 'another-alarm'});
  assert.deepEqual(f.saved(), saved);
});

test('tab activation and URL updates attribute each interval to the previous site', async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(10_000);
  f.state.tabs.get(1).active = false;
  f.state.tabs.set(2, {id: 2, windowId: 1, active: true, url: 'https://second.example/'});
  await f.emit('activated', {tabId: 2, windowId: 1});
  assert.equal(total(f.saved(), 'example.com'), 10_000);
  assert.equal(f.saved().checkpoint.host, 'second.example');
  f.advance(15_000);
  f.state.tabs.get(2).url = 'https://third.example/path?private=value';
  await f.emit('updated', 2, {url: f.state.tabs.get(2).url}, f.state.tabs.get(2));
  assert.equal(total(f.saved(), 'second.example'), 15_000);
  assert.equal(f.saved().checkpoint.host, 'third.example');
  assert.equal(JSON.stringify(f.saved()).includes('private=value'), false);
  f.advance(5_000);
  await f.emit('updated', 2, {status: 'complete'}, f.state.tabs.get(2));
  assert.equal(total(f.saved(), 'third.example'), 5_000);
});

test('focus loss and return omit time spent in another app', async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(12_000);
  f.state.windows.get(1).focused = false;
  await f.emit('focus', -1);
  assert.equal(total(f.saved()), 12_000);
  assert.equal(f.saved().checkpoint, null);
  f.advance(20_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  assert.equal(total(f.saved()), 12_000);
  f.state.windows.get(1).focused = true;
  await f.emit('focus', 1);
  f.advance(8_000);
  await f.summary();
  assert.equal(total(f.saved()), 20_000);
});

test('idle and locked events pause recording until activity resumes', async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(20_000);
  f.state.idle = 'idle';
  await f.emit('idle', 'idle');
  assert.equal(total(f.saved()), 20_000);
  assert.equal(f.saved().checkpoint, null);
  f.advance(30_000);
  f.state.idle = 'locked';
  await f.emit('idle', 'locked');
  assert.equal(total(f.saved()), 20_000);
  f.advance(20_000);
  f.state.idle = 'active';
  await f.emit('idle', 'active');
  f.advance(10_000);
  await f.summary();
  assert.equal(total(f.saved()), 30_000);
});

test('incognito windows, incognito tabs, internal pages and minimized windows are excluded', async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(5_000);
  f.state.windows.get(1).incognito = true;
  await f.emit('focus', 1);
  assert.equal(total(f.saved()), 5_000);
  assert.equal(f.saved().checkpoint, null);
  f.advance(10_000);
  f.state.windows.get(1).incognito = false;
  f.state.tabs.get(1).incognito = true;
  await f.emit('activated', {tabId: 1, windowId: 1});
  assert.equal(f.saved().checkpoint, null);
  f.advance(10_000);
  f.state.tabs.get(1).incognito = false;
  f.state.tabs.get(1).url = 'chrome://extensions';
  await f.emit('updated', 1, {url: 'chrome://extensions'});
  assert.equal(f.saved().checkpoint, null);
  f.advance(10_000);
  f.state.tabs.get(1).url = 'https://example.com/';
  f.state.windows.get(1).state = 'minimized';
  await f.emit('focus', 1);
  assert.equal(f.saved().checkpoint, null);
  assert.equal(total(f.saved()), 5_000);
});

test('switching browser windows counts only the newly focused window', async () => {
  const f = fixture();
  f.state.windows.set(2, {id: 2, focused: false, state: 'normal'});
  f.state.tabs.set(2, {id: 2, windowId: 2, active: true, url: 'https://second.example/'});
  await f.tracker.start();
  f.advance(10_000);
  f.state.windows.get(1).focused = false;
  f.state.windows.get(2).focused = true;
  f.state.focusedWindowId = 2;
  await f.emit('focus', 2);
  f.advance(15_000);
  const result = await f.summary();
  assert.equal(total(f.saved(), 'second.example'), 15_000);
  assert.equal(total(f.saved(), 'example.com'), 10_000);
  assert.deepEqual(result.sites, []);
  assert.equal(result.totalMs, 0);
});

test('a restarted worker in the same browser session resumes an atomic checkpoint once', async () => {
  const first = fixture();
  await first.tracker.start();
  first.advance(20_000);
  await first.emit('alarm', {name: USAGE_ALARM});
  const second = fixture({at: first.now() + 10_000, backing: first.backing, environment: first.state});
  await second.tracker.start();
  assert.equal(total(second.saved()), 30_000);
  assert.equal(second.saved().checkpoint.sessionId, first.saved().checkpoint.sessionId);
  await second.tracker.start();
  assert.equal(total(second.saved()), 30_000);
  second.advance(10_000);
  await second.summary();
  assert.equal(total(second.saved()), 40_000);
});

test('a new browser session discards the closed-browser gap even when it is short', async () => {
  const first = fixture();
  await first.tracker.start();
  first.advance(10_000);
  await first.emit('alarm', {name: USAGE_ALARM});
  const previousSession = first.saved().checkpoint.sessionId;
  first.backing.session = {};
  const second = fixture({at: first.now() + 20_000, backing: first.backing, environment: first.state});
  await second.tracker.start();
  assert.equal(total(second.saved()), 10_000);
  assert.notEqual(second.saved().checkpoint.sessionId, previousSession);
  second.advance(5_000);
  await second.summary();
  assert.equal(total(second.saved()), 15_000);
});

test('a delayed alarm discards the whole sleep gap and resumes from the wake sample', async () => {
  const f = fixture();
  await f.tracker.start();
  f.advance(15_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  f.advance(MAX_GAP_MS + 1);
  await f.emit('alarm', {name: USAGE_ALARM});
  assert.equal(total(f.saved()), 15_000);
  f.advance(20_000);
  await f.summary();
  assert.equal(total(f.saved()), 35_000);
});

test('exactly five daily minutes stay hidden and crossing the cutoff includes the whole day', async () => {
  const f = fixture();
  await f.tracker.start();
  await f.record(300_000);
  const atCutoff = await f.summary();
  assert.equal(atCutoff.minimumDailyMs, 300_000);
  assert.equal(atCutoff.totalMs, 0);
  assert.deepEqual(atCutoff.sites, []);
  assert.equal(total(f.saved()), 300_000, 'short usage must remain available for later accumulation');
  f.advance(1);
  assert.equal((await f.summary()).totalMs, 300_001);
  await f.record(59_999);
  assert.deepEqual((await f.summary()).sites, [{host: 'example.com', ms: 360_000}]);
});

test('separate short visits qualify together without counting time on other sites', async () => {
  const f = fixture();
  await f.tracker.start();
  await f.record(180_000);
  f.state.tabs.get(1).url = 'https://second.example/';
  await f.emit('updated', 1, {url: f.state.tabs.get(1).url});
  await f.record(60_000);
  assert.equal((await f.summary()).totalMs, 0);
  f.state.tabs.get(1).url = 'https://example.com/another-page';
  await f.emit('updated', 1, {url: f.state.tabs.get(1).url});
  await f.record(180_000);
  const result = await f.summary();
  assert.equal(result.totalMs, 360_000);
  assert.deepEqual(result.sites, [{host: 'example.com', ms: 360_000}]);
  assert.equal(total(f.saved(), 'second.example'), 60_000);
});

test('the daily cutoff resets at midnight even when a seven-day view includes both days', async () => {
  const midnight = new Date(2026, 8, 20).getTime();
  const f = fixture({at: midnight - 360_000});
  await f.tracker.start();
  await f.record(360_000);
  await f.record(240_000);
  assert.equal((await f.summary()).totalMs, 0);
  const week = await f.summary(7);
  assert.equal(week.totalMs, 360_000);
  assert.equal(week.daily.at(-2).ms, 360_000);
  assert.equal(week.daily.at(-1).ms, 0);
  assert.equal(f.saved().days['2026-09-20']['example.com'], 240_000);
  await f.record(120_000);
  assert.equal((await f.summary()).totalMs, 360_000);
  assert.equal((await f.summary(7)).totalMs, 720_000);
});

test('blocked usage requests use the supplied current list while preserving all local usage', async () => {
  const f = fixture();
  await f.tracker.start();
  await f.record(360_000);
  f.state.tabs.get(1).url = 'https://second.example/';
  await f.emit('updated', 1, {url: f.state.tabs.get(1).url});
  await f.record(420_000);
  const saved = f.saved();
  const request = {type: 'GET_USAGE', days: 7, filter: 'blocked'};
  const first = await f.tracker.request(request, {
    enabled: false, sites: ['example.com'], allowedSites: ['example.com']
  });
  assert.equal(first.filter, 'blocked');
  assert.equal(first.totalMs, 360_000);
  assert.deepEqual(first.sites, [{host: 'example.com', ms: 360_000}]);
  assert.equal(first.daily.at(-1).ms, first.totalMs);
  const updated = await f.tracker.request(request, {sites: ['second.example']});
  assert.equal(updated.totalMs, 420_000);
  assert.deepEqual(updated.sites, [{host: 'second.example', ms: 420_000}]);
  assert.equal((await f.tracker.request(request)).totalMs, 0);
  assert.equal((await f.summary(7)).totalMs, 780_000);
  assert.deepEqual(f.saved(), saved);
});

test('recording pause and resume preserve short sessions until their daily total qualifies', async () => {
  const f = fixture();
  await f.tracker.start();
  await f.record(180_000);
  const paused = await f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: false});
  assert.equal(paused.enabled, false);
  assert.equal(paused.totalMs, 0);
  assert.equal(total(f.saved()), 180_000);
  assert.equal(f.saved().checkpoint, null);
  f.advance(20_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  await f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: true});
  await f.record(180_000);
  assert.equal((await f.summary()).totalMs, 360_000);
  assert.equal(total(f.saved()), 360_000);
});

test('clearing usage removes old checkpoints so worker restart cannot resurrect records', async () => {
  const first = fixture();
  await first.tracker.start();
  await first.record(180_000);
  const cleared = await first.tracker.request({type: 'CLEAR_USAGE'});
  assert.equal(cleared.totalMs, 0);
  assert.deepEqual(first.saved().days, {});
  const second = fixture({at: first.now(), backing: first.backing, environment: first.state});
  await second.tracker.start();
  assert.equal(total(second.saved()), 0);
  await second.record(180_000);
  assert.equal((await second.summary()).totalMs, 0);
  assert.equal(total(second.saved()), 180_000);
  await second.record(180_000);
  assert.equal((await second.summary()).totalMs, 360_000);
});

test('an active interval crossing local midnight is split between calendar days', async () => {
  const midnight = new Date(2026, 8, 20).getTime();
  const f = fixture({at: midnight - 10_000});
  await f.tracker.start();
  f.advance(30_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  assert.equal(f.saved().days['2026-09-19']['example.com'], 10_000);
  assert.equal(f.saved().days['2026-09-20']['example.com'], 20_000);
  assert.equal((await f.summary()).totalMs, 0);
  assert.equal((await f.summary(7)).totalMs, 0);
});

test('invalid request payloads do not change recording preferences or erase history', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.tracker.start();
  f.advance(10_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  const before = f.saved();
  for (const message of [
    {type: 'GET_USAGE', days: 2},
    {type: 'GET_USAGE', days: '7'},
    {type: 'GET_USAGE', filter: 'unknown'},
    {type: 'GET_USAGE', filter: false},
    {type: 'CLEAR_USAGE', days: -1},
    {type: 'SET_USAGE_ENABLED', enabled: 'false'},
    {type: 'UNKNOWN'}, null, undefined
  ]) {
    await assert.rejects(f.tracker.request(message));
    assert.deepEqual(f.saved(), before);
  }
  await f.summary();
  assert.equal(total(f.saved()), 10_000, 'queue remains usable after rejected requests');
});

test('failed persistence can retry without committing or double counting the failed sample', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.tracker.start();
  const before = f.saved();
  f.advance(20_000);
  f.failStorageWrite();
  await assert.rejects(f.summary(), /Storage unavailable/);
  assert.deepEqual(f.saved(), before);
  await f.summary();
  assert.equal(total(f.saved()), 20_000);
  f.advance(10_000);
  await f.summary();
  assert.equal(total(f.saved()), 30_000);
});

test('retrying a failed focus-loss write does not count the intervening time in another app', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.tracker.start();
  f.advance(10_000);
  f.state.windows.get(1).focused = false;
  f.failStorageWrite();
  await f.emit('focus', -1);
  f.advance(20_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  assert.equal(total(f.saved()), 10_000, 'only the ten seconds before focus loss were active');
  assert.equal(f.saved().checkpoint, null);
});

test('a failed clear preserves observed usage in storage and memory until an explicit retry', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.tracker.start();
  f.advance(20_000);
  await f.emit('alarm', {name: USAGE_ALARM});
  f.advance(5_000);
  // Let the pending observation succeed, then fail the user's deletion write.
  f.failStorageWrite(2);
  await assert.rejects(f.tracker.request({type: 'CLEAR_USAGE'}), /Storage unavailable/);
  assert.equal(total(f.saved()), 25_000);
  assert.equal(f.saved().enabled, true);
  f.advance(5_000);
  await f.summary();
  assert.equal(total(f.saved()), 30_000, 'subsequent reads must not silently apply the failed deletion');
  assert.equal((await f.tracker.request({type: 'CLEAR_USAGE'})).totalMs, 0);
  assert.deepEqual(f.saved().days, {});
});

test('a failed pause retains enabled recording after its preceding observation is saved', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.tracker.start();
  f.advance(10_000);
  f.failStorageWrite(2);
  await assert.rejects(f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: false}), /Storage unavailable/);
  assert.equal(f.saved().enabled, true);
  assert.equal(total(f.saved()), 10_000);
  assert.equal(f.saved().checkpoint.host, 'example.com');
  f.advance(5_000);
  const stillRecording = await f.summary();
  assert.equal(stillRecording.enabled, true);
  assert.equal(total(f.saved()), 15_000);
  const paused = await f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: false});
  assert.equal(paused.enabled, false);
  f.advance(10_000);
  await f.summary();
  assert.equal(total(f.saved()), 15_000);
});

test('a failed resume retains disabled recording and does not collect the failed-resume interval', async t => {
  t.mock.method(console, 'error', () => {});
  const f = fixture();
  await f.tracker.start();
  f.advance(10_000);
  await f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: false});
  const before = f.saved();
  f.advance(20_000);
  // An already paused observation has no changes; the next write is resume.
  f.failStorageWrite();
  await assert.rejects(f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: true}), /Storage unavailable/);
  assert.deepEqual(f.saved(), before);
  f.advance(10_000);
  const stillPaused = await f.summary();
  assert.equal(stillPaused.enabled, false);
  assert.equal(total(f.saved()), 10_000);
  await f.tracker.request({type: 'SET_USAGE_ENABLED', enabled: true});
  f.advance(5_000);
  await f.summary();
  assert.equal(total(f.saved()), 15_000);
});
