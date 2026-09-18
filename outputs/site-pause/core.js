export const MAX_SITES = 200;

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
  return state.sites.map((site, index) => ({
    id: index + 1,
    priority: 1,
    action: {type: 'redirect', redirect: {url: `${extensionOrigin.replace(/\/$/, '')}/blocked.html?site=${encodeURIComponent(site)}`}},
    condition: {requestDomains: [site], resourceTypes: ['main_frame']}
  }));
}
