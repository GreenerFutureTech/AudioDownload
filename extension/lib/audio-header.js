export function hasMp4Header(bytes) {
  if (bytes.length < 12) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Permit ordinary padding boxes before ftyp, without trusting a random ftyp
  // string found elsewhere in an encoded or encrypted payload.
  for (let offset = 0; offset + 12 <= bytes.length;) {
    const size = view.getUint32(offset);
    if (size < 8) return false;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === 'ftyp') return size >= 12 && size <= bytes.length - offset;
    if (!['free', 'skip', 'wide'].includes(type) || size > bytes.length - offset) return false;
    offset += size;
  }
  return false;
}

export async function validateM4aSource(url, fetcher = fetch) {
  const response = await fetcher(url, { credentials: 'include', signal: AbortSignal.timeout(30000),
    headers: { Range: 'bytes=0-65535' } });
  if (!response.ok) throw new Error(`Source audio request failed: HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The source audio response is empty.');
  const pieces = [];
  let length = 0;
  try {
    while (length < 65536) {
      const { value, done } = await reader.read();
      if (done) break;
      const part = value.subarray(0, 65536 - length);
      pieces.push(part); length += part.length;
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of pieces) { bytes.set(part, offset); offset += part.length; }
  if (!hasMp4Header(bytes)) {
    throw new Error('This source URL does not return a valid MP4/M4A header. Saving it as .m4a will not make it playable. Use the HLS playlist to download the served audio.');
  }
}
