let database;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error('Local recording storage failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Local recording storage was interrupted.'));
  });
}

async function db() {
  if (!database) {
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('audio-download-recordings', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('recordings', { keyPath: 'id' });
        request.result.createObjectStore('chunks', { keyPath: 'key' }).createIndex('recordingId', 'recordingId');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  return database;
}

export async function putRecording(recording) {
  const transaction = (await db()).transaction('recordings', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('recordings').put(recording);
  await done;
}

export async function getRecording(id) {
  return requestResult((await db()).transaction('recordings').objectStore('recordings').get(id));
}

export async function listRecordings() {
  const rows = await requestResult((await db()).transaction('recordings').objectStore('recordings').getAll());
  return rows.sort((a, b) => b.startedAt - a.startedAt);
}

export async function putChunk(recordingId, sequence, blob) {
  const transaction = (await db()).transaction('chunks', 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('chunks').put({ key: `${recordingId}:${sequence}`, recordingId, sequence, blob });
  await done;
}

export async function finishRecording(recording, reason = '') {
  const database = await db();
  const chunks = await requestResult(database.transaction('chunks').objectStore('chunks')
    .index('recordingId').getAll(recording.id));
  chunks.sort((a, b) => a.sequence - b.sequence);
  const blob = new Blob(chunks.map(chunk => chunk.blob), { type: recording.mimeType });
  const transaction = database.transaction(['recordings', 'chunks'], 'readwrite');
  const done = transactionDone(transaction);
  if (blob.size) transaction.objectStore('recordings').put({ ...recording, blob, bytes: blob.size,
    status: 'ready', reason, duration: Math.max(0, (recording.stoppedAt || Date.now()) - recording.startedAt) });
  else transaction.objectStore('recordings').delete(recording.id);
  for (const chunk of chunks) transaction.objectStore('chunks').delete(chunk.key);
  await done;
  return blob.size;
}

export async function deleteRecording(id) {
  const database = await db();
  const keys = await requestResult(database.transaction('chunks').objectStore('chunks').index('recordingId').getAllKeys(id));
  const transaction = database.transaction(['recordings', 'chunks'], 'readwrite');
  const done = transactionDone(transaction);
  transaction.objectStore('recordings').delete(id);
  for (const key of keys) transaction.objectStore('chunks').delete(key);
  await done;
}
