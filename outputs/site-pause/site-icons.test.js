import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteIcon } from './site-icons.js';

function withDocument(run, { runtime = true } = {}) {
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const chromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
  const document = {
    createElement(tagName) {
      return {
        tagName,
        children: [],
        attributes: {},
        events: {},
        hidden: false,
        setAttribute(name, value) { this.attributes[name] = value; },
        addEventListener(name, listener) { this.events[name] = listener; },
        append(...children) { this.children.push(...children); },
      };
    },
  };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document });
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: runtime ? { runtime: { getURL: path => `chrome-extension://test-extension${path}` } } : undefined,
  });
  try {
    run();
  } finally {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor);
    else delete globalThis.document;
    if (chromeDescriptor) Object.defineProperty(globalThis, 'chrome', chromeDescriptor);
    else delete globalThis.chrome;
  }
}

test('favicon requests use the Chrome endpoint with only the site origin', () => {
  withDocument(() => {
    for (const [value, expected] of [
      ['youtube.com', 'https://www.youtube.com/'],
      ['https://example.test/private?token=secret#fragment', 'https://example.test/'],
      ['http://name:password@localhost:8080/private', 'http://localhost:8080/'],
      ['https://music.youtube.com/playlist?list=private', 'https://music.youtube.com/'],
    ]) {
      const icon = createSiteIcon(value);
      const source = new URL(icon.children[1].src);
      assert.equal(source.protocol, 'chrome-extension:');
      assert.equal(source.pathname, '/_favicon/');
      assert.equal(source.searchParams.get('pageUrl'), expected);
      assert.equal(source.searchParams.get('size'), '32');
    }
  });
});

test('normalized site domains use known homepages without rewriting page URLs or subdomains', () => {
  withDocument(() => {
    for (const [value, expected] of [
      ['instagram.com', 'https://www.instagram.com/'],
      ['google.com', 'https://www.google.com/'],
      ['google.co.kr', 'https://www.google.co.kr/'],
      ['reddit.com', 'https://www.reddit.com/'],
      ['facebook.com', 'https://www.facebook.com/'],
      ['naver.com', 'https://www.naver.com/'],
      ['netflix.com', 'https://www.netflix.com/'],
      ['notion.so', 'https://www.notion.so/'],
      ['notion.com', 'https://www.notion.com/'],
      ['www.youtube.com', 'https://www.youtube.com/'],
      ['music.youtube.com', 'https://music.youtube.com/'],
      ['studio.youtube.com', 'https://studio.youtube.com/'],
      ['github.com', 'https://github.com/'],
      ['mail.google.com', 'https://mail.google.com/'],
      ['youtube.com.example.test', 'https://youtube.com.example.test/'],
      ['https://youtube.com/watch?v=private', 'https://youtube.com/'],
      ['http://instagram.com/private', 'http://instagram.com/'],
    ]) {
      const source = new URL(createSiteIcon(value).children[1].src);
      assert.equal(source.searchParams.get('pageUrl'), expected, value);
    }
  });
});

test('favicon loading and failures always leave one unbroken visual', () => {
  withDocument(() => {
    const icon = createSiteIcon('youtube.com');
    const [fallback, image] = icon.children;
    assert.equal(icon.attributes['aria-hidden'], 'true');
    assert.equal(image.alt, '');
    assert.equal(fallback.hidden, false);
    assert.equal(image.hidden, true);
    image.events.load();
    assert.equal(fallback.hidden, true);
    assert.equal(image.hidden, false);
    image.events.error();
    assert.equal(fallback.hidden, false);
    assert.equal(image.hidden, true);
  });
});

test('invalid sites and unavailable Chrome APIs retain the local fallback', () => {
  withDocument(() => {
    for (const value of ['', null, undefined, 'not a domain', 'file:///private', 'javascript:alert(1)', 'data:image/svg+xml,unsafe']) {
      const [fallback, image] = createSiteIcon(value).children;
      assert.equal(image.src, undefined);
      assert.equal(image.hidden, true);
      assert.equal(fallback.hidden, false);
    }
  });
  withDocument(() => {
    const [fallback, image] = createSiteIcon('youtube.com').children;
    assert.equal(image.src, undefined);
    assert.equal(fallback.hidden, false);
  }, { runtime: false });
});
