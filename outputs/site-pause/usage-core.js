export const RETENTION_DAYS = 30;
export const MINIMUM_DAILY_MS = 5 * 60 * 1000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const isRecord = value => value !== null && typeof value === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const isDuration = value => typeof value === 'number' && Number.isFinite(value) && value > 0;

function validTime(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  const year = new Date(value).getFullYear();
  return year >= 1 && year <= 9999;
}

function canonicalHost(value) {
  if (typeof value !== 'string' || !value || /[\s/@?#%\\]/.test(value)) return null;
  const host = value.toLowerCase().replace(/^(?:www\.)+/, '').replace(/\.$/, '');
  if (FORBIDDEN_KEYS.has(host) || host.length > 253) return null;
  if (host.startsWith('[')) {
    try { return new URL(`https://${host}`).hostname === host ? host : null; }
    catch { return null; }
  }
  return host.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label)) ? host : null;
}

// Only the hostname leaves this function: paths, queries, credentials and ports
// are never part of the persisted usage data.
export function usageHost(address) {
  if (typeof address !== 'string') return null;
  try {
    const url = new URL(address);
    return ['http:', 'https:'].includes(url.protocol) ? canonicalHost(url.hostname) : null;
  } catch { return null; }
}

export function localDateKey(timestamp) {
  if (!validTime(timestamp)) return null;
  const date = new Date(timestamp);
  return `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function dayStart(timestamp) {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date;
}

function validDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  return localDateKey(date.getTime()) === key;
}

function dateWindow(days, now) {
  if (!validTime(now)) return [];
  const date = dayStart(now);
  date.setDate(date.getDate() - days + 1);
  const keys = [];
  for (let index = 0; index < days; index++) {
    const key = localDateKey(date.getTime());
    if (key) keys.push(key);
    date.setDate(date.getDate() + 1);
  }
  return keys;
}

function increment(bucket, host, duration) {
  const previous = Object.hasOwn(bucket, host) && isDuration(bucket[host]) ? bucket[host] : 0;
  const next = previous + duration;
  // Corrupt persisted numbers must not turn an otherwise valid total infinite.
  if (Number.isFinite(next)) bucket[host] = next;
}

export function normalizeUsage(saved, now = Date.now()) {
  const source = isRecord(saved) ? saved : {};
  const result = {enabled: source.enabled !== false, days: {}};
  if (!isRecord(source.days)) return result;
  const allowedDates = new Set(dateWindow(RETENTION_DAYS, now));
  for (const [date, sites] of Object.entries(source.days)) {
    if (!allowedDates.has(date) || !validDateKey(date) || !isRecord(sites)) continue;
    const bucket = {};
    for (const [value, duration] of Object.entries(sites)) {
      const host = canonicalHost(value);
      if (host && isDuration(duration)) increment(bucket, host, duration);
    }
    if (Object.keys(bucket).length) result.days[date] = bucket;
  }
  return result;
}

export function addUsage(data, value, start, end) {
  const host = canonicalHost(value);
  if (!isRecord(data) || data.enabled === false || !isRecord(data.days) || !host ||
      !validTime(start) || !validTime(end) || end <= start) return data;
  let cursor = start;
  while (cursor < end) {
    const key = localDateKey(cursor);
    const midnight = dayStart(cursor);
    midnight.setDate(midnight.getDate() + 1);
    const until = Math.min(end, midnight.getTime());
    if (until <= cursor) break;
    if (!Object.hasOwn(data.days, key) || !isRecord(data.days[key])) data.days[key] = {};
    increment(data.days[key], host, until - cursor);
    cursor = until;
  }
  return data;
}

export function summarizeUsage(data, days = 1, now = Date.now()) {
  const period = [1, 7, 30].includes(days) ? days : 1;
  const normalized = normalizeUsage(data, now);
  const dates = dateWindow(period, now);
  const totals = {};
  const daily = dates.map(date => {
    let ms = 0;
    for (const [host, duration] of Object.entries(normalized.days[date] ?? {})) {
      // Qualify each local day separately. Keep raw local sums so several short
      // visits can pass the threshold later; then include the entire day's use.
      if (duration <= MINIMUM_DAILY_MS) continue;
      increment(totals, host, duration);
      ms += duration;
    }
    return {date, ms};
  });
  return {
    enabled: normalized.enabled,
    days: period,
    totalMs: daily.reduce((total, entry) => total + entry.ms, 0),
    sites: Object.entries(totals).map(([host, ms]) => ({host, ms}))
      .sort((a, b) => b.ms - a.ms || (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)),
    daily,
    startDate: dates[0] ?? null,
    endDate: dates.at(-1) ?? null,
    retentionDays: RETENTION_DAYS,
    minimumDailyMs: MINIMUM_DAILY_MS
  };
}
