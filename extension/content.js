(() => {
  let timer;
  let stopped = false;
  let observer;
  const events = ['play', 'pause', 'ended', 'emptied', 'loadedmetadata'];
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    observer?.disconnect();
    for (const event of events) document.removeEventListener(event, schedule, true);
  }
  function alive() {
    if (stopped) return false;
    try { if (chrome.runtime.id) return true; } catch { /* Extension was reloaded. */ }
    stop(); return false;
  }
  function report() {
    if (!alive()) return;
    const media = [...document.querySelectorAll('audio, video')].slice(0, 100);
    const sources = media.flatMap(element => {
      const urls = [element.currentSrc, element.src, ...[...element.querySelectorAll('source')].map(source => source.src)];
      return [...new Set(urls.filter(Boolean))].map(url => ({ url,
        mimeType: element.querySelector('source')?.type || '',
        playing: url === element.currentSrc && !element.paused && !element.ended,
        audioElement: element.tagName === 'AUDIO' }));
    });
    // Recover recognizable requests made before this content script was attached.
    const resources = performance.getEntriesByType('resource').slice(-500)
      .filter(entry => /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|m3u8|mpd)(?:[?#]|$)/i.test(entry.name))
      .map(entry => ({ url: entry.name }));
    try {
      chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_MEDIA', sources, resources,
      hasBlob: sources.some(source => source.url.startsWith('blob:')) }).catch(error => {
        if (/extension context invalidated/i.test(error?.message || '') || !alive()) stop();
      });
    } catch { stop(); }
  }
  function schedule() { if (!alive()) return; clearTimeout(timer); timer = setTimeout(report, 200); }
  for (const event of events) {
    document.addEventListener(event, schedule, true);
  }
  observer = new MutationObserver(schedule);
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['src'],
  });
  try {
    chrome.runtime.onMessage.addListener(message => {
      if (!alive()) return;
      if (message.type === 'SCAN_PAGE') report();
    });
  } catch { stop(); return; }
  report();
})();
