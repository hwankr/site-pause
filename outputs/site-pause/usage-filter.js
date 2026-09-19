import {normalizeSite} from './core.js';
import {normalizeUsage, usageHost} from './usage-core.js';

function canonicalUsageHost(value) {
  if (typeof value !== 'string' || !value || /[\s/@?#%\\]/.test(value)) return null;
  const host = usageHost(`https://${value}`);
  // A usage key must be a hostname, never a URL, path, or hostname with a port.
  const expected = value.toLowerCase().replace(/^(?:www\.)+/, '').replace(/\.$/, '');
  return host === expected ? host : null;
}

function blockedHostMatcher(rules) {
  const sites = (Array.isArray(rules?.sites) ? rules.sites : []).flatMap(value => {
    try {
      const host = canonicalUsageHost(normalizeSite(value));
      return host ? [host] : [];
    } catch { return []; }
  });
  const pages = new Set((Array.isArray(rules?.blockedPages) ? rules.blockedPages : [])
    .map(usageHost).filter(Boolean));

  // This is membership in the current saved block list. A disabled blocker or
  // an allow exception does not remove a site the user has chosen to block.
  // Usage stores no paths, so page rules include the whole hostname's total;
  // unlike whole-site rules, they do not include other subdomains.
  return host => pages.has(host) || sites.some(site => host === site || host.endsWith(`.${site}`));
}

export function isBlockedUsageHost(value, rules = {}) {
  const host = canonicalUsageHost(value);
  return Boolean(host && blockedHostMatcher(rules)(host));
}

// Filter before summarizing so the ranking, total, and daily chart describe the
// same sites. Normalization creates a copy and retains the collection setting.
export function filterUsageData(data, filter = 'all', rules = {}, now = Date.now()) {
  if (!['all', 'blocked'].includes(filter)) throw new Error('사용 시간 필터를 확인해 주세요.');
  const normalized = normalizeUsage(data, now);
  if (filter === 'all') return normalized;
  const matches = blockedHostMatcher(rules);
  for (const [date, sites] of Object.entries(normalized.days)) {
    const filtered = Object.fromEntries(Object.entries(sites).filter(([host]) => matches(host)));
    if (Object.keys(filtered).length) normalized.days[date] = filtered;
    else delete normalized.days[date];
  }
  return normalized;
}
