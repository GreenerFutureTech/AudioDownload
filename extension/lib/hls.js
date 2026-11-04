import { embeddedAudioSources, httpUrl } from './media.js';

export const MAX_HLS_BYTES = 128 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 2 * 1024 * 1024;
const MAX_PARTS = 4000;

export function attributes(line) {
  const result = {};
  const value = line.slice(line.indexOf(':') + 1);
  const pattern = /(?:^|,)\s*([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (const match of value.matchAll(pattern)) result[match[1]] = match[2].replace(/^"|"$/g, '');
  return result;
}

function resolveUrl(value, base) {
  let resolved;
  try { resolved = httpUrl(new URL(value, base).href); } catch { /* handled below */ }
  if (!resolved) throw new Error('The playlist contains an unsupported media URL.');
  return resolved;
}

function byteRange(value, previous, url) {
  if (!value) return null;
  const match = value.match(/^(\d+)(?:@(\d+))?$/);
  if (!match || Number(match[1]) < 1) throw new Error('Invalid HLS byte range.');
  const length = Number(match[1]);
  const offset = match[2] != null ? Number(match[2]) : previous?.url === url && previous.range
    ? previous.range.offset + previous.range.length : NaN;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length + offset)) {
    throw new Error('The playlist has an incomplete or oversized byte range.');
  }
  return { offset, length };
}

export function parsePlaylist(text, baseUrl) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('This URL did not return an HLS playlist. Your login or link may have expired.');
  const variants = [];
  const renditions = [];
  const parts = [];
  let init = null;
  let range = null;
  let duration = 0;
  let segmentDuration = null;
  let pendingVariant = null;
  let ended = false;
  const originals = new Map(embeddedAudioSources(baseUrl).map(media => [media.url, media]));
  for (const line of lines.slice(1)) {
    if (/^#EXT-X-(?:SESSION-)?KEY:/.test(line) && attributes(line).METHOD !== 'NONE') {
      throw new Error('This HLS stream is encrypted. Download the original source if available; encrypted streams are not assembled.');
    }
    if (/^#EXT-X-(?:DISCONTINUITY(?:$|:)|GAP(?:$|:))/.test(line)) {
      throw new Error('This playlist has timeline changes or missing segments that require remuxing. Try the original source or tab recording.');
    }
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = attributes(line);
      if (attrs.TYPE === 'AUDIO' && attrs.URI) renditions.push({ url: resolveUrl(attrs.URI, baseUrl),
        name: attrs.NAME || attrs.LANGUAGE || 'Audio', default: attrs.DEFAULT === 'YES' });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = attributes(line);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = attributes(line);
      if (!attrs.URI) throw new Error('The playlist is missing its initialization URL.');
      const url = resolveUrl(attrs.URI, baseUrl);
      const next = { url, range: byteRange(attrs.BYTERANGE, null, url) };
      if (init && JSON.stringify(next) !== JSON.stringify(init)) throw new Error('Changing initialization files require remuxing. Try tab recording.');
      if (!init && parts.length) throw new Error('The initialization file must precede the audio segments.');
      init = next;
      for (const media of embeddedAudioSources(url)) originals.set(media.url, media);
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice(line.indexOf(':') + 1);
    } else if (line.startsWith('#EXTINF:')) {
      segmentDuration = Number(line.slice(8).split(',')[0]);
      if (!Number.isFinite(segmentDuration) || segmentDuration < 0) throw new Error('Invalid segment duration.');
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (!line.startsWith('#')) {
      const url = resolveUrl(line, baseUrl);
      for (const media of embeddedAudioSources(url)) originals.set(media.url, media);
      if (pendingVariant) {
        const codecs = pendingVariant.CODECS?.toLowerCase().split(',').map(codec => codec.trim());
        if (codecs?.length && codecs.every(codec => /^(mp4a|ac-3|ec-3|opus|flac)(?:\.|$)/.test(codec))) {
          variants.push({ url, bandwidth: Number(pendingVariant.BANDWIDTH) || 0, name: 'Audio' });
        }
        pendingVariant = null;
      } else {
        if (segmentDuration == null) throw new Error('A media segment is missing its EXTINF duration.');
        parts.push({ url, range: byteRange(range, parts.at(-1), url) });
        if (parts.length > MAX_PARTS) throw new Error('This playlist is too large (maximum 4,000 segments).');
        duration += segmentDuration;
        segmentDuration = null;
        range = null;
      }
    }
  }
  const choices = renditions.length ? renditions.sort((a, b) => Number(b.default) - Number(a.default))
    : variants.sort((a, b) => b.bandwidth - a.bandwidth);
  if (choices.length) return { type: 'master', choices, originals: [...originals.values()] };
  if (lines.some(line => line.startsWith('#EXT-X-STREAM-INF:'))) {
    throw new Error('This master playlist has no standalone audio rendition. Try the original source or tab recording.');
  }
  if (!parts.length) throw new Error('The playlist does not contain any complete audio segments.');
  if (!ended) throw new Error('This is a live or incomplete playlist. A finished playlist with EXT-X-ENDLIST is needed to save the full track.');
  if (segmentDuration != null) throw new Error('The playlist ends before its final segment URL.');
  const extension = init ? 'm4a' : new URL(parts[0].url).pathname.match(/\.(aac|mp3)$/i)?.[1]?.toLowerCase();
  if (!extension || (!init && parts.some(part => !new URL(part.url).pathname.toLowerCase().endsWith(`.${extension}`)))) {
    throw new Error('This segment format needs remuxing. Supported: audio-only fragmented MP4, AAC, and MP3. Try tab recording.');
  }
  return { type: 'media', init, parts, duration, extension,
    mimeType: extension === 'm4a' ? 'audio/mp4' : extension === 'aac' ? 'audio/aac' : 'audio/mpeg',
    originals: [...originals.values()] };
}

