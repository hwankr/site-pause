import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {cp, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Reproduce a new UI talking to the worker from before usage tracking existed.
// Both the extension copy and the browser profile are disposable; the installed
// extension, its source files, and the user's Chrome profile are never changed.
// Overrides: PLAYWRIGHT_MODULE_PATH, CHROMIUM_EXECUTABLE.
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceExtension = path.join(root, 'outputs', 'site-pause');
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'site-pause-upgrade-test-'));
const extensionPath = path.join(temporaryDirectory, 'extension');
const profile = path.join(temporaryDirectory, 'profile');
const pageErrors = [];
let context;
let checks = 0;
const passed = label => { checks++; console.log(`PASS ${label}`); };

async function launch() {
  const browserContext = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ...(process.env.CHROMIUM_EXECUTABLE ? {executablePath: process.env.CHROMIUM_EXECUTABLE} : {}),
    headless: true,
    viewport: {width: 1100, height: 1000},
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  browserContext.setDefaultTimeout(8000);
  browserContext.on('page', page => page.on('pageerror', error => pageErrors.push(error.message)));
  return browserContext;
}

try {
  await cp(sourceExtension, extensionPath, {recursive: true});
  const oldRevision = 'acb6f8844e512222a5f2d4e080bc42b88e7dc1ba';
  const oldBackground = execFileSync('git', ['show', `${oldRevision}:outputs/site-pause/background.js`],
    {cwd: root, encoding: 'utf8'});
  assert.ok(!oldBackground.includes('GET_USAGE'), 'the upgrade fixture must predate usage support');
  await writeFile(path.join(extensionPath, 'background.js'), oldBackground);
  context = await launch();
  const oldWorker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(oldWorker.url()).host}`;
  await oldWorker.evaluate(() => {
    globalThis.__upgradeMessages = [];
    globalThis.__upgradeErrors = [];
    chrome.runtime.onMessage.addListener(message => { globalThis.__upgradeMessages.push(message.type); });
    const originalError = console.error.bind(console);
    console.error = (...args) => {
      globalThis.__upgradeErrors.push(args.map(String).join(' '));
      originalError(...args);
    };
  });

  const options = await context.newPage();
  await options.goto(`${origin}/options.html`);
  await options.waitForFunction(() => !document.getElementById('site-input').disabled);
  const unsupported = await options.evaluate(() => chrome.runtime.sendMessage({type: 'GET_USAGE', days: 1}));
  assert.deepEqual(unsupported, {ok: false, error: '지원하지 않는 요청이에요.'});
  assert.ok((await oldWorker.evaluate(() => globalThis.__upgradeErrors)).some(error =>
    error === 'Site Pause: Error: 지원하지 않는 요청이에요.'));
  passed('the pre-usage worker reproduces the exact reported unsupported-request error');

  const savedRules = await options.evaluate(async () => {
    const saved = await chrome.runtime.sendMessage({type: 'SAVE_RULES', sites: ['example.test'],
      blockedPages: [], allowedSites: ['allowed.example.test'], allowedPages: []});
    if (!saved.ok) throw new Error(saved.error);
    const enabled = await chrome.runtime.sendMessage({type: 'SET_ENABLED', enabled: true});
    if (!enabled.ok) throw new Error(enabled.error);
    const date = new Date();
    const today = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    await chrome.storage.local.set({sitePauseUsage: {
      enabled: false, days: {[today]: {'fixture.example.test': 7 * 60000}}, checkpoint: null
    }});
    return enabled.state;
  });
  await oldWorker.evaluate(() => {
    globalThis.__upgradeMessages = [];
    globalThis.__upgradeErrors = [];
  });

  const popup = await context.newPage();
  await popup.setViewportSize({width: 380, height: 600});
  await popup.goto(`${origin}/popup.html`);
  await popup.locator('#reload-extension').waitFor({state: 'visible'});
  assert.match(await popup.locator('#usage-error').textContent(), /새로고침|업데이트/);
  assert.equal(await popup.locator('#site-count').textContent(), '1');
  assert.equal(await popup.locator('#toggle-button').getAttribute('aria-checked'), 'true');
  passed('new popup offers extension reload while existing blocking settings still work');

  const usage = await context.newPage();
  await usage.goto(`${origin}/usage.html`);
  await usage.locator('#reload-extension').waitFor({state: 'visible'});
  assert.match(await usage.locator('#usage-error-text').textContent(), /새로고침|업데이트/);
  assert.equal(await usage.locator('#recording-toggle').isDisabled(), true);
  assert.equal(await usage.locator('#clear-button').isDisabled(), true);
  passed('new usage page also identifies the old worker and offers extension reload');

  // Exercise visibility refreshes and at least one actual 15-second polling
  // interval, so the old worker cannot silently accumulate the reported errors.
  await popup.bringToFront();
  await usage.bringToFront();
  await usage.waitForTimeout(16000);
  const staleActivity = await oldWorker.evaluate(() => ({
    messages: globalThis.__upgradeMessages, errors: globalThis.__upgradeErrors
  }));
  assert.ok(staleActivity.messages.includes('GET_STATE'));
  assert.equal(staleActivity.messages.some(type => /USAGE/.test(type)), false,
    `an unsupported worker must not receive usage requests: ${staleActivity.messages.join(', ')}`);
  assert.deepEqual(staleActivity.errors, []);
  passed('visibility changes and the poll interval send no unsupported usage requests or worker errors');

  await writeFile(path.join(extensionPath, 'background.js'),
    await readFile(path.join(sourceExtension, 'background.js')));
  await usage.locator('#reload-extension').click();
  for (let attempt = 0; context.serviceWorkers().includes(oldWorker) && attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(context.serviceWorkers().includes(oldWorker), false);
  passed('reload button invokes the real runtime API and unloads the stale worker');

  // This Chromium automation session unregisters command-line-loaded extensions
  // after runtime.reload. Recovery below therefore explicitly restarts the
  // disposable browser with the same profile. It verifies persisted data and
  // the current worker, not same-session extension re-registration.
  await context.close();
  context = await launch();
  const restoredPopup = await context.newPage();
  await restoredPopup.goto(`${origin}/popup.html`);
  await restoredPopup.waitForFunction(() => document.querySelector('.popup-usage').getAttribute('aria-busy') === 'false' &&
    document.getElementById('usage-total').textContent === '7분');
  assert.equal(await restoredPopup.locator('#reload-extension').isVisible(), false);
  assert.equal(await restoredPopup.locator('#usage-error').isVisible(), false);
  const restored = await restoredPopup.evaluate(async () => ({
    settings: await chrome.runtime.sendMessage({type: 'GET_STATE'}),
    usage: await chrome.runtime.sendMessage({type: 'GET_USAGE', days: 1})
  }));
  assert.deepEqual(restored.settings.state, savedRules);
  assert.equal(restored.settings.capabilities.usage, true);
  assert.equal(restored.usage.ok, true);
  assert.equal(restored.usage.state.enabled, false);
  assert.equal(restored.usage.state.totalMs, 7 * 60000);
  assert.deepEqual(restored.usage.state.sites, [{host: 'fixture.example.test', ms: 7 * 60000}]);
  passed('explicit browser restart loads the current worker and preserves rules, blocking state and saved usage');

  const restoredUsage = await context.newPage();
  await restoredUsage.goto(`${origin}/usage.html`);
  await restoredUsage.waitForFunction(() => !document.getElementById('recording-toggle').disabled);
  assert.equal(await restoredUsage.locator('#total-time').textContent(), '7분');
  assert.equal(await restoredUsage.locator('#usage-error').isVisible(), false);
  assert.deepEqual(pageErrors, []);
  passed('usage detail page works after restart without uncaught page errors');
  console.log(`Upgrade browser integration: ${checks} checks passed.`);
} finally {
  await context?.close();
  const resolvedDirectory = path.resolve(temporaryDirectory);
  assert.ok(resolvedDirectory.startsWith(`${path.resolve(tmpdir())}${path.sep}`) &&
    path.basename(resolvedDirectory).startsWith('site-pause-upgrade-test-'),
  'only remove this test temporary extension and profile');
  await rm(resolvedDirectory, {recursive: true, force: true, maxRetries: 3, retryDelay: 150});
}
