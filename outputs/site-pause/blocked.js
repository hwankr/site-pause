import { observeState, showMessage } from './shared-ui.js';
import { getBlockedRule } from './core.js';

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
} catch {}

if (site) {
  byId('blocked-site').textContent = site;
  byId('blocked-site').hidden = false;
}

observeState((state) => {
  const blocked = state.enabled && (!destination || Boolean(getBlockedRule(destination, state)));
  document.body.dataset.enabled = String(blocked);
  byId('blocked-heading').textContent = blocked ? '사이트 차단 중' : '차단 해제';
  const link = byId('return-link');
  link.hidden = blocked || !destination;
  if (!blocked && destination) link.href = destination;
  else link.removeAttribute('href');
  showMessage(byId('message'), '');
}, (text) => {
  byId('return-link').hidden = true;
  showMessage(byId('message'), text);
});
