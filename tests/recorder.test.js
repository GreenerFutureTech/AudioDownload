import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';
import { safeFilename } from '../extension/lib/media.js';

test('stopping capture preserves the final WebM chunk and downloadable WebM filename', async () => {
  let listener;
  let trackStopped = false;
  let contextClosed = false;
  const rows = new Map();
  const chunks = [];
  const track = { stop() { trackStopped = true; } };
  const store = {
    listRecordings: async () => [...rows.values()],
    putRecording: async row => { rows.set(row.id, row); },
    putChunk: async (id, sequence, blob) => {
      await new Promise(resolve => setTimeout(resolve, 0));
      chunks.push({ sequence, blob });
    },
    finishRecording: async row => {
      const blob = new Blob(chunks.sort((a, b) => a.sequence - b.sequence).map(chunk => chunk.blob), { type: row.mimeType });
      rows.set(row.id, { ...row, status: 'ready', blob, bytes: blob.size });
    },
    getRecording: async id => rows.get(id),
    deleteRecording: async id => rows.delete(id),
  };
  class Recorder {
    static isTypeSupported(type) { return type === 'audio/webm;codecs=opus'; }
    state = 'inactive';
    start() { this.state = 'recording'; this.ondataavailable({ data: new Blob(['header']) }); }
    stop() {
      this.state = 'inactive';
      queueMicrotask(() => { this.ondataavailable({ data: new Blob(['final']) }); this.onstop(); });
    }
  }
  const source = (await readFile(new URL('../extension/offscreen.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
  const context = {
    store, safeFilename, resolvePlaylist() { throw new Error('HLS must not be involved in tab recording.'); },
    assembleHls() { throw new Error('HLS must not be involved in tab recording.'); },
    crypto: { randomUUID }, Blob, URL, AbortController, DOMException, setTimeout, clearTimeout,
    navigator: { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [track] }) } },
    MediaRecorder: Recorder,
    AudioContext: class {
      createMediaStreamSource() { return { connect() {} }; }
      async resume() {}
      async close() { contextClosed = true; }
    },
    chrome: { runtime: { id: 'test', sendMessage: async () => ({ ok: true }),
      getURL: path => `chrome-extension://test/${path}`,
      onMessage: { addListener(callback) { listener = callback; } } } },
  };
  vm.runInNewContext(source, context);
  const dispatch = (type, data = {}) => new Promise(resolve => {
    listener({ target: 'offscreen', type, ...data }, { id: 'test' }, resolve);
  });
  const start = await dispatch('START_RECORDING', { tabId: 7, title: 'My song',
    pageUrl: 'https://suno.com/song/one', streamId: 'test-stream' });
  assert.equal(start.ok, true);
  assert.equal(start.capture.status, 'recording');
  try {
    const duplicate = await dispatch('START_RECORDING', { tabId: 7 });
    assert.equal(duplicate.ok, false);
    const reopened = await dispatch('GET_RECORDINGS');
    assert.equal(reopened.capture.id, start.capture.id);
    const stopped = await dispatch('STOP_RECORDING');
    assert.equal(stopped.ok, true);
    assert.equal(stopped.capture, null);
    assert.equal(trackStopped, true);
    assert.equal(contextClosed, true);
    const result = await dispatch('GET_RECORDINGS');
    assert.equal(result.recordings.length, 1);
    const saved = result.recordings[0];
    assert.equal(saved.mimeType, 'audio/webm;codecs=opus');
    assert.equal(saved.tabId, 7);
    assert.equal(await rows.get(saved.id).blob.text(), 'headerfinal');
    const file = await dispatch('RECORDING_URL', { id: saved.id });
    assert.equal(file.ok, true);
    assert.match(file.filename, /\.webm$/);
    await dispatch('RELEASE_URL', { token: file.token });
    assert.equal((await dispatch('STOP_RECORDING')).ok, true);
  } finally { await dispatch('STOP_RECORDING'); }
});
