const GLOBE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/></svg>';

const WWW_HOMEPAGES = new Set([
  'youtube.com', 'instagram.com', 'google.com', 'google.co.kr',
  'reddit.com', 'facebook.com', 'naver.com', 'netflix.com',
  'notion.so', 'notion.com',
]);

function siteOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const address = value.trim();
  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(address);
    const url = new URL(hasScheme ? address : `https://${address}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    // Stored domains omit www, but Chrome's favicon cache keeps the visited host.
    if (!hasScheme && !/[/?#@]/.test(address) && WWW_HOMEPAGES.has(url.hostname)) {
      url.hostname = `www.${url.hostname}`;
    }
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

export function createSiteIcon(value) {
  const icon = document.createElement('span');
  icon.className = 'site-icon';
  icon.setAttribute('aria-hidden', 'true');

  const fallback = document.createElement('span');
  fallback.className = 'site-icon-fallback';
  fallback.innerHTML = GLOBE_ICON;

  const image = document.createElement('img');
  image.className = 'site-icon-image';
  image.alt = '';
  image.width = 16;
  image.height = 16;
  image.hidden = true;
  image.addEventListener('load', () => {
    fallback.hidden = true;
    image.hidden = false;
  });
  image.addEventListener('error', () => {
    fallback.hidden = false;
    image.hidden = true;
  });
  icon.append(fallback, image);

  const pageUrl = siteOrigin(value);
  if (pageUrl && globalThis.chrome?.runtime?.getURL) {
    const faviconUrl = new URL(chrome.runtime.getURL('/_favicon/'));
    faviconUrl.searchParams.set('pageUrl', pageUrl);
    faviconUrl.searchParams.set('size', '32');
    image.src = faviconUrl.href;
  }
  return icon;
}
