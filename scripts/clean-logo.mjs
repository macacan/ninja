// Tvättar loggans kant och bygger om alla ikoner från img/logo-512.png.
//   node scripts/clean-logo.mjs   (kräver npm i --no-save sharp)
// Cirkeln klipptes ut ur en JPG lite snett, så de yttersta pixlarna nere till höger blev vita (originalets bakgrund).
// Skriptet målar om den yttersta kanten i badgens mörka kantfärg, och lägger app-ikonerna på samma färg så att
// cirkeln smälter in i ikonens bakgrund på hemskärmen. Det går att köra flera gånger, resultatet blir detsamma.
import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../", import.meta.url);
const out = (p) => fileURLToPath(new URL(p, ROOT));
const SIZE = 512;
const EDGE_FROM = 253; // radie där den mörka kanten tar slut och den vita fransen börjar
const SAMPLE = [245, 252]; // radier med ren mörk kantfärg

const { data, info } = await sharp(out("img/logo-512.png")).resize(SIZE, SIZE).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const c = (SIZE - 1) / 2;

// Kantfärgen: snittet av den mörka ringen strax innanför fransen.
let sum = [0, 0, 0], n = 0;
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const r = Math.hypot(x - c, y - c), i = (y * SIZE + x) * 4;
  if (r >= SAMPLE[0] && r <= SAMPLE[1] && data[i + 3] > 200) { sum[0] += data[i]; sum[1] += data[i + 1]; sum[2] += data[i + 2]; n++; }
}
const edge = sum.map((v) => Math.round(v / n));
console.log("Kantfärg:", `rgb(${edge.join(", ")})`, `#${edge.map((v) => v.toString(16).padStart(2, "0")).join("")}`);

// Yttersta kanten i kantfärgen, mjuk övergång mot genomskinligt utanför cirkeln.
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
  const r = Math.hypot(x - c, y - c), i = (y * SIZE + x) * 4;
  if (r < EDGE_FROM) continue;
  data[i] = edge[0]; data[i + 1] = edge[1]; data[i + 2] = edge[2];
  data[i + 3] = r <= SIZE / 2 - 1 ? 255 : r <= SIZE / 2 ? 128 : 0;
}
const badge = await sharp(data, { raw: { width: SIZE, height: SIZE, channels: 4 } }).png().toBuffer();
const bg = { r: edge[0], g: edge[1], b: edge[2], alpha: 1 };
const clear = { r: 0, g: 0, b: 0, alpha: 0 };
const resized = (s) => sharp(badge).resize(s, s, { fit: "contain", background: clear }).png().toBuffer();
// Badgen centrerad på en fyrkant i kantfärgen. inner = badgens storlek.
const onSquare = async (s, inner) => sharp({ create: { width: s, height: s, channels: 4, background: bg } })
  .composite([{ input: await resized(inner), gravity: "center" }]).png().toBuffer();

const logo512 = badge;
fs.writeFileSync(out("img/logo-512.png"), logo512);
fs.writeFileSync(out("img/icon-192.png"), await resized(192));
const fav48 = await resized(48);
fs.writeFileSync(out("img/favicon-48.png"), fav48);
// iPhone rundar själv hörnen. Badgen fyller nästan hela ytan, resten är samma färg som kanten.
fs.writeFileSync(out("img/apple-touch-icon.png"), await onSquare(180, 172));
// Android beskär maskable-ikoner till cirkel eller squircle: viktiga delar inom de inre 80 %, resten i kantfärgen.
fs.writeFileSync(out("img/icon-512-maskable.png"), await onSquare(512, 420));

// favicon.ico med 16, 32 och 48 px (PNG inbäddade).
const icoImgs = [[16, await resized(16)], [32, await resized(32)], [48, fav48]];
const header = Buffer.alloc(6); header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoImgs.length, 4);
let offset = 6 + 16 * icoImgs.length;
const dir = icoImgs.map(([s, buf]) => {
  const e = Buffer.alloc(16);
  e.writeUInt8(s, 0); e.writeUInt8(s, 1); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12); offset += buf.length;
  return e;
});
fs.writeFileSync(out("favicon.ico"), Buffer.concat([header, ...dir, ...icoImgs.map(([, b]) => b)]));

fs.writeFileSync(out("logo.svg"), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <image href="data:image/png;base64,${logo512.toString("base64")}" x="0" y="0" width="512" height="512"/>
</svg>
`, "utf8");
console.log("Klart: logo-512, icon-192, favicon-48, apple-touch-icon, icon-512-maskable, favicon.ico, logo.svg");
