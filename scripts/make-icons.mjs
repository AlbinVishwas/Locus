/**
 * node scripts/make-icons.mjs: draws the Locus mark (a cream ring with a dot, on the app's near-black) and writes
 * the PNG and ICO files the app, the web-app manifest and the browser tab use. Pure Node (zlib), no image library.
 * The output is committed; run this only to change the icon.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const BG = [10, 10, 12];
const CREAM = [230, 220, 203];

function crc32(buf) {
  let c;
  let crc = ~0;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** scale: how much of the canvas the mark may use (maskable icons keep it inside the safe zone). */
function render(size, { scale = 1, rounded = false } = {}) {
  const ss = 4; // supersampling for smooth edges
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const c = size / 2;
  const ringOuter = size * 0.3 * scale;
  const ringInner = size * 0.245 * scale;
  const dot = size * 0.085 * scale;
  const corner = rounded ? size * 0.22 : 0;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let cover = 0;
      let inside = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss;
          const py = y + (sy + 0.5) / ss;
          const d = Math.hypot(px - c, py - c);
          if ((d <= ringOuter && d >= ringInner) || d <= dot) cover++;
          if (corner > 0) {
            const dx = Math.max(corner - px, 0, px - (size - corner));
            const dy = Math.max(corner - py, 0, py - (size - corner));
            if (Math.hypot(dx, dy) <= corner) inside++;
          } else inside++;
        }
      const t = cover / (ss * ss);
      const a = inside / (ss * ss);
      const i = y * (size * 4 + 1) + 1 + x * 4;
      for (let k = 0; k < 3; k++) raw[i + k] = Math.round(BG[k] * (1 - t) + CREAM[k] * t);
      raw[i + 3] = Math.round(255 * a);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

function ico(png, size) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(1, 4); // one image
  const entry = Buffer.alloc(16);
  entry[0] = size;
  entry[1] = size;
  entry.writeUInt16LE(1, 4); // planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12); // data offset
  return Buffer.concat([head, entry, png]);
}

const root = path.resolve(import.meta.dirname, "..");
const write = (rel, buf) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`wrote ${rel} (${buf.length} bytes)`);
};
write("public/icons/icon-192.png", render(192, { rounded: true }));
write("public/icons/icon-512.png", render(512, { rounded: true }));
write("public/icons/icon-maskable-512.png", render(512, { scale: 0.8 })); // full-bleed, mark inside the safe zone
write("src/app/icon.png", render(512, { rounded: true }));
write("src/app/apple-icon.png", render(180));
write("src/app/favicon.ico", ico(render(32, { rounded: true }), 32));
