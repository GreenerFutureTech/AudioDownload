import { detectMedia, detectBlobMedia, embeddedAudioSources, mergeTrack, responseSize } from './lib/media.js';

const queues = new Map();
let creatingOffscreen;
let recordingControl = Promise.resolve();
const stateKey = tabId => `tab:${tabId}`;
const emptyState = () => ({ tracks: [], frames: {} });

function enqueue(tabId, operation) {
  const previous = queues.get(tabId) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(tabId, next);
  void next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}

async function readTab(tabId) {
  const key = stateKey(tabId);
  return (await chrome.storage.session.get(key))[key] || emptyState();
}

async function updateBadge(tabId, state) {
  const { capture } = await chrome.storage.session.get('capture');
  const recording = capture?.tabId === tabId && ['recording', 'saving'].includes(capture.status);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: recording ? '#e36977' : '#43d9c0' });
  await chrome.action.setBadgeText({ tabId, text: recording ? 'REC' : state.tracks.length ? String(state.tracks.length) : '' });
}

async function saveTab(tabId, state) {
  await chrome.storage.session.set({ [stateKey(tabId)]: state });
  await updateBadge(tabId, state).catch(() => {});
}

function addTrack(state, media, extra = {}) {
  if (!media) return;
  state.tracks = mergeTrack(state.tracks, {
    ...media, id: crypto.randomUUID(), firstSeen: Date.now(), lastSeen: Date.now(), ...extra,
  });
}

chrome.webRequest.onHeadersReceived.addListener(details => {
  if (details.tabId < 0 || details.method !== 'GET' || details.statusCode < 200 || details.statusCode >= 400) return;
  const header = name => details.responseHeaders?.find(item => item.name.toLowerCase() === name)?.value || '';
  const media = detectMedia(details.url, header('content-type'), header('content-disposition'));
  const originals = embeddedAudioSources(details.url);
  if (!media && !originals.length) return;
  void enqueue(details.tabId, async () => {
    const state = await readTab(details.tabId);
    addTrack(state, media, { size: responseSize(details.responseHeaders, details.statusCode), source: 'network' });
    for (const original of originals) addTrack(state, original, { source: 'embedded' });
    await saveTab(details.tabId, state);
  }).catch(console.warn);
}, { urls: ['http://*/*', 'https://*/*'] }, ['responseHeaders']);

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status !== 'loading' && !change.url) return;
  void enqueue(tabId, async () => {
    const state = await readTab(tabId);
    const pageUrl = (change.url || tab.url || '').split('#')[0];
    if (change.status === 'loading' || state.pageUrl !== pageUrl) {
      await saveTab(tabId, { ...emptyState(), pageUrl });
    }
  }).catch(console.warn);
});

chrome.tabs.onRemoved.addListener(tabId => {
  void enqueue(tabId, () => chrome.storage.session.remove(stateKey(tabId))).catch(console.warn);
  // Ended stream tracks also stop the recorder; this handles a quiet tab closing.
  void chrome.storage.session.get('capture').then(({ capture }) => {
    if (capture?.tabId === tabId && capture.status === 'recording') {
      return offscreenMessage('STOP_RECORDING', { reason: 'Tab closed' });
    }
  }).catch(console.warn);
});

async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'BLOBS'], justification: 'Record tab audio and keep local recordings available for download.' });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function offscreenMessage(type, data = {}) {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({ target: 'offscreen', type, ...data });
  if (!result?.ok) throw new Error(result?.error || 'The recorder did not respond. Please reopen the extension.');
  return result;
}

async function setCapture(capture) {
  const previous = (await chrome.storage.session.get('capture')).capture;
  await chrome.storage.session.set({ capture });
  for (const tabId of new Set([previous?.tabId, capture?.tabId].filter(Number.isInteger))) {
    await updateBadge(tabId, await readTab(tabId)).catch(() => {});
  }
}

async function downloadTrack(tabId, trackId) {
  const state = await readTab(tabId);
  const track = state.tracks.find(item => item.id === trackId);
  if (!track) throw new Error('This track is no longer on the page. Scan the page again.');
  if (track.source === 'blob') {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'DOWNLOAD_BLOB', url: track.url,
      filename: track.filename }, { frameId: track.frameId });
    if (!result?.ok) throw new Error(result?.error || 'The blob file is no longer available. Play the song and scan again.');
    return {};
  }
  const downloadId = await chrome.downloads.download({ url: track.url,
    filename: `AudioDownload/${track.filename}`, conflictAction: 'uniquify', saveAs: true });
  return { downloadId };
}

async function releaseDownload(id) {
  const key = `download:${id}`;
  const entry = (await chrome.storage.session.get(key))[key];
  if (!entry) return;
  await offscreenMessage('RELEASE_URL', { token: entry.token });
  await chrome.storage.session.remove(key);
}

chrome.downloads.onChanged.addListener(delta => {
  if (['complete', 'interrupted'].includes(delta.state?.current)) void releaseDownload(delta.id).catch(console.warn);
});

