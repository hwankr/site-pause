import {request} from './shared-ui.js';

export const UPDATE_REQUIRED = 'UPDATE_REQUIRED';
export const UPDATE_MESSAGE = '새 버전을 적용하려면 확장 프로그램을 새로고침해 주세요. 차단 목록과 사용 기록은 유지됩니다.';

export async function requestUsage(type, payload = {}) {
  // Unpacked extension pages can load new files while Chrome still runs the
  // previous worker. Probe the longstanding GET_STATE request first; sending
  // GET_USAGE directly would make that worker log "unsupported request".
  const response = await chrome.runtime.sendMessage({type: 'GET_STATE'});
  if (!response) throw new Error('연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  if (response.capabilities?.usage !== true || response.capabilities?.usageFilters !== true) {
    throw Object.assign(new Error(UPDATE_MESSAGE), {code: UPDATE_REQUIRED});
  }
  if (!response.ok) throw new Error(response.error || '설정을 불러오지 못했어요. 다시 시도해 주세요.');
  return request(type, payload);
}
