// Generates a minimal 512x512 solid-color PNG to seed `tauri icon`.
// Run: node scripts/generate-icon.js
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync, crc32 } from "node:zlib";
import { Buffer } from "node:buffer";

const SIZE = 512;
// Coco brand green (#217346)
const R = 0x21, G = 0x73, B = 0x46;

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr.writeUInt8(8, 8);   // bit depth
ihdr.writeUInt8(2, 9);   // color type: RGB
ihdr.writeUInt8(0, 10);  // compression
ihdr.writeUInt8(0, 11);  // filter
ihdr.writeUInt8(0, 12);  // interlace

// IDAT: filtered scanlines (filter byte 0 + RGB pixel data)
const row = Buffer.alloc(1 + SIZE * 3);
row[0] = 0;
for (let x = 0; x < SIZE; x++) {
  row[1 + x * 3] = R;
  row[1 + x * 3 + 1] = G;
  row[1 + x * 3 + 2] = B;
}
const raw = Buffer.concat(Array.from({ length: SIZE }, () => row));
const idat = deflateSync(raw);

const png = Buffer.concat([
  signature,
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("src-tauri/icons", { recursive: true });
writeFileSync("src-tauri/icons/source.png", png);
console.log(`Wrote src-tauri/icons/source.png (${png.length} bytes)`);
