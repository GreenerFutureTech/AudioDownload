import test from 'node:test';
import assert from 'node:assert/strict';
import { pageAwareFetch } from '../extension/lib/page-fetch.js';
import { resolvePlaylist, assembleHls } from '../extension/lib/hls.js';
import { hlsFailureDetails } from '../extension/lib/diagnostics.js';

const url = 'https://suno.com/stream/manifest.m3u8?token=secret&muffleAfter=10';
const playlist = '#EXTM3U\n#EXTINF:1,\ntrack.aac?muffleAfter=10&sig=a%2Bb\n#EXT-X-ENDLIST';

test('successful extension requests do not trigger a page retry', async () => {
  const fetcher = pageAwareFetch(7, 0, { sendMessage() { throw new Error('Unexpected page retry'); } }, async () => new Response('audio'));
  assert.equal(await (await fetcher(url)).text(), 'audio');
});

test('playlist 404 retries from the correct tab/frame and assembles the exact original segment URL', async () => {
  const calls = [];
  const runtime = { sendMessage: async message => {
    calls.push(message);
    return { ok: true, status: 200, url: message.url, headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      data: btoa(message.url.includes('manifest') ? playlist : 'existing-audio-bytes') };
  } };
  const fetcher = pageAwareFetch(7, 3, runtime, async () => new Response('missing', { status: 404 }));
  const plan = await resolvePlaylist(url, { fetcher });
  const blob = await assembleHls(plan, { fetcher });
  assert.equal(await blob.text(), 'existing-audio-bytes');
  assert.equal(calls[0].tabId, 7);
  assert.equal(calls[0].frameId, 3);
  assert.equal(calls[0].url, url);
  assert.equal(calls[1].url, 'https://suno.com/stream/track.aac?muffleAfter=10&sig=a%2Bb');
});

test('page retry preserves byte ranges and redirected response URLs', async () => {
  const fetcher = pageAwareFetch(7, 0, { sendMessage: async message => {
    assert.equal(message.range, 'bytes=10-13');
    return { ok: true, status: 206, url: 'https://cdn.example.com/final/a.aac',
      headers: { 'content-range': 'bytes 10-13/50' }, data: btoa('abcd') };
  } }, async () => { throw new TypeError('Failed to fetch'); });
  const response = await fetcher(url, { headers: { Range: 'bytes=10-13' } });
  assert.equal(response.status, 206);
  assert.equal(response.url, 'https://cdn.example.com/final/a.aac');
  assert.equal(response.headers.get('content-range'), 'bytes 10-13/50');
  assert.equal(await response.text(), 'abcd');
});

test('diagnostics identify playlist and segment failures without copying signed query values', async () => {
  const fetcher = pageAwareFetch(7, 0, { sendMessage: async () => ({ ok: false, error: 'Page unavailable' }) },
    async () => new Response('missing', { status: 404 }));
  let failure;
  await assert.rejects(resolvePlaylist(url, { fetcher }), error => {
    failure = error.failure;
    return error.message.includes('Playlist request failed: HTTP 404');
  });
  const details = hlsFailureDetails({ failure });
  assert.equal(details.stage, 'Playlist');
  assert.equal(details.httpStatus, 404);
  assert.equal(details.pageRetry, 'Page unavailable');
  assert.ok(!JSON.stringify(details).includes('secret'));
  assert.deepEqual(details.request.queryParameters, ['token', 'muffleAfter']);
  const plan = await resolvePlaylist(url, { fetcher: async () => new Response(playlist) });
  await assert.rejects(assembleHls(plan, { fetcher: async () => new Response('missing', { status: 404 }) }), error => {
    assert.equal(error.failure.stage, 'Segment 1'); return true;
  });
});

test('a canceled download does not retry through the page', async () => {
  const controller = new AbortController(); controller.abort();
  const fetcher = pageAwareFetch(7, 0, { sendMessage() { throw new Error('Unexpected retry'); } },
    async () => new Response('missing', { status: 404 }));
  await assert.rejects(fetcher(url, { signal: controller.signal }), /abort/i);
});
