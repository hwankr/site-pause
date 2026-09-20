import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

// Real extension UI, synthetic responses, and manually released requests make
// loading and out-of-order results reproducible without user browsing data.
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = path.join(root, 'outputs', 'site-pause');
const profile = await mkdtemp(path.join(tmpdir(), 'site-pause-transitions-test-'));
const errors = [];
let context;
let checks = 0;
const passed = label => { checks++; console.log(`PASS ${label}`); };

async function ready(page) {
  await page.waitForFunction(() => document.getElementById('usage-report').getAttribute('aria-busy') === 'false' &&
    !document.getElementById('recording-toggle').disabled);
}

async function queue(page, plan = {}) {
  return page.evaluate(plan => {
    const fixture = window.__usageTransitionFixture;
    fixture.plans.push({hold: true, ...plan});
    return fixture.requests.length;
  }, plan);
}

async function pending(page, index) {
  await page.waitForFunction(index => window.__usageTransitionFixture.requests[index]?.held, index);
  assert.equal(await page.locator('#usage-report').getAttribute('aria-busy'), 'true');
}

async function release(page, index) {
  await page.evaluate(index => window.__usageTransitionFixture.release(index), index);
  await page.waitForFunction(index => window.__usageTransitionFixture.requests[index].settled, index);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const text = id => document.getElementById(id).textContent;
    const selectors = ['.usage-shell', '.usage-toolbar', '.usage-metrics', '.usage-sites-card',
      '#daily-section', '#daily-chart', '[data-filter="all"]', '[data-filter="blocked"]'];
    return {
      content: {
        total: text('total-time'), count: text('total-sites'), period: text('period-label'), date: text('date-range'),
        scope: document.getElementById('usage-report').getAttribute('aria-label'),
        title: text('usage-sites-title'), dailyTitle: text('daily-title'), daily: text('daily-detail'),
        rows: [...document.querySelectorAll('.usage-site')].map(row => row.textContent),
        bars: [...document.querySelectorAll('.daily-column')].map(bar => bar.getAttribute('aria-label')),
        chartHidden: document.getElementById('daily-section').hidden
      },
      boxes: Object.fromEntries(selectors.map(selector => {
        const element = document.querySelector(selector);
        const box = element.getBoundingClientRect();
        return [selector, {x: box.x, y: box.y + scrollY, width: box.width, height: box.height}];
      }))
    };
  });
}

function stableBoxes(before, after, label, {pending = false} = {}) {
  for (const [selector, box] of Object.entries(before.boxes)) {
    const dimensions = ['x', 'y', 'width'];
    if (pending || ['.usage-toolbar', '.usage-metrics', '#daily-section', '#daily-chart'].includes(selector)) {
      dimensions.push('height');
    }
    for (const dimension of dimensions) {
      assert.ok(Math.abs(box[dimension] - after.boxes[selector][dimension]) <= 1,
        `${label}: ${selector} ${dimension} changed from ${box[dimension]} to ${after.boxes[selector][dimension]}`);
    }
  }
}

async function retained(page, before, label) {
  const during = await snapshot(page);
  assert.deepEqual(during.content, before.content, `${label}: existing result stays correctly labeled while loading`);
  stableBoxes(before, during, label, {pending: true});
}

