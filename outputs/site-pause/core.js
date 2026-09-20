export const MAX_SITES = 200;
const RULE_KEYS = ['sites', 'blockedPages', 'allowedSites', 'allowedPages'];
export const SHORT_FORM_FEATURES = Object.freeze([
  Object.freeze({
    key: 'youtubeShorts', label: 'YouTube 쇼츠', site: 'youtube.com',
    pattern: '^https?://(?:www\\.|m\\.)?youtube\\.com\\.?(?::[0-9]+)?/shorts(?:[/?]|$)'
  }),
  Object.freeze({
    key: 'instagramReels', label: 'Instagram 릴스', site: 'instagram.com',
    pattern: '^https?://(?:www\\.)?instagram\\.com\\.?(?::[0-9]+)?/(?:reels?|[a-zA-Z0-9_.]+/reels)(?:[/?]|$)'
  })
]);
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Use the same raw query grammar for normalization and Chrome's RE2 matcher.
// An earlier bare/encoded v must not let a later v select a different video.
const BEFORE_VIDEO = '(?:(?:[^v%&#][^&#]*|v[^=&#][^&#]*)?&)*';
const VIDEO_QUERY = new RegExp(`^\\?${BEFORE_VIDEO}v=([a-zA-Z0-9_-]+)(&[^#]*)?$`);

