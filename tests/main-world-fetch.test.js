import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readPageMedia } from '../extension/lib/main-world-fetch.js';

test('self-contained MAIN-world function uses page fetch and reports the service worker controller', async () => {
  const url = 'https://suno.com/_sw-mango/manifest.m3u8?src=original&muffleAfter=10';
  const context = {
    URL, AbortController, btoa, setTimeout, clearTimeout, args: [url, 'bytes=0-4'],
    navigator: { serviceWorker: { controller: {} } },
    fetch: async (actual, options) => {
      assert.equal(actual, url);
      assert.equal(options.credentials, 'include');
      assert.equal(options.headers.Range, 'bytes=0-4');
      return new Response(Uint8Array.from([0, 1, 127, 128, 255]), {
        status: 206, headers: { 'content-range': 'bytes 0-4/10' },
      });
    },
  };
  const result = await vm.runInNewContext(`(${readPageMedia.toString()})(...args)`, context);
  assert.equal(result.transport, 'page-main');
  assert.equal(result.serviceWorkerControlled, true);
  assert.equal(result.url, url);
  assert.equal(result.headers['content-range'], 'bytes 0-4/10');
  assert.deepEqual(Buffer.from(result.data, 'base64'), Buffer.from([0, 1, 127, 128, 255]));
});

test('missing page service worker is visible in diagnostics instead of assumed to be active', async () => {
  const context = { URL, AbortController, btoa, setTimeout, clearTimeout, navigator: {},
    fetch: async () => new Response('missing', { status: 404 }) };
  const result = await vm.runInNewContext(`(${readPageMedia.toString()})('https://suno.com/_sw-mango/manifest.m3u8')`, context);
  assert.equal(result.status, 404);
  assert.equal(result.serviceWorkerControlled, false);
});
