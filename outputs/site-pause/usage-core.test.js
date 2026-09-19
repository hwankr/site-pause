import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {RETENTION_DAYS, MINIMUM_DAILY_MS, usageHost, localDateKey, normalizeUsage, addUsage, summarizeUsage} from './usage-core.js';

const time = (day, hour = 12, minute = 0) => new Date(2026, 8, day, hour, minute).getTime();
const now = time(19);

test('usage records only HTTP(S) hostnames, without page, query, credentials or port details', () => {
  assert.equal(usageHost('https://user:secret@WWW.Example.com:8443/private?token=secret#section'), 'example.com');
  assert.equal(usageHost('http://music.example.com/song/123'), 'music.example.com');
  assert.equal(usageHost('https://www.example.com./'), 'example.com');
  assert.equal(usageHost('https://www.www.example.com/'), 'example.com');
  assert.equal(usageHost('http://localhost:3000/'), 'localhost');
  assert.equal(usageHost('http://127.0.0.1:3000/'), '127.0.0.1');
  assert.equal(usageHost('http://[::1]:3000/'), '[::1]');
  assert.equal(usageHost('https://한글.example/'), 'xn--bj0bj06e.example');
  for (const value of ['chrome://extensions/', 'chrome-extension://abc/page.html', 'file:///tmp/file',
    'about:blank', 'data:text/plain,hi', 'ftp://example.com/', 'example.com', 'not a URL', null, 1]) {
    assert.equal(usageHost(value), null, String(value));
  }
});

test('normalization defaults collection on, merges host variants and retains explicit disable', () => {
  assert.deepEqual(normalizeUsage(undefined, now), {enabled: true, days: {}});
  assert.deepEqual(normalizeUsage({enabled: false, days: {'2026-09-19': {
    'WWW.Example.com': 2000, 'example.com': 3000, 'music.example.com': 1000
  }}}, now), {enabled: false, days: {'2026-09-19': {'example.com': 5000, 'music.example.com': 1000}}});
});

test('normalization retains only the last 30 local calendar days including today', () => {
  assert.equal(RETENTION_DAYS, 30);
  const result = normalizeUsage({days: {
    '2026-08-20': {'old.example': 1000},
    '2026-08-21': {'first.example': 2000},
    '2026-09-19': {'today.example': 3000},
    '2026-09-20': {'future.example': 4000},
    '2026-09-00': {'bad.example': 5000},
    '2026-09-31': {'bad.example': 6000}
  }}, now);
  assert.deepEqual(result.days, {
    '2026-08-21': {'first.example': 2000}, '2026-09-19': {'today.example': 3000}
  });
});

test('malformed or unsafe persisted values are ignored without prototype pollution', () => {
  const hostile = JSON.parse('{"enabled":true,"days":{"__proto__":{"polluted":1},"2026-09-19":{"__proto__":1,"constructor":2,"prototype":3,"https://example.com/path":4,"example.com/path":5,"example.com?secret":6,"user@example.com":7,"example.com:443":8,"good.example":123,"zero.example":0,"negative.example":-1,"text.example":"42","null.example":null}}}');
  hostile.days['2026-09-19']['infinity.example'] = Infinity;
  hostile.days['2026-09-19']['nan.example'] = NaN;
  hostile.days['2026-09-18'] = [];
  hostile.days['2026-09-17'] = 'bad';
  assert.deepEqual(normalizeUsage(hostile, now), {enabled: true, days: {'2026-09-19': {'good.example': 123}}});
  assert.equal({}.polluted, undefined);
  for (const saved of [null, [], 'bad', 42, {days: []}, {days: 'bad'}]) {
    assert.deepEqual(normalizeUsage(saved, now), {enabled: true, days: {}});
  }
  assert.deepEqual(normalizeUsage({days: {'2026-09-19': {'good.example': 12}}}, NaN).days, {});
});

test('summaries rank sites by total then hostname and include zero-filled daily totals', () => {
  const data = {enabled: false, days: {
    '2026-09-17': {'other.example': 9000000},
    '2026-09-18': {'b.example': 600000, 'a.example': 600000},
    '2026-09-19': {'b.example': 900000, 'a.example': 900000, 'c.example': 1800000}
  }};
  const today = summarizeUsage(data, 1, now);
  assert.deepEqual(today, {
    enabled: false, days: 1, totalMs: 3600000,
    sites: [{host: 'c.example', ms: 1800000}, {host: 'a.example', ms: 900000}, {host: 'b.example', ms: 900000}],
    daily: [{date: '2026-09-19', ms: 3600000}],
    startDate: '2026-09-19', endDate: '2026-09-19', retentionDays: 30, minimumDailyMs: 300000
  });
  const week = summarizeUsage(data, 7, now);
  assert.equal(week.totalMs, 13800000);
  assert.equal(week.daily.length, 7);
  assert.deepEqual(week.daily[0], {date: '2026-09-13', ms: 0});
  assert.deepEqual(week.sites.slice(2), [{host: 'a.example', ms: 1500000}, {host: 'b.example', ms: 1500000}]);
  assert.deepEqual(data.days['2026-09-18'], {'b.example': 600000, 'a.example': 600000});
});

