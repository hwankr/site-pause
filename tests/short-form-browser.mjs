import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Real Chromium + unpacked extension, disposable profile, synthetic site DOM.
// Overrides: PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE, BROWSER_SCREENSHOT_DIR.
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'outputs', 'site-pause');
const profile = await mkdtemp(path.join(tmpdir(), 'site-pause-short-form-test-'));
const screenshots = path.resolve(process.env.BROWSER_SCREENSHOT_DIR || path.join(root, 'work', 'short-form-check'));
const empty = {sites: [], blockedPages: [], allowedSites: [], allowedPages: [], youtubeShorts: false, instagramReels: false};
const errors = [];
let context;
let checks = 0;
const passed = label => { checks++; console.log(`PASS ${label}`); };

const youtubeFixture = `<!doctype html><meta charset="utf-8"><title>YouTube fixture</title>
<style>ytd-reel-shelf-renderer,ytd-rich-item-renderer,ytd-reel-item-renderer,ytd-guide-entry-renderer,yt-lockup-view-model {display:block;padding:8px}</style>
<h1 id="fixture">YouTube</h1>
<ytd-guide-entry-renderer id="shorts-nav"><a href="/shorts/">Shorts</a></ytd-guide-entry-renderer>
<ytd-guide-entry-renderer id="shorts-no-href"><a title="Shorts">Shorts</a></ytd-guide-entry-renderer>
<a id="regular-nav" href="/feed/subscriptions">Subscriptions</a>
<ytd-reel-shelf-renderer id="shelf"><ytd-reel-item-renderer id="short-card"><a id="short-link" href="/shorts/blocked123">Short</a><video id="short-video"></video></ytd-reel-item-renderer></ytd-reel-shelf-renderer>
<ytd-rich-item-renderer id="regular-card"><a href="/watch?v=normal123">Regular video</a></ytd-rich-item-renderer>
<yt-lockup-view-model id="modern-card"><a href="/shorts/modern123">Modern short</a></yt-lockup-view-model>
<grid-shelf-view-model id="modern-shelf"><ytm-shorts-lockup-view-model-v2><a href="/shorts/v2short123">New short</a></ytm-shorts-lockup-view-model-v2></grid-shelf-view-model>
<grid-shelf-view-model id="mixed-grid"><ytm-shorts-lockup-view-model-v2><a href="/shorts/v2mixed123">Short</a></ytm-shorts-lockup-view-model-v2><a href="/watch?v=normal123">Normal</a></grid-shelf-view-model>
<ytd-reel-item-renderer id="recycled"><a id="recycled-link" href="/shorts/recycled123">Recycled</a></ytd-reel-item-renderer>
<ytd-rich-item-renderer id="mixed-card"><a href="/watch?v=mixed123">Ordinary</a><a id="mixed-short" href="/shorts/mixed123">Short</a></ytd-rich-item-renderer>
<ytd-reel-shelf-renderer id="allowed-shelf"><ytd-reel-item-renderer id="allowed-card"><a href="/shorts/allowed123">Allowed short</a></ytd-reel-item-renderer><ytd-reel-item-renderer id="neighbor-card"><a href="/shorts/neighbor123">Blocked neighbor</a></ytd-reel-item-renderer></ytd-reel-shelf-renderer>`;
const instagramFixture = `<!doctype html><meta charset="utf-8"><title>Instagram fixture</title>
<h1 id="fixture">Instagram</h1><nav><a id="reels-nav" href="/reels/">Reels</a><a id="dm" href="/direct/inbox/">DM</a><a id="profile" href="/person/">Profile</a></nav>
<a id="reel-card" href="/reel/reel123/"><img alt="Reel thumbnail"><video id="reel-video"></video></a>
<a id="photo" href="/p/photo123/">Photo</a><a id="profile-reels" href="/person/reels/">Profile reels</a>
<article id="mixed-post"><p>Keep this caption</p><a id="embedded-reel" href="/reel/embedded123/">Reel link</a><a id="mixed-photo" href="/p/photo456/">Photo</a></article>`;

async function launch() {
  const result = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
    viewport: {width: 1100, height: 1000}, ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  result.setDefaultTimeout(8000);
  result.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await result.route(/^https?:\/\//, route => route.fulfill({contentType: 'text/html; charset=utf-8',
    body: new URL(route.request().url()).hostname.replace(/\.$/, '').endsWith('instagram.com') ? instagramFixture : youtubeFixture}));
  return result;
}

