import test from 'node:test';
import assert from 'node:assert/strict';
import {request} from './shared-ui.js';

test('new short-form settings never silently save through an older background worker', async () => {
  const calls = [];
  globalThis.chrome = {runtime: {async sendMessage(message) {
    calls.push(message);
    return {ok: true, state: {enabled: false}, capabilities: {usage: true}};
  }}};
  await assert.rejects(request('SAVE_RULES', {youtubeShorts: true}), /새로고침/);
  assert.deepEqual(calls.map(message => message.type), ['GET_STATE']);
});

test('short-form capability is checked freshly and the saved state is returned', async () => {
  const calls = [];
  const saved = {enabled: true, instagramReels: true};
  globalThis.chrome = {runtime: {async sendMessage(message) {
    calls.push(message);
    return {ok: true, state: saved, capabilities: {shortForm: true}};
  }}};
  assert.deepEqual(await request('SAVE_RULES', {instagramReels: true}), saved);
  assert.deepEqual(calls.map(message => message.type), ['GET_STATE', 'SAVE_RULES']);
  assert.equal(calls[1].instagramReels, true);
});