test('7-day and 30-day windows use inclusive calendar boundaries across months', () => {
  const data = {days: {
    '2026-08-20': {'example.com': 600000}, '2026-08-21': {'example.com': 1200000},
    '2026-09-12': {'example.com': 2400000}, '2026-09-13': {'example.com': 4800000},
    '2026-09-19': {'example.com': 9600000}, '2026-09-20': {'example.com': 19200000}
  }};
  assert.equal(summarizeUsage(data, 7, now).totalMs, 14400000);
  const month = summarizeUsage(data, 30, now);
  assert.equal(month.totalMs, 18000000);
  assert.equal(month.startDate, '2026-08-21');
  assert.equal(month.daily.length, 30);
  assert.equal(month.daily.reduce((sum, day) => sum + day.ms, 0), month.totalMs);
  assert.equal(summarizeUsage(data, 2, now).days, 1);
  assert.equal(summarizeUsage({}, 7, now).daily.every(day => day.ms === 0), true);
});

test('addUsage splits sessions at local midnight and includes only elapsed time', () => {
  const data = normalizeUsage(undefined, now);
  const start = time(18, 23, 59);
  const end = time(19, 0, 2);
  assert.equal(addUsage(data, 'WWW.Example.com', start, end), data);
  assert.deepEqual(data.days, {
    '2026-09-18': {'example.com': 60000}, '2026-09-19': {'example.com': 120000}
  });
  addUsage(data, 'example.com', end, end + 500);
  assert.equal(data.days['2026-09-19']['example.com'], 120500);
  assert.equal(summarizeUsage(data, 7, now).totalMs, 0, 'neither day crosses the five-minute threshold');
  const midnight = normalizeUsage(undefined, now);
  addUsage(midnight, 'example.com', start, time(19, 0));
  assert.deepEqual(midnight.days, {'2026-09-18': {'example.com': 60000}});
});

test('addUsage does not cap durations, and retention is applied when reading', () => {
  const data = {enabled: true, days: {}};
  const start = new Date(2026, 7, 20, 23, 59).getTime();
  const end = new Date(2026, 7, 21, 0, 1).getTime();
  addUsage(data, 'example.com', start, end);
  assert.equal(Object.keys(data.days).length, 2);
  assert.deepEqual(normalizeUsage(data, now).days, {'2026-08-21': {'example.com': 60000}});
  const long = {enabled: true, days: {}};
  addUsage(long, 'example.com', time(17, 0), time(19, 0));
  assert.equal(summarizeUsage(long, 7, now).totalMs, time(19, 0) - time(17, 0));
});

test('invalid, disabled or backwards sessions never add usage', () => {
  const data = {enabled: true, days: {}};
  for (const host of ['__proto__', 'constructor', 'prototype', 'https://example.com', 'example.com/path', null]) {
    addUsage(data, host, now, now + 1000);
  }
  for (const [start, end] of [[now, now], [now, now - 1], [NaN, now], [now, Infinity], ['1', now]]) {
    addUsage(data, 'example.com', start, end);
  }
  assert.deepEqual(data.days, {});
  data.enabled = false;
  addUsage(data, 'example.com', now, now + 1000);
  assert.deepEqual(data.days, {});
  assert.doesNotThrow(() => addUsage(null, 'example.com', now, now + 1000));
});

test('local date keys follow local dates and reject invalid timestamps', () => {
  assert.equal(localDateKey(time(19, 0)), '2026-09-19');
  assert.equal(localDateKey(time(19, 0) - 1), '2026-09-18');
  for (const value of [NaN, Infinity, undefined, null, '2026-09-19']) assert.equal(localDateKey(value), null);
});

test('daily reports exclude five minutes inclusively and include the entire qualifying duration', () => {
  assert.equal(MINIMUM_DAILY_MS, 300000);
  const data = {days: {'2026-09-19': {
    'short.example': 299999, 'exact.example': 300000, 'over.example': 300001, 'long.example': 420000
  }}};
  const snapshot = structuredClone(data);
  const summary = summarizeUsage(data, 1, now);
  assert.deepEqual(summary.sites, [{host: 'long.example', ms: 420000}, {host: 'over.example', ms: 300001}]);
  assert.equal(summary.totalMs, 720001);
  assert.equal(summary.daily[0].ms, summary.totalMs);
  assert.deepEqual(data, snapshot, 'local sums remain available for later cumulative use');
});

test('weekly qualification is per day, not the combined reporting period', () => {
  const data = {days: {
    '2026-09-17': {'short.example': 240000, 'mixed.example': 120000},
    '2026-09-18': {'short.example': 240000, 'mixed.example': 360000},
    '2026-09-19': {'short.example': 300000, 'mixed.example': 300000}
  }};
  for (const days of [7, 30]) {
    const summary = summarizeUsage(data, days, now);
    assert.deepEqual(summary.sites, [{host: 'mixed.example', ms: 360000}]);
    assert.equal(summary.totalMs, 360000);
    assert.equal(summary.daily.at(-1).ms, 0);
    assert.equal(summary.daily.at(-2).ms, 360000);
  }
});

test('local midnight splitting and calendar windows handle 23-hour and 25-hour DST days', () => {
  const script = `
    import assert from 'node:assert/strict';
    import {addUsage, summarizeUsage} from ${JSON.stringify(new URL('./usage-core.js', import.meta.url).href)};
    for (const [month, day, hours] of [[2, 8, 23], [10, 1, 25]]) {
      const start = new Date(2026, month, day).getTime();
      const end = new Date(2026, month, day + 1).getTime();
      assert.equal((end - start) / 3600000, hours);
      const data = {enabled: true, days: {}};
      addUsage(data, 'example.com', start, end);
      const summary = summarizeUsage(data, 7, end - 1);
      assert.equal(Object.keys(data.days).length, 1);
      assert.equal(summary.daily.length, 7);
      assert.equal(summary.daily.at(-1).ms, hours * 3600000);
      assert.equal(summary.totalMs, hours * 3600000);
    }
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: {...process.env, TZ: 'America/New_York'}, stdio: 'pipe'
  });
});
