(() => {
  let timer;
  const blobs = new Map();
  async function probeBlob(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Blob is no longer available.');
    const mimeType = (response.headers.get('content-type') || '').split(';')[0].trim();
    const length = response.headers.get('content-length');
    await response.body?.cancel();
    return mimeType.startsWith('audio/') ? { blobAvailable: true, mimeType,
      size: length != null && /^\d+$/.test(length) ? Number(length) : null } : null;
  }
  function report() {
    const media = [...document.querySelectorAll('audio, video')].slice(0, 100);
    const sources = media.flatMap(element => {
      const urls = [element.currentSrc, element.src, ...[...element.querySelectorAll('source')].map(source => source.src)];
      return [...new Set(urls.filter(Boolean))].map(url => ({ url,
        mimeType: [...element.querySelectorAll('source')].find(source => source.src === url)?.type || '',
        playing: url === element.currentSrc && !element.paused && !element.ended,
        audioElement: element.tagName === 'AUDIO', title: document.title,
        ...(blobs.get(url) || {}) }));
    });
    for (const source of sources) {
      if (!source.url.startsWith('blob:') || blobs.has(source.url)) continue;
      blobs.set(source.url, null);
      // Real Blob files can be fetched; MediaSource blob URLs cannot. Do not
      // manufacture a downloadable WebM entry for a live MediaSource stream.
      void probeBlob(source.url).then(result => {
        if (result) { blobs.set(source.url, result); report(); }
      }).catch(() => {});
    }
    // Recover recognizable requests made before this content script was attached.
    const resources = performance.getEntriesByType('resource').slice(-500)
      .filter(entry => /\.(mp3|m4a|aac|wav|wave|ogg|oga|opus|flac|webm|aiff|aif|m3u8?|mpd|m4s|cmfa)(?:[?#]|$)/i.test(entry.name)
        || /[?&]src=/.test(entry.name))
      .map(entry => ({ url: entry.name }));
    chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_MEDIA', sources, resources,
      hasMedia: sources.some(source => source.audioElement || source.playing),
      hasBlob: sources.some(source => source.url.startsWith('blob:')) }).catch(() => {});
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(report, 200); }
  for (const event of ['play', 'pause', 'ended', 'emptied', 'loadedmetadata']) {
    document.addEventListener(event, schedule, true);
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['src'],
  });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'SCAN_PAGE') report();
    if (message.type === 'DOWNLOAD_BLOB') {
      if (!blobs.get(message.url)?.blobAvailable) {
        sendResponse({ ok: false, error: 'This is not an available audio Blob file. Scan the page again.' });
        return;
      }
      probeBlob(message.url).then(result => {
        if (!result) throw new Error('This blob is not a downloadable audio file.');
        const anchor = document.createElement('a');
        anchor.href = message.url;
        anchor.download = message.filename;
        anchor.hidden = true;
        document.documentElement.append(anchor);
        anchor.click(); anchor.remove();
        sendResponse({ ok: true });
      }).catch(error => sendResponse({ ok: false, error: error.message }));
      return true;
    }
  });
  report();
})();
