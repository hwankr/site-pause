// This is a classic content script; import the shared URL/exception rules in the
// isolated extension world so navigation blocking and hiding agree.
(() => {
  const SLOT = Symbol.for('site-pause.short-form-content');
  globalThis[SLOT]?.stop();
  const MARKER = 'data-site-pause-short-form-hidden';
  const token = `sp-${Math.random().toString(36).slice(2)}`;
  const shelves = 'ytd-reel-shelf-renderer,ytm-reel-shelf-renderer,ytd-shorts-shelf-renderer,ytd-rich-shelf-renderer[is-shorts]';
  const reelCards = 'ytd-reel-item-renderer,ytm-reel-item-renderer,ytm-shorts-lockup-view-model,ytm-shorts-lockup-view-model-v2,.ytm-shorts-lockup-view-model';
  const guides = 'ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer';
  const cards = `${reelCards},ytd-rich-item-renderer,ytd-video-renderer,ytd-grid-video-renderer,ytd-compact-video-renderer,yt-lockup-view-model,.yt-lockup-view-model,${guides}`;
  const relevant = `a[href],${shelves},${reelCards},${guides},grid-shelf-view-model`;
  const owned = new Map();
  const events = [];
  let state = {};
  let core;
  let observer;
  let style;
  let timer;
  let poll;
  let stopped = false;
  let suspended = false;
  let storageRevision = 0;
  let lastAddress = location.href;

  const controller = {stop};
  globalThis[SLOT] = controller;

  function listen(target, name, callback, options = false) {
    target.addEventListener(name, callback, options);
    events.push([target, name, callback, options]);
  }

  function validContext() {
    try { return Boolean(chrome.runtime.id); }
    catch { return false; }
  }

  function allowed(address) {
    return core.matchesSite(address, state.allowedSites ?? []) || core.matchesPage(address, state.allowedPages ?? []);
  }

  function blockedLink(link) {
    const feature = core.matchesShortForm(link.href, state);
    return feature && !allowed(link.href) ? feature : null;
  }

  function restore(element, previous) {
    // Do not overwrite a new value assigned by the page or another injector.
    if (element.getAttribute(MARKER) !== token) return;
    if (previous === null) element.removeAttribute(MARKER);
    else element.setAttribute(MARKER, previous);
  }

  function restoreAll() {
    for (const [element, previous] of owned) restore(element, previous);
    owned.clear();
  }

  function hide(element) {
    if (!owned.has(element)) owned.set(element, element.getAttribute(MARKER));
    element.setAttribute(MARKER, token);
    for (const video of element.querySelectorAll('video')) {
      try { video.pause(); } catch {}
    }
  }

  function ensureStyle() {
    if (style?.isConnected || !document.documentElement) return;
    style = document.createElement('style');
    style.textContent = `[${MARKER}="${token}"] { display: none !important; }`;
    (document.head || document.documentElement).append(style);
  }

  function hasAllowedShortLink(element) {
    return [...element.querySelectorAll('a[href]')].some(link => core.matchesShortForm(link.href, state) && allowed(link.href));
  }

  function hasNormalVideo(element) {
    return [...element.querySelectorAll('a[href]')].some(candidate => {
      try {
        const url = new URL(candidate.href);
        return /(^|\.)youtube\.com$/.test(url.hostname.replace(/\.$/, '')) && url.pathname === '/watch';
      } catch { return false; }
    });
  }

  function targetForLink(link, feature) {
    // Instagram has no stable dedicated card container: hiding the anchor keeps
    // mixed posts, captions, photographs and profile/DM controls intact.
    if (feature.key !== 'youtubeShorts') return link;
    const card = link.closest(cards);
    if (!card || hasAllowedShortLink(card)) return link;
    // Recycled/generic YouTube cards can contain a normal video plus a Shorts
    // link. Hide only the link in that case, leaving the ordinary video usable.
    return hasNormalVideo(card) ? link : card;
  }

  function scan() {
    timer = undefined;
    if (stopped || suspended) return;
    if (!validContext()) { stop(); return; }
    const desired = new Set();
    const host = location.hostname.toLowerCase().replace(/\.$/, '');
    const youtube = /(^|\.)youtube\.com$/.test(host) && state.youtubeShorts === true;
    const instagram = /(^|\.)instagram\.com$/.test(host) && state.instagramReels === true;
    if (state.enabled === true && (youtube || instagram) && !allowed(location.href)) {
      ensureStyle();
      for (const link of document.querySelectorAll('a[href]')) {
        const feature = blockedLink(link);
        if (feature && ((youtube && feature.key === 'youtubeShorts') || (instagram && feature.key === 'instagramReels'))) {
          desired.add(targetForLink(link, feature));
        }
      }
      if (youtube) {
        for (const element of document.querySelectorAll(`${shelves},${reelCards}`)) {
          // An allowed item must survive inside an otherwise blocked shelf.
          // Individual blocked cards are still hidden by the link pass above.
          if (!hasAllowedShortLink(element) && !hasNormalVideo(element)) desired.add(element);
        }
        // Current search results also use generic grid shelves. Only collapse a
        // grid when every link identifies a blocked Short, never a mixed grid.
        for (const element of document.querySelectorAll('grid-shelf-view-model')) {
          const links = [...element.querySelectorAll('a[href]')];
          if (element.querySelector(reelCards) && links.length && links.every(link => blockedLink(link)?.key === 'youtubeShorts')) {
            desired.add(element);
          }
        }
        // YouTube's desktop guide sometimes uses an event-only link with no
        // href. Scope the exact branded label to guide entries to avoid hiding
        // videos or channels that happen to mention Shorts in their title.
        if (!allowed(`${location.origin}/shorts`) && !allowed(`${location.origin}/shorts/`)) {
          for (const guide of document.querySelectorAll(guides)) {
            const entry = guide.querySelector('a:not([href])');
            const label = entry?.getAttribute('title') || entry?.getAttribute('aria-label') || '';
            if (/^(shorts|쇼츠)$/i.test(label.trim())) desired.add(guide);
          }
        }
      }
    }
    for (const [element, previous] of owned) {
      if (!desired.has(element) || !element.isConnected) {
        restore(element, previous);
        owned.delete(element);
      }
    }
    for (const element of desired) hide(element);
    if (!desired.size) { style?.remove(); style = undefined; }
  }

  function schedule() {
    if (!stopped && !suspended && !timer) timer = setTimeout(scan, 100);
  }

  function checkAddress() {
    if (!validContext()) { stop(); return; }
    if (lastAddress !== location.href) {
      lastAddress = location.href;
      schedule();
    }
  }

  function onMutations(records) {
    for (const record of records) {
      if (record.type === 'attributes' || (record.removedNodes.length && owned.size)) {
        schedule();
        return;
      }
      for (const node of record.addedNodes) {
        if (node.nodeType === 1 && (node.matches(relevant) || node.querySelector(relevant))) {
          schedule();
          return;
        }
      }
    }
  }

  function onStorage(changes, area) {
    if (area !== 'local' || !changes.sitePause) return;
    storageRevision++;
    state = changes.sitePause.newValue ?? {};
    schedule();
  }

  async function refreshState() {
    const revision = storageRevision;
    try {
      const saved = await chrome.storage.local.get('sitePause');
      if (stopped) return;
      // A storage event that arrives during this read contains the newer state.
      if (revision === storageRevision) state = saved.sitePause ?? {};
      schedule();
    } catch { stop(); }
  }

  function suspend() {
    suspended = true;
    observer?.disconnect();
    clearTimeout(timer);
    clearInterval(poll);
    timer = poll = undefined;
    restoreAll();
    style?.remove();
    style = undefined;
  }

  function resume() {
    if (stopped || !validContext()) { stop(); return; }
    suspended = false;
    lastAddress = location.href;
    observer.observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ['href', 'title', 'aria-label', 'is-shorts']});
    clearInterval(poll);
    // Instagram does not dispatch a public navigation event. This only compares
    // the URL; expensive DOM scans happen on a change or relevant DOM mutation.
    poll = setInterval(checkAddress, 1000);
    void refreshState();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    suspend();
    for (const [target, name, callback, options] of events) target.removeEventListener(name, callback, options);
    events.length = 0;
    try { chrome.storage.onChanged.removeListener(onStorage); } catch {}
    if (globalThis[SLOT] === controller) delete globalThis[SLOT];
  }

  void (async () => {
    try {
      core = await import(chrome.runtime.getURL('core.js'));
      if (stopped) return;
      observer = new MutationObserver(onMutations);
      chrome.storage.onChanged.addListener(onStorage);
      for (const event of ['yt-navigate-finish', 'yt-page-data-updated', 'popstate', 'hashchange']) listen(window, event, schedule);
      listen(document, 'visibilitychange', () => { if (!document.hidden) { checkAddress(); schedule(); } });
      listen(window, 'pagehide', event => { if (event.persisted) suspend(); else stop(); });
      listen(window, 'pageshow', event => { if (event.persisted) resume(); });
      // Autoplay can restart inside a hidden card after the initial hide.
      const onPlay = event => {
        if (event.target instanceof HTMLVideoElement && [...owned.keys()].some(element => element.contains(event.target))) {
          try { event.target.pause(); } catch {}
        }
      };
      listen(document, 'play', onPlay, true);
      resume();
    } catch { stop(); }
  })();
})();
