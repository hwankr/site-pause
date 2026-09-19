import test from 'node:test';
import assert from 'node:assert/strict';
import {requestUsage, UPDATE_MESSAGE} from './usage-client.js';

function connection(reply) {
  const messages = [];
  globalThis.chrome = {runtime: {async sendMessage(message) {
    messages.push(message);
    return reply(message);
  }}};
  return messages;
}

test('old worker is probed without sending unsupported usage requests', async () => {
  for (const oldResponse of [
    {ok: true, state: {enabled: false, sites: []}},
    {ok: true, state: {}, capabilities: {usage: true}},
    // The previous worker only authorizes popup/options, not the new usage page.
    {ok: false, error: '확장 프로그램 화면에서 사용해 주세요.'}
  ]) {
    const messages = connection(() => oldResponse);
    for (const type of ['GET_USAGE', 'SET_USAGE_ENABLED', 'CLEAR_USAGE']) {
      await assert.rejects(requestUsage(type), error => error.code === 'UPDATE_REQUIRED' && error.message === UPDATE_MESSAGE);
    }
    assert.deepEqual(messages.map(message => message.type), ['GET_STATE', 'GET_STATE', 'GET_STATE']);
  }
});

test('updated worker receives the requested period or mutation after its capability check', async () => {
  const result = {enabled: true, days: 7, totalMs: 4000};
  const messages = connection(message => message.type === 'GET_STATE'
    ? {ok: true, state: {}, capabilities: {usage: true, usageFilters: true}}
    : {ok: true, state: result});
  assert.deepEqual(await requestUsage('SET_USAGE_ENABLED', {enabled: true, days: 7, filter: 'blocked'}), result);
  assert.deepEqual(messages, [{type: 'GET_STATE'}, {type: 'SET_USAGE_ENABLED', enabled: true, days: 7, filter: 'blocked'}]);
});

test('modern worker failures remain useful errors and do not send a follow-up mutation', async () => {
  const messages = connection(() => ({ok: false, error: 'storage unavailable', capabilities: {usage: true, usageFilters: true}}));
  await assert.rejects(requestUsage('CLEAR_USAGE'), error => error.message === 'storage unavailable' && !error.code);
  assert.deepEqual(messages, [{type: 'GET_STATE'}]);
  connection(() => { throw new Error('Connection closed'); });
  await assert.rejects(requestUsage('GET_USAGE'), /Connection closed/);
});

test('a manual retry discovers the updated worker without a stale capability cache', async () => {
  let updated = false;
  connection(message => message.type === 'GET_STATE'
    ? {ok: true, state: {}, ...(updated ? {capabilities: {usage: true, usageFilters: true}} : {})}
    : {ok: true, state: {totalMs: 0}});
  await assert.rejects(requestUsage('GET_USAGE'), {code: 'UPDATE_REQUIRED'});
  updated = true;
  assert.deepEqual(await requestUsage('GET_USAGE'), {totalMs: 0});
});
