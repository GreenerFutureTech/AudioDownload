import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { recordingsForPage } from '../extension/lib/page-audio.js';

test('shows a page recording alongside source links, including after reopening the song in a different tab', () => {
  const recordings = [
    { id: 'webm', pageUrl: 'https://suno.com/song/one', title: 'My song', tabId: 1 },
    { id: 'hls', pageUrl: 'https://suno.com/song/one', category: 'hls', extension: 'm4a' },
    { id: 'other', pageUrl: 'https://suno.com/song/two', title: 'Other song', tabId: 2 },
    { id: 'legacy', tabId: 3, title: 'My song' },
  ];
  const tab = { id: 3, url: 'https://suno.com/song/one#player', title: 'My song' };
  assert.deepEqual(recordingsForPage(recordings, tab).map(row => row.id), ['webm', 'legacy']);
  assert.deepEqual(recordingsForPage(recordings, { ...tab, url: 'https://suno.com/song/three', title: 'Another song' }), []);
});

test('content scan recovers prior WebM requests and reports an audio blob for recording', async () => {
  const messages = [];
  const audio = { currentSrc: 'blob:https://suno.com/song', src: 'blob:https://suno.com/song',
    paused: false, ended: false, tagName: 'AUDIO', querySelectorAll: () => [] };
  const context = {
    document: { querySelectorAll: () => [audio], addEventListener() {}, documentElement: {} },
    performance: { getEntriesByType: () => [
      { name: 'https://example.com/song.webm?token=123' },
      { name: 'https://example.com/song.m4a' },
      { name: 'https://example.com/list.m3u8' },
      { name: 'https://example.com/style.css' },
    ] },
    chrome: { runtime: { sendMessage: async message => { messages.push(message); }, onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'), context);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].hasBlob, true);
  assert.equal(messages[0].hasMedia, true);
  assert.deepEqual(Array.from(messages[0].resources, row => row.url), [
    'https://example.com/song.webm?token=123', 'https://example.com/song.m4a', 'https://example.com/list.m3u8',
  ]);
});

test('a real audio blob downloads the existing file without invoking recording', async () => {
  const messages = [];
  let listener;
  let downloads = 0;
  let downloadedName;
  const url = 'blob:https://suno.com/real-blob';
  const audio = { currentSrc: url, src: url, paused: false, ended: false, tagName: 'AUDIO', querySelectorAll: () => [] };
  const context = {
    fetch: async value => {
      assert.equal(value, url);
      return new Response(new Blob(['existing-webm'], { type: 'audio/webm' }), {
        headers: { 'content-type': 'audio/webm', 'content-length': '13' },
      });
    },
    document: { title: 'Sitting on my Computer', querySelectorAll: () => [audio], addEventListener() {},
      documentElement: { append() {} }, createElement: () => ({
        click() { downloads++; downloadedName = this.download; }, remove() {},
      }) },
    performance: { getEntriesByType: () => [] },
    chrome: { runtime: { sendMessage: async message => { messages.push(message); },
      onMessage: { addListener(value) { listener = value; } } } },
    MutationObserver: class { observe() {} }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'), context);
  await new Promise(resolve => setTimeout(resolve, 0));
  const source = messages.at(-1).sources[0];
  assert.equal(source.blobAvailable, true);
  assert.equal(source.mimeType, 'audio/webm');
  const result = await new Promise(resolve => listener({ type: 'DOWNLOAD_BLOB', url,
    filename: 'Sitting on my Computer.webm' }, {}, resolve));
  assert.equal(result.ok, true);
  assert.equal(downloads, 1);
  assert.equal(downloadedName, 'Sitting on my Computer.webm');
});

test('MediaSource blob URLs are not advertised as downloadable WebM files', async () => {
  const messages = [];
  const audio = { currentSrc: 'blob:https://suno.com/media-source', src: '', paused: false,
    ended: false, tagName: 'AUDIO', querySelectorAll: () => [] };
  vm.runInNewContext(await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'), {
    fetch: async () => { throw new TypeError('Failed to fetch'); },
    document: { title: 'Song', querySelectorAll: () => [audio], addEventListener() {}, documentElement: {} },
    performance: { getEntriesByType: () => [] },
    chrome: { runtime: { sendMessage: async message => { messages.push(message); }, onMessage: { addListener() {} } } },
    MutationObserver: class { observe() {} }, setTimeout, clearTimeout,
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.ok(messages.every(message => message.sources.every(source => !source.blobAvailable)));
});
