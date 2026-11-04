(() => {
  let timer;
  function report() {
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
      .filter(entry => /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|m3u8|mpd)(?:[?#]|$)/i.test(entry.name))
      .map(entry => ({ url: entry.name }));
    chrome.runtime.sendMessage({ target: 'background', type: 'PAGE_MEDIA', sources, resources,
      hasBlob: sources.some(source => source.url.startsWith('blob:')) }).catch(() => {});
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(report, 200); }
  for (const event of ['play', 'pause', 'ended', 'emptied', 'loadedmetadata']) {
    document.addEventListener(event, schedule, true);
  }
  new MutationObserver(schedule).observe(document.documentElement, {
    subtree: true, childList: true, attributes: true, attributeFilter: ['src'],
  });
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'SCAN_PAGE') report();
  });
  report();
})();
