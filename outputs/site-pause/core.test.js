import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSites, normalizePages, normalizeRuleLists,
  matchesSite, matchesPage, getBlockedRule, hasBlockingRules, buildRules
} from './core.js';

const origin = 'chrome-extension://test-extension/';
const state = (overrides = {}) => ({
  enabled: true, sites: [], blockedPages: [], allowedSites: [], allowedPages: [],
  ...overrides
});

// Evaluate the fields emitted by buildRules, so manual tab enforcement and
// Chrome's network rules must agree on the same navigation examples.
function networkAction(address, rules, resourceType = 'main_frame') {
  const url = new URL(address);
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const matching = rules.filter(({condition}) => {
    if (condition.resourceTypes && !condition.resourceTypes.includes(resourceType)) return false;
    if (condition.requestDomains && !condition.requestDomains.some((domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return false;
    if (condition.regexFilter && !new RegExp(condition.regexFilter,
      condition.isUrlFilterCaseSensitive ? '' : 'i').test(url.href.split('#')[0])) return false;
    assert.equal(condition.urlFilter, undefined, 'extend this evaluator if urlFilter is used');
    return true;
  }).sort((a, b) => b.priority - a.priority);
  return matching[0]?.action.type ?? null;
}

test('existing whole-site rules still include subdomains without matching lookalike domains', () => {
  assert.deepEqual(normalizeSites('https://WWW.YouTube.com/watch?v=song, youtube.com'), ['youtube.com']);
  for (const address of ['https://youtube.com/', 'https://www.youtube.com/watch?v=song', 'http://m.youtube.com/']) {
    assert.equal(matchesSite(address, ['youtube.com']), 'youtube.com');
  }
  for (const address of ['https://notyoutube.com/', 'https://youtube.com.attacker.example/', 'chrome://extensions/', 'invalid']) {
    assert.equal(matchesSite(address, ['youtube.com']), null);
  }
});

test('old saved lists receive empty page and exception lists', () => {
  assert.deepEqual(normalizeRuleLists({sites: ['youtube.com']}), {
    sites: ['youtube.com'], blockedPages: [], allowedSites: [], allowedPages: []
  });
});

test('registration limit applies across all four lists after deduplication', () => {
  const sites = Array.from({length: 199}, (_, i) => `site${i}.example`);
  const lists = {sites: [...sites, sites[0]], allowedPages: ['https://example.com/music']};
  assert.equal(normalizeRuleLists(lists).sites.length, 199);
  assert.throws(() => normalizeRuleLists({...lists, blockedPages: ['https://example.com/other']}), /200/);
});

test('only blocking entries allow blocking to be enabled', () => {
  assert.equal(hasBlockingRules(state()), false);
  assert.equal(hasBlockingRules(state({allowedSites: ['example.com'], allowedPages: ['https://example.com/music']})), false);
  assert.equal(hasBlockingRules(state({sites: ['example.com']})), true);
  assert.equal(hasBlockingRules(state({blockedPages: ['https://example.com/music']})), true);
});

test('page registration rejects unsupported protocols and embedded credentials', () => {
  for (const address of ['file:///music', 'chrome://settings/', 'javascript:alert(1)', 'https://user:password@example.com/music']) {
    assert.throws(() => normalizePages([address]));
  }
});

test('page-only blocking leaves other pages on the site available', () => {
  const blockedPages = normalizePages(['https://example.com/watch?id=1']);
  const configuration = state({blockedPages});
  assert.equal(getBlockedRule('https://example.com/watch?id=1', configuration), blockedPages[0]);
  for (const address of ['https://example.com/', 'https://example.com/watch?id=2', 'https://example.com/watch/extra?id=1']) {
    assert.equal(getBlockedRule(address, configuration), null);
  }
  assert.equal(matchesPage('invalid', blockedPages), null);
  assert.equal(matchesPage('chrome://extensions/', blockedPages), null);
});

test('ordinary pages preserve exact scheme, host, path and query while ignoring fragments', () => {
  const pages = normalizePages(['example.com/music?a=1&b=2#first', 'https://example.com/music?a=1&b=2#second']);
  assert.deepEqual(pages, ['https://example.com/music?a=1&b=2']);
  assert.equal(matchesPage('https://example.com/music?a=1&b=2#playing', pages), pages[0]);
  for (const address of [
    'http://example.com/music?a=1&b=2',
    'https://www.example.com/music?a=1&b=2',
    'https://example.com:8443/music?a=1&b=2',
    'https://example.com/Music?a=1&b=2',
    'https://example.com/music/?a=1&b=2',
    'https://example.com/music?a=1&b=2&c=3',
    'https://example.com/music?b=2&a=1'
  ]) assert.equal(matchesPage(address, pages), null, address);
});

test('page lists preserve commas and semicolons inside URLs', () => {
  const first = 'https://example.com/music?q=one,two;three';
  const second = 'https://example.com/other';
  assert.deepEqual(normalizePages(`${first}\n${second}`), [first, second]);
});

test('YouTube video links normalize across hosts, short links and incidental query parameters', () => {
  const song = 'https://www.youtube.com/watch?v=music123';
  const inputs = [
    song,
    'https://youtube.com/watch?v=music123&t=42#player',
    'http://m.youtube.com/watch?list=playlist&v=music123&feature=share',
    'https://music.youtube.com/watch?v=music123&list=playlist',
    'https://youtu.be/music123?si=tracking'
  ];
  assert.deepEqual(normalizePages(inputs), [song]);
  for (const address of inputs) assert.equal(matchesPage(address, [song]), song, address);
  for (const address of [
    'https://www.youtube.com/watch?v=music1234',
    'https://www.youtube.com/watch?v=MUSIC123',
    'https://www.youtube.com/watch?other=music123',
    'https://www.youtube.com/playlist?list=music123',
    'https://www.youtube.com/shorts/music123',
    'https://www.youtube.com.attacker.example/watch?v=music123'
  ]) assert.equal(matchesPage(address, [song]), null, address);
});

test('allow exceptions take precedence over both site and page blocking', () => {
  const song = normalizePages(['https://www.youtube.com/watch?v=music123'])[0];
  const configuration = state({sites: ['youtube.com'], blockedPages: [song], allowedPages: [song], allowedSites: ['music.youtube.com']});
  assert.equal(getBlockedRule(song, configuration), null);
  assert.equal(getBlockedRule('https://music.youtube.com/explore', configuration), null);
  assert.equal(getBlockedRule('https://www.youtube.com/watch?v=other123', configuration), 'youtube.com');
  assert.equal(getBlockedRule('https://www.youtube.com/', {...configuration, enabled: false}), null);
});

test('ambiguous or encoded video parameters retain exact matching and cannot select a later video', () => {
  const song = 'https://www.youtube.com/watch?v=music123';
  const configuration = state({sites: ['youtube.com'], allowedPages: [song]});
  const rules = buildRules(configuration, origin);
  for (const address of [
    'https://www.youtube.com/watch?v=%6dusic123',
    'https://www.youtube.com/watch?%76=music123',
    'https://www.youtube.com/watch?%76=other123&v=music123',
    'https://www.youtube.com/watch?v&v=music123',
    'https://www.youtube.com/watch?v=&v=music123',
    'https://www.youtube.com/watch?v=other123&v=music123'
  ]) {
    const normalized = normalizePages([address]);
    assert.equal(matchesPage(address, normalized), normalized[0], 'an accepted URL must match its own rule');
    assert.equal(matchesPage(address, [song]), null, address);
    assert.equal(networkAction(address, rules), 'redirect', address);
    assert.equal(getBlockedRule(address, configuration), 'youtube.com', address);
  }
});

test('generated network rules give exceptions higher priority and only affect top-level pages', () => {
  const configuration = state({
    sites: ['youtube.com'],
    blockedPages: normalizePages(['https://example.com/private']),
    allowedSites: ['music.youtube.com'],
    allowedPages: normalizePages(['https://www.youtube.com/watch?v=music123'])
  });
  const rules = buildRules(configuration, origin);
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  const redirects = rules.filter(rule => rule.action.type === 'redirect');
  const exceptions = rules.filter(rule => rule.action.type === 'allow');
  assert.equal(redirects.length, 2);
  assert.equal(exceptions.length, 2);
  assert.ok(exceptions.every(rule => redirects.every(block => rule.priority > block.priority)));
  assert.ok(rules.every(rule => JSON.stringify(rule.condition.resourceTypes) === '["main_frame"]'));
  assert.ok(redirects.every(rule => rule.action.redirect.url.startsWith(`${origin}blocked.html?`)));
  assert.equal(networkAction('https://www.youtube.com/', rules, 'media'), null);
  assert.deepEqual(buildRules({...configuration, enabled: false}, origin), []);
});

test('network rules and tab enforcement agree on blocked and allowed addresses', () => {
  const configuration = state({
    sites: ['youtube.com'],
    blockedPages: normalizePages(['https://example.com/private?item=1']),
    allowedSites: ['music.youtube.com'],
    allowedPages: normalizePages(['https://www.youtube.com/watch?v=music123'])
  });
  const rules = buildRules(configuration, origin);
  const addresses = [
    'https://www.youtube.com/',
    'https://youtube.com/watch?v=other123',
    'https://www.youtube.com/watch?v=music123',
    'https://m.youtube.com/watch?v=music123&t=42',
    'https://www.youtube.com/watch?list=playlist&v=music123',
    'https://www.youtube.com/watch?v=music123#comments',
    'https://www.youtube.com/watch?v=music1234',
    'https://www.youtube.com/watch?v=MUSIC123',
    'https://music.youtube.com/explore',
    'https://music.youtube.com.attacker.example/',
    'https://example.com/private?item=1',
    'https://example.com/private?item=1#details',
    'https://example.com/private?item=2',
    'https://example.com/private/child?item=1',
    'https://example.com/private?item=1&other=2',
    'https://sub.example.com/private?item=1',
    'https://example.com/PRIVATE?item=1',
    'https://example.com/',
    'http://example.com/private?item=1'
  ];
  for (const address of addresses) {
    assert.equal(networkAction(address, rules) === 'redirect', Boolean(getBlockedRule(address, configuration)), address);
  }
});
