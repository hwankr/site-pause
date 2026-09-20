import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSites, normalizePages, normalizeRuleLists,
  matchesSite, matchesPage, matchesShortForm, getBlockedRule, hasBlockingRules,
  blockingRuleCount, SHORT_FORM_FEATURES, buildRules
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
    sites: ['youtube.com'], blockedPages: [], allowedSites: [], allowedPages: [],
    youtubeShorts: false, instagramReels: false
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

test('short-form flags default off and only accept booleans', () => {
  assert.equal(normalizeRuleLists().youtubeShorts, false);
  assert.equal(normalizeRuleLists().instagramReels, false);
  for (const feature of SHORT_FORM_FEATURES) {
    assert.equal(normalizeRuleLists({[feature.key]: true})[feature.key], true);
    for (const invalid of ['true', 'false', 1, 0, null, undefined, [], {}]) {
      assert.throws(() => normalizeRuleLists({[feature.key]: invalid}), /차단 설정/);
    }
  }
  assert.equal(blockingRuleCount(state({youtubeShorts: true, instagramReels: true})), 2);
  assert.equal(blockingRuleCount(state({sites: ['example.com'], youtubeShorts: true,
    allowedSites: ['youtube.com']})), 2, 'exceptions do not remove saved block rules');
  assert.equal(hasBlockingRules(state({youtubeShorts: true})), true);
  assert.equal(hasBlockingRules(state({instagramReels: true})), true);
});

test('short-form path matching and network rules agree without blocking ordinary pages', () => {
  const configuration = state({youtubeShorts: true, instagramReels: true});
  const rules = buildRules(configuration, origin);
  const cases = [
    ['https://youtube.com/shorts', 'youtubeShorts'],
    ['https://www.youtube.com/shorts/', 'youtubeShorts'],
    ['https://m.youtube.com/shorts/AbC_123?feature=share#details', 'youtubeShorts'],
    ['http://www.youtube.com/shorts?feature=share', 'youtubeShorts'],
    ['https://WWW.YOUTUBE.COM:443/shorts/AbC_123', 'youtubeShorts'],
    ['https://www.youtube.com.:8443/shorts/AbC_123', 'youtubeShorts'],
    ['https://youtube.com/shorts#details', 'youtubeShorts'],
    ['https://instagram.com/reel/AbC_123/', 'instagramReels'],
    ['https://www.instagram.com/reels', 'instagramReels'],
    ['https://www.instagram.com/reels?next=1', 'instagramReels'],
    ['https://www.instagram.com/reel#details', 'instagramReels'],
    ['http://www.instagram.com./reels/AbC_123/', 'instagramReels'],
    ['https://www.instagram.com:8443/name.123_/reels/', 'instagramReels'],
    ['https://youtube.com/', null],
    ['https://www.youtube.com/watch?v=AbC_123', null],
    ['https://youtu.be/AbC_123', null],
    ['https://www.youtube.com/results?search_query=shorts', null],
    ['https://www.youtube.com/shortstory', null],
    ['https://www.youtube.com/Shorts/AbC_123', null],
    ['https://music.youtube.com/shorts/AbC_123', null],
    ['https://www.youtube.com.attacker.test/shorts/AbC_123', null],
    ['https://notyoutube.com/shorts/AbC_123', null],
    ['https://youtube.com@attacker.test/shorts/AbC_123', null],
    ['https://www.instagram.com/', null],
    ['https://www.instagram.com/p/AbC_123/', null],
    ['https://www.instagram.com/direct/inbox/', null],
    ['https://www.instagram.com/name.123_/', null],
    ['https://www.instagram.com/reelstory/', null],
    ['https://www.instagram.com/name/reelstory/', null],
    ['https://www.instagram.com/REELS/', null],
    ['https://m.instagram.com/reels/', null],
    ['https://www.instagram.com.attacker.test/reel/AbC_123/', null],
    ['ftp://www.youtube.com/shorts/AbC_123', null]
  ];
  for (const [address, expected] of cases) {
    assert.equal(matchesShortForm(address, configuration)?.key ?? null, expected, address);
    assert.equal(getBlockedRule(address, configuration), expected, address);
    assert.equal(networkAction(address, rules) === 'redirect', expected !== null, address);
  }
  assert.equal(matchesShortForm('invalid', configuration), null);
  assert.equal(matchesShortForm('https://youtube.com/shorts/a', state()), null);
  assert.equal(matchesShortForm('https://youtube.com/shorts/a', {...configuration, enabled: false}).key,
    'youtubeShorts', 'the shared matcher classifies the path independently of the global switch');
  assert.equal(getBlockedRule('https://youtube.com/shorts/a', {...configuration, enabled: false}), null);
});

test('allow rules continue to override short-form blocking in both enforcement paths', () => {
  const page = 'https://www.instagram.com/reel/allowed/';
  const configuration = state({youtubeShorts: true, instagramReels: true,
    allowedSites: ['youtube.com'], allowedPages: [page]});
  const rules = buildRules(configuration, origin);
  for (const address of ['https://m.youtube.com/shorts/any', page, `${page}#details`]) {
    assert.equal(getBlockedRule(address, configuration), null, address);
    assert.equal(networkAction(address, rules), 'allow', address);
  }
  assert.equal(getBlockedRule('https://www.instagram.com/reel/other/', configuration), 'instagramReels');
  assert.equal(networkAction('https://www.instagram.com/reel/other/', rules), 'redirect');
});

test('short-form redirects preserve full source URLs and feature labels', () => {
  const configuration = state({youtubeShorts: true, instagramReels: true,
    allowedPages: ['https://www.youtube.com/shorts/', 'https://www.instagram.com/reels/']});
  const rules = buildRules(configuration, origin);
  assert.equal(rules.length, 4);
  assert.equal(new Set(rules.map(rule => rule.id)).size, rules.length);
  for (const rule of rules.filter(item => item.action.type === 'redirect')) {
    const source = rule.condition.regexFilter.includes('youtube')
      ? 'https://www.youtube.com/shorts/AbC_123?feature=share&value=one%26two&from=other'
      : 'https://www.instagram.com/reel/AbC_123/?igsh=hello%2Bworld&other=two';
    const pattern = new RegExp(rule.condition.regexFilter);
    assert.equal(pattern.exec(source)?.[0], source, 'network redirects must capture the complete URL');
    const target = new URL(source.replace(pattern, match => rule.action.redirect.regexSubstitution.replace('\\0', match)));
    assert.ok(target.hash.startsWith('#source='));
    const from = target.hash.slice('#source='.length);
    const feature = SHORT_FORM_FEATURES.find(item => item.key === target.searchParams.get('feature'));
    assert.ok(feature);
    assert.equal(from, source, 'raw fragment source keeps query separators and encoded bytes');
    assert.equal(target.searchParams.get('site'), feature.site);
    assert.equal(target.pathname, '/blocked.html');
    assert.equal(getBlockedRule(from, configuration), feature.key);
    assert.equal(rule.priority, 2);
    assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    assert.equal(networkAction(from, rules, 'media'), null);
    assert.equal(networkAction(from, rules, 'sub_frame'), null);
  }
  assert.deepEqual(buildRules({...configuration, enabled: false}, origin), []);
});
