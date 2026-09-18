export async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok || !response.state) {
    throw new Error(response?.error || '연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  return response.state;
}

export function observeState(onState, onError) {
  let alive = true;
  let pending = null;
  const accept = (state) => { if (alive) onState(state); };
  const refresh = () => {
    if (pending) return pending;
    pending = request('GET_STATE').then(accept).catch((error) => {
      if (alive) onError(error.message);
    }).finally(() => { pending = null; });
    return pending;
  };
  const changed = (changes, area) => {
    if (area === 'local' && changes.sitePause) refresh();
  };
  chrome.storage.onChanged.addListener(changed);
  const cleanup = () => {
    alive = false;
    chrome.storage.onChanged.removeListener(changed);
  };
  window.addEventListener('pagehide', cleanup, { once: true });
  refresh();
  return { accept, refresh, cleanup };
}

export function showMessage(element, text, kind = 'error') {
  element.textContent = text;
  element.dataset.kind = kind;
  element.hidden = !text;
}

export function makeChip(site) {
  const chip = document.createElement('span');
  chip.className = 'site-chip';
  chip.textContent = site;
  chip.title = site;
  return chip;
}
