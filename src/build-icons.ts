// Generates the favicon set from assets/wp_logo.png. Run by hand after the logo
// changes - `npm run icons:build` - and the outputs committed, because assets/
// is deliberately not copied into the Docker image (the Dockerfile ships
// public/ only), so nothing can render these at deploy time.
//
// The mark is three stacked ellipses, black on transparency, 2:1. Two decisions
// are baked in here, both settled by rendering the candidates at true 16px and
// looking at them rather than reasoning about them:
//
//   - It gets an opaque ground. Black on transparency is near-invisible on a
//     dark tab strip, which every major browser now ships. The app's own --bg
//     is that ground, so the tab matches the page it opens.
//   - The mark takes 86% of the tile. At 98% the top ellipse collides with the
//     edges and reads as cramped; the 2:1 letterboxing that leaves is margin,
//     not waste.
//
// No rounded corners: Safari and iOS apply their own mask, and a corner we cut
// ourselves shows up as a notch inside theirs.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.join(here, "../assets/wp_logo.png");
const OUT_DIR = path.join(here, "../public");

// --bg in public/app.css. Opaque: iOS ignores alpha on a touch icon and
// composites it onto black, which would put the black mark on black.
const GROUND = { r: 244, g: 246, b: 251, alpha: 1 };
const MARK_FILL = 0.86;

async function renderIcon(mark: Buffer, size: number): Promise<Buffer> {
  const resized = await sharp(mark).resize(Math.round(size * MARK_FILL)).toBuffer();
  const { width = 0, height = 0 } = await sharp(resized).metadata();

  return sharp({ create: { width: size, height: size, channels: 4, background: GROUND } })
    .composite([
      { input: resized, left: Math.round((size - width) / 2), top: Math.round((size - height) / 2) },
    ])
    .png()
    .toBuffer();
}

// ICO is a container, and sharp cannot write one. Rather than take a dependency
// for ~20 lines, assemble it: a 6-byte ICONDIR, one 16-byte ICONDIRENTRY per
// image, then the encoded images back to back. The entries carry PNGs rather
// than raw DIBs - every browser in use reads PNG-in-ICO, and it keeps the
// alpha and the file small.
function buildIco(images: { size: number; png: Buffer }[]): Buffer {
  const HEADER = 6;
  const ENTRY = 16;

  const header = Buffer.alloc(HEADER);
  header.writeUInt16LE(0, 0); // reserved, always 0
  header.writeUInt16LE(1, 2); // 1 = icon (2 would be a cursor)
  header.writeUInt16LE(images.length, 4);

  let offset = HEADER + ENTRY * images.length;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(ENTRY);
    // A 256px image is written as 0: the field is one byte and 256 overflows it.
    entry.writeUInt8(size >= 256 ? 0 : size, 0); // width
    entry.writeUInt8(size >= 256 ? 0 : size, 1); // height
    entry.writeUInt8(0, 2); // palette size, 0 for truecolour
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });

  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function main(): Promise<void> {
  // trim() drops any transparent border, so MARK_FILL is a fraction of the mark
  // itself rather than of whatever padding the export happened to carry.
  const mark = await sharp(SOURCE).trim().toBuffer();

  const ico16 = await renderIcon(mark, 16);
  const ico32 = await renderIcon(mark, 32);
  const touch = await renderIcon(mark, 180);

  const outputs: [string, Buffer][] = [
    ["favicon.ico", buildIco([{ size: 16, png: ico16 }, { size: 32, png: ico32 }])],
    ["favicon-32.png", ico32],
    ["apple-touch-icon.png", touch],
  ];

  for (const [name, bytes] of outputs) {
    const target = path.join(OUT_DIR, name);
    fs.writeFileSync(target, bytes);
    console.log(`wrote public/${name} (${bytes.length} bytes)`);
  }
}

await main();