async function fetchBytes(url, { signal, range, stage = 'media', limit = MAX_HLS_BYTES, fetcher = fetch } = {}) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) throw new DOMException('Download canceled.', 'AbortError');
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('The server took too long to respond.')), 30000);
  try {
    const response = await fetcher(url, { credentials: 'include', signal: controller.signal,
      headers: range ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {} });
    if (!response.ok) {
      const error = new Error(`${stage} request failed: HTTP ${response.status} (${new URL(url).pathname}).${response.pageError ? ` Page retry: ${response.pageError}` : ''}`);
      error.failure = { stage, status: response.status, url, responseUrl: response.url || url,
        transport: response.transport || 'extension', pageError: response.pageError || null,
        serviceWorkerControlled: response.serviceWorkerControlled ?? null };
      throw error;
    }
    if (range) {
      const match = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(?:\d+|\*)$/i);
      if (response.status !== 206 || !match || Number(match[1]) !== range.offset
        || Number(match[2]) !== range.offset + range.length - 1) {
        controller.abort();
        throw new Error('The server did not honor the playlist byte range.');
      }
    }
    const advertised = Number(response.headers.get('content-length'));
    if (advertised > limit) { controller.abort(); throw new Error('The download exceeds the 128 MB limit.'); }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new Error('The download exceeds the 128 MB limit.'); }
      chunks.push(value);
    }
    if (!size || (range && size !== range.length)) throw new Error('The server returned an empty or incomplete audio segment.');
    return { blob: new Blob(chunks), url: response.url || url };
  } catch (error) {
    if (!error.failure) error.failure = { stage, url, status: null, responseUrl: null, transport: 'unknown' };
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function resolvePlaylist(url, options = {}) {
  const seen = new Set();
  const originals = new Map();
  let selected = '';
  for (let depth = 0; depth < 5; depth++) {
    if (seen.has(url)) throw new Error('The playlist links back to itself.');
    seen.add(url);
    const response = await fetchBytes(url, { ...options, stage: 'Playlist', limit: MAX_PLAYLIST_BYTES });
    const plan = parsePlaylist(await response.blob.text(), response.url);
    for (const media of plan.originals) originals.set(media.url, media);
    if (plan.type === 'media') return { ...plan, originals: [...originals.values()], selected };
    selected = plan.choices[0].name;
    url = plan.choices[0].url;
  }
  throw new Error('Too many nested playlists.');
}

function boxes(bytes, start = 0, end = bytes.byteLength) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = [];
  for (let offset = start; offset < end;) {
    if (offset + 8 > end) throw new Error('Invalid MP4 box header.');
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) throw new Error('Invalid MP4 box size.');
      size = Number(view.getBigUint64(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (!Number.isSafeInteger(size) || size < header || offset + size > end) throw new Error('Incomplete MP4 data.');
    result.push({ type, start: offset + header, end: offset + size });
    offset += size;
  }
  return result;
}

export function validateAudioInit(bytes) {
  const top = boxes(bytes);
  const moov = top.find(box => box.type === 'moov');
  if (!moov || !top.some(box => box.type === 'ftyp')) throw new Error('The initialization file is not a valid fragmented MP4.');
  const tracks = boxes(bytes, moov.start, moov.end).filter(box => box.type === 'trak');
  if (!tracks.length) throw new Error('The MP4 initialization file has no audio track.');
  for (const track of tracks) {
    const mdia = boxes(bytes, track.start, track.end).find(box => box.type === 'mdia');
    const hdlr = mdia && boxes(bytes, mdia.start, mdia.end).find(box => box.type === 'hdlr');
    const handler = hdlr && hdlr.end - hdlr.start >= 12
      ? String.fromCharCode(...bytes.subarray(hdlr.start + 8, hdlr.start + 12)) : '';
    if (handler !== 'soun') throw new Error('This HLS rendition includes video or non-audio tracks. Select an audio-only source or record the tab.');
  }
}

export function validateFragment(bytes) {
  const top = boxes(bytes);
  if (!top.some(box => box.type === 'moof') || !top.some(box => box.type === 'mdat')) {
    throw new Error('A segment is not a complete fragmented MP4 audio segment.');
  }
}

export async function assembleHls(plan, { signal, fetcher = fetch, onProgress = () => {} } = {}) {
  const inputs = [...(plan.init ? [plan.init] : []), ...plan.parts];
  const blobs = [];
  let bytes = 0;
  for (let index = 0; index < inputs.length; index++) {
    const input = inputs[index];
    const response = await fetchBytes(input.url, { signal, fetcher, range: input.range,
      stage: plan.init && index === 0 ? 'Initialization file' : `Segment ${index + (plan.init ? 0 : 1)}`,
      limit: MAX_HLS_BYTES - bytes });
    if (plan.init) {
      const data = new Uint8Array(await response.blob.arrayBuffer());
      if (index === 0) validateAudioInit(data); else validateFragment(data);
    }
    blobs.push(response.blob);
    bytes += response.blob.size;
    onProgress({ completed: index + 1, total: inputs.length, bytes });
  }
  return new Blob(blobs, { type: plan.mimeType });
}
