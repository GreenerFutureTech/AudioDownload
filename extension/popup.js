import { formatBytes, formatDuration } from './lib/media.js';
import { hlsFailureDetails } from './lib/diagnostics.js';

const $ = id => document.getElementById(id);
let currentTab;
let tracks = [];
let capture = null;
let recordings = [];
let hlsJob = null;
let recordingBusy = false;
let lastTracks = '';
let lastSaved = '';
let refreshBusy = false;

async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ target: 'background', type, ...data });
  if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Try reopening it.');
  return result;
}

function message(text, error = false) {
  $('messageText').textContent = text;
  $('message').classList.toggle('error', error);
  $('message').hidden = false;
}

async function action(button, operation) {
  button.disabled = true;
  try { await operation(); } catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
}

function showSaved(saved) {
  $('detectedPanel').hidden = saved;
  $('savedPanel').hidden = !saved;
  $('detectedTab').classList.toggle('active', !saved);
  $('savedTab').classList.toggle('active', saved);
  $('detectedTab').setAttribute('aria-pressed', String(!saved));
  $('savedTab').setAttribute('aria-pressed', String(saved));
}

function badge(container, text, style = '') {
  const element = document.createElement('span');
  element.className = `badge ${style}`;
  element.textContent = text;
  container.append(element);
}

function renderTracks() {
  const query = $('search').value.trim().toLowerCase();
  const view = tracks.filter(track => !query || `${track.name} ${track.url}`.toLowerCase().includes(query))
    .sort((a, b) => Number(b.source === 'embedded') - Number(a.source === 'embedded')
      || Number(b.playing) - Number(a.playing) || Number(a.kind !== 'file') - Number(b.kind !== 'file'));
  $('trackCount').textContent = tracks.length;
  const signature = JSON.stringify(view.map(({ lastSeen, ...track }) => track));
  if (signature === lastTracks) return;
  lastTracks = signature;
  $('tracks').replaceChildren();
  $('emptyTracks').hidden = view.length > 0;
  $('emptyTracks').querySelector('h3').textContent = tracks.length ? 'No matching tracks' : 'Ready when the music is';
  for (const track of view) {
    const node = $('trackTemplate').content.firstElementChild.cloneNode(true);
    node.querySelector('.track-name').textContent = track.name;
    node.querySelector('.track-name').title = track.filename;
    node.querySelector('.track-meta').textContent = `${track.host} · ${formatBytes(track.size)}`;
    node.querySelector('.format-label').textContent = track.format;
    node.querySelector('.source-url').textContent = track.url;
    const badges = node.querySelector('.track-badges');
    if (track.source === 'embedded') badge(badges, 'SOURCE LINK · UNVERIFIED');
    if (track.playing) badge(badges, 'PLAYING');
    if (track.kind === 'playlist') badge(badges, track.format === 'HLS' ? 'HLS PLAYLIST' : 'DASH MANIFEST', 'stream');
    if (track.kind === 'segment') badge(badges, 'SINGLE SEGMENT', 'segment');
    const download = node.querySelector('.download');
    const isHls = track.format === 'HLS';
    download.textContent = isHls ? '↓ Assemble audio' : track.kind === 'playlist' ? '↓ Save manifest' : `↓ Download ${track.format}`;
    download.addEventListener('click', () => action(download, async () => {
      if (isHls) {
        await request('START_HLS', { tabId: currentTab.id, trackId: track.id });
        message('Assembling HLS audio. Download the result from Saved audio when finished. You can close this popup.');
        await refresh();
      } else {
        await request('DOWNLOAD_TRACK', { tabId: currentTab.id, trackId: track.id });
        message(track.kind === 'playlist' ? 'Saving manifest text. It does not contain the audio itself.' : 'Download sent to the browser.');
      }
    }));
    const inspect = node.querySelector('.inspect');
    inspect.hidden = !isHls;
    inspect.addEventListener('click', () => action(inspect, async () => {
      const result = await request('INSPECT_HLS', { tabId: currentTab.id, trackId: track.id });
      message(result.originals.length ? 'Found audio source URLs supplied by the site. Try the source link above first.'
        : `Found ${result.summary.segments} segments (${formatDuration(result.summary.duration * 1000)}). Choose Assemble audio to save them.`);
      await refresh();
    }));
    const copy = node.querySelector('.copy');
    copy.addEventListener('click', () => action(copy, async () => {
      await navigator.clipboard.writeText(track.url); message('Source URL copied.');
    }));
    node.querySelector('.open').addEventListener('click', () => {
      void chrome.tabs.create({ url: track.url }).catch(error => message(error.message, true));
    });
    const detail = node.querySelector('.track-detail');
    if (track.hls) {
      detail.hidden = false;
      detail.textContent = `${track.hls.segments} segments · ${formatDuration(track.hls.duration * 1000)} · ${track.hls.extension.toUpperCase()} output${track.hls.selected ? ` · ${track.hls.selected}` : ''}`;
    } else if (track.source === 'embedded') {
      detail.hidden = false;
      detail.textContent = 'Source URL exposed by the site. Access and completeness depend on the server.';
    } else if (track.kind === 'segment') {
      detail.hidden = false;
      detail.textContent = 'Only one part of a track. Use its HLS playlist to assemble the audio.';
    }
    $('tracks').append(node);
  }
}

