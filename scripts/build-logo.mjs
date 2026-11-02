// Bygger loggan och alla ikoner från de två originalbilderna i img/brand/ (2000×2000 px, "LOOT NINJA" i pixelstil).
//   node scripts/build-logo.mjs   (kräver npm i --no-save sharp)
// source-dark.jpg (mörk bakgrund) är standardloggan, source-light.jpg (vit bakgrund) visas bara i ljust läge.
// Ur båda klipps ordloggan ut med genomskinlig bakgrund: bakgrundsfärgen blir genomskinlig, och kanten mot den
// tonar mjukt så att JPG-brus inte syns. Ikonerna (favicon, app-ikoner) görs av den mörka bilden, med bakgrunden kvar.
import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const out = (p) => fileURLToPath(new URL(p, ROOT));
const LOGO_H = 200; // loggans höjd i px (visas ca 50 px hög, så den är skarp även på skärmar med hög upplösning)
const FADE = [26, 64]; // färgavstånd från bakgrunden: under är helt genomskinligt, över helt synligt

// Ordloggan med genomskinlig bakgrund, beskuren tätt runt texten. Returnerar { png, box, bg }.
async function cutout(file) {
  const { data, info } = await sharp(out(file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;
  // Bakgrundsfärgen: snittet av de fyra hörnen
  const bg = [0, 1, 2].map((c) => Math.round([[4, 4], [w - 5, 4], [4, h - 5], [w - 5, h - 5]]
    .reduce((s, [x, y]) => s + data[(y * w + x) * 3 + c], 0) / 4));
  const rgba = Buffer.alloc(w * h * 4);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, d = Math.hypot(data[i * 3] - bg[0], data[i * 3 + 1] - bg[1], data[i * 3 + 2] - bg[2]);
    const a = Math.round(255 * Math.min(1, Math.max(0, (d - FADE[0]) / (FADE[1] - FADE[0]))));
    rgba[i * 4] = data[i * 3]; rgba[i * 4 + 1] = data[i * 3 + 1]; rgba[i * 4 + 2] = data[i * 3 + 2]; rgba[i * 4 + 3] = a;
    if (a > 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  }
  const box = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const png = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).extract(box).png().toBuffer();
  return { png, box, bg };
}

// Windows-ikon med flera storlekar (PNG inuti)
function ico(images) {
  const head = Buffer.alloc(6);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const dir = images.map(({ size, buffer }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0); e.writeUInt8(size, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buffer.length, 8); e.writeUInt32LE(offset, 12);
    offset += buffer.length;
    return e;
  });
  return Buffer.concat([head, ...dir, ...images.map((i) => i.buffer)]);
}

const dark = await cutout("img/brand/source-dark.jpg");
const light = await cutout("img/brand/source-light.jpg");
for (const [name, c] of [["logo.png", dark], ["logo-light.png", light]]) {
  await sharp(c.png).resize({ height: LOGO_H }).png({ compressionLevel: 9, palette: true, quality: 90 }).toFile(out(`img/${name}`));
  console.log(`img/${name}`);
}

// Ikonerna: texten på mörk bakgrund i en kvadrat. inner = andel av kvadraten som texten får ta upp på bredden.
const bg = { r: dark.bg[0], g: dark.bg[1], b: dark.bg[2], alpha: 1 };
const icon = async (size, inner) => {
  const text = await sharp(dark.png).resize({ width: Math.round(size * inner) }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: bg } }).composite([{ input: text, gravity: "center" }]).png().toBuffer();
};
const files = {
  "img/logo-512.png": await icon(512, 0.84),
  "img/icon-192.png": await icon(192, 0.86),
  "img/apple-touch-icon.png": await icon(180, 0.8),
  // Maskerbar ikon: telefonen kan klippa bort allt utanför en cirkel med 80 % av bredden
  "img/icon-512-maskable.png": await icon(512, 0.66),
  "img/favicon-48.png": await icon(48, 0.92),
};
for (const [file, buf] of Object.entries(files)) {
  fs.writeFileSync(out(file), buf);
  console.log(file);
}
fs.writeFileSync(out("favicon.ico"), ico([
  { size: 16, buffer: await icon(16, 0.94) },
  { size: 32, buffer: await icon(32, 0.94) },
  { size: 48, buffer: files["img/favicon-48.png"] },
]));
console.log("favicon.ico");
