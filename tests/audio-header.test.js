import test from 'node:test';
import assert from 'node:assert/strict';
import { hasMp4Header, validateM4aSource } from '../extension/lib/audio-header.js';

const valid = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 77, 52, 65, 32, 0, 0, 0, 0]);
test('accepts MP4 headers and rejects the unplayable download header observed locally', () => {
  assert.equal(hasMp4Header(valid), true);
  assert.equal(hasMp4Header(Buffer.from('43d52e38b20795caec9ed6afeef3a5051fa1e6377af1efd50350d41c9be6c99a', 'hex')), false);
  assert.equal(hasMp4Header(Buffer.from('<html>not audio</html>')), false);
});
test('source validation reads a bounded prefix and keeps the source URL unchanged', async () => {
  const url = 'https://example.com/song.m4a?sig=a%2Bb&muffleAfter=10';
  await validateM4aSource(url, async (actual, options) => {
    assert.equal(actual, url);
    assert.equal(options.headers.Range, 'bytes=0-65535');
    return new Response(valid);
  });
  await assert.rejects(validateM4aSource(url, async () => new Response(new Uint8Array(100))), /valid MP4\/M4A header/);
  await assert.rejects(validateM4aSource(url, async () => new Response('missing', { status: 404 })), /HTTP 404/);
});
