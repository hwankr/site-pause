import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Real MV3 favicon handling, with synthetic navigation and a disposable profile.
// Overrides: PLAYWRIGHT_MODULE_PATH and CHROMIUM_EXECUTABLE.
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'outputs', 'site-pause');
const temporaryRoot = path.resolve(tmpdir());
const profile = await mkdtemp(path.join(temporaryRoot, 'site-pause-favicon-test-'));
const iconPng = await readFile(path.join(extensionPath, 'icons', '32.png'));
const fixtureHost = 'favicon-fixture.test';
const fixtureOrigin = `https://${fixtureHost}`;
const errors = [];
let context;
let checks = 0;
const passed = label => { checks++; console.log(`PASS ${label}`); };

async function launch() {
  const browserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
    headless: true,
    viewport: {width: 1000, height: 1000},
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  browserContext.setDefaultTimeout(8000);
  browserContext.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await browserContext.route(/^https?:\/\//, route => {
    if (new URL(route.request().url()).pathname === '/fixture-icon.png') {
      return route.fulfill({contentType: 'image/png', body: iconPng});
    }
    return route.fulfill({contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><meta charset="utf-8"><title>Private fixture tab title</title>' +
        '<link rel="icon" type="image/png" sizes="32x32" href="/fixture-icon.png"><h1>Favicon fixture</h1>'});
  });
  return browserContext;
}

async function optionsPage(origin) {
  const page = await context.newPage();
  await page.goto(`${origin}/options.html`);
  await page.waitForFunction(() => !document.getElementById('site-input').disabled);
  return page;
}

async function loadedIcons(page, selector) {
  await page.waitForFunction(selector => {
    const icons = [...document.querySelectorAll(selector)];
    return icons.length > 0 && icons.every(icon => icon.complete && icon.naturalWidth > 0 && !icon.hidden);
  }, selector);
  const sources = await page.locator(selector).evaluateAll(icons => icons.map(icon => icon.src));
  for (const source of sources) {
    const url = new URL(source);
    assert.equal(url.protocol, 'chrome-extension:');
    assert.equal(url.pathname, '/_favicon/');
    assert.equal(url.searchParams.get('size'), '32');
    const target = new URL(url.searchParams.get('pageUrl'));
    assert.equal(target.pathname, '/');
    assert.equal(target.search, '');
    assert.equal(target.hash, '');
    assert.equal(target.username, '');
    assert.equal(target.password, '');
  }
  assert.equal(await page.locator(selector).evaluateAll(icons =>
    icons.every(icon => icon.parentElement.querySelector('.site-icon-fallback').hidden)), true);
}

async function matchesFixtureIcon(locator) {
  return locator.evaluate(async image => {
    const expected = new Image();
    expected.src = chrome.runtime.getURL('/icons/32.png');
    await expected.decode();
    const pixels = source => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      canvas.getContext('2d').drawImage(source, 0, 0, 32, 32);
      return canvas.toDataURL();
    };
    return pixels(image) === pixels(expected);
  });
}

