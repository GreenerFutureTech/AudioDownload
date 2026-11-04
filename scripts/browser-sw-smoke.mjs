import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifacts = resolve(root, 'artifacts');
await mkdir(artifacts, { recursive: true });
const profile = await mkdtemp(join(artifacts, 'sw-smoke-'));
const executable = process.env.AUDIODOWNLOAD_BROWSER
  || join(process.env.LOCALAPPDATA, 'BraveSoftware/Brave-Browser/Application/brave.exe');
await access(executable);
const manifest = '#EXTM3U\n#EXTINF:1,\naudio.aac?muffleAfter=10\n#EXT-X-ENDLIST';
const audio = 'fixture-audio-transport-bytes';
const server = createServer((request, response) => {
  if (request.url === '/sw.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(`self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));
self.addEventListener('fetch',e=>{const p=new URL(e.request.url).pathname;
if(p==='/_sw-mango/manifest.m3u8')e.respondWith(new Response(${JSON.stringify(manifest)},{headers:{'Content-Type':'application/vnd.apple.mpegurl'}}));
if(p==='/_sw-mango/audio.aac')e.respondWith(new Response(${JSON.stringify(audio)},{headers:{'Content-Type':'audio/aac'}}));});`);
  } else if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Service worker audio fixture</title><h1>Local audio transport test</h1>');
  } else { response.writeHead(404); response.end('Not on the HTTP server.'); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const clients = [];
let browser;

async function until(operation, description, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${description}`);
}

async function cdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const operation = pending.get(message.id);
    if (!operation) return;
    pending.delete(message.id);
    if (message.error) operation.reject(new Error(message.error.message)); else operation.resolve(message.result);
  });
  const client = {
    send(method, params = {}) { return new Promise((resolve, reject) => { const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })); }); },
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    close() { socket.close(); },
  };
  clients.push(client);
  return client;
}

try {
  browser = spawn(executable, ['--headless=new', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, '--remote-debugging-port=0',
    `--disable-extensions-except=${resolve(root, 'extension')}`, `--load-extension=${resolve(root, 'extension')}`, 'about:blank'],
  { windowsHide: true, stdio: 'ignore' });
  let launchError;
  browser.on('error', error => { launchError = error; });
  const port = await until(async () => {
    if (launchError) throw launchError;
    try { return Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; }
  }, 'browser debugging port');
  const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = await cdp((await until(async () => (await targets()).find(target => target.type === 'page'), 'page')).webSocketDebuggerUrl);
  await page.send('Page.navigate', { url: origin });
  await until(() => page.evaluate(`location.origin === ${JSON.stringify(origin)}`), 'fixture navigation');
  await page.evaluate(`navigator.serviceWorker.register('/sw.js')`);
  await until(() => page.evaluate('Boolean(navigator.serviceWorker.controller)'), 'site service worker control');
  const worker = await cdp((await until(async () => (await targets()).find(target => target.type === 'service_worker'
    && target.url.startsWith('chrome-extension://')), 'extension worker')).webSocketDebuggerUrl);
  const resource = `${origin}/_sw-mango/manifest.m3u8?contentId=fixture&muffleAfter=10`;
  assert.equal(await worker.evaluate(`fetch(${JSON.stringify(resource)}).then(r=>r.status)`), 404);
  await worker.evaluate(`(async()=>{ await chrome.offscreen.createDocument({url:'offscreen.html',reasons:['USER_MEDIA','BLOBS'],justification:'Local service-worker transport test'}); return true; })()`);
  const tabId = await worker.evaluate(`chrome.tabs.query({url:${JSON.stringify(`${origin}/*`)}}).then(t=>t[0].id)`);
  const message = payload => worker.evaluate(`chrome.runtime.sendMessage(${JSON.stringify({ target: 'offscreen', tabId, frameId: 0, ...payload })})`);
  const inspected = await message({ type: 'INSPECT_HLS', url: resource });
  assert.equal(inspected.ok, true, inspected.error);
  assert.equal(inspected.summary.segments, 1);
  assert.equal((await message({ type: 'START_HLS', url: resource, title: 'Local service worker test' })).ok, true);
  const saved = await until(async () => {
    const result = await message({ type: 'GET_RECORDINGS' });
    if (result.hlsJob?.status === 'error') throw new Error(result.hlsJob.error);
    return result.hlsJob?.status === 'ready' ? result : null;
  }, 'HLS assembly through the site service worker');
  assert.equal(saved.recordings[0].bytes, Buffer.byteLength(audio));
  assert.equal(saved.recordings[0].extension, 'aac');
  console.log('PASS: server/extension fetch returns 404; MAIN-world site service worker serves playlist and segment; real extension assembly saves the exact bytes.');
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const control = await cdp(version.webSocketDebuggerUrl);
  void control.send('Browser.close').catch(() => {});
  await new Promise(resolve => browser.once('exit', resolve));
} finally {
  clients.forEach(client => client.close());
  if (browser && browser.exitCode == null) browser.kill();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  // Only the fresh profile created inside this workspace may be removed.
  if (resolve(profile).startsWith(`${artifacts}${sep}`)) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
