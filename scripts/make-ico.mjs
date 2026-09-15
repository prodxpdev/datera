#!/usr/bin/env node
/**
 * Builds brand/… PNGs into a Windows .ico.
 *
 * Hand-assembled rather than shelled out to ImageMagick: this repo already refuses to
 * depend on tools a contributor may not have, and an ICO that embeds PNG data (Vista and
 * later) is a 6-byte header plus one 16-byte directory entry per image. Fewer moving
 * parts than a converter, and it runs the same on every machine.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sizes = [16, 32, 48, 256];

const images = await Promise.all(
  sizes.map(async (size) => ({
    size,
    data: await readFile(resolve(root, 'brand/png', size === 256 ? 'icon-256.png' : `icon-${size}.png`)),
  })),
);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // 1 = icon
header.writeUInt16LE(images.length, 4);

const directory = Buffer.alloc(16 * images.length);
let offset = header.length + directory.length;

images.forEach((image, i) => {
  const at = i * 16;
  // 256 is stored as 0 — the field is one byte, so 256 does not fit.
  directory.writeUInt8(image.size === 256 ? 0 : image.size, at);
  directory.writeUInt8(image.size === 256 ? 0 : image.size, at + 1);
  directory.writeUInt8(0, at + 2); // palette colours: 0 for truecolour
  directory.writeUInt8(0, at + 3); // reserved
  directory.writeUInt16LE(1, at + 4); // colour planes
  directory.writeUInt16LE(32, at + 6); // bits per pixel
  directory.writeUInt32LE(image.data.length, at + 8);
  directory.writeUInt32LE(offset, at + 12);
  offset += image.data.length;
});

const out = resolve(root, 'apps/desktop/build/icon.ico');
await writeFile(out, Buffer.concat([header, directory, ...images.map((i) => i.data)]));
console.log(`wrote ${out} (${images.map((i) => i.size).join(', ')})`);
