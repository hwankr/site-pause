import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeUsage} from './usage-core.js';
import {isBlockedUsageHost, filterUsageData} from './usage-filter.js';

const now = new Date(2026, 8, 19, 12).getTime();
const minute = 60000;

test('whole-site membership matches normalized hostnames and proper subdomain boundaries', () => {
  const rules = {sites: ['example.com', 'WWW.Other.Example.']};
  for (const host of ['example.com', 'WWW.Example.com', 'music.example.com',
    'nested.music.example.com', 'other.example', 'www.other.example']) {
    assert.equal(isBlockedUsageHost(host, rules), true, host);
  }
  for (const host of ['notexample.com', 'example.com.evil.test', 'example.net',
    'https://example.com', 'example.com/private', 'example.com:443']) {
    assert.equal(isBlockedUsageHost(host, rules), false, host);
  }
});

test('page-only blocks include their hostname total without including sibling or child hosts', () => {
  const rules = {blockedPages: ['https://www.youtube.com/watch?v=test', 'https://news.example.com/article/1']};
  assert.equal(isBlockedUsageHost('youtube.com', rules), true);
  assert.equal(isBlockedUsageHost('www.youtube.com', rules), true);
  assert.equal(isBlockedUsageHost('news.example.com', rules), true);
  assert.equal(isBlockedUsageHost('music.youtube.com', rules), false);
  assert.equal(isBlockedUsageHost('other.example.com', rules), false);
  assert.equal(isBlockedUsageHost('nested.news.example.com', rules), false);
});

test('saved block-list membership survives disabled blocking and allow exceptions', () => {
  const rules = {
    enabled: false, sites: ['example.com'], blockedPages: ['https://other.example/private'],
    allowedSites: ['example.com', 'other.example'], allowedPages: ['https://example.com/']
  };
  assert.equal(isBlockedUsageHost('example.com', rules), true);
  assert.equal(isBlockedUsageHost('other.example', rules), true);
  assert.equal(isBlockedUsageHost('unlisted.example', rules), false);
});

test('invalid hostnames and malformed rules are ignored safely', () => {
  for (const rules of [undefined, null, [], 'example.com', {sites: 'example.com'},
    {sites: [null, 123, {}, 'ftp://example.com'], blockedPages: [null, 123, 'bad', 'file:///tmp/file']}]) {
    assert.equal(isBlockedUsageHost('example.com', rules), false);
  }
  for (const value of [null, undefined, 123, {}, '', '__proto__', 'constructor', 'example.com?secret']) {
    assert.equal(isBlockedUsageHost(value, {sites: ['example.com']}), false);
  }
});

test('filtering before summarizing keeps daily chart, totals and ranking consistent', () => {
  const data = {enabled: false, days: {
    '2026-09-18': {'example.com': 10 * minute, 'other.example': 20 * minute},
    '2026-09-19': {'sub.example.com': 6 * minute, 'youtube.com': 8 * minute, 'other.example': 30 * minute}
  }};
  const original = structuredClone(data);
  const rules = {sites: ['example.com'], blockedPages: ['https://www.youtube.com/watch?v=test']};
  const filtered = filterUsageData(data, 'blocked', rules, now);
  const week = summarizeUsage(filtered, 7, now);
  assert.equal(week.enabled, false);
  assert.equal(week.totalMs, 24 * minute);
  assert.deepEqual(week.sites, [
    {host: 'example.com', ms: 10 * minute},
    {host: 'youtube.com', ms: 8 * minute},
    {host: 'sub.example.com', ms: 6 * minute}
  ]);
  assert.deepEqual(week.daily.slice(-2), [
    {date: '2026-09-18', ms: 10 * minute}, {date: '2026-09-19', ms: 14 * minute}
  ]);
  assert.equal(week.daily.reduce((total, day) => total + day.ms, 0), week.totalMs);
  assert.equal(week.sites.reduce((total, site) => total + site.ms, 0), week.totalMs);
  assert.deepEqual(data, original);
  assert.equal(summarizeUsage(filterUsageData(data, 'all', rules, now), 7, now).totalMs, 74 * minute);
});

test('empty block lists yield an empty report and removed rules immediately cease to match', () => {
  const data = {enabled: true, days: {'2026-09-19': {'example.com': 10 * minute}}};
  const rules = {sites: ['example.com']};
  assert.equal(summarizeUsage(filterUsageData(data, 'blocked', rules, now), 1, now).totalMs, 10 * minute);
  rules.sites = [];
  const empty = summarizeUsage(filterUsageData(data, 'blocked', rules, now), 1, now);
  assert.equal(empty.totalMs, 0);
  assert.deepEqual(empty.sites, []);
  assert.deepEqual(empty.daily, [{date: '2026-09-19', ms: 0}]);
});

test('filters normalize malformed stored data and reject unknown filter values', () => {
  const data = JSON.parse('{"enabled":false,"days":{"2026-09-19":{"__proto__":1,"example.com":600000,"invalid.example":"600000"}}}');
  assert.deepEqual(filterUsageData(data, 'blocked', {sites: ['example.com']}, now), {
    enabled: false, days: {'2026-09-19': {'example.com': 600000}}
  });
  for (const value of [null, [], 'bad', {days: []}]) {
    assert.deepEqual(filterUsageData(value, 'blocked', {}, now), {enabled: true, days: {}});
  }
  for (const filter of ['unknown', '', null, false, {}]) {
    assert.throws(() => filterUsageData(data, filter, {}, now), /필터/);
  }
  assert.equal({}.polluted, undefined);
});
