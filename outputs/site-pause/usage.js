import { showMessage } from './shared-ui.js';
import { observeUsage, formatDuration } from './usage-ui.js';
import { siteName } from './site-labels.js';
import { createSiteIcon } from './site-icons.js';

const byId = id => document.getElementById(id);
const periodButtons = [...document.querySelectorAll('[data-days]')];
const filterButtons = [...document.querySelectorAll('[data-filter]')];
let currentState = null;
let days = 1;
let filter = 'all';
let busy = false;
let loading = true;
let selectedDate = null;
let updateRequired = false;

function dateLabel(date) {
  const [, month, day] = date.split('-');
  return `${Number(month)}월 ${Number(day)}일`;
}

function updateControls() {
  periodButtons.forEach(button => {
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(Number(button.dataset.days) === days));
  });
  filterButtons.forEach(button => {
    button.disabled = busy;
    button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
  });
  byId('recording-toggle').disabled = busy || loading || updateRequired || !currentState;
  byId('clear-button').disabled = busy || loading || updateRequired || !currentState;
  byId('confirm-clear').disabled = busy || loading || updateRequired || !currentState;
  byId('cancel-clear').disabled = busy;
}

function renderScope() {
  const blocked = filter === 'blocked';
  const scope = blocked ? '차단 목록 사이트' : '전체 사이트';
  byId('usage-scope-label').textContent = `${scope} · 도메인 기준`;
  byId('usage-report').setAttribute('aria-label', `${scope} 사용 시간 통계`);
  byId('usage-sites-title').textContent = blocked ? '차단 목록 사이트 사용 시간' : '사이트별 사용 시간';
  byId('daily-title').textContent = blocked ? '차단 목록의 날짜별 사용 시간' : '날짜별 사용 시간';
  byId('daily-chart').setAttribute('aria-label', `${scope} 날짜별 사용 시간`);
  byId('blocked-filter-help').hidden = !blocked;
}

function siteRow(site, total, maximum) {
  const row = document.createElement('li');
  row.className = 'usage-site';
  const details = document.createElement('div');
  details.className = 'usage-site-details';
  const identity = document.createElement('span');
  identity.className = 'usage-site-name';
  const domain = document.createElement('span');
  domain.className = 'usage-domain';
  domain.textContent = siteName(site.host);
  domain.title = site.host;
  identity.append(createSiteIcon(site.host), domain);
  const values = document.createElement('span');
  values.className = 'usage-site-values';
  const time = document.createElement('strong');
  time.textContent = formatDuration(site.ms);
  const share = document.createElement('span');
  const percentage = total ? site.ms / total * 100 : 0;
  share.textContent = percentage > 0 && percentage < 1 ? '1% 미만' : `${Math.round(percentage)}%`;
  values.append(time, share);
  details.append(identity, values);
  const track = document.createElement('div');
  track.className = 'usage-bar-track';
  track.setAttribute('aria-hidden', 'true');
  const bar = document.createElement('span');
  bar.style.width = `${maximum ? site.ms / maximum * 100 : 0}%`;
  track.append(bar);
  row.append(details, track);
  return row;
}

function renderDaily(state) {
  const focusedDate = document.activeElement?.closest('.daily-column')?.dataset.date;
  byId('daily-section').hidden = state.days === 1 || state.totalMs === 0;
  const max = Math.max(1, ...state.daily.map(day => day.ms));
  const selected = state.daily.find(day => day.date === selectedDate) || state.daily.at(-1);
  selectedDate = selected?.date || null;
  byId('daily-chart').style.setProperty('--day-count', state.daily.length);
  byId('daily-chart').dataset.days = String(state.days);
  byId('daily-chart').replaceChildren(...state.daily.map((day, index) => {
    const button = document.createElement('button');
    button.className = 'daily-column';
    button.type = 'button';
    button.dataset.date = day.date;
    button.setAttribute('aria-label', `${dateLabel(day.date)}, ${formatDuration(day.ms)}`);
    button.setAttribute('aria-pressed', String(day.date === selectedDate));
    const track = document.createElement('span');
    track.className = 'daily-bar-track';
    const bar = document.createElement('span');
    bar.className = 'daily-bar';
    bar.style.height = `${day.ms ? Math.max(2, day.ms / max * 100) : 0}%`;
    track.append(bar);
    const label = document.createElement('span');
    label.className = 'daily-label';
    label.setAttribute('aria-hidden', 'true');
    label.textContent = `${Number(day.date.slice(5, 7))}/${Number(day.date.slice(8))}`;
    if (state.days === 30 && index !== 0 && index !== state.daily.length - 1 &&
        (index % 7 !== 0 || index > state.daily.length - 4)) label.classList.add('is-spacer');
    button.append(track, label);
    button.addEventListener('click', () => {
      selectedDate = day.date;
      document.querySelectorAll('.daily-column').forEach(column => column.setAttribute('aria-pressed', String(column.dataset.date === selectedDate)));
      byId('daily-detail').textContent = `${dateLabel(day.date)} · ${formatDuration(day.ms)}`;
    });
    return button;
  }));
  byId('daily-detail').textContent = selected ? `${dateLabel(selected.date)} · ${formatDuration(selected.ms)}` : '';
  if (focusedDate) {
    [...byId('daily-chart').children].find(column => column.dataset.date === focusedDate)?.focus({ preventScroll: true });
  }
}