async function fits(page, label) {
  const result = await page.evaluate(() => {
    const total = document.createRange();
    total.selectNodeContents(document.getElementById('total-time'));
    const metric = document.querySelector('.usage-metric').getBoundingClientRect();
    const totalBox = total.getBoundingClientRect();
    const section = document.getElementById('daily-section');
    const title = document.getElementById('daily-title').getBoundingClientRect();
    const detail = document.getElementById('daily-detail').getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      totalOverflow: totalBox.right > metric.right + 1,
      headerOverlap: !section.hidden && title.right > detail.left + 1 && title.top < detail.bottom && detail.top < title.bottom,
      rowOverlap: [...document.querySelectorAll('.usage-site-details')].some(row => {
        const [identity, values] = [...row.children].map(child => child.getBoundingClientRect());
        return identity.right > values.left + 1;
      })
    };
  });
  assert.deepEqual(result, {overflow: false, totalOverflow: false, headerOverlap: false, rowOverlap: false}, label);
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
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  await context.route(/^https?:\/\//, route => route.abort());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;

  for (const width of [1100, 320]) {
    const page = await context.newPage();
    await page.setViewportSize({width, height: 1000});
    await page.addInitScript(() => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      const fixture = window.__usageTransitionFixture = {plans: [], requests: []};
      const stateFor = (message, plan) => {
        const days = message.days || 1;
        const filter = message.filter || 'all';
        const source = [
          ['youtube.com', 91], ['github.com', 74], ['instagram.com', 63], ['notion.so', 39],
          ['x.com', 22], ['music.youtube.com', 18], ['example.test', 12],
          ['a-long-site-name-for-responsive-transitions.example.test', 8]
        ];
        const selected = plan.empty ? [] : filter === 'blocked' ? source.slice(0, 2) : source;
        const dailyTotal = selected.reduce((sum, [, minutes]) => sum + minutes * 60000, 0);
        const daily = Array.from({length: days}, (_, index) => ({
          date: new Date(Date.UTC(2026, 8, 20 - days + index + 1)).toISOString().slice(0, 10), ms: dailyTotal
        }));
        return {enabled: true, days, filter, startDate: daily[0].date, endDate: daily.at(-1).date,
          totalMs: dailyTotal * days, sites: selected.map(([host, minutes]) => ({host, ms: minutes * 60000 * days})), daily};
      };
      chrome.runtime.sendMessage = message => {
        if (message.type === 'GET_STATE') return Promise.resolve({ok: true, capabilities: {usage: true, usageFilters: true}});
        if (message.type !== 'GET_USAGE') return original(message);
        const plan = fixture.plans.shift() || {};
        const request = {days: message.days, filter: message.filter, held: Boolean(plan.hold), settled: false};
        const promise = new Promise(resolve => {
          request.resolve = () => {
            resolve(plan.error ? {ok: false, error: plan.error} : {ok: true, state: stateFor(message, plan)});
            request.settled = true;
          };
        });
        fixture.requests.push(request);
        if (!request.held) request.resolve();
        return promise;
      };
      fixture.release = index => fixture.requests[index].resolve();
    });
    await page.goto(`${origin}/usage.html`);
    await ready(page);
    await fits(page, `${width}px initial layout`);
    let before = await snapshot(page);
    let request = await queue(page);
    await page.locator('[data-filter="blocked"]').click();
    await pending(page, request);
    await retained(page, before, `${width}px filter loading`);
    await release(page, request);
    await ready(page);
    let after = await snapshot(page);
    assert.equal(after.content.count, '2개');
    assert.match(after.content.scope, /차단 목록/);
    assert.equal(after.content.title, before.content.title);
    assert.equal(after.content.dailyTitle, before.content.dailyTitle);
    stableBoxes(before, after, `${width}px completed filter`);
    assert.equal(await page.locator('.usage-method').getAttribute('open'), null);
    assert.equal(await page.locator('#blocked-filter-help').isVisible(), false);
    await page.locator('.usage-method summary').click();
    assert.equal(await page.locator('#blocked-filter-help').isVisible(), true);
    await page.locator('.usage-method summary').click();
    await fits(page, `${width}px filtered layout`);
    passed(`${width}px filter retains content and geometry while loading; completed headings and help stay stable`);

    await page.locator('[data-days="7"]').click();
    await ready(page);
    await page.locator('[data-filter="all"]').click();
    await ready(page);
    before = await snapshot(page);
    request = await queue(page, {empty: true});
    await page.locator('[data-filter="blocked"]').click();
    await pending(page, request);
    await retained(page, before, `${width}px weekly empty-filter loading`);
    await release(page, request);
    await ready(page);
    after = await snapshot(page);
    assert.equal(after.content.total, '0분');
    assert.equal(after.content.chartHidden, false);
    assert.equal(after.content.bars.length, 7);
    assert.ok(after.content.bars.every(label => label.endsWith('0분')));
    assert.equal(await page.locator('#usage-empty').isVisible(), true);
    stableBoxes(before, after, `${width}px weekly empty-filter result`);
    await fits(page, `${width}px weekly empty layout`);
    passed(`${width}px empty weekly filter preserves the chart and surrounding section positions`);

    await page.locator('[data-filter="all"]').click();
    await ready(page);
    before = await snapshot(page);
    const older = await queue(page);
    await page.locator('[data-filter="blocked"]').click();
    await pending(page, older);
    const latest = await queue(page);
    await page.locator('[data-filter="all"]').click();
    await pending(page, latest);
    await release(page, latest);
    await ready(page);
    await release(page, older);
    assert.deepEqual((await snapshot(page)).content, before.content, 'late blocked response must not replace latest all-sites result');
    assert.equal(await page.locator('[data-filter="all"]').getAttribute('aria-pressed'), 'true');
    passed(`${width}px rapidly switching all/blocked/all ignores the older response`);

    before = await snapshot(page);
    request = await queue(page);
    await page.locator('[data-days="30"]').click();
    await pending(page, request);
    await retained(page, before, `${width}px period loading`);
    await release(page, request);
    await ready(page);
    assert.equal(await page.locator('.daily-column').count(), 30);
    assert.equal(await page.locator('#period-label').textContent(), '최근 30일 사용 시간');
    await fits(page, `${width}px 30-day layout including three-digit hours`);
    passed(`${width}px period change keeps the old chart during loading and fits long totals after completion`);

    before = await snapshot(page);
    request = await queue(page, {error: '전환 테스트 연결 오류'});
    await page.locator('[data-filter="blocked"]').click();
    await pending(page, request);
    await release(page, request);
    await page.locator('#usage-error').waitFor({state: 'visible'});
    assert.equal(await page.locator('#usage-report').getAttribute('aria-busy'), 'false');
    assert.deepEqual((await snapshot(page)).content, before.content, 'failed filter keeps the previous result and its labels');
    const error = await page.locator('#usage-error-text').textContent();
    assert.match(error, /전환 테스트 연결 오류/);
    assert.match(error, /전체 사이트/);
    assert.match(error, /30일/);
    request = await queue(page);
    await page.locator('#retry-button').click();
    await pending(page, request);
    assert.deepEqual(await page.evaluate(index => {
      const request = window.__usageTransitionFixture.requests[index];
      return {days: request.days, filter: request.filter};
    }, request), {days: 30, filter: 'blocked'}, 'retry requests the selected query, not the retained result');
    assert.deepEqual((await snapshot(page)).content, before.content);
    await release(page, request);
    await ready(page);
    assert.equal(await page.locator('#usage-error').isVisible(), false);
    assert.equal(await page.locator('#total-sites').textContent(), '2개');
    assert.match(await page.locator('#usage-report').getAttribute('aria-label'), /차단 목록/);
    await fits(page, `${width}px recovered layout`);
    passed(`${width}px failed query keeps labeled results; Retry completes the newly selected query`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log(`Usage transition browser integration: ${checks} checks passed.`);
} finally {
  await context?.close();
  const resolvedProfile = path.resolve(profile);
  assert.ok(resolvedProfile.startsWith(`${path.resolve(tmpdir())}${path.sep}`) &&
    path.basename(resolvedProfile).startsWith('site-pause-transitions-test-'), 'only remove this test temporary profile');
  await rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 150});
}
