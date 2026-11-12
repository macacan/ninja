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
// --add: behåller indexet och lägger bara till bilder som saknas (nya promos, eventkort).
const ADD = process.argv.includes("--add");
const HJ = new URL("../data/op/hashes.json", import.meta.url), HB = new URL("../data/op/hashes.bin", import.meta.url);
const old = ADD ? JSON.parse(fs.readFileSync(HJ, "utf8")) : null;
const have = new Set(old?.ids || []);
const list = [...byImage.values()].filter((c) => !have.has(c.id));
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
const ids = [...(old?.ids || [])], vecs = [];
const oldBin = ADD ? fs.readFileSync(HB) : Buffer.alloc(0);
// Kort som bara finns hos TCGplayer (id "SET/tcg123": eventkort, promos) är ofta samma bild som ett kort med samma nummer,
// med en liten stämpel ("Pre-Release", "Release Event"). Avtrycket kan inte skilja dem åt, och skannern skulle tveka mellan
// dem. Ser utgåvan likadan ut (likhet 0.9) som ett kort med samma nummer som redan finns i indexet hoppas den över:
// skannern väljer originalet, och utgåvan går att söka fram i Kortpriser.
const noOf = new Map(cards.map((c) => [c.id, c.no]));
const byNo = new Map();
const keep = (id, v) => { const n = noOf.get(id); if (n) (byNo.get(n) || byNo.set(n, []).get(n)).push(v); };
const oldDb = new Int8Array(oldBin.buffer, oldBin.byteOffset, oldBin.length);
(old?.ids || []).forEach((id, i) => keep(id, oldDb.subarray(i * FP.LEN, (i + 1) * FP.LEN)));
const same = (a, b) => { let s = 0; for (let k = 0; k < FP.LEN; k++) s += a[k] * b[k]; return s / (127 * 127) >= 0.9; };
let twins = 0;
list.forEach((c, i) => {
  const v = results[i];
  if (!v) return;
  if (/\/tcg\d+$/.test(c.id) && (byNo.get(c.no) || []).some((w) => same(v, w))) { twins++; return; }
  ids.push(c.id); vecs.push(v); keep(c.id, v);
});
console.log(`${twins} utgåvor med samma bild som ett kort i indexet hoppades över`);
if (!ADD && ids.length < list.length * 0.9) throw new Error(`För många misslyckade: ${failed}/${list.length}`);
const bin = Buffer.alloc(ids.length * FP.LEN);
oldBin.copy(bin, 0);
vecs.forEach((v, i) => Buffer.from(v.buffer).copy(bin, oldBin.length + i * FP.LEN));
fs.writeFileSync(HB, bin);
fs.writeFileSync(HJ, JSON.stringify({ len: FP.LEN, n: ids.length, v: createHash("sha1").update(bin).digest("hex").slice(0, 12), ids }));
console.log(`Klart: ${ids.length} avtryck, ${(bin.length / 1e6).toFixed(2)} MB (misslyckade: ${failed})`);
