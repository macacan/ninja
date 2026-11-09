// Notisikonen i Androids statusfält (badge i sw.js och js/push.js), byggd av LOOT NINJA-loggan.
// Android visar bara formen, vitt på genomskinligt, så bara bokstävernas gula fyllning blir vit.
// Den svarta konturen blir genomskinlig, så att bokstäverna hålls isär även när ikonen är liten.
//   node scripts/build-badge.mjs   (kräver npm i --no-save sharp)
import sharp from "sharp";

const SIZE = 96, PAD = 4;
const { data, info } = await sharp("img/logo.png").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const out = Buffer.alloc(data.length);
for (let i = 0; i < data.length; i += 4) {
  const fill = data[i + 3] > 128 && data[i] > 150; // gul/orange fyllning, inte svart kontur
  out[i] = out[i + 1] = out[i + 2] = 255;
  out[i + 3] = fill ? 255 : 0;
}
const shape = await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).trim().png().toBuffer();
const fitted = await sharp(shape).resize({ width: SIZE - PAD * 2, height: SIZE - PAD * 2, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
await sharp({ create: { width: SIZE, height: SIZE, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: fitted, gravity: "center" }]).png({ compressionLevel: 9 }).toFile("img/badge-96.png");
console.log("img/badge-96.png");