async function screenshot(page, name) {
  await mkdir(screenshots, {recursive: true});
  await page.screenshot({path: path.join(screenshots, `${name}.png`), fullPage: true, animations: 'disabled'});
}

try {
  context = await launch();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  let options = await context.newPage();
  await options.goto(`${origin}/options.html`);
  await options.waitForFunction(() => !document.getElementById('youtube-shorts').disabled);
  const message = async (type, payload = {}) => {
    const response = await options.evaluate(data => chrome.runtime.sendMessage(data), {type, ...payload});
    assert.equal(response.ok, true, response.error);
    return response.state;
  };
  const save = async () => {
    await options.locator('#save-button').click();
    await options.waitForFunction(() => document.getElementById('save-message').textContent === '저장 완료');
    assert.equal(await options.locator('#save-button').isDisabled(), true);
  };
  async function visit(address, heading) {
    const page = await context.newPage();
    try { await page.goto(address); }
    catch (error) { if (!/ERR_ABORTED|interrupted by another navigation/.test(error.message)) throw error; }
    if (heading) {
      await page.waitForFunction(value => document.getElementById('blocked-heading')?.textContent === value, heading);
      assert.equal(new URL(page.url()).pathname, '/blocked.html');
    } else {
      await page.locator('#fixture').waitFor();
      assert.equal(page.url(), address);
    }
    return page;
  }
  const visible = async (page, selector, yes = true) => {
    await page.locator(selector).waitFor({state: yes ? 'visible' : 'hidden'});
  };

  assert.equal(await options.locator('#youtube-shorts').isChecked(), false);
  assert.equal(await options.locator('#instagram-reels').isChecked(), false);
  const youtube = await visit('https://www.youtube.com/');
  const instagram = await visit('https://www.instagram.com/');
  await visible(youtube, '#short-card');
  await visible(instagram, '#reel-card');
  await options.locator('#youtube-shorts').focus();
  await options.keyboard.press('Space');
  await options.locator('#instagram-reels').check();
  assert.equal(await options.locator('#draft-status').isVisible(), true);
  assert.equal((await message('GET_STATE')).youtubeShorts, false, 'selection is a draft until saved');
  await save();
  assert.equal((await message('GET_STATE')).enabled, false);
  assert.equal(await options.locator('#toggle-button').isDisabled(), false);
  await options.locator('#toggle-button').click();
  await options.waitForFunction(() => document.getElementById('toggle-button').getAttribute('aria-checked') === 'true');
  await visible(youtube, '#short-card', false);
  await visible(instagram, '#reel-card', false);
  passed('feature-only settings save, keyboard toggles work, and enabling affects already open pages');

  for (const selector of ['#shelf', '#shorts-nav', '#shorts-no-href', '#modern-card', '#modern-shelf', '#mixed-short']) await visible(youtube, selector, false);
  for (const selector of ['#regular-nav', '#regular-card', '#mixed-card', '#mixed-grid']) await visible(youtube, selector);
  for (const selector of ['#reels-nav', '#profile-reels', '#embedded-reel']) await visible(instagram, selector, false);
  for (const selector of ['#dm', '#profile', '#photo', '#mixed-post', '#mixed-photo']) await visible(instagram, selector);
  await youtube.evaluate(() => {
    document.getElementById('recycled-link').href = '/watch?v=recycled123';
    const card = document.createElement('ytd-rich-item-renderer');
    card.id = 'dynamic-card'; card.innerHTML = '<a href="/shorts/dynamic123">Dynamic</a>';
    document.body.append(card);
  });
  await visible(youtube, '#recycled');
  await visible(youtube, '#dynamic-card', false);
  await instagram.evaluate(() => { document.getElementById('reel-card').href = '/p/reused123/'; });
  await visible(instagram, '#reel-card');
  passed('menus/cards and dynamically added shorts hide; ordinary content and recycled cards remain usable');

  await youtube.evaluate(() => {
    const video = document.getElementById('short-video');
    const canvas = document.createElement('canvas');
    video.addEventListener('play', () => { video.dataset.playAttempted = 'true'; }, {once: true});
    video.muted = true;
    video.srcObject = canvas.captureStream(10);
    canvas.getContext('2d').fillRect(0, 0, 20, 20);
    void video.play().catch(() => {});
  });
  await youtube.waitForFunction(() => {
    const video = document.getElementById('short-video');
    return video.dataset.playAttempted === 'true' && video.paused;
  });
  await youtube.evaluate(() => {
    const video = document.getElementById('short-video');
    video.srcObject.getTracks().forEach(track => track.stop());
    window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted: true}));
  });
  await visible(youtube, '#shelf');
  await youtube.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted: true})));
  await visible(youtube, '#shelf', false);
  passed('hidden videos cannot resume autoplay and cached-page lifecycle restores active hiding');

  const dottedYoutube = await visit('https://www.youtube.com./');
  const dottedInstagram = await visit('https://www.instagram.com./');
  await visible(dottedYoutube, '#shelf', false);
  await visible(dottedYoutube, '#regular-card');
  await visible(dottedInstagram, '#reel-card', false);
  await visible(dottedInstagram, '#photo');
  await dottedYoutube.close();
  await dottedInstagram.close();
  passed('fully qualified hostnames use the same content hiding and preserve ordinary content');

  const dnr = await worker.evaluate(async () => {
    const rules = await chrome.declarativeNetRequest.getDynamicRules();
    const checks = [];
    for (const [url, type] of [
      ['https://www.youtube.com/shorts/abc?one=1&two=2', 'main_frame'],
      ['https://m.youtube.com/shorts', 'main_frame'],
      ['https://www.instagram.com/reel/abc/', 'main_frame'],
      ['https://www.instagram.com/person/reels/', 'main_frame'],
      ['https://www.youtube.com/watch?v=abc', 'main_frame'],
      ['https://www.youtube.com/shortstory', 'main_frame'],
      ['https://www.instagram.com/direct/inbox/', 'main_frame'],
      ['https://youtube.com.evil.test/shorts/abc', 'main_frame'],
      ['https://www.youtube.com/shorts/abc', 'sub_frame']
    ]) checks.push((await chrome.declarativeNetRequest.testMatchOutcome({url, type})).matchedRules.length);
    return {checks, count: rules.length, valid: await Promise.all(rules.map(rule => chrome.declarativeNetRequest.isRegexSupported({regex: rule.condition.regexFilter, isCaseSensitive: true, requireCapturing: true})))};
  });
  assert.deepEqual(dnr.checks.map(Boolean), [true, true, true, true, false, false, false, false, false]);
  assert.equal(dnr.count, 2);
  assert.ok(dnr.valid.every(result => result.isSupported));
  const source = 'https://www.youtube.com/shorts/source123?one=1&two=a%26b';
  const blocked = await visit(source, 'YouTube 쇼츠 차단 중');
  const dottedSource = 'https://www.youtube.com./shorts/dotted123?one=1&two=2';
  const dottedBlocked = await visit(dottedSource, 'YouTube 쇼츠 차단 중');
  await screenshot(blocked, 'short-form-blocked');
  for (const address of ['https://www.instagram.com/reels/', 'https://www.instagram.com/reel/abc/', 'https://www.instagram.com/person/reels/']) {
    await (await visit(address, 'Instagram 릴스 차단 중')).close();
  }
  for (const address of ['https://www.youtube.com/watch?v=abc', 'https://www.instagram.com/p/photo123/', 'https://www.instagram.com/direct/inbox/']) await (await visit(address)).close();
  passed('Chromium accepts real DNR rules and redirects feature routes while ordinary pages and subframes stay open');

  await message('SAVE_RULES', {allowedPages: ['https://www.youtube.com/shorts', 'https://www.youtube.com/shorts/allowed123']});
  await blocked.waitForFunction(() => document.body.dataset.enabled === 'true');
  await visible(youtube, '#allowed-shelf');
  await visible(youtube, '#allowed-card');
  await visible(youtube, '#neighbor-card', false);
  await visible(youtube, '#shorts-no-href');
  await (await visit('https://www.youtube.com/shorts/allowed123')).close();
  await message('SAVE_RULES', {allowedPages: ['https://www.youtube.com/']});
  await visible(youtube, '#shelf');
  await youtube.evaluate(() => history.pushState({}, '', '/feed/subscriptions'));
  await visible(youtube, '#shelf', false);
  await youtube.evaluate(() => history.pushState({}, '', '/shorts/spa123'));
  await youtube.waitForFunction(() => document.getElementById('blocked-heading')?.textContent === 'YouTube 쇼츠 차단 중');
  const instagramSpa = await visit('https://www.instagram.com/direct/inbox/');
  await instagramSpa.evaluate(() => history.pushState({}, '', '/reels/'));
  await instagramSpa.waitForFunction(() => document.getElementById('blocked-heading')?.textContent === 'Instagram 릴스 차단 중');
  await instagramSpa.close();
  passed('allowed links survive inside shelves, current-page exceptions restore content, and SPA entries are blocked');

  await message('SAVE_RULES', {allowedSites: ['youtube.com'], allowedPages: []});
  const allowedHome = await visit('https://www.youtube.com/');
  await visible(allowedHome, '#shelf');
  await options.locator('#youtubeShorts-notice').waitFor({state: 'visible'});
  assert.match(await options.locator('#youtubeShorts-notice').textContent(), /허용.*우선/);
  await message('SAVE_RULES', {allowedSites: []});
  await visible(allowedHome, '#shelf', false);
  await message('SET_ENABLED', {enabled: false});
  await visible(allowedHome, '#shelf');
  await visible(instagram, '#reels-nav');
  await blocked.locator('#return-link').waitFor({state: 'visible'});
  assert.equal(await blocked.locator('#return-link').getAttribute('href'), source, 'DNR redirect preserves all original query parameters');
  await dottedBlocked.locator('#return-link').waitFor({state: 'visible'});
  assert.equal(await dottedBlocked.locator('#return-link').getAttribute('href'), dottedSource);
  await message('SET_ENABLED', {enabled: true});
  await message('SAVE_RULES', {youtubeShorts: false});
  await visible(allowedHome, '#shelf');
  await visible(instagram, '#reels-nav', false);
  await message('SAVE_RULES', {youtubeShorts: true});
  passed('site exceptions, global disable, and independent feature toggles restore content and exact return URLs');

  // Only locally edited fields should win over simultaneous settings changes.
  await options.locator('#site-input').fill('draft.example.test');
  await message('SAVE_RULES', {instagramReels: false});
  await options.waitForFunction(() => !document.getElementById('instagram-reels').checked);
  assert.equal(await options.locator('#site-input').inputValue(), 'draft.example.test');
  await save();
  assert.equal((await message('GET_STATE')).instagramReels, false);
  await message('SAVE_RULES', {...empty, youtubeShorts: true, instagramReels: true});
  await options.waitForFunction(() => document.getElementById('instagram-reels').checked);
  passed('external settings changes merge with unrelated unsaved address drafts');

  const popup = await context.newPage();
  await popup.setViewportSize({width: 340, height: 760});
  await popup.goto(`${origin}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('site-count').textContent === '2');
  assert.deepEqual(await popup.locator('#site-list .site-domain').allTextContents(), ['YouTube 쇼츠', 'Instagram 릴스']);
  await screenshot(popup, 'short-form-popup');
  await screenshot(options, 'short-form-options');
  await options.setViewportSize({width: 320, height: 900});
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await screenshot(options, 'short-form-options-320');
  passed('popup shows selected features and settings fit 320px without horizontal overflow');

  await context.close();
  context = await launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  options = await context.newPage();
  await options.goto(`${origin}/options.html`);
  await options.waitForFunction(() => !document.getElementById('youtube-shorts').disabled);
  const restored = await message('GET_STATE');
  assert.equal(restored.enabled, true);
  assert.equal(restored.youtubeShorts, true);
  assert.equal(restored.instagramReels, true);
  await (await visit('https://www.youtube.com/shorts/restarted123', 'YouTube 쇼츠 차단 중')).close();
  await message('SAVE_RULES', empty);
  assert.equal((await message('GET_STATE')).enabled, false);
  assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()), []);
  assert.deepEqual(errors, []);
  passed('browser restart restores feature-only blocking; removing the last feature disables it cleanly');
  console.log(`Short-form browser integration: ${checks} checks passed.`);
} finally {
  await context?.close();
  const resolved = path.resolve(profile);
  assert.ok(resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`) && path.basename(resolved).startsWith('site-pause-short-form-test-'));
  await rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 150});
}
