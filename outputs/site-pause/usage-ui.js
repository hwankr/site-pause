import { requestUsage } from './usage-client.js';

export function formatDuration(ms) {
  if (ms <= 0) return '0분';
  if (ms < 60000) return '1분 미만';
  if (ms > 300000 && ms < 360000) return '5분 초과';
  const minutes = Math.floor(ms / 60000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}` : `${minutes}분`;
}

// GET_USAGE may persist a running interval. Polling instead of reacting to every
// storage write avoids a read → write → read feedback loop.
export function observeUsage(onState, onError, initialDays = 1, initialFilter = 'all') {
  let days = initialDays;
  let filter = initialFilter === 'blocked' ? 'blocked' : 'all';
  let alive = true;
  let generation = 0;
  let pending = null;
  let mutating = false;
  let updateRequired = false;
  const refresh = (force = false) => {
    if (!alive || mutating || (!force && (document.hidden || updateRequired))) return Promise.resolve();
    if (pending && !force) return pending;
    const ticket = ++generation;
    const operation = requestUsage('GET_USAGE', { days, filter }).then(state => {
      if (alive && ticket === generation) {
        updateRequired = false;
        onState(state);
      }
    }).catch(error => {
      if (alive && ticket === generation) {
        if (error.code === 'UPDATE_REQUIRED') updateRequired = true;
        onError(error.message, error.code);
      }
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  };
  const visibilityChanged = () => { if (!document.hidden && !updateRequired) refresh(true); };
  const timer = window.setInterval(() => refresh(), 15000);
  document.addEventListener('visibilitychange', visibilityChanged);
  const cleanup = () => {
    alive = false;
    generation++;
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', visibilityChanged);
  };
  window.addEventListener('pagehide', cleanup, { once: true });
  refresh(true);
  return {
    refresh,
    setDays(value) { days = value; return refresh(true); },
    setFilter(value) { filter = value === 'blocked' ? 'blocked' : 'all'; return refresh(true); },
    async mutate(type, payload = {}) {
      mutating = true;
      const ticket = ++generation;
      try {
        const state = await requestUsage(type, { ...payload, days, filter });
        if (alive && ticket === generation) {
          updateRequired = false;
          onState(state);
        }
        return state;
      } catch (error) {
        if (error.code === 'UPDATE_REQUIRED') updateRequired = true;
        throw error;
      } finally { mutating = false; }
    },
    cleanup
  };
}
