import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../extension/icons/', import.meta.url));
await mkdir(directory, { recursive: true });
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const label = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
  return Buffer.concat([length, label, data, crc]);
}
for (const size of [16, 32, 48, 128]) {
  const raw = Buffer.alloc(size * (1 + size * 4));
  const heights = [0.21, 0.44, 0.65, 0.37, 0.22];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const px = (x + 0.5) / size;
    const py = (y + 0.5) / size;
    const radius = .2;
    const cx = Math.max(radius - px, 0, px - (1 - radius));
    const cy = Math.max(radius - py, 0, py - (1 - radius));
    const inside = cx * cx + cy * cy <= radius * radius;
    const bar = heights.some((height, index) => Math.abs(px - (.22 + index * .14)) < .035 && Math.abs(py - .5) < height / 2);
    const offset = y * (1 + size * 4) + 1 + x * 4;
    const color = bar ? [13, 49, 40] : [119, 229, 197];
    raw.set([...color, inside ? 255 : 0], offset);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6;
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  await writeFile(`${directory}/icon${size}.png`, png);
}
console.log('Generated extension icons (16, 32, 48, 128).');
