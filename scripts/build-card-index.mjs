// Bygger kortskannerns bildindex: data/hashes.json (id- och namnlista) + data/hashes.bin (ett avtryck på 240 byte per kort).
// Körs av GitHub Actions (Bygg kortindex) en gång i månaden. Kräver: npm i --no-save sharp.
// Bilder från TCGdex. Kort som saknar bild där tas från data/card-images.json (samma reservbilder som sidan visar).
// node scripts/build-card-index.mjs --add: behåller indexet och lägger bara till kort som saknas (t.ex. ett nytt set
// som TCGdex har utan bilder). Tar någon minut i stället för en timme.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const FP = require("../js/scan/fingerprint.js");
const CONC = 24;

const list = await (await fetch("https://api.tcgdex.net/v2/en/cards")).json();
let extra = {};
try { extra = JSON.parse(fs.readFileSync(new URL("../data/card-images.json", import.meta.url), "utf8")); } catch {}
// Reservbilden används också när TCGdex bild inte går att hämta (de har trasiga bildadresser för en del kort)
const fallback = (c) => { const e = extra[c.id]; return typeof e === "string" ? e : e?.low || e?.high || null; };
const url = (c) => (c.image ? c.image + "/low.webp" : fallback(c));
// Pokémon TCG Pocket (set A1, B1, P-A …) är bara digitala kort. De har ofta samma konstverk som ett fysiskt kort, och
// då pekar bilden ut två nästan identiska kort, så att skannern inte vågar välja.
const pocket = (c) => /\/tcgp\//.test(c.image || "") || /^(?:[AB]\d|P-A-)/.test(c.id);
const ADD = process.argv.includes("--add");
const HJ = new URL("../data/hashes.json", import.meta.url), HB = new URL("../data/hashes.bin", import.meta.url);
const old = ADD ? JSON.parse(fs.readFileSync(HJ, "utf8")) : null;
const have = new Set(old?.ids || []);
// Lokala set (data/sets/*.json med local: true) som TCGdex inte listar än
const known = new Set(list.map((c) => c.id));
for (const f of fs.readdirSync(new URL("../data/sets/", import.meta.url))) {
  let set; try { set = JSON.parse(fs.readFileSync(new URL("../data/sets/" + f, import.meta.url), "utf8")); } catch { continue; }
  if (set.local) for (const c of set.cards || []) if (!known.has(c.id)) list.push({ id: c.id, localId: c.localId, name: c.name, image: c.image || undefined });
}
// Kort som TCGdex saknar helt (data/extra-cards.json, t.ex. nya promos)
try {
  const ex = JSON.parse(fs.readFileSync(new URL("../data/extra-cards.json", import.meta.url), "utf8"));
  for (const [k, arr] of Object.entries(ex)) if (Array.isArray(arr)) for (const c of arr) if (!known.has(c.id)) { known.add(c.id); list.push({ id: c.id, localId: c.localId, name: c.name }); }
} catch {}
const cards = list.filter((c) => !pocket(c) && url(c) && !have.has(c.id));
console.log(`${cards.length} kort med bild (${cards.filter((c) => !c.image).length} med reservbild)`);

async function one(c) {
  for (let t = 0; t < 3; t++) {
    try {
      const u = t > 0 && fallback(c) ? fallback(c) : url(c);
      const r = await fetch(u);
      if (!r.ok) throw new Error(r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const { data } = await sharp(buf).resize(FP.CW, FP.CH, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      return FP.vector(FP.describe(data, FP.CW, FP.CH, 3));
    } catch { await new Promise((r) => setTimeout(r, 500 * (t + 1))); }
  }
  return null;
}

let next = 0, done = 0, failed = 0;
const results = new Array(cards.length);
await Promise.all(Array.from({ length: CONC }, async () => {
  while (next < cards.length) {
    const i = next++;
    results[i] = await one(cards[i]);
    if (!results[i]) failed++;
    if (++done % 2000 === 0) console.log(`${done}/${cards.length} (misslyckade: ${failed})`);
  }
}));
const ids = [...(old?.ids || [])], names = [...(old?.names || [])], vecs = [];
const oldBin = ADD ? fs.readFileSync(HB) : Buffer.alloc(0);
for (let i = 0; i < cards.length; i++) if (results[i]) { ids.push(cards[i].id); names.push(cards[i].name); vecs.push(results[i]); }
const miss = cards.filter((_, i) => !results[i]).map((c) => c.id);
if (miss.length) console.log(`Utan bild: ${miss.join(", ")}`);
if (!ADD && vecs.length < cards.length * 0.9) throw new Error(`För många misslyckade: ${vecs.length}/${cards.length}`);
const bin = Buffer.alloc(ids.length * FP.LEN);
oldBin.copy(bin, 0);
vecs.forEach((v, i) => Buffer.from(v.buffer).copy(bin, oldBin.length + i * FP.LEN));
fs.writeFileSync(HB, bin);
fs.writeFileSync(HJ, JSON.stringify({ len: FP.LEN, n: ids.length, v: createHash("sha1").update(bin).digest("hex").slice(0, 12), ids, names }));
console.log(`Klart: ${ids.length} kort, ${(bin.length / 1e6).toFixed(1)} MB`);
