import test from 'node:test';
import assert from 'node:assert/strict';
import {siteName} from './site-labels.js';

test('known sites share display names across recognized hostname variants', () => {
  assert.equal(siteName('youtube.com'), 'YouTube');
  assert.equal(siteName('WWW.YouTube.COM.'), 'YouTube');
  assert.equal(siteName('m.youtube.com'), 'YouTube');
  assert.equal(siteName('youtu.be'), 'YouTube');
  assert.equal(siteName('github.com'), 'GitHub');
  assert.equal(siteName('instagram.com'), 'Instagram');
  assert.equal(siteName('twitter.com'), 'X');
  assert.equal(siteName('chat.openai.com'), 'ChatGPT');
});

test('separate services on branded subdomains retain distinct names', () => {
  assert.equal(siteName('music.youtube.com'), 'YouTube Music');
  assert.equal(siteName('studio.youtube.com'), 'YouTube Studio');
  assert.equal(siteName('google.com'), 'Google');
  assert.equal(siteName('mail.google.com'), 'Gmail');
  assert.equal(siteName('drive.google.com'), 'Google Drive');
  assert.equal(siteName('docs.google.com'), 'Google Docs');
});

test('unknown domains retain their original text', () => {
  for (const host of ['news.example.test', 'WWW.Unknown.example.', 'localhost', '127.0.0.1', '__proto__']) {
    assert.equal(siteName(host), host);
  }
});

test('lookalikes and unlisted subdomains cannot inherit a brand name', () => {
  for (const host of [
    'youtube.com.example.test', 'notyoutube.com', 'youtube.example',
    'private.youtube.com', 'www.www.youtube.com', 'youtube.com..',
    'example.notion.site', 'example.github.io', 'example.notion.so',
    'https://youtube.com/watch?v=123', 'youtube.com/path',
  ]) {
    assert.equal(siteName(host), host);
  }
});
