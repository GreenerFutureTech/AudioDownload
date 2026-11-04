const FORMATS = {
  mp3: 'MP3', m4a: 'M4A', aac: 'AAC', wav: 'WAV', wave: 'WAV',
  ogg: 'OGG', oga: 'OGG', opus: 'OPUS', flac: 'FLAC', aiff: 'AIFF', aif: 'AIFF', webm: 'WEBM',
  m3u8: 'HLS', m3u: 'HLS', mpd: 'DASH', m4s: 'M4S', cmfa: 'M4S',
};
const MIME_EXTENSIONS = {
  'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/aacp': 'aac',
  'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
  'audio/ogg': 'ogg', 'application/ogg': 'ogg', 'audio/opus': 'opus',
  'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/webm': 'webm',
  'audio/aiff': 'aiff', 'audio/x-aiff': 'aiff',
  'application/vnd.apple.mpegurl': 'm3u8', 'application/x-mpegurl': 'm3u8',
  'audio/mpegurl': 'm3u8', 'audio/x-mpegurl': 'm3u8', 'application/dash+xml': 'mpd',
};

export function httpUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function dispositionFilename(disposition = '') {
  const encoded = disposition.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (encoded) return decode(encoded[1].trim().replace(/^"|"$/g, ''));
  const plain = disposition.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  return plain ? (plain[1] || plain[2]).trim() : '';
}

export function safeFilename(name, fallback = 'audio') {
  let safe = String(name || '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 160);
  if (!safe) safe = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

export function detectMedia(value, contentType = '', disposition = '') {
  const url = httpUrl(value);
  if (!url) return null;
  const pathname = decode(new URL(url).pathname);
  const headerName = dispositionFilename(disposition);
  const pathExtension = pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const headerExtension = headerName.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const mimeType = contentType.split(';')[0].trim().toLowerCase();
  let extension = MIME_EXTENSIONS[mimeType] || (FORMATS[pathExtension] && pathExtension)
    || (FORMATS[headerExtension] && headerExtension);
  if (!extension && mimeType.startsWith('audio/')) extension = 'audio';
  if (!extension) return null;
  // A video MIME type overrides an ambiguous filename; manifests remain useful.
  if (mimeType.startsWith('video/') && !['m3u8', 'm3u', 'mpd'].includes(extension)) return null;
  const kind = ['m3u8', 'm3u', 'mpd'].includes(extension) ? 'playlist'
    : ['m4s', 'cmfa'].includes(pathExtension) ? 'segment' : 'file';
  let filename = safeFilename(headerName || pathname.split('/').pop() || 'audio');
  if (!filename.toLowerCase().endsWith(`.${extension}`)) filename += `.${extension}`;
  return { url, mimeType, extension, format: FORMATS[extension] || extension.toUpperCase(), kind, filename,
    name: filename.replace(/\.[^.]+$/, ''), host: new URL(url).host };
}

export function detectBlobMedia(source, pageUrl) {
  if (!source.blobAvailable || !source.url?.startsWith('blob:')) return null;
  try {
    const page = new URL(pageUrl);
    if (!['http:', 'https:'].includes(page.protocol) || new URL(source.url).origin !== page.origin) return null;
    const media = detectMedia(`${page.origin}/audio`, source.mimeType);
    if (!media || media.kind !== 'file') return null;
    const name = safeFilename(source.title || 'Page audio');
    return { ...media, url: source.url, filename: `${name}.${media.extension}`, name,
      size: Number.isSafeInteger(source.size) && source.size >= 0 ? source.size : null, source: 'blob' };
  } catch { return null; }
}

export function responseSize(headers = [], statusCode = 200) {
  const header = name => headers.find(item => item.name.toLowerCase() === name)?.value;
  const total = header('content-range')?.match(/\/(\d+)$/)?.[1];
  const value = total ?? (statusCode === 206 ? null : header('content-length'));
  if (value == null || !/^\d+$/.test(value)) return null;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : null;
}

export function mergeTrack(tracks, incoming, limit = 200) {
  const index = tracks.findIndex(track => track.url === incoming.url);
  if (index < 0) return [...tracks, incoming].slice(-limit);
  const previous = tracks[index];
  const preferred = previous.source === 'network' && incoming.source === 'page' ? previous : incoming;
  const merged = { ...previous, ...incoming, ...preferred, id: previous.id,
    firstSeen: previous.firstSeen, size: incoming.size ?? previous.size,
    mimeType: preferred.mimeType || previous.mimeType,
    lastSeen: incoming.lastSeen,
    playing: incoming.playing ?? previous.playing,
    source: previous.source === 'network' ? 'network' : incoming.source };
  const result = [...tracks];
  result[index] = merged;
  return result;
}

// Read only the source explicitly supplied by the site. Do not rewrite its URL,
// remove access parameters, or guess alternate paths to a full-length track.
export function embeddedAudioSources(value) {
  const url = httpUrl(value);
  if (!url) return [];
  const source = new URL(url).searchParams.get('src');
  const media = source && detectMedia(source);
  return media?.kind === 'file' ? [{ ...media, source: 'embedded', sourcePage: url }] : [];
}

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return 'Size unknown';
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 3);
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

export function formatDuration(milliseconds = 0) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
