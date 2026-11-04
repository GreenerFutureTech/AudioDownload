// Must remain self-contained: scripting.executeScript serializes this function
// into the website's MAIN world, where its service worker can handle the fetch.
export async function readPageMedia(resourceUrl, range = null) {
  const url = new URL(resourceUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid media URL.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(resourceUrl, { credentials: 'include', signal: controller.signal,
      headers: range ? { Range: range } : {} });
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new Error('This media response exceeds the page fetch limit (16 MB).'); }
      for (let offset = 0; offset < value.length; offset += 32768) {
        chunks.push(String.fromCharCode(...value.subarray(offset, offset + 32768)));
      }
    }
    return { url: response.url || resourceUrl, status: response.status, transport: 'page-main',
      serviceWorkerControlled: Boolean(navigator.serviceWorker?.controller),
      headers: Object.fromEntries(['content-type', 'content-length', 'content-range']
        .map(name => [name, response.headers.get(name)]).filter(([, value]) => value != null)),
      data: btoa(chunks.join('')) };
  } finally { clearTimeout(timeout); }
}
