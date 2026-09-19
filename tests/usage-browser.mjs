import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Run against the real unpacked extension in an isolated, disposable profile.
// Screenshot data below is a synthetic test fixture, never user browsing data.
// Overrides: PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE, BROWSER_SCREENSHOT_DIR.
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'outputs', 'site-pause');
const profile = await mkdtemp(path.join(tmpdir(), 'site-pause-usage-test-'));
const screenshotDirectory = path.resolve(process.env.BROWSER_SCREENSHOT_DIR || path.join(root, 'outputs', 'browser-check'));
const errors = [];
let context;
let checks = 0;
const passed = label => { checks++; console.log(`PASS ${label}`); };

async function launch() {
  const browserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
    headless: true,
    viewport: {width: 1100, height: 1100},
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  browserContext.setDefaultTimeout(8000);
  browserContext.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await browserContext.route(/^https?:\/\//, route => route.fulfill({
    contentType: 'text/html; charset=utf-8',
    body: '<!doctype html><meta charset="utf-8"><title>Usage fixture</title><h1 id="fixture">Usage fixture</h1>'
  }));
  return browserContext;
}

async function screenshot(page, name) {
  await mkdir(screenshotDirectory, {recursive: true});
  await page.screenshot({path: path.join(screenshotDirectory, `${name}.png`), fullPage: true, animations: 'disabled'});
}

async function ready(page) {
  await page.waitForFunction(() => document.getElementById('usage-report').getAttribute('aria-busy') === 'false' &&
    !document.getElementById('recording-toggle').disabled);
}

