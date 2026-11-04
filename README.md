# AudioDownload

An unpacked Manifest V3 extension for Brave and Chrome. It detects audio files and playlists on the active page, finds source URLs explicitly exposed by the site, assembles supported unencrypted HLS audio, and records tab audio with **Start recording → Stop & Save → Saved audio → Download**.

## Install in Brave

1. Open `brave://extensions` and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository's **extension** folder.
3. Pin AudioDownload to the toolbar. Reload your song's page and start playback.
4. Open the extension. Try **Download** on a source link or audio file, or **Assemble audio** on an HLS playlist.

After editing or updating the extension, click its **Reload** button on `brave://extensions`, then reload the audio page. Reloading an extension ends a running capture; stop and save first when possible. Chrome uses `chrome://extensions` with the same steps. Requires Chromium 116 or newer. No build step or runtime dependencies.

## The manifest / blob case

For a segment URL such as `seg-0.mp4?src=https%3A%2F%2Fexample.com%2Fsong.m4a&muffleAfter=10`, AudioDownload surfaces the exact decoded `src` URL as an **unverified source link**. Source links are preserved exactly. If the original is accessible, this is preferable to recording or assembling processed segments. The server may deny access or return only a preview; the extension cannot guarantee a full song.

If needed, **Inspect HLS** reads a playlist and discovers source links in its initialization and segment URLs. **Assemble audio** downloads its initialization file and segments in order and saves the result under **Saved audio**. This is not merely a downloaded `.m3u8` file. A `blob:` attached to MediaSource refers to a player stream, so the extension works with its underlying URLs instead.

Supported assembly: finite (`EXT-X-ENDLIST`), unencrypted audio-only fragmented MP4, AAC, and MP3; relative URLs, query strings, byte ranges, and master playlists with standalone audio renditions. The default audio rendition (or highest bandwidth audio-only variant) is selected. Fragmented MP4 output is `.m4a`; no transcoding occurs. Discontinuities, encryption, changing initialization files, live/incomplete streams, MPEG-TS, video renditions, and DASH assembly are rejected with a reason. Assembly preserves whatever audio the server returns.

## Recording

The **Stop & Save** button is always visible at the top. It controls the active recording even after reopening the popup or switching tabs. Finished WebM recordings appear under **Audio on this page** for the song's page as well as **Saved audio**, with an explicit **Download WEBM** button. M4A source links remain separate options labeled **Download M4A**; they do not replace or convert WebM recordings. Direct `.webm` files are detected by their URL or audio MIME type, including requests recovered by Scan page.

Detected audio lists downloadable files and playlists, without recording shortcuts. Real audio Blob files are probed from the page and downloaded there in their actual format, including WebM. A MediaSource blob is not a complete file and is not shown as a downloadable WebM. Streaming songs can be saved from their original audio URL or a supported HLS playlist. HLS URLs and processing parameters are used unchanged; there is no muffling-removal option.

Recording runs in an offscreen document and restores audible playback through Web Audio. It captures the selected tab only, never the microphone. Finished recordings are WebM/Opus. Capturing protected playback may fail or yield silence.

Chunks are persisted to IndexedDB every second. On stop, capture tracks and the audio context are released, and the chunks are saved as a recording. If the browser exits, persisted chunks can be recovered next time the recorder opens; the last unsaved chunk can be lost. The extension limits an individual recording or assembly to approximately 128 MB, recordings to 60 minutes, and HLS to 4,000 segments. Browser storage quotas still apply. Download important results to your filesystem.

## Privacy and permissions

No telemetry, accounts, remote code, or upload server. HTTP/HTTPS host access and `webRequest` observe media response headers; a content script reports audio/video sources and playback state. Detection metadata is tab-scoped in session storage and clears on navigation or tab close. Local IndexedDB keeps saved audio until you delete it, clear extension data, or uninstall. `downloads` saves files; `activeTab`, `tabCapture`, and `offscreen` support explicitly started recording. Site authentication, cookie policies, expired links, and Brave Shields may affect downloads. This extension does not bypass access controls or DRM.

## Development

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run check
npm.cmd run package
```

Development checks require Node 22 or newer. Tests use Node's test runner without subprocess isolation, local fixtures, and a mocked recorder; they do not access your song or browser account. The package command writes `artifacts/AudioDownload-1.0.3.zip`, containing just the extension.

References: [Chrome tab recording](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture), [offscreen documents](https://developer.chrome.com/docs/extensions/reference/api/offscreen), [HLS RFC 8216](https://www.rfc-editor.org/rfc/rfc8216).
