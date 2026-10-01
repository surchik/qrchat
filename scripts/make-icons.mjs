// Generates extension/icons/icon{16,32,48,128}.png with no dependencies:
// a violet rounded square with a white magnifier + down arrow, rendered by signed distance.
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp = (v) => Math.max(0, Math.min(1, v));
function sdRoundBox(x, y, half, r) {
  const qx = Math.abs(x) - half + r;
  const qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

// Shape in a unit square [0,1]^2.
function glyph(x, y) {
  const ring = Math.abs(Math.hypot(x - 0.43, y - 0.43) - 0.22) - 0.055;
  const handle = sdSegment(x, y, 0.6, 0.6, 0.8, 0.8) - 0.06;
  const stem = sdSegment(x, y, 0.43, 0.31, 0.43, 0.53) - 0.035;
  const left = sdSegment(x, y, 0.43, 0.55, 0.34, 0.46) - 0.035;
  const right = sdSegment(x, y, 0.43, 0.55, 0.52, 0.46) - 0.035;
  return Math.min(ring, handle, stem, left, right);
}

for (const size of [16, 32, 48, 128]) {
  const buf = Buffer.alloc(size * size * 4);
  const aa = 1 / size;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      const x = (px + 0.5) / size;
      const y = (py + 0.5) / size;
      const bg = clamp(0.5 - sdRoundBox(x - 0.5, y - 0.5, 0.5, 0.22) / aa);
      const fg = clamp(0.5 - glyph(x, y) / aa);
      // violet #7c3aed -> white glyph
      const r = 124 + (255 - 124) * fg;
      const g = 58 + (255 - 58) * fg;
      const b = 237 + (255 - 237) * fg;
      const i = (py * size + px) * 4;
      buf[i] = Math.round(r);
      buf[i + 1] = Math.round(g);
      buf[i + 2] = Math.round(b);
      buf[i + 3] = Math.round(255 * bg);
    }
  }
  writeFileSync(join(outDir, `icon${size}.png`), png(size, buf));
}
console.log(`icons written to ${outDir}`);