function render(state) {
  currentState = state;
  loading = false;
  updateRequired = false;
  days = state.days;
  filter = state.filter;
  byId('usage-report').setAttribute('aria-busy', 'false');
  byId('usage-loading').hidden = true;
  byId('usage-error').hidden = true;
  byId('period-label').textContent = days === 1 ? '오늘의 사용 시간' : `최근 ${days}일 사용 시간`;
  byId('total-time').textContent = formatDuration(state.totalMs);
  byId('total-sites').textContent = `${state.sites.length}개`;
  byId('date-range').textContent = days === 1 ? dateLabel(state.endDate) : `${dateLabel(state.startDate)} – ${dateLabel(state.endDate)}`;
  const sites = [...state.sites].sort((a, b) => b.ms - a.ms || a.host.localeCompare(b.host));
  byId('usage-sites').replaceChildren(...sites.map(site => siteRow(site, state.totalMs, sites[0]?.ms || 0)));
  byId('usage-empty').hidden = state.sites.length > 0;
  byId('usage-empty-title').textContent = filter === 'blocked' ? '차단 목록에 해당하는 사용 기록이 없어요' : '조건에 맞는 사용 기록이 없어요';
  byId('usage-empty-copy').textContent = state.enabled ? '선택한 기간에 하루 누적 5분을 초과한 사이트의 사용 시간이 표시돼요.' : '사용 시간 기록이 꺼져 있어요. 아래에서 기록을 켤 수 있어요.';
  byId('recording-toggle').setAttribute('aria-checked', String(state.enabled));
  byId('recording-status').textContent = state.enabled ? '기록 켜짐' : '일시 중지 · 기존 기록은 유지돼요';
  renderScope();
  renderDaily(state);
  updateControls();
}

function renderError(text, code) {
  loading = false;
  updateRequired = code === 'UPDATE_REQUIRED';
  byId('usage-report').setAttribute('aria-busy', 'false');
  byId('usage-loading').hidden = true;
  byId('usage-error').hidden = false;
  byId('usage-error-text').textContent = text;
  byId('reload-extension').hidden = !updateRequired;
  byId('retry-button').hidden = updateRequired;
  if (!currentState) {
    byId('date-range').textContent = updateRequired ? '새로고침 필요' : '불러오기 실패';
    byId('recording-status').textContent = updateRequired ? '새로고침 후 확인할 수 있어요' : '불러오기 실패';
  }
  updateControls();
}

function startLoading() {
  loading = true;
  byId('usage-report').setAttribute('aria-busy', 'true');
  byId('usage-loading').hidden = false;
  byId('usage-error').hidden = true;
  byId('total-time').textContent = '—';
  byId('total-sites').textContent = '—';
  byId('period-label').textContent = days === 1 ? '오늘의 사용 시간' : `최근 ${days}일 사용 시간`;
  byId('date-range').textContent = '불러오는 중';
  byId('usage-sites').replaceChildren();
  byId('usage-empty').hidden = true;
  byId('daily-section').hidden = true;
  renderScope();
  updateControls();
}

const observer = observeUsage(render, renderError);
periodButtons.forEach(button => button.addEventListener('click', () => {
  if (busy || days === Number(button.dataset.days)) return;
  days = Number(button.dataset.days);
  selectedDate = null;
  startLoading();
  observer.setDays(days);
}));
filterButtons.forEach(button => button.addEventListener('click', () => {
  if (busy || filter === button.dataset.filter) return;
  filter = button.dataset.filter;
  selectedDate = null;
  startLoading();
  observer.setFilter(filter);
}));
byId('retry-button').addEventListener('click', () => { startLoading(); observer.refresh(true); });
byId('reload-extension').addEventListener('click', async () => {
  byId('reload-extension').disabled = true;
  try { await chrome.runtime.reload(); }
  catch (error) {
    byId('usage-error-text').textContent = error.message || '새로고침하지 못했어요. 확장 프로그램 관리 화면에서 다시 시도해 주세요.';
  } finally { byId('reload-extension').disabled = false; }
});

async function mutate(type, payload, successMessage) {
  if (busy || loading || !currentState) return;
  busy = true;
  updateControls();
  showMessage(byId('action-message'), '');
  try {
    await observer.mutate(type, payload);
    showMessage(byId('action-message'), successMessage, 'success');
    return true;
  } catch (error) {
    if (error.code === 'UPDATE_REQUIRED') renderError(error.message, error.code);
    else showMessage(byId('action-message'), error.message);
    return false;
  }
  finally { busy = false; updateControls(); }
}

byId('recording-toggle').addEventListener('click', () => {
  if (!currentState) return;
  const enabled = !currentState.enabled;
  mutate('SET_USAGE_ENABLED', { enabled }, enabled ? '사용 시간 기록을 켰어요.' : '사용 시간 기록을 일시 중지했어요.');
});
function closeConfirmation() {
  byId('clear-confirmation').hidden = true;
  byId('clear-button').setAttribute('aria-expanded', 'false');
  byId('clear-button').focus();
}
byId('clear-button').addEventListener('click', () => {
  byId('clear-confirmation').hidden = false;
  byId('clear-button').setAttribute('aria-expanded', 'true');
  byId('cancel-clear').focus();
});
byId('cancel-clear').addEventListener('click', closeConfirmation);
byId('clear-confirmation').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !busy) { event.preventDefault(); closeConfirmation(); }
});
byId('confirm-clear').addEventListener('click', async () => {
  if (await mutate('CLEAR_USAGE', {}, '모든 사용 기록을 삭제했어요.')) closeConfirmation();
});
