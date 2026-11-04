// Retry denied/missing extension-origin requests in the original page's session.
// This uses normal browser credentials and CORS checks, without rewriting URLs.
export function pageAwareFetch(tabId, frameId = 0, runtime = chrome.runtime, fetcher = fetch) {
  frameId = Number.isInteger(frameId) && frameId >= 0 ? frameId : 0;
  return async (url, options = {}) => {
    let original;
    let originalError;
    try { original = await fetcher(url, options); } catch (error) { originalError = error; }
    if (options.signal?.aborted) throw options.signal.reason;
    if (original && ![401, 403, 404].includes(original.status)) return original;
    let result;
    try {
      result = await runtime.sendMessage({ target: 'background', type: 'FETCH_HLS_RESOURCE',
        tabId, frameId, url, range: options.headers?.Range || null });
    } catch { /* Keep the original failure if the page cannot be reached. */ }
    if (options.signal?.aborted) throw options.signal.reason;
    if (result?.ok) {
      const bytes = Uint8Array.from(atob(result.data), character => character.charCodeAt(0));
      const response = new Response(bytes.length ? bytes : null, { status: result.status, headers: result.headers });
      Object.defineProperty(response, 'url', { value: result.url || url });
      Object.defineProperty(response, 'transport', { value: result.transport || 'page' });
      Object.defineProperty(response, 'serviceWorkerControlled', { value: result.serviceWorkerControlled ?? null });
      await original?.body?.cancel();
      return response;
    }
    if (original) {
      Object.defineProperty(original, 'pageError', { value: result?.error || 'The original page could not fetch this resource.' });
      return original;
    }
    throw originalError || new Error(result?.error || 'The media request failed.');
  };
}
