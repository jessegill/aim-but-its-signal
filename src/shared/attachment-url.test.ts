/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * The attachment URL, both directions.
 *
 * This is the address an inline thumbnail is fetched by, and the only reason it exists is that
 * `file://` does not work in both builds: the packaged renderer is a `file://` document and can
 * load one, the dev renderer is served over http and cannot. Thumbnails therefore rendered when
 * packaged and silently vanished under `npm run dev`.
 *
 * The thing most likely to break it is the colon. A message id is `<aci>:<sentAt>`, and a colon
 * that stops being encoded changes what a URL parser thinks the parts are — silently, and only
 * for real ids, not for whatever a hand-written test URL happens to contain. So the round trip is
 * asserted on the shape ids actually have.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ATTACHMENT_SCHEME, attachmentUrl, parseAttachmentUrl } from './types.ts';

const MESSAGE_ID = '11111111-2222-4333-8444-555555555555:1700000012345';
const ATTACHMENT_ID = '11111111-2222-4333-8444-555555555555:1700000012345:a0';

describe('attachment URLs', () => {
  test('a real message id survives the round trip', () => {
    const url = attachmentUrl(MESSAGE_ID, ATTACHMENT_ID);
    assert.equal(parseAttachmentUrl(url)?.messageId, MESSAGE_ID);
    assert.equal(parseAttachmentUrl(url)?.attachmentId, ATTACHMENT_ID);
  });

  test('the colon in an id is encoded, not left to the URL parser', () => {
    const url = attachmentUrl(MESSAGE_ID, ATTACHMENT_ID);
    // Two separators and no more: everything else is percent-encoded.
    assert.equal(url.slice(`${ATTACHMENT_SCHEME}://`.length).split('/').length, 3);
    assert.ok(!url.includes(':17000'), 'a raw colon leaked into the path');
  });

  test('ids that look like path traversal survive as data and cannot escape', () => {
    // The parser must hand back exactly what went in. Whether that names anything is decided by
    // the message row, not by the URL — the handler looks the id up and refuses a path outside
    // the cache, so a traversal-shaped id is just an id that matches no message.
    const url = attachmentUrl('../../etc/passwd', 'a0');
    assert.equal(parseAttachmentUrl(url)?.messageId, '../../etc/passwd');
  });

  test('malformed URLs are null, never a throw', () => {
    // The handler turns null into a 404. A throw inside a protocol handler is a broken image
    // with no explanation anywhere.
    for (const bad of [
      'not a url',
      'https://example.com/a/b',
      `${ATTACHMENT_SCHEME}://file/only-one`,
      `${ATTACHMENT_SCHEME}://file/a/b/c`,
      `${ATTACHMENT_SCHEME}://file/`,
      `${ATTACHMENT_SCHEME}://file/%E0%A4%A/b`,
    ]) {
      assert.equal(parseAttachmentUrl(bad), null, `${bad} should not parse`);
    }
  });

  test('the scheme is checked, so another scheme cannot reach the handler', () => {
    assert.equal(parseAttachmentUrl('file://file/a/b'), null);
  });
});
