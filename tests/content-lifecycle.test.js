import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness(runtime) {
  let mutations;
  let disconnected = 0;
  let removed = 0;
  const context = {
    document: { querySelectorAll: () => [], addEventListener() {}, removeEventListener() { removed++; }, documentElement: {} },
    performance: { getEntriesByType: () => [] },
    chrome: { runtime }, setTimeout, clearTimeout,
    MutationObserver: class { constructor(callback) { mutations = callback; } observe() {} disconnect() { disconnected++; } },
  };
  vm.runInNewContext(await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'), context);
  return { mutate: () => mutations(), get disconnected() { return disconnected; }, get removed() { return removed; } };
}

test('synchronous context invalidation stops old scripts without uncaught exceptions', async () => {
  let sends = 0;
  const script = await harness({ id: 'extension', onMessage: { addListener() {} },
    sendMessage() { sends++; throw new Error('Extension context invalidated.'); } });
  assert.equal(script.disconnected, 1);
  assert.equal(script.removed, 5);
  assert.doesNotThrow(script.mutate);
  assert.equal(sends, 1);
});

test('a reloaded extension detaches mutation and playback listeners from an old document', async () => {
  let live = true;
  const script = await harness({ get id() { if (!live) throw new Error('Extension context invalidated.'); return 'extension'; },
    onMessage: { addListener() {} }, sendMessage: async () => ({ ok: true }) });
  live = false;
  assert.doesNotThrow(script.mutate);
  assert.equal(script.disconnected, 1);
  assert.equal(script.removed, 5);
});

test('asynchronous invalidation also shuts down a stale content script', async () => {
  const script = await harness({ id: 'extension', onMessage: { addListener() {} },
    sendMessage: async () => { throw new Error('Extension context invalidated.'); } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(script.disconnected, 1);
  assert.doesNotThrow(script.mutate);
});
