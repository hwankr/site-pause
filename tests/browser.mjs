import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// npm install --no-save playwright && npx playwright install chromium
// Optional overrides: PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE,
// and BROWSER_SCREENSHOT_DIR. Only this test's disposable profile is used.
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'outputs', 'site-pause');
const profile = await mkdtemp(path.join(tmpdir(), 'site-pause-browser-test-'));
const emptyRules = {sites: [], blockedPages: [], allowedSites: [], allowedPages: []};
const song = 'https://www.youtube.com/watch?v=music123abc';
const privatePage = 'https://example.test/private?item=1';
const pageErrors = [];
let context;
let checks = 0;

function passed(label) {
  checks++;
  console.log(`PASS ${label}`);
}

try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
    headless: true,
    viewport: {width: 1100, height: 1000},
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  context.setDefaultTimeout(8000);
  context.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  // Fixtures replace the destination response, but Chromium still evaluates the
  // real extension's DNR rules. No request to YouTube or example.test is sent.
  await context.route(/^https?:\/\//, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta charset="utf-8"><title>Navigation fixture</title><h1 id="fixture">Navigation fixture</h1>'
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // URL.origin is "null" for chrome-extension URLs in Node.
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).host}`;
  const options = await context.newPage();
  await options.goto(`${extensionOrigin}/options.html`);
  await options.locator('#site-input').waitFor({state: 'visible'});
  await options.waitForFunction(() => !document.getElementById('site-input').disabled);

  async function screenshot(page, name) {
    if (!process.env.BROWSER_SCREENSHOT_DIR) return;
    const destination = path.resolve(process.env.BROWSER_SCREENSHOT_DIR);
    await mkdir(destination, {recursive: true});
    await page.screenshot({path: path.join(destination, `${name}.png`), fullPage: true, animations: 'disabled'});
  }

  async function selectRule(kind) {
    const action = kind.startsWith('allowed') ? 'allow' : 'block';
    const scope = kind.endsWith('Pages') ? 'page' : 'site';
    await options.locator(`input[name="rule-action"][value="${action}"]`).focus();
    await options.keyboard.press('Space');
    await options.locator('#scope-button').click();
    await options.locator(`#scope-menu [data-scope="${scope}"]`).click();
  }

  async function message(type, payload = {}) {
    const response = await options.evaluate(data => chrome.runtime.sendMessage(data), {type, ...payload});
    assert.equal(response.ok, true, response.error);
    return response.state;
  }

  async function saveFromUi() {
    await options.locator('#save-button').click();
    await options.waitForFunction(() => !document.getElementById('save-button').textContent.includes('저장 중') &&
      document.getElementById('save-message').textContent.length > 0);
    assert.equal(await options.locator('#save-message').textContent(), '저장 완료');
    assert.equal(await options.locator('#save-button').isDisabled(), true);
  }

  async function visit(address, blocked) {
    const page = await context.newPage();
    try {
      await page.goto(address);
    } catch (error) {
      // Tab enforcement can supersede the navigation being awaited.
      if (!/ERR_ABORTED|interrupted by another navigation/.test(error.message)) throw error;
    }
    if (blocked) {
      await page.locator('#blocked-heading').waitFor();
      assert.equal(new URL(page.url()).pathname, '/blocked.html');
      await page.waitForFunction(() => document.body.dataset.enabled === 'true');
      assert.equal(await page.locator('#blocked-heading').textContent(), '사이트 차단 중');
    } else {
      await page.locator('#fixture').waitFor();
      assert.equal(page.url(), address);
    }
    return page;
  }

  async function assertDnr(address, expected, resourceType = 'main_frame') {
    const {rules, matches} = await worker.evaluate(async ({address, resourceType}) => ({
      rules: await chrome.declarativeNetRequest.getDynamicRules(),
      matches: await chrome.declarativeNetRequest.testMatchOutcome({url: address, type: resourceType})
    }), {address, resourceType});
    const ids = new Set(matches.matchedRules.map(match => match.ruleId));
    const winner = rules.filter(rule => ids.has(rule.id)).sort((a, b) => b.priority - a.priority)[0];
    assert.equal(winner?.action.type ?? null, expected, `Chromium DNR: ${address}`);
  }

  assert.equal(await options.locator('#toggle-button').isDisabled(), true);
  await screenshot(options, 'rules-empty');
  const actionBlock = options.locator('input[name="rule-action"][value="block"]');
  const actionAllow = options.locator('input[name="rule-action"][value="allow"]');
  await actionBlock.focus();
  await options.keyboard.press('ArrowRight');
  assert.equal(await actionAllow.isChecked(), true, 'native radio arrow keys select Allow');
  await options.keyboard.press('ArrowLeft');
  assert.equal(await actionBlock.isChecked(), true, 'native radio arrow keys select Block');
  const scopeButton = options.locator('#scope-button');
  const scopeMenu = options.locator('#scope-menu');
  await scopeButton.focus();
  await options.keyboard.press('ArrowDown');
  assert.equal(await scopeButton.getAttribute('aria-expanded'), 'true');
  await options.keyboard.press('ArrowDown');
  await options.keyboard.press('Enter');
  assert.equal(await scopeButton.getAttribute('aria-expanded'), 'false');
  assert.equal(await options.evaluate(() => document.activeElement.id), 'scope-button');
  await scopeButton.click();
  assert.equal(await scopeMenu.locator('[data-scope="page"]').getAttribute('aria-selected'), 'true');
  await screenshot(options, 'rules-dropdown');
  await options.keyboard.press('Escape');
  assert.equal(await scopeButton.getAttribute('aria-expanded'), 'false');
  assert.equal(await options.evaluate(() => document.activeElement.id), 'scope-button');
  await scopeButton.click();
  await options.locator('#site-input').click();
  assert.equal(await scopeButton.getAttribute('aria-expanded'), 'false');
  assert.equal(await options.evaluate(() => document.activeElement.id), 'site-input');
  await scopeButton.click();
  await options.keyboard.press('Home');
  assert.equal(await options.evaluate(() => document.activeElement.dataset.scope), 'site');
  await options.keyboard.press('End');
  assert.equal(await options.evaluate(() => document.activeElement.dataset.scope), 'page');
  await options.keyboard.press('Tab');
  assert.equal(await scopeButton.getAttribute('aria-expanded'), 'false');
  assert.equal(await options.evaluate(() => document.activeElement.id), 'site-input');
  passed('action radios and custom scope dropdown support keyboard, Escape, outside click and focus restoration');

  await selectRule('allowedPages');
  await options.locator('#site-input').fill('https://youtu.be/music123abc?si=tracking');
  // Saving also stages an address that has not separately been added.
  await saveFromUi();
  assert.deepEqual((await message('GET_STATE')).allowedPages, [song]);
  assert.equal(await options.locator('#toggle-button').isDisabled(), true);
  passed('page exceptions can be saved; exception-only configurations cannot enable blocking');

  await selectRule('sites');
  await options.locator('#site-input').fill('youtube.com');
  await options.locator('#site-input').press('Enter');
  assert.equal(await options.locator('#site-input').inputValue(), '');
  assert.equal((await message('GET_STATE')).sites.length, 0, 'Enter stages a rule until Save');
  assert.equal(await options.locator('#draft-status').isVisible(), true);
  await options.locator('.quick-buttons [data-site="music.youtube.com"]').click();
  await selectRule('blockedPages');
  await options.locator('#site-input').fill(privatePage);
  await selectRule('allowedPages');
  assert.equal(await options.locator('#site-input').inputValue(), privatePage, 'switching action/scope preserves input');
  await selectRule('blockedPages');
  await options.locator('#add-button').click();
  assert.equal(await options.locator('#site-list li').count(), 4);
  passed('Enter stages rules and action/scope changes preserve unsaved input and staged rules');
  await saveFromUi();
  const saved = await message('GET_STATE');
  assert.deepEqual(saved, {enabled: false, sites: ['youtube.com'], blockedPages: [privatePage],
    allowedSites: ['music.youtube.com'], allowedPages: [song]});
  await options.locator('#toggle-button').click();
  await options.waitForFunction(() => document.getElementById('toggle-button').getAttribute('aria-checked') === 'true');
  passed('all four rule types persist through the actual options UI and blocking enables');

  const regexChecks = await worker.evaluate(async () => Promise.all(
    (await chrome.declarativeNetRequest.getDynamicRules()).filter(rule => rule.condition.regexFilter).map(async rule => ({
      id: rule.id,
      ...(await chrome.declarativeNetRequest.isRegexSupported({regex: rule.condition.regexFilter, isCaseSensitive: true}))
    }))
  ));
  assert.equal(regexChecks.length, 2);
  assert.ok(regexChecks.every(result => result.isSupported), JSON.stringify(regexChecks));
  for (const [address, action] of [
    ['https://www.youtube.com/', 'redirect'],
    ['https://www.youtube.com/watch?v=other123', 'redirect'],
    [song, 'allow'],
    [`${song}&t=45&list=playlist`, 'allow'],
    ['https://www.youtube.com/watch?list=playlist&v=music123abc', 'allow'],
    ['https://m.youtube.com/watch?v=music123abc', 'allow'],
    ['https://youtu.be/music123abc?si=tracking', 'allow'],
    ['https://www.youtube.com/watch?v=music123abc4', 'redirect'],
    ['https://www.youtube.com/watch?v=MUSIC123ABC', 'redirect'],
    ['https://www.youtube.com/watch?v=other123&v=music123abc', 'redirect'],
    ['https://www.youtube.com/watch?v=&v=music123abc', 'redirect'],
    ['https://www.youtube.com/watch?%76=other123&v=music123abc', 'redirect'],
    ['https://music.youtube.com/explore', 'allow'],
    [privatePage, 'redirect'],
    ['https://example.test/private?item=2', null],
    ['https://example.test/private/child?item=1', null],
    ['https://example.test/', null]
  ]) await assertDnr(address, action);
  await assertDnr('https://www.youtube.com/watch?v=other123', null, 'media');
  passed('Chromium accepts regex filters and resolves site/page exceptions with correct priority');

  for (const [address, blocked] of [
    ['https://www.youtube.com/', true],
    ['https://www.youtube.com/watch?v=other123', true],
    [song, false],
    [`${song}&t=45`, false],
    ['https://music.youtube.com/explore', false],
    [privatePage, true],
    ['https://example.test/private?item=2', false]
  ]) await (await visit(address, blocked)).close();
  passed('real main-frame navigations block other videos and allow the chosen song and YouTube Music');

  const spa = await visit(song, false);
  await spa.evaluate(() => history.pushState({}, '', '/watch?v=other123'));
  // Multiple tab/history events may supersede the first redirect navigation.
  await spa.locator('#blocked-heading').waitFor();
  assert.equal(new URL(spa.url()).pathname, '/blocked.html');
  assert.equal(new URLSearchParams(new URL(spa.url()).hash.slice(1)).get('from'),
    'https://www.youtube.com/watch?v=other123');
  await spa.close();
  passed('YouTube-style history.pushState navigation from an allowed video to a blocked video is enforced');

  await options.reload();
  await options.waitForFunction(() => !document.getElementById('site-input').disabled);
  assert.equal(await options.locator('#site-list li').count(), 4);
  await message('SAVE_RULES', {...emptyRules, sites: ['youtube.com'],
    allowedSites: ['music.youtube.com'], allowedPages: [song]});
  await options.waitForFunction(() => document.querySelectorAll('#site-list li').length === 3);
  const popup = await context.newPage();
  await popup.setViewportSize({width: 380, height: 540});
  await popup.goto(`${extensionOrigin}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('site-count').textContent === '1');
  assert.equal(await popup.locator('#exception-count').textContent(), '허용 예외 2개');
  await popup.locator('#toggle-button').click();
  await options.waitForFunction(() => document.body.dataset.enabled === 'false');
  await popup.waitForFunction(() => document.getElementById('toggle-button').getAttribute('aria-checked') === 'false' &&
    !document.getElementById('toggle-button').disabled);
  await popup.locator('#toggle-button').click();
  await options.waitForFunction(() => document.body.dataset.enabled === 'true');
  await popup.waitForFunction(() => document.getElementById('toggle-button').getAttribute('aria-checked') === 'true');
  await screenshot(options, 'rules-desktop');
  await screenshot(popup, 'rules-popup');
  await popup.close();
  await selectRule('allowedPages');
  await options.locator('#site-input').fill('https://www.youtube.com/watch?v=music123abc');
  await screenshot(options, 'rules-allow-composer');
  await options.locator('#site-input').fill('');
  await options.setViewportSize({width: 390, height: 844});
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    'narrow options page should not scroll horizontally');
  await screenshot(options, 'rules-mobile');
  await options.setViewportSize({width: 320, height: 780});
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true,
    '320px options page should not scroll horizontally');
  await scopeButton.click();
  const menuBounds = await scopeMenu.boundingBox();
  assert.ok(menuBounds && menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 321,
    'the open scope menu fits within a 320px viewport');
  await screenshot(options, 'rules-small-dropdown');
  await options.keyboard.press('Escape');
  await options.locator('#site-input').fill('https://www.youtube.com/watch?v=other123');
  const draftBounds = await options.locator('#draft-status').boundingBox();
  const saveBounds = await options.locator('#save-button').boundingBox();
  assert.ok(draftBounds && saveBounds && draftBounds.x + draftBounds.width <= saveBounds.x &&
    saveBounds.x + saveBounds.width <= 320, 'dirty footer text and Save fit without overlapping at 320px');
  await screenshot(options, 'rules-small-dirty');
  await options.locator('#site-input').fill('');
  await options.setViewportSize({width: 1100, height: 1000});
  passed('saved rules survive reload and settings, dropdown and popup fit desktop, 390px and 320px viewports');

  await scopeButton.click();
  const normalMotion = await options.evaluate(() => ({
    segment: getComputedStyle(document.querySelector('.segment-indicator')).transitionDuration,
    menu: getComputedStyle(document.getElementById('scope-menu')).animationDuration
  }));
  assert.ok(Number.parseFloat(normalMotion.segment) > 0 && Number.parseFloat(normalMotion.menu) > 0,
    'normal mode provides segment transitions and dropdown animation');
  await options.keyboard.press('Escape');
  await options.emulateMedia({reducedMotion: 'reduce'});
  await selectRule('allowedSites');
  await options.locator('#site-input').fill('motion.example.test');
  await options.locator('#site-input').press('Enter');
  assert.equal(await options.locator('#site-list .is-new').count(), 1);
  await scopeButton.click();
  const movingElements = await options.evaluate(() => {
    const durationSeconds = value => value.split(',').map(part => part.trim().endsWith('ms')
      ? Number.parseFloat(part) / 1000 : Number.parseFloat(part));
    return [...document.querySelectorAll('*')].flatMap(element => {
      const style = getComputedStyle(element);
      const animation = style.animationName !== 'none' && durationSeconds(style.animationDuration).some(time => time > 0.001);
      const transition = style.transitionProperty !== 'none' && durationSeconds(style.transitionDuration).some(time => time > 0.001);
      return animation || transition ? [{element: element.id || element.className, animation: style.animationDuration,
        transition: style.transitionDuration}] : [];
    });
  });
  assert.deepEqual(movingElements, [], 'reduced motion removes visible transitions and animations');
  await options.keyboard.press('Escape');
  await options.locator('#site-list button[data-site="motion.example.test"]').click();
  assert.equal(await options.locator('#save-button').isDisabled(), true);
  await options.emulateMedia({reducedMotion: 'no-preference'});
  passed('reduced-motion preference disables decorative transitions and animations');

  await message('SAVE_RULES', {...emptyRules, blockedPages: [privatePage]});
  assert.equal((await message('GET_STATE')).enabled, true);
  await (await visit('https://example.test/', false)).close();
  const blockedPage = await visit(privatePage, true);
  await screenshot(blockedPage, 'rules-blocked');
  await message('SAVE_RULES', {...emptyRules, blockedPages: [privatePage], allowedPages: [privatePage]});
  await blockedPage.locator('#return-link').waitFor({state: 'visible'});
  assert.equal(await blockedPage.locator('#return-link').getAttribute('href'), privatePage);
  await blockedPage.locator('#return-link').click();
  await blockedPage.locator('#fixture').waitFor();
  await blockedPage.close();
  passed('page-only blocking leaves the rest of the site open, and adding an exception releases the blocked page');

  await message('SET_ENABLED', {enabled: false});
  assert.deepEqual(await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules()), []);
  await (await visit(privatePage, false)).close();
  assert.deepEqual(pageErrors, []);
  passed('disabling removes network rules and all extension pages remain free of runtime errors');
  console.log(`Browser integration: ${checks} checks passed.`);
} finally {
  await context?.close();
  const resolvedProfile = path.resolve(profile);
  assert.ok(resolvedProfile.startsWith(`${path.resolve(tmpdir())}${path.sep}`) &&
    path.basename(resolvedProfile).startsWith('site-pause-browser-test-'), 'only remove this test temporary profile');
  await rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 150});
}