export function normalizeSite(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('사이트 주소를 입력해 주세요.');
  const value = input.trim().replace(/^\*\./, '');
  if (/\s/.test(value) || /[\\<>"']/.test(value)) throw new Error(`올바른 사이트 주소가 아니에요: ${input}`);
  const scheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  if (scheme && !/^https?:\/\//i.test(value)) throw new Error('http 또는 https 사이트만 등록할 수 있어요.');
  let url;
  try { url = new URL(scheme ? value : `https://${value}`); }
  catch { throw new Error(`올바른 사이트 주소가 아니에요: ${input}`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('로그인 정보가 포함되지 않은 http 또는 https 주소를 입력해 주세요.');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  const labels = host.split('.');
  if (host.length > 253 || (!host.includes('.') && host !== 'localhost') ||
      labels.some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/.test(label))) {
    throw new Error(`도메인 주소를 확인해 주세요: ${input}`);
  }
  return host;
}

export function normalizeSites(input) {
  if (typeof input !== 'string' && !Array.isArray(input)) throw new Error('사이트 목록 형식을 확인해 주세요.');
  const parts = typeof input === 'string' ? input.split(/[\s,;]+/).filter(Boolean) : input;
  if (parts.length > 1000) throw new Error('사이트는 최대 200개까지 등록할 수 있어요.');
  const sites = [...new Set(parts.map(normalizeSite))];
  if (sites.length > MAX_SITES) throw new Error('사이트는 최대 200개까지 등록할 수 있어요.');
  return sites;
}

function youtubeVideo(url) {
  if (url.port) return null;
  const host = url.hostname;
  let id;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host) && url.pathname === '/watch') {
    // Unusual encoded video parameters retain exact-URL semantics instead.
    id = url.search.match(VIDEO_QUERY)?.[1];
  } else if (host === 'youtu.be') {
    id = url.pathname.slice(1);
  }
  return id && /^[a-zA-Z0-9_-]+$/.test(id) ? id : null;
}

export function normalizePage(input) {
  // Reuse domain validation, but preserve the page's scheme, host, port and query.
  normalizeSite(input);
  const value = input.trim();
  if (value.startsWith('*.')) throw new Error('페이지에는 * 대신 정확한 주소를 입력해 주세요.');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  url.hash = '';
  if (url.href.length > 2000) throw new Error('페이지 주소가 너무 길어요. 2,000자 이내로 입력해 주세요.');
  const video = youtubeVideo(url);
  return video ? `https://www.youtube.com/watch?v=${video}` : url.href;
}

export function normalizePages(input) {
  if (typeof input !== 'string' && !Array.isArray(input)) throw new Error('페이지 목록 형식을 확인해 주세요.');
  // Commas and semicolons can be part of a URL, so only whitespace separates pages.
  const parts = typeof input === 'string' ? input.split(/\s+/).filter(Boolean) : input;
  if (parts.length > 1000) throw new Error('규칙은 모두 합해 최대 200개까지 등록할 수 있어요.');
  const pages = [...new Set(parts.map(normalizePage))];
  if (pages.length > MAX_SITES) throw new Error('규칙은 모두 합해 최대 200개까지 등록할 수 있어요.');
  return pages;
}

export function normalizeRuleLists(value) {
  const lists = {
    sites: normalizeSites(value?.sites ?? []),
    blockedPages: normalizePages(value?.blockedPages ?? []),
    allowedSites: normalizeSites(value?.allowedSites ?? []),
    allowedPages: normalizePages(value?.allowedPages ?? [])
  };
  if (RULE_KEYS.reduce((count, key) => count + lists[key].length, 0) > MAX_SITES) {
    throw new Error('규칙은 모두 합해 최대 200개까지 등록할 수 있어요.');
  }
  for (const feature of SHORT_FORM_FEATURES) {
    if (Object.hasOwn(value ?? {}, feature.key) && typeof value[feature.key] !== 'boolean') {
      throw new Error(`${feature.label} 차단 설정을 확인해 주세요.`);
    }
    lists[feature.key] = value?.[feature.key] === true;
  }
  return lists;
}

export function blockingRuleCount(state) {
  return (state.sites?.length ?? 0) + (state.blockedPages?.length ?? 0) +
    SHORT_FORM_FEATURES.filter(feature => state[feature.key] === true).length;
}

export function hasBlockingRules(state) {
  return blockingRuleCount(state) > 0;
}

function pagePattern(page) {
  const video = youtubeVideo(new URL(page));
  if (video) {
    // Match the first v parameter, keeping IDs case-sensitive. Other query values
    // (timestamps, sharing tags, playlist context) do not change the video.
    // Stop at the ID delimiter to stay within Chrome's 2 KB compiled RE2 limit.
    return `^https?://((www\\.|m\\.|music\\.)?youtube\\.com/watch\\?${BEFORE_VIDEO}v=${video}(&|$)|youtu\\.be/${video}(\\?|$))`;
  }
  return `^${escapeRegex(page)}$`;
}

export function matchesPage(address, pages = []) {
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    // Fragments are not sent with requests and are absent from DNR matching.
    url.hash = '';
    return pages.find(page => new RegExp(pagePattern(page)).test(url.href)) ?? null;
  } catch { return null; }
}

export function getBlockedRule(address, state) {
  if (!state.enabled || matchesSite(address, state.allowedSites ?? []) || matchesPage(address, state.allowedPages)) return null;
  return matchesPage(address, state.blockedPages) || matchesSite(address, state.sites ?? []) ||
    matchesShortForm(address, state)?.key || null;
}

export function matchesShortForm(address, state) {
  try {
    const url = new URL(address);
    url.hash = '';
    return SHORT_FORM_FEATURES.find(feature => state[feature.key] === true &&
      new RegExp(feature.pattern).test(url.href)) ?? null;
  } catch { return null; }
}

export function matchesSite(address, sites) {
  try {
    const url = new URL(address);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    return sites.find(site => host === site || host.endsWith(`.${site}`)) ?? null;
  } catch { return null; }
}

export function buildRules(state, extensionOrigin) {
  if (!state.enabled) return [];
  const rules = [];
  for (const key of RULE_KEYS) {
    const page = key.endsWith('Pages');
    const allow = key.startsWith('allowed');
    for (const value of state[key] ?? []) {
      const target = new URL(`${extensionOrigin.replace(/\/$/, '')}/blocked.html`);
      target.searchParams.set('site', page ? new URL(value).hostname : value);
      if (page) target.hash = new URLSearchParams({from: value}).toString();
      rules.push({
        id: rules.length + 1,
        priority: allow ? 3 : page ? 2 : 1,
        action: allow ? {type: 'allow'} : {type: 'redirect', redirect: {url: target.href}},
        condition: {
          ...(page ? {regexFilter: pagePattern(value), isUrlFilterCaseSensitive: true} : {requestDomains: [value]}),
          resourceTypes: ['main_frame']
        }
      });
    }
  }
  for (const feature of SHORT_FORM_FEATURES) {
    if (state[feature.key] !== true) continue;
    const target = new URL(`${extensionOrigin.replace(/\/$/, '')}/blocked.html`);
    target.searchParams.set('site', feature.site);
    target.searchParams.set('feature', feature.key);
    // Preserve the complete requested URL so a page-specific allow exception
    // cannot make the blocked screen report an unrelated fallback as allowed.
    rules.push({
      id: rules.length + 1,
      priority: 2,
      action: {type: 'redirect', redirect: {regexSubstitution: `${target.href}#source=\\0`}},
      condition: {regexFilter: `${feature.pattern}[^#]*$`, isUrlFilterCaseSensitive: true, resourceTypes: ['main_frame']}
    });
  }
  return rules;
}
