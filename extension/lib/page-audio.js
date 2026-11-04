export function recordingsForPage(recordings, tab) {
  const page = value => typeof value === 'string' ? value.split('#')[0] : '';
  return recordings.filter(recording => {
    if (recording.category === 'hls' || (recording.extension && recording.extension !== 'webm')) return false;
    if (recording.pageUrl) return Boolean(tab?.url) && page(recording.pageUrl) === page(tab.url);
    // Recordings saved by earlier extension versions only have tab ID and title.
    return recording.tabId === tab?.id && recording.title === tab?.title;
  });
}

