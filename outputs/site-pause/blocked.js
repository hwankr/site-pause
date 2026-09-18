import { observeState, showMessage } from './shared-ui.js';

const byId = (id) => document.getElementById(id);
const parameters = new URLSearchParams(location.search);
let site = '';
let destination = null;

try {
  const candidate = parameters.get('site') || '';
  const parsed = new URL(`https://${candidate}`);
  if (candidate && parsed.hostname === candidate.toLowerCase() && !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash) {
    site = parsed.hostname;
    destination = parsed.href;
  }
  const from = new URLSearchParams(location.hash.slice(1)).get('from');
  if (from && site) {
    const original = new URL(from);
    if (['http:', 'https:'].includes(original.protocol) && (original.hostname === site || original.hostname.endsWith(`.${site}`))) {
      original.username = '';
      original.password = '';
      destination = original.href;
    }
  }
} catch { /* An invalid address is never used for navigation. */ }

if (site) {
  byId('blocked-site').textContent = site;
  byId('blocked-site').hidden = false;
}

observeState((state) => {
  const destinationHost = destination ? new URL(destination).hostname : site;
  const matches = destinationHost && state.sites.some((domain) => destinationHost === domain || destinationHost.endsWith(`.${domain}`));
  const blocked = state.enabled && (!site || matches);
  document.body.dataset.enabled = String(blocked);
  byId('blocked-status').textContent = blocked ? '사이트 차단 중' : '다시 열 수 있어요';
  byId('blocked-heading').textContent = blocked ? '잠깐,\n지금은 집중할 시간이에요.' : '잠시 쉬어 가도\n괜찮아요.';
  byId('blocked-description').textContent = blocked ? '잠시 멈추고, 하던 공부로 돌아가 볼까요?' : '이 사이트의 차단이 해제되었어요. 준비되면 다시 열어 주세요.';
  byId('blocked-help').hidden = !blocked;
  const link = byId('return-link');
  link.hidden = blocked || !destination;
  if (!blocked && destination) link.href = destination;
  else link.removeAttribute('href');
  showMessage(byId('message'), '');
}, (text) => {
  byId('return-link').hidden = true;
  showMessage(byId('message'), text);
});