try {
  context = await launch();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  let options = await optionsPage(extensionOrigin);
  assert.ok((await worker.evaluate(() => chrome.runtime.getManifest())).permissions.includes('favicon'));
  assert.equal((await options.evaluate(() => chrome.runtime.sendMessage({type: 'SET_USAGE_ENABLED', enabled: false}))).ok, true);
  const fixture = await context.newPage();
  await fixture.goto(`${fixtureOrigin}/private-path?token=not-persisted`);
  await fixture.waitForFunction(() => document.title === 'Private fixture tab title');
  await options.waitForFunction(async fixtureOrigin => {
    const tabs = await chrome.tabs.query({url: `${fixtureOrigin}/*`});
    return tabs.some(tab => tab.favIconUrl === `${fixtureOrigin}/fixture-icon.png`);
  }, fixtureOrigin);
  const youtubeFixture = await context.newPage();
  await youtubeFixture.goto('https://www.youtube.com/');
  await options.waitForFunction(async () => {
    const tabs = await chrome.tabs.query({url: 'https://www.youtube.com/*'});
    return tabs.some(tab => tab.favIconUrl === 'https://www.youtube.com/fixture-icon.png');
  });

  const saved = await options.evaluate(async ({fixtureHost, fixtureOrigin}) => {
    const result = await chrome.runtime.sendMessage({type: 'SAVE_RULES',
      sites: ['youtube.com', fixtureHost], blockedPages: [`${fixtureOrigin}/private/document?token=private-query`],
      allowedSites: [], allowedPages: [], youtubeShorts: false, instagramReels: false});
    const today = new Date();
    const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    await chrome.storage.local.set({sitePauseUsage: {enabled: false,
      days: {[date]: {'youtube.com': 12 * 60000, [fixtureHost]: 6 * 60000}}, checkpoint: null}});
    return result;
  }, {fixtureHost, fixtureOrigin});
  assert.equal(saved.ok, true, saved.error);
  await fixture.close();
  await youtubeFixture.close();
  await context.close();
  context = await launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  options = await optionsPage(extensionOrigin);
  const before = await options.evaluate(() => chrome.storage.local.get(null));
  await loadedIcons(options, '#site-list .site-icon-image');
  assert.equal(await options.locator('.site-domain[title="youtube.com"]').textContent(), 'YouTube');
  assert.equal(await options.locator(`.site-domain[title="${fixtureHost}"]`).textContent(), fixtureHost);
  const youtubeIcon = options.locator('#site-list .site-row').filter({has: options.locator('.site-domain[title="youtube.com"]')})
    .locator('.site-icon-image');
  assert.equal(new URL(await youtubeIcon.getAttribute('src')).searchParams.get('pageUrl'), 'https://www.youtube.com/');
  assert.equal(await matchesFixtureIcon(youtubeIcon), true, 'a normalized YouTube domain finds its actual www favicon');
  passed('site management resolves the actual cached www YouTube icon and preserves unknown labels');

  const popup = await context.newPage();
  await popup.setViewportSize({width: 380, height: 600});
  await popup.goto(`${extensionOrigin}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('.popup-usage').getAttribute('aria-busy') === 'false');
  await loadedIcons(popup, '#usage-list .site-icon-image');
  await loadedIcons(popup, '#site-list .site-icon-image');
  assert.equal(await popup.locator('#usage-list .site-icon-image').count(), 2);
  const usage = await context.newPage();
  await usage.goto(`${extensionOrigin}/usage.html`);
  await usage.waitForFunction(() => document.getElementById('usage-report').getAttribute('aria-busy') === 'false');
  await loadedIcons(usage, '#usage-sites .site-icon-image');
  passed('popup usage, popup block rules and usage details render loaded favicon images');

  const probeUrl = await options.evaluate(async () => {
    const {createSiteIcon} = await import('./site-icons.js');
    const icon = createSiteIcon('https://user:secret@favicon-fixture.test/private/document?token=private-query#section');
    icon.id = 'favicon-private-probe';
    document.body.append(icon);
    return icon.querySelector('img').src;
  });
  assert.equal(new URL(probeUrl).searchParams.get('pageUrl'), `${fixtureOrigin}/`);
  await loadedIcons(options, '#favicon-private-probe .site-icon-image');
  assert.equal(await matchesFixtureIcon(options.locator('#favicon-private-probe .site-icon-image')), true,
    'Chrome returns a host favicon cached at a private path without requiring a homepage visit');
  passed('origin-only lookup finds a private-path cached favicon while excluding paths, queries, fragments and credentials');

  await options.locator('#favicon-private-probe .site-icon-image').evaluate(image => {
    image.src = chrome.runtime.getURL('/missing-favicon-test-image.png');
  });
  await options.waitForFunction(() => {
    const icon = document.getElementById('favicon-private-probe');
    const image = icon.querySelector('img');
    return image.complete && image.naturalWidth === 0 && image.hidden &&
      !icon.querySelector('.site-icon-fallback').hidden;
  });
  assert.equal(await options.locator('#favicon-private-probe .site-icon-fallback').isVisible(), true);
  assert.equal(await options.locator('#favicon-private-probe .site-icon-image').isVisible(), false);
  passed('an actual failed image request restores the visible fallback without a broken image');

  const after = await options.evaluate(() => chrome.storage.local.get(null));
  assert.deepEqual(after, before, 'reading favicons and a failed icon must not mutate extension storage');
  assert.equal(JSON.stringify(after.sitePauseUsage).includes('Private fixture tab title'), false);
  assert.equal(JSON.stringify(after.sitePauseUsage).includes('private-query'), false);
  assert.deepEqual(errors, []);
  passed('favicon rendering adds no stored titles, paths or image data and emits no page errors');
  console.log(`Completed ${checks} favicon browser checks.`);
} finally {
  await context?.close();
  const resolvedProfile = path.resolve(profile);
  assert.equal(path.dirname(resolvedProfile), temporaryRoot);
  assert.ok(path.basename(resolvedProfile).startsWith('site-pause-favicon-test-'));
  await rm(resolvedProfile, {recursive: true, force: true});
}
