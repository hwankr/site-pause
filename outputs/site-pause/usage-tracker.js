import {usageHost, normalizeUsage, addUsage, summarizeUsage} from './usage-core.js';
import {filterUsageData} from './usage-filter.js';

export const USAGE_KEY = 'sitePauseUsage';
const SESSION_KEY = 'sitePauseUsageSession';
export const USAGE_ALARM = 'site-pause-usage';
const IDLE_SECONDS = 60;
// A delayed alarm must not turn sleep or a stopped browser into hours of usage.
export const MAX_GAP_MS = 60_000;

export function createUsageTracker(api, now = () => Date.now()) {
  let saved;
  let sessionId;
  let needsWrite = true;
  let queue = Promise.resolve();

  function enqueue(task) {
    const result = queue.then(task);
    queue = result.catch(error => console.error('Site Pause usage:', error));
    return result;
  }

  async function load() {
    if (saved) return;
    const session = await api.storage.session.get(SESSION_KEY);
    sessionId = session[SESSION_KEY];
    if (!sessionId) {
      sessionId = crypto.randomUUID();
      await api.storage.session.set({[SESSION_KEY]: sessionId});
    }
    const stored = (await api.storage.local.get(USAGE_KEY))[USAGE_KEY];
    const data = normalizeUsage(stored, now());
    const point = stored?.checkpoint;
    const checkpoint = data.enabled && point?.sessionId === sessionId &&
      Number.isFinite(point.at) && point.at <= now() &&
      usageHost(`https://${point.host}`) === point.host ? point : null;
    api.idle.setDetectionInterval(IDLE_SECONDS);
    if (!await api.alarms.get(USAGE_ALARM)) {
      await api.alarms.create(USAGE_ALARM, {periodInMinutes: 0.5});
    }
    saved = {...data, checkpoint};
  }

  async function currentHost(pause) {
    if (pause) return null;
    try {
      if (await api.idle.queryState(IDLE_SECONDS) !== 'active') return null;
      const window = await api.windows.getLastFocused();
      if (!window.focused || window.incognito || window.state === 'minimized') return null;
      const [tab] = await api.tabs.query({active: true, windowId: window.id});
      if (!tab || tab.incognito) return null;
      return usageHost(tab.url);
    } catch {
      // Windows/tabs may disappear between the two queries.
      return null;
    }
  }

  async function persist(next, retainObservation = false) {
    try {
      if (needsWrite || JSON.stringify(next) !== JSON.stringify(saved)) {
        await api.storage.local.set({[USAGE_KEY]: next});
      }
    } catch (error) {
      // A failed write must not leave the clock running on a tab that has
      // already lost focus. Keep observations for retry, but never silently
      // apply a failed user preference change or deletion.
      if (retainObservation) { saved = next; needsWrite = true; }
      throw error;
    }
    needsWrite = false;
    saved = next;
  }

  async function refresh({pause = false, clear = false, enabled} = {}) {
    await load();
    const timestamp = now();
    const data = normalizeUsage(saved, timestamp);
    const point = saved.checkpoint;
    if (data.enabled && point && timestamp >= point.at && timestamp - point.at <= MAX_GAP_MS) {
      addUsage(data, point.host, point.at, timestamp);
    }
    const host = data.enabled ? await currentHost(pause) : null;
    const checkpoint = host ? {host, at: timestamp, sessionId} : null;
    // Aggregates and their checkpoint are one atomic write, avoiding double
    // counting when Chrome suspends and later restarts this service worker.
    await persist({...data, checkpoint}, true);
    if (clear || typeof enabled === 'boolean') {
      const next = {...saved, days: clear ? {} : saved.days};
      if (typeof enabled === 'boolean') next.enabled = enabled;
      const nextHost = next.enabled ? host || await currentHost(pause) : null;
      next.checkpoint = nextHost ? {host: nextHost, at: timestamp, sessionId} : null;
      await persist(next);
    }
  }

  const sample = options => enqueue(() => refresh(options));
  api.tabs.onActivated.addListener(() => { sample(); });
  api.tabs.onUpdated.addListener((_id, change) => {
    if (change.url || change.status) sample();
  });
  api.tabs.onRemoved.addListener(() => { sample(); });
  api.tabs.onReplaced.addListener(() => { sample(); });
  api.windows.onFocusChanged.addListener(id => {
    sample({pause: id === api.windows.WINDOW_ID_NONE});
  });
  api.windows.onRemoved.addListener(() => { sample(); });
  api.idle.onStateChanged.addListener(state => { sample({pause: state !== 'active'}); });
  api.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === USAGE_ALARM) sample();
  });
  api.runtime.onStartup.addListener(() => { sample(); });
  api.runtime.onInstalled.addListener(() => { sample(); });

  return {
    start: () => sample(),
    request(message, rules = {}) {
      return enqueue(async () => {
        const days = message.days ?? 1;
        const filter = message.filter ?? 'all';
        if (![1, 7, 30].includes(days)) throw new Error('조회 기간을 확인해 주세요.');
        if (!['all', 'blocked'].includes(filter)) throw new Error('사이트 필터를 확인해 주세요.');
        if (message.type === 'SET_USAGE_ENABLED' && typeof message.enabled !== 'boolean') {
          throw new Error('사용 시간 기록 상태를 확인해 주세요.');
        }
        if (!['GET_USAGE', 'SET_USAGE_ENABLED', 'CLEAR_USAGE'].includes(message.type)) {
          throw new Error('지원하지 않는 요청이에요.');
        }
        await refresh({
          clear: message.type === 'CLEAR_USAGE',
          enabled: message.type === 'SET_USAGE_ENABLED' ? message.enabled : undefined
        });
        const timestamp = now();
        return {...summarizeUsage(filterUsageData(saved, filter, rules, timestamp), days, timestamp), filter};
      });
    }
  };
}