function renderSaved() {
  $('savedCount').textContent = recordings.length;
  $('emptySaved').hidden = recordings.length > 0;
  const signature = JSON.stringify(recordings);
  if (signature === lastSaved) return;
  lastSaved = signature;
  $('recordings').replaceChildren();
  for (const recording of recordings) {
    const node = $('savedTemplate').content.firstElementChild.cloneNode(true);
    node.querySelector('.track-name').textContent = recording.title;
    node.querySelector('.track-name').title = recording.title;
    node.querySelector('.track-meta').textContent = `${formatDuration(recording.duration)} · ${formatBytes(recording.bytes)} · ${recording.category === 'hls' ? 'Assembled HLS' : 'Tab recording'}`;
    node.querySelector('.format-label').textContent = (recording.extension || 'webm').toUpperCase();
    node.querySelector('.saved-date').textContent = `${new Date(recording.startedAt).toLocaleString()}${recording.reason ? ` · ${recording.reason}` : ''}`;
    const download = node.querySelector('.download');
    download.addEventListener('click', () => action(download, async () => {
      await request('DOWNLOAD_RECORDING', { id: recording.id }); message('Download sent to the browser.');
    }));
    const remove = node.querySelector('.delete');
    let confirmDelete = false;
    remove.addEventListener('click', () => action(remove, async () => {
      if (!confirmDelete) {
        confirmDelete = true;
        remove.textContent = 'Confirm delete';
        remove.setAttribute('aria-label', 'Confirm delete saved audio');
        return;
      }
      await request('DELETE_RECORDING', { id: recording.id });
      message('Saved audio deleted from this browser.'); await refresh();
    }));
    $('recordings').append(node);
  }
}

function renderRecorder() {
  const isRecording = capture?.status === 'recording';
  $('recordDot').classList.toggle('live', Boolean(capture));
  $('recordStatus').textContent = recordingBusy ? 'Please wait…' : isRecording ? 'Recording tab audio' : capture ? 'Saving audio…' : 'Ready to record';
  $('recordTimer').textContent = capture ? formatDuration(Date.now() - capture.startedAt) : '00:00';
  $('recordTarget').textContent = capture ? `Recording: ${capture.title}` : 'Audio from this tab only. You can close the popup while recording.';
  $('recordBtn').disabled = recordingBusy || Boolean(capture) || !/^https?:/.test(currentTab?.url || '');
  // Stop applies to the global recording, even when the user switches tabs.
  $('stopBtn').disabled = recordingBusy || !isRecording;
}

