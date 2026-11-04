import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlaylist, resolvePlaylist, assembleHls, validateAudioInit, validateFragment } from '../extension/lib/hls.js';

const base = 'https://example.com/stream/manifest.m3u8?token=abc';
const source = 'https://d2lwuy8qc234o3.cloudfront.net/1/clip/45b80291-efdb-4cee-b511-ced18dbdf1b2.m4a';
const query = `?src=${encodeURIComponent(source)}&muffleAfter=10`;
const manifest = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-MAP:URI="init.mp4${query}"
#EXTINF:6.000000,
seg-0.mp4${query}
#EXTINF:4.000000,
seg-1.mp4${query}
#EXT-X-ENDLIST`;

function box(type, ...contents) {
  const data = Buffer.concat(contents);
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8); header.write(type, 4);
  return Buffer.concat([header, data]);
}
function init(handler = 'soun') {
  return box('ftyp', Buffer.from('isom0000')).length && Buffer.concat([
    box('ftyp', Buffer.from('isom0000')), box('moov', box('trak', box('mdia', box('hdlr', Buffer.alloc(8), Buffer.from(handler))))) ]);
}
const fragment = Buffer.concat([box('moof'), box('mdat', Buffer.from([1, 2, 3, 4]))]);

test('parses the supplied fMP4 layout, preserves processing parameters, and discovers the original', () => {
  const plan = parsePlaylist(manifest, base);
  assert.equal(plan.extension, 'm4a');
  assert.equal(plan.duration, 10);
  assert.equal(plan.parts.length, 2);
  assert.equal(plan.originals[0].url, source);
  assert.equal(plan.init.url, `https://example.com/stream/init.mp4${query}`);
  assert.equal(new URL(plan.parts[1].url).searchParams.get('muffleAfter'), '10');
});

test('rejects encryption, incomplete streams, discontinuities, changed maps, missing segments, and TS', () => {
  assert.throws(() => parsePlaylist(manifest.replace('#EXT-X-ENDLIST', ''), base), /live or incomplete/);
  assert.throws(() => parsePlaylist(manifest.replace('#EXT-X-VERSION:7', '#EXT-X-KEY:METHOD=AES-128,URI="key"'), base), /encrypted/);
  assert.throws(() => parsePlaylist(manifest.replace('#EXT-X-VERSION:7', '#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI="key"'), base), /encrypted/);
  assert.throws(() => parsePlaylist(manifest.replace('#EXTINF:4', '#EXT-X-DISCONTINUITY\n#EXTINF:4'), base), /timeline/);
  assert.throws(() => parsePlaylist(manifest.replace('#EXTINF:4', '#EXT-X-MAP:URI="other.mp4"\n#EXTINF:4'), base), /Changing initialization/);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:1,\nsegment.ts\n#EXT-X-ENDLIST', base), /needs remuxing/);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:1,\nfile.aac\n#EXTINF:2,\n#EXT-X-ENDLIST', base), /final segment/);
  assert.throws(() => parsePlaylist('<html>Login required</html>', base), /login or link/);
});

test('selects default standalone audio from a master and audio-only variants by bandwidth', () => {
  const master = '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="French, stereo",DEFAULT=NO,URI="fr/audio.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="English",DEFAULT=YES,URI="en/audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="a"\nvideo.m3u8';
  const parsed = parsePlaylist(master, base);
  assert.equal(parsed.choices[0].name, 'English');
  assert.equal(parsed.choices[1].name, 'French, stereo');
  assert.equal(parsed.choices[0].url, 'https://example.com/stream/en/audio.m3u8');
  const audio = parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"\nhigh.m3u8', base);
  assert.match(audio.choices[0].url, /high/);
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.4d401f,mp4a.40.2"\nv.m3u8', base), /no standalone audio/);
});

test('resolves signed relative paths against the final redirected playlist URL', async () => {
  const fetcher = async () => {
    const response = new Response('#EXTM3U\n#EXTINF:1,\na.aac?sig=a%2Bb\n#EXT-X-ENDLIST');
    Object.defineProperty(response, 'url', { value: 'https://cdn.example.com/final/list.m3u8' });
    return response;
  };
  const plan = await resolvePlaylist(base, { fetcher });
  assert.equal(plan.parts[0].url, 'https://cdn.example.com/final/a.aac?sig=a%2Bb');
});

test('supports explicit and consecutive implicit byte ranges on the same resource', () => {
  const plan = parsePlaylist('#EXTM3U\n#EXT-X-MAP:URI="all.mp4",BYTERANGE="16@0"\n#EXTINF:1,\n#EXT-X-BYTERANGE:20@16\nall.mp4\n#EXTINF:1,\n#EXT-X-BYTERANGE:30\nall.mp4\n#EXT-X-ENDLIST', base);
  assert.deepEqual(plan.init.range, { offset: 0, length: 16 });
  assert.deepEqual(plan.parts[1].range, { offset: 36, length: 30 });
  assert.throws(() => parsePlaylist('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:30\na.aac\n#EXT-X-ENDLIST', base), /incomplete/);
});

test('assembles init plus complete fragments in exact order with credentials and progress', async () => {
  const plan = parsePlaylist(manifest, base);
  const calls = [];
  const progress = [];
  const audioInit = init();
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    return new Response(url.includes('init.mp4') ? audioInit : fragment);
  };
  const blob = await assembleHls(plan, { fetcher, onProgress: value => progress.push(value) });
  assert.equal(blob.type, 'audio/mp4');
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), Buffer.concat([audioInit, fragment, fragment]));
  assert.equal(progress.at(-1).completed, 3);
  assert.equal(calls[0].options.credentials, 'include');
  assert.ok(calls.every(call => call.url.includes('muffleAfter=10')));
});

test('refuses video initialization, malformed fragments, access errors and canceled jobs', async () => {
  assert.throws(() => validateAudioInit(init('vide')), /includes video/);
  assert.throws(() => validateAudioInit(Buffer.from('not mp4')), /MP4/);
  assert.throws(() => validateFragment(box('mdat', Buffer.from('data'))), /not a complete/);
  const plan = parsePlaylist(manifest, base);
  await assert.rejects(assembleHls(plan, { fetcher: async () => new Response('denied', { status: 403 }) }), /HTTP 403/);
  await assert.rejects(assembleHls(plan, { signal: AbortSignal.abort() }), /canceled/);
});

test('rejects servers ignoring requested ranges and enforces bounded downloads', async () => {
  const plan = parsePlaylist('#EXTM3U\n#EXTINF:1,\n#EXT-X-BYTERANGE:4@0\na.aac\n#EXT-X-ENDLIST', base);
  await assert.rejects(assembleHls(plan, { fetcher: async () => new Response('abcd') }), /did not honor/);
  const blob = await assembleHls(plan, { fetcher: async (url, options) => {
    assert.equal(options.headers.Range, 'bytes=0-3');
    return new Response('abcd', { status: 206, headers: { 'Content-Range': 'bytes 0-3/10' } });
  } });
  assert.equal(await blob.text(), 'abcd');
  await assert.rejects(assembleHls(plan, { fetcher: async () => new Response('x', {
    status: 206, headers: { 'Content-Range': 'bytes 0-3/10', 'Content-Length': String(129 * 1024 * 1024) },
  }) }), /128 MB/);
});

