import test from 'node:test';
import assert from 'node:assert/strict';
import { detectMedia, httpUrl, embeddedAudioSources, mergeTrack, responseSize,
  safeFilename, dispositionFilename, formatDuration, formatBytes } from '../extension/lib/media.js';

test('detects signed and extensionless audio without changing access parameters', () => {
  const url = 'https://example.com/Song.MP3?token=a%2Bb&expires=123';
  assert.equal(detectMedia(url).url, url);
  assert.equal(detectMedia(url).format, 'MP3');
  assert.equal(detectMedia('https://example.com/play?id=1', 'audio/mp4; codecs=mp4a.40.2').extension, 'm4a');
  assert.equal(detectMedia('https://example.com/playlist?id=1', 'application/vnd.apple.mpegurl').kind, 'playlist');
  assert.equal(detectMedia('https://example.com/video.mp4', 'video/mp4'), null);
  assert.equal(detectMedia('https://example.com/chunk.m4s', 'audio/mp4').kind, 'segment');
});

test('extracts the exact M4A source from the supplied Suno-style manifest segment URL', () => {
  const source = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/45b80291-efdb-4cee-b511-ced18dbdf1b2.m4a?Signature=a%2Bb&Key-Pair-Id=123';
  const segment = `https://example.com/seg-0.mp4?contentId=45b80291-efdb-4cee-b511-ced18dbdf1b2&src=${encodeURIComponent(source)}&contentType=clip&muffleAfter=10`;
  const [media] = embeddedAudioSources(segment);
  assert.equal(media.url, source);
  assert.equal(media.source, 'embedded');
  assert.equal(new URL(media.sourcePage).searchParams.get('muffleAfter'), '10');
  assert.deepEqual(embeddedAudioSources('https://example.com/init.mp4?src=javascript%3Aalert(1)'), []);
  assert.deepEqual(embeddedAudioSources('https://example.com/init.mp4?src=https%3A%2F%2Fexample.com%2Fvideo.mp4'), []);
});

test('rejects blob, executable, credential-bearing and non-network URLs', () => {
  for (const url of ['blob:https://suno.com/test', 'javascript:alert(1)', 'file:///C:/test.mp3',
    'data:audio/mp3,test', 'https://user:pass@example.com/song.mp3']) assert.equal(httpUrl(url), null);
  assert.equal(detectMedia('https://example.com/song.exe'), null);
});

test('sanitizes filenames and handles RFC 5987 content disposition', () => {
  assert.equal(dispositionFilename("attachment; filename*=UTF-8''My%20song.m4a"), 'My song.m4a');
  assert.equal(safeFilename('../CON:demo?.mp3'), '_CON_demo_.mp3');
  assert.equal(safeFilename('CON.mp3'), '_CON.mp3');
  assert.equal(safeFilename('..'), 'audio');
  const result = detectMedia('https://example.com/download', 'audio/mpeg', 'attachment; filename="bad.exe"');
  assert.equal(result.filename, 'bad.exe.mp3');
});

test('uses total file size for range requests and avoids displaying chunk length as total', () => {
  assert.equal(responseSize([{ name: 'Content-Range', value: 'bytes 0-99/2000' }, { name: 'Content-Length', value: '100' }], 206), 2000);
  assert.equal(responseSize([{ name: 'Content-Length', value: '100' }], 206), null);
  assert.equal(responseSize([{ name: 'content-length', value: '100' }]), 100);
});

test('deduplicates repeated range requests, retains network metadata and bounds history', () => {
  const original = { ...detectMedia('https://example.com/play?id=1', 'audio/mp4'), id: 'one', firstSeen: 1,
    lastSeen: 2, size: 100, source: 'network', playing: false };
  const incoming = { ...detectMedia(original.url, 'audio/unknown'), id: 'two', firstSeen: 3,
    lastSeen: 4, source: 'page', playing: true, size: null };
  const merged = mergeTrack([original], incoming);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, 'one');
  assert.equal(merged[0].format, 'M4A');
  assert.equal(merged[0].size, 100);
  assert.equal(merged[0].playing, true);
  assert.equal(merged[0].lastSeen, 4);
  assert.equal(mergeTrack([original], { url: 'https://example.com/two.mp3' }, 1).length, 1);
});

test('formats zero, unknown sizes and elapsed times', () => {
  assert.equal(formatDuration(62000), '01:02');
  assert.equal(formatDuration(-10), '00:00');
  assert.equal(formatBytes(null), 'Size unknown');
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
});
