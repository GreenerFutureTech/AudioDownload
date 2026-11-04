import * as store from './lib/recording-store.js';
import { safeFilename } from './lib/media.js';

const MAX_BYTES = 128 * 1024 * 1024;
const MAX_DURATION = 60 * 60 * 1000;
let active = null;
let starting = false;
let lastError = '';
const objectUrls = new Map();
const ready = (async () => {
  // Recover persisted chunks when a browser restart interrupted a recording.
  for (const recording of await store.listRecordings()) {
    if (recording.status === 'recording') await store.finishRecording(recording, 'Recovered after the recorder closed');
  }
})();

function captureState() {
  if (!active) return null;
  const { id, tabId, title, startedAt, bytes, status } = active;
  return { id, tabId, title, startedAt, bytes, status };
}

function notify() {
  void chrome.runtime.sendMessage({ target: 'background', type: 'CAPTURE_CHANGED', capture: captureState() }).catch(() => {});
}

async function releaseMedia(recording) {
  clearTimeout(recording.timeout);
  recording.stream?.getTracks().forEach(track => track.stop());
  await recording.context?.close().catch(() => {});
}

async function finalize(recording) {
  recording.status = 'saving';
  recording.stoppedAt = Date.now();
  notify();
  await releaseMedia(recording);
  try {
    await recording.writes;
    await store.finishRecording({ id: recording.id, tabId: recording.tabId, title: recording.title,
      startedAt: recording.startedAt, stoppedAt: recording.stoppedAt, mimeType: recording.mimeType }, recording.reason);
  } catch (error) {
    lastError = `Could not finish saving: ${error.message}. Reopen the extension to recover stored chunks.`;
  } finally {
    active = null;
    notify();
    recording.resolveStopped();
  }
}

async function startRecording(message) {
  if (active || starting) throw new Error('A recording is already running.');
  starting = true;
  const recording = { id: crypto.randomUUID(), tabId: message.tabId, title: message.title,
    startedAt: Date.now(), bytes: 0, sequence: 0, writes: Promise.resolve(), status: 'recording', reason: '' };
  try {
    recording.stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId } }, video: false,
    });
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('This browser does not support WebM audio recording.');
    recording.mimeType = mimeType;
    recording.context = new AudioContext();
    recording.context.createMediaStreamSource(recording.stream).connect(recording.context.destination);
    await recording.context.resume();
    recording.recorder = new MediaRecorder(recording.stream, { mimeType, audioBitsPerSecond: 192000 });
    recording.stopped = new Promise(resolve => { recording.resolveStopped = resolve; });
    await store.putRecording({ id: recording.id, title: recording.title, tabId: recording.tabId,
      startedAt: recording.startedAt, mimeType, status: 'recording' });
    recording.recorder.ondataavailable = event => {
      if (!event.data.size) return;
      const sequence = recording.sequence++;
      recording.bytes += event.data.size;
      // Serialize disk writes so stop waits for the final chunk as well.
      recording.writes = recording.writes.then(() => store.putChunk(recording.id, sequence, event.data))
        .catch(error => {
          lastError = `Recording stopped because local storage failed: ${error.message}`;
          stopRecording('Local storage full');
        });
      if (recording.bytes >= MAX_BYTES) stopRecording('Saved at the 128 MB size limit');
    };
    recording.recorder.onstop = () => { void finalize(recording); };
    recording.recorder.onerror = event => {
      lastError = event.error?.message || 'The browser stopped audio capture.';
      stopRecording(lastError);
    };
    for (const track of recording.stream.getTracks()) track.onended = () => stopRecording('Tab audio capture ended');
    active = recording;
    lastError = '';
    recording.recorder.start(1000);
    recording.timeout = setTimeout(() => stopRecording('Saved at the 60 minute limit'), MAX_DURATION);
    notify();
    return { capture: captureState() };
  } catch (error) {
    active = null;
    await releaseMedia(recording);
    await store.deleteRecording(recording.id).catch(() => {});
    throw error;
  } finally { starting = false; }
}

function stopRecording(reason = '') {
  if (!active) return Promise.resolve();
  if (active.recorder.state !== 'inactive') {
    active.reason = reason;
    active.status = 'saving';
    active.recorder.stop();
    notify();
  }
  return active.stopped;
}

async function handleMessage(message) {
  await ready;
  switch (message.type) {
    case 'GET_RECORDINGS':
      return { capture: captureState(), lastError,
        recordings: (await store.listRecordings()).filter(row => row.status === 'ready')
          .map(({ blob, ...metadata }) => metadata) };
    case 'START_RECORDING': return startRecording(message);
    case 'STOP_RECORDING': await stopRecording(message.reason); return { capture: captureState() };
    case 'DELETE_RECORDING':
      if (active?.id === message.id) throw new Error('Stop this recording before deleting it.');
      await store.deleteRecording(message.id);
      return {};
    case 'RECORDING_URL': {
      const recording = await store.getRecording(message.id);
      if (!recording?.blob) throw new Error('This recording is no longer saved.');
      const token = crypto.randomUUID();
      const url = URL.createObjectURL(recording.blob);
      objectUrls.set(token, url);
      const stamp = new Date(recording.startedAt).toISOString().slice(0, 19).replace(/[T:]/g, '-');
      return { token, url, filename: `${safeFilename(recording.title).slice(0, 100)}-${stamp}.webm` };
    }
    case 'RELEASE_URL':
      if (objectUrls.has(message.token)) {
        URL.revokeObjectURL(objectUrls.get(message.token));
        objectUrls.delete(message.token);
      }
      return {};
    default: throw new Error('Unknown recorder action.');
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'offscreen' || sender.id !== chrome.runtime.id || sender.tab) return;
  handleMessage(message).then(result => sendResponse({ ...result, ok: true }),
    error => sendResponse({ ok: false, error: error.message }));
  return true;
});
