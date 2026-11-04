// Bygger kortskannerns bildindex för One Piece: data/op/hashes.json (id-lista) + data/op/hashes.bin (240 byte per bild).
// Samma avtryck som för Pokémon och Riftbound (js/scan/fingerprint.js), med One Piece-kortens ruta för konstverket.
// Bilder från data/op/cards.json (optcgapi och TCGplayer). Körs av GitHub Actions (Bygg kortindex). Kräver: npm i --no-save sharp.
//
// Varje variant (parallel, manga, alternativ bild) har en egen bild och ett eget avtryck. Samma bild flera gånger läggs
// in en gång, under kortet utan variant om det finns.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const FP = require("../js/scan/fingerprint.js");
const CONC = 12;

const { cards } = JSON.parse(fs.readFileSync(new URL("../data/op/cards.json", import.meta.url), "utf8"));
const byImage = new Map();
for (const c of cards) {
  if (!c.image) continue;
  const prev = byImage.get(c.image);
  if (!prev || (prev.variant && !c.variant)) byImage.set(c.image, c);
}
const list = [...byImage.values()];
console.log(`${list.length} unika bilder av ${cards.length} kort`);

async function one(c) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch(c.image);
      if (!r.ok) throw new Error(r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const { data } = await sharp(buf).resize(FP.CW, FP.CH, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return FP.vector(FP.describe(data, FP.CW, FP.CH, 3, 0, 0, FP.BOX.op));
    } catch { await new Promise((r) => setTimeout(r, 500 * (t + 1))); }
  }
  return null;
}

let next = 0, done = 0, failed = 0;
const results = new Array(list.length);
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < list.length) {
    const i = next++;
    results[i] = await one(list[i]);
    if (!results[i]) failed++;
    if (++done % 300 === 0) console.log(`${done}/${list.length} (misslyckade: ${failed})`);
  }
}));
const ids = [], vecs = [];
list.forEach((c, i) => { if (results[i]) { ids.push(c.id); vecs.push(results[i]); } });
if (ids.length < list.length * 0.9) throw new Error(`För många misslyckade: ${failed}/${list.length}`);
const bin = Buffer.alloc(ids.length * FP.LEN);
vecs.forEach((v, i) => Buffer.from(v.buffer).copy(bin, i * FP.LEN));
fs.writeFileSync(new URL("../data/op/hashes.bin", import.meta.url), bin);
fs.writeFileSync(new URL("../data/op/hashes.json", import.meta.url), JSON.stringify({ len: FP.LEN, n: ids.length, v: createHash("sha1").update(bin).digest("hex").slice(0, 12), ids }));
console.log(`Klart: ${ids.length} avtryck, ${(bin.length / 1e6).toFixed(2)} MB (misslyckade: ${failed})`);