async function handleMessage(message, sender) {
  switch (message.type) {
    case 'PAGE_MEDIA': {
      const tabId = sender.tab?.id;
      if (!Number.isInteger(tabId)) throw new Error('A page tab is required.');
      await enqueue(tabId, async () => {
        const state = await readTab(tabId);
        const frameId = sender.frameId || 0;
        state.frames[frameId] = { hasBlob: Boolean(message.hasBlob), hasMedia: Boolean(message.hasMedia),
          playing: (message.sources || []).filter(source => source.playing).map(source => source.url) };
        for (const source of (message.sources || []).slice(0, 300)) {
          const media = detectBlobMedia(source, sender.url)
            || detectMedia(source.url, source.mimeType)
            || (source.audioElement ? detectMedia(source.url, 'audio/unknown') : null);
          addTrack(state, media, { source: media?.source === 'blob' ? 'blob' : 'page', frameId });
          for (const original of embeddedAudioSources(source.url)) addTrack(state, original, { source: 'embedded' });
        }
        for (const resource of (message.resources || []).slice(0, 500)) {
          addTrack(state, detectMedia(resource.url), { source: 'page' });
          for (const original of embeddedAudioSources(resource.url)) addTrack(state, original, { source: 'embedded' });
        }
        const playing = new Set(Object.values(state.frames).flatMap(frame => frame.playing));
        state.tracks = state.tracks.map(track => ({ ...track, playing: playing.has(track.url) }));
        await saveTab(tabId, state);
      });
      return {};
    }
    case 'GET_TAB':
      if (!Number.isInteger(message.tabId)) throw new Error('No active tab.');
      await (queues.get(message.tabId) || Promise.resolve());
      return { state: await readTab(message.tabId) };
    case 'SCAN_TAB':
      await chrome.tabs.sendMessage(message.tabId, { type: 'SCAN_PAGE' }).catch(() => {
        throw new Error('Reload this page once to enable scanning. Browser settings pages cannot be scanned.');
      });
      return {};
    case 'CLEAR_TAB':
      await enqueue(message.tabId, () => saveTab(message.tabId, emptyState()));
      return {};
    case 'DOWNLOAD_TRACK':
      return downloadTrack(message.tabId, message.trackId);
    case 'INSPECT_HLS': {
      const state = await readTab(message.tabId);
      const track = state.tracks.find(item => item.id === message.trackId);
      if (track?.format !== 'HLS') throw new Error('Choose an HLS playlist to inspect.');
      const result = await offscreenMessage('INSPECT_HLS', { url: track.url });
      await enqueue(message.tabId, async () => {
        const latest = await readTab(message.tabId);
        if (!latest.tracks.some(item => item.id === track.id)) return;
        for (const original of result.originals) addTrack(latest, original, { source: 'embedded' });
        const current = latest.tracks.find(item => item.id === track.id);
        current.hls = result.summary;
        await saveTab(message.tabId, latest);
      });
      return result;
    }
    case 'START_HLS': {
      const state = await readTab(message.tabId);
      const track = state.tracks.find(item => item.id === message.trackId);
      if (track?.format !== 'HLS') throw new Error('Choose an HLS playlist to save.');
      const tab = await chrome.tabs.get(message.tabId);
      return offscreenMessage('START_HLS', { url: track.url, title: tab.title || track.name });
    }
    case 'CANCEL_HLS':
      return offscreenMessage('CANCEL_HLS');
    case 'GET_RECORDINGS': {
      const result = await offscreenMessage('GET_RECORDINGS');
      await setCapture(result.capture);
      return result;
    }
    case 'START_RECORDING': {
      const operation = recordingControl.catch(() => {}).then(async () => {
        const status = await offscreenMessage('GET_RECORDINGS');
        if (status.capture) throw new Error('A recording is already running. Stop it before starting another.');
        const tab = await chrome.tabs.get(message.tabId);
        if (!/^https?:\/\//.test(tab.url || '')) throw new Error('Open a regular website to record its audio.');
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
        const result = await offscreenMessage('START_RECORDING', { streamId, tabId: tab.id,
          pageUrl: tab.url, title: tab.title || 'Tab audio' });
        await setCapture(result.capture);
        return result;
      });
      recordingControl = operation;
      return operation;
    }
    case 'STOP_RECORDING': {
      const operation = recordingControl.catch(() => {}).then(() => offscreenMessage('STOP_RECORDING'));
      recordingControl = operation;
      return operation;
    }
    case 'CAPTURE_CHANGED':
      await setCapture(message.capture);
      return {};
    case 'DOWNLOAD_RECORDING': {
      const result = await offscreenMessage('RECORDING_URL', { id: message.id });
      try {
        const downloadId = await chrome.downloads.download({ url: result.url,
          filename: `AudioDownload/${result.filename}`, conflictAction: 'uniquify', saveAs: true });
        await chrome.storage.session.set({ [`download:${downloadId}`]: { token: result.token } });
        const [download] = await chrome.downloads.search({ id: downloadId });
        if (download && ['complete', 'interrupted'].includes(download.state)) await releaseDownload(downloadId);
        return { downloadId };
      } catch (error) {
        await offscreenMessage('RELEASE_URL', { token: result.token });
        throw error;
      }
    }
    case 'DELETE_RECORDING':
      return offscreenMessage('DELETE_RECORDING', { id: message.id });
    default: throw new Error('Unknown extension action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  // Content scripts can report detections but cannot start recordings or downloads.
  if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL('')) && message.type !== 'PAGE_MEDIA') {
    sendResponse({ ok: false, error: 'This action must be started from the extension.' });
    return;
  }
  handleMessage(message, sender).then(result => sendResponse({ ...result, ok: true }),
    error => sendResponse({ ok: false, error: error.message }));
  return true;
});