function renderHls() {
  $('hlsProgress').hidden = !hlsJob;
  if (!hlsJob) return;
  const working = hlsJob.status === 'working';
  $('hlsTitle').textContent = working ? 'Assembling audio' : hlsJob.status === 'ready' ? 'Your HLS audio is ready' : hlsJob.status === 'canceled' ? 'Assembly canceled' : 'Could not assemble audio';
  $('cancelHls').hidden = !working;
  $('showSaved').hidden = hlsJob.status !== 'ready';
  $('copyFailure').hidden = hlsJob.status !== 'error';
  const bar = $('hlsBar');
  bar.hidden = !working;
  if (hlsJob.total) { bar.max = hlsJob.total; bar.value = hlsJob.completed; } else bar.removeAttribute('value');
  $('hlsStatus').textContent = hlsJob.status === 'error' ? hlsJob.error
    : working ? hlsJob.total ? `${hlsJob.completed} / ${hlsJob.total} parts · ${formatBytes(hlsJob.bytes)}` : 'Reading the playlist…'
      : hlsJob.status === 'ready' ? 'Open Saved audio to download a copy.' : 'You can try another source.';
}

async function refresh() {
  if (refreshBusy || !currentTab) return;
  refreshBusy = true;
  try {
    const [tabResult, savedResult] = await Promise.allSettled([
      request('GET_TAB', { tabId: currentTab.id }), request('GET_RECORDINGS'),
    ]);
    if (tabResult.status === 'fulfilled') {
      tracks = tabResult.value.state.tracks;
      $('blobNote').hidden = !Object.values(tabResult.value.state.frames || {}).some(frame => frame.hasBlob);
      renderTracks();
    } else message(tabResult.reason.message, true);
    if (savedResult.status === 'fulfilled') {
      const wasRecording = Boolean(capture);
      capture = savedResult.value.capture;
      recordings = savedResult.value.recordings;
      hlsJob = savedResult.value.hlsJob;
      if (wasRecording && !capture) { message('Recording finished. Download it from Saved audio.'); showSaved(true); }
      if (savedResult.value.lastError) message(savedResult.value.lastError, true);
      renderSaved(); renderRecorder(); renderHls();
    } else message(savedResult.reason.message, true);
  } finally { refreshBusy = false; }
}

$('detectedTab').addEventListener('click', () => showSaved(false));
$('savedTab').addEventListener('click', () => showSaved(true));
$('showSaved').addEventListener('click', () => showSaved(true));
$('copyFailure').addEventListener('click', () => action($('copyFailure'), async () => {
  await navigator.clipboard.writeText(JSON.stringify({ version: chrome.runtime.getManifest().version,
    ...hlsFailureDetails(hlsJob) }, null, 2));
  message('Failure details copied. URL query values are omitted.');
}));
$('search').addEventListener('input', renderTracks);
$('dismissMessage').addEventListener('click', () => { $('message').hidden = true; });
$('scanBtn').addEventListener('click', () => action($('scanBtn'), async () => {
  await request('SCAN_TAB', { tabId: currentTab.id });
  message('Scanning the page. Start playback if the track has not loaded yet.'); setTimeout(refresh, 400);
}));
$('clearBtn').addEventListener('click', () => action($('clearBtn'), async () => {
  await request('CLEAR_TAB', { tabId: currentTab.id }); await refresh();
}));
async function recordingAction(type) {
  recordingBusy = true; renderRecorder();
  try {
    const result = await request(type, { tabId: currentTab.id });
    capture = result.capture;
    if (type === 'STOP_RECORDING') { showSaved(true); message('Recording stopped and saved. Choose Download to save the file.'); }
    await refresh();
  } catch (error) { message(error.message, true); }
  finally { recordingBusy = false; renderRecorder(); }
}
$('recordBtn').addEventListener('click', () => recordingAction('START_RECORDING'));
$('stopBtn').addEventListener('click', () => recordingAction('STOP_RECORDING'));
$('cancelHls').addEventListener('click', () => action($('cancelHls'), async () => {
  await request('CANCEL_HLS'); await refresh();
}));

try {
  document.querySelector('.version').textContent = `v${chrome.runtime.getManifest().version}`;
  [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!currentTab) throw new Error('No active browser tab.');
  $('pageTitle').textContent = currentTab.title || 'This tab';
  $('pageTitle').title = currentTab.title || '';
  $('pageHost').textContent = /^https?:/.test(currentTab.url || '') ? new URL(currentTab.url).host : 'Browser page';
  await refresh();
  setInterval(refresh, 1200);
  setInterval(renderRecorder, 250);
} catch (error) { message(error.message, true); }