try {
  context = await launch();
  let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const seedPage = await context.newPage();
  await seedPage.goto(`${origin}/options.html`);
  await seedPage.waitForFunction(() => !document.getElementById('site-input').disabled);
  const fixture = await seedPage.evaluate(() => {
    const days = {};
    for (let offset = 29; offset >= 0; offset--) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      days[key] = offset === 0 ? {'youtube.com': 70 * 60000, 'github.com': 37 * 60000,
        'news.example.test': 9 * 60000, 'a-very-long-site-name-for-responsive-layout.example.test': 5 * 60000} :
        {'youtube.com': (20 + offset % 5 * 11) * 60000, 'github.com': (12 + offset % 4 * 9) * 60000};
    }
    return {enabled: true, days, checkpoint: null};
  });
  await seedPage.evaluate(async data => {
    await chrome.runtime.sendMessage({type: 'SAVE_RULES', sites: ['youtube.com', 'instagram.com', 'x.com'],
      blockedPages: [], allowedSites: ['music.youtube.com'], allowedPages: []});
    await chrome.storage.local.set({sitePauseUsage: data});
  }, fixture);
  // The background worker caches aggregates; restart the disposable browser to
  // load the fixture through the same persisted-state path as a real restart.
  await context.close();
  context = await launch();
  worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const options = await context.newPage();
  await options.goto(`${origin}/options.html`);
  await options.locator('.header-link').click();
  assert.equal(options.url(), `${origin}/usage.html`);
  const usage = options;
  await ready(usage);
  assert.equal(await usage.locator('#total-time').textContent(), '2시간 1분');
  assert.equal(await usage.locator('#total-sites').textContent(), '4개');
  assert.equal(await usage.locator('#usage-sites .usage-domain').first().textContent(), 'youtube.com');
  assert.equal(await usage.locator('#daily-section').isVisible(), false);
  assert.equal(await usage.locator('#recording-toggle').getAttribute('aria-checked'), 'true');
  passed('options usage link loads stored today totals and sites in descending order');

  for (const days of [7, 30, 1, 7]) {
    await usage.locator(`button[data-days="${days}"]`).click();
    await ready(usage);
    const response = await usage.evaluate(days => chrome.runtime.sendMessage({type: 'GET_USAGE', days}), days);
    assert.equal(response.ok, true);
    const dates = Object.keys(fixture.days).sort().slice(-days);
    const expected = dates.reduce((sum, date) => sum + Object.values(fixture.days[date]).reduce((a, b) => a + b, 0), 0);
    assert.equal(response.state.totalMs, expected);
    assert.equal(await usage.locator(`button[data-days="${days}"]`).getAttribute('aria-pressed'), 'true');
    if (days > 1) {
      assert.equal(await usage.locator('.daily-column').count(), days);
      assert.equal(await usage.locator('#daily-section').isVisible(), true);
    }
  }
  await usage.locator('.daily-column').first().focus();
  await usage.keyboard.press('Enter');
  assert.equal(await usage.locator('.daily-column').first().getAttribute('aria-pressed'), 'true');
  assert.match(await usage.locator('#daily-detail').textContent(), /월.*일 ·/);
  await screenshot(usage, 'usage-desktop');
  passed('today, 7-day and 30-day periods show correct totals; daily bars support keyboard selection');

  await usage.locator('#recording-toggle').focus();
  await usage.keyboard.press('Space');
  await usage.waitForFunction(() => document.getElementById('recording-toggle').getAttribute('aria-checked') === 'false' &&
    !document.getElementById('recording-toggle').disabled);
  assert.match(await usage.locator('#recording-status').textContent(), /일시 중지/);
  const preservedRows = await usage.locator('.usage-site').count();
  assert.equal(preservedRows, 4);
  await usage.locator('#recording-toggle').click();
  await usage.waitForFunction(() => document.getElementById('recording-toggle').getAttribute('aria-checked') === 'true' &&
    !document.getElementById('recording-toggle').disabled);
  passed('recording pauses and resumes through keyboard and pointer without deleting earlier totals');

  for (const width of [390, 320]) {
    await usage.setViewportSize({width, height: 1000});
    await usage.locator('button[data-days="30"]').click();
    await ready(usage);
    assert.equal(await usage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      `${width}px usage page has no horizontal overflow`);
    const overlaps = await usage.locator('.usage-site-details').evaluateAll(rows => rows.some(row => {
      const [host, value] = [...row.children].map(child => child.getBoundingClientRect());
      return host.right > value.left + 1;
    }));
    assert.equal(overlaps, false, `${width}px domain and duration do not overlap`);
    if (width === 390) await screenshot(usage, 'usage-mobile');
  }
  await usage.setViewportSize({width: 1100, height: 1100});
  passed('30-day chart and long domains fit 390px and 320px screens');

  const popup = await context.newPage();
  await popup.setViewportSize({width: 380, height: 600});
  await popup.goto(`${origin}/popup.html`);
  await popup.waitForFunction(() => document.querySelector('.popup-usage').getAttribute('aria-busy') === 'false' &&
    document.getElementById('site-count').textContent === '3');
  assert.equal(await popup.locator('#usage-total').textContent(), '2시간 1분');
  assert.equal(await popup.locator('#usage-list li').count(), 3);
  assert.equal(await popup.locator('#site-list .site-row').count(), 2);
  assert.equal(await popup.locator('#more-button').isVisible(), true);
  const popupSize = await popup.evaluate(() => ({height: document.querySelector('.popup-shell').getBoundingClientRect().height,
    width: document.documentElement.scrollWidth}));
  assert.ok(popupSize.height <= 600, `popup content height ${popupSize.height} <= 600px`);
  assert.ok(popupSize.width <= 380, `popup width ${popupSize.width} <= 380px`);
  await screenshot(popup, 'usage-popup');
  const linkedPagePromise = context.waitForEvent('page');
  await popup.locator('#usage-link').click();
  const linkedPage = await linkedPagePromise;
  await linkedPage.waitForURL(`${origin}/usage.html`);
  await ready(linkedPage);
  await linkedPage.close();
  await popup.close();
  passed('popup displays today and top 3, opens usage details, and fits 600px with two block rows and exceptions');

  await usage.bringToFront();
  await usage.locator('#clear-button').click();
  assert.equal(await usage.locator('#clear-confirmation').isVisible(), true);
  assert.equal(await usage.evaluate(() => document.activeElement.id), 'cancel-clear');
  await usage.keyboard.press('Escape');
  assert.equal(await usage.locator('#clear-confirmation').isVisible(), false);
  assert.equal(await usage.evaluate(() => document.activeElement.id), 'clear-button');
  await usage.locator('#clear-button').click();
  await usage.locator('#cancel-clear').click();
  assert.equal(await usage.locator('.usage-site').count(), 4);
  await usage.locator('button[data-days="1"]').click();
  await ready(usage);
  await usage.locator('#clear-button').click();
  await usage.locator('#confirm-clear').click();
  await usage.locator('#clear-confirmation').waitFor({state: 'hidden'});
  assert.equal(await usage.locator('#total-time').textContent(), '0분');
  assert.equal(await usage.locator('#usage-empty').isVisible(), true);
  const cleared = await usage.evaluate(() => chrome.runtime.sendMessage({type: 'GET_USAGE', days: 30}));
  assert.equal(cleared.state.totalMs, 0, 'all periods are cleared even when viewing today');
  assert.equal(await usage.evaluate(() => document.activeElement.id), 'clear-button');
  await screenshot(usage, 'usage-empty');
  passed('clear requires in-page confirmation; Escape/cancel preserve records and confirm clears all 30 days');

  const errorPage = await context.newPage();
  await errorPage.addInitScript(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    let fail = true;
    chrome.runtime.sendMessage = message => {
      if (message.type === 'GET_USAGE' && fail) {
        fail = false;
        return Promise.resolve({ok: false, error: '테스트 연결 오류'});
      }
      return original(message);
    };
  });
  await errorPage.goto(`${origin}/usage.html`);
  await errorPage.locator('#usage-error').waitFor({state: 'visible'});
  assert.equal(await errorPage.locator('#usage-error-text').textContent(), '테스트 연결 오류');
  await errorPage.locator('#retry-button').click();
  await ready(errorPage);
  assert.equal(await errorPage.locator('#usage-error').isVisible(), false);
  await errorPage.close();
  passed('a failed usage request presents an error and Retry recovers');

  // CI may have no recent OS keyboard/mouse activity. Simulate only the OS idle
  // reading inside this disposable worker; tab/window APIs, clock and storage
  // remain real. Deterministic unit tests exercise actual idle transitions.
  await worker.evaluate(() => {
    globalThis.__usageTestIdleQuery = chrome.idle.queryState;
    chrome.idle.queryState = () => Promise.resolve('active');
  });
  const active = await context.newPage();
  try {
    await active.goto('https://timer-fixture.example.test/private?secret=never-saved');
    await active.locator('#fixture').waitFor();
    await active.bringToFront();
    await usage.evaluate(() => chrome.runtime.sendMessage({type: 'GET_USAGE', days: 1}));
    await active.waitForTimeout(1300);
    const measured = await usage.evaluate(() => chrome.runtime.sendMessage({type: 'GET_USAGE', days: 1}));
    assert.equal(measured.ok, true);
    const recorded = measured.state.sites.find(site => site.host === 'timer-fixture.example.test');
    assert.ok(recorded?.ms > 0 && recorded.ms < 15000, `real active-tab interval recorded: ${JSON.stringify(recorded)}`);
    const saved = await usage.evaluate(() => chrome.storage.local.get('sitePauseUsage'));
    assert.equal(JSON.stringify(saved).includes('private'), false);
    assert.equal(JSON.stringify(saved).includes('secret'), false);
  } finally {
    await worker.evaluate(() => {
      chrome.idle.queryState = globalThis.__usageTestIdleQuery;
      delete globalThis.__usageTestIdleQuery;
    });
    await active.close();
  }
  assert.deepEqual(errors, []);
  passed('real active HTTP tab/clock/storage accrue domain time with simulated OS active state; no path/query or runtime errors');
  console.log(`Usage browser integration: ${checks} checks passed.`);
} finally {
  await context?.close();
  const resolvedProfile = path.resolve(profile);
  assert.ok(resolvedProfile.startsWith(`${path.resolve(tmpdir())}${path.sep}`) &&
    path.basename(resolvedProfile).startsWith('site-pause-usage-test-'), 'only remove this test temporary profile');
  await rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 150});
}
