// Fyller i kortbilder som TCGdex saknar (t.ex. Shiny Vault, Trainer Gallery, Shining Legends, McDonald's och
// promokort) i data/card-images.json: { "<tcgdex-kort-id>": { low, high } }. Körs med: node scripts/update-card-images.mjs
// Källor: 1. Pokémon TCG API:s öppna data på GitHub (PokemonTCG/pokemon-tcg-data). Kortet matchas på nummer och namn,
// eller bara på namn när numreringen skiljer sig och namnet är unikt i båda seten.
// 2. TCGplayers produktbilder via tcgcsv.com, för tränarkit, McDonald's och promos som källa 1 saknar.
// Gissa inte bildadresser hos andra källor: Scrydex svarar "finns" även för fel kort (t.ex. me1-1 = Bulbasaur för
// Mega Evolution Energy 001). Hellre kortets baksida än fel kort.
// Kort som redan har en bild hos TCGdex eller i card-images.json rörs inte.
import { readFile, writeFile, readdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("data/card-images.json", ROOT);
const PTCG = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";

// TCGdex-set vars namn inte går att matcha automatiskt mot Pokémon TCG API.
const ALIAS = { sve: "sve", svp: "svp", exu: "ex10", cel25cc: "cel25c", "sm3.5": "sm35", "sm7.5": "sm75", "swsh4.5sv": "swsh45sv", "swsh12.5gg": "swsh12pt5gg" };

const readJSON = async (u, fallback) => JSON.parse(await readFile(u, "utf8").catch(() => "null")) ?? fallback;
async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

const tokens = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const name = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
// "SV001" och "SV1", "001" och "1" är samma nummer. TCGdex skriver "?" som "%3F".
const num = (n) => decodeURIComponent(String(n)).toUpperCase().replace(/^([A-Z]*)0*(\d)/, "$1$2");
const sameName = (a, b) => { const x = name(a), y = name(b); return x === y || x.includes(y) || y.includes(x); };

const images = await readJSON(OUT, {});

const sets = [];
for (const f of (await readdir(new URL("data/sets/", ROOT)).catch(() => [])).filter((f) => f.endsWith(".json"))) {
  const s = await readJSON(new URL(`data/sets/${f}`, ROOT), null);
  const missing = s?.cards.filter((c) => !c.image && !images[c.id]) || [];
  if (missing.length) sets.push({ ...s, missing });
}
if (!sets.length) { console.log("Alla kort har bild."); process.exit(0); }

// ---------- 1. Pokémon TCG API ----------
const ptcgSets = (await getJSON(`${PTCG}/sets/en.json`)) || [];
const ptcgFor = (s) => {
  if (ALIAS[s.id]) return ptcgSets.find((p) => p.id === ALIAS[s.id]);
  const want = tokens(s.name), date = s.releaseDate?.replace(/-/g, "/");
  const cands = ptcgSets.filter((p) => { const t = tokens(p.name); return want.every((w) => t.includes(w)) || (t.length >= 2 && t.every((w) => want.includes(w))); });
  return cands.sort((a, b) => (b.releaseDate === date) - (a.releaseDate === date) || Math.abs(a.total - s.cards.length) - Math.abs(b.total - s.cards.length))[0];
};
let fromPtcg = 0;
for (const s of sets) {
  s.ptcg = ptcgFor(s);
  if (!s.ptcg) continue;
  const cards = (await getJSON(`${PTCG}/cards/en/${s.ptcg.id}.json`)) || [];
  const byNum = new Map(cards.map((c) => [num(c.number), c]));
  const count = (list, c) => list.filter((x) => name(x.name) === name(c.name)).length;
  for (const c of s.missing) {
    let m = byNum.get(num(c.localId));
    if (m && !sameName(m.name, c.name)) m = null;
    // Annan numrering (t.ex. Classic Collection): namnet räcker om det bara finns en gång i båda seten.
    if (!m) { const same = cards.filter((x) => name(x.name) === name(c.name)); if (same.length === 1 && count(s.cards, c) === 1) m = same[0]; }
    if (m?.images?.small) { images[c.id] = { low: m.images.small, high: m.images.large || m.images.small }; fromPtcg++; }
  }
}

// ---------- 2. TCGplayer (via tcgcsv.com) ----------
// Tränarkit, McDonald's, MEP-promos och liknande som Pokémon TCG API saknar. tcgcsv.com speglar TCGplayers
// produktdata och vill att man anger vem man är i User-Agent (tcgcsv.com/docs#usage-guidelines).
// Matchning: samma nummer och samma namn. Tränarkiten har två lekar i samma TCGplayer-grupp, båda numrerade
// 1/30 och uppåt, så namnet skiljer dem åt, och vid dubbletter lekens namn i parentes (t.ex. "Energy Switch (Raichu)").
// Är det fortfarande flera olika kort som passar hoppas kortet över.
const TCGP_GROUP = {
  mep: 24451, mee: 24461, "2024sv": 24163, "2023sv": 23306, mfb: 23330, svp: 22872, sve: 24382, swshp: 2545, ecard2: 1397,
  "tk-hs-g": 1540, "tk-hs-r": 1540, "tk-bw-e": 1538, "tk-bw-z": 1538, "tk-sm-r": 2069, "tk-sm-l": 2069,
  "tk-xy-b": 1533, "tk-xy-w": 1533, "tk-xy-latia": 1536, "tk-xy-latio": 1536, "tk-xy-n": 1532, "tk-xy-sy": 1532,
  "tk-xy-p": 1796, "tk-xy-su": 1796, "tk-dp-m": 1541, "tk-dp-l": 1541,
};
const TCGCSV = { headers: { "User-Agent": "Lootninja-card-images/1.0 (+https://lootninja.se)" } };
const groups = new Map();
const productsOf = async (id) => {
  if (!groups.has(id)) {
    const r = await fetch(`https://tcgcsv.com/tcgplayer/3/${id}/products`, { ...TCGCSV, signal: AbortSignal.timeout(30000) }).catch(() => null);
    const list = r?.ok ? (await r.json()).results || [] : [];
    groups.set(id, list.map((p) => {
      const ext = Object.fromEntries((p.extendedData || []).map((e) => [e.name, e.value]));
      // "Energy Switch (Raichu)" och "Meganium - 001 (Cosmos Holo)": själva namnet, numret och det i parentes.
      const tag = (p.name.match(/\(([^)]*)\)/) || [])[1] || "";
      const base = p.name.replace(/\s*\([^)]*\)/g, "").replace(/\s+-\s+\w+$/, "");
      return { id: p.productId, base, tag, num: ext.Number ? num(String(ext.Number).split("/")[0]) : null, card: !!ext.Rarity };
    }).filter((p) => p.card));
  }
  return groups.get(id);
};
let fromTcgp = 0;
for (const s of sets) {
  const gid = TCGP_GROUP[s.id];
  if (!gid) continue;
  const prods = await productsOf(gid);
  const deck = name((s.name.match(/\(([^)]*)\)/) || [])[1] || "");
  for (const c of s.missing) {
    if (images[c.id]) continue;
    let cands = prods.filter((p) => name(p.base) === name(c.name) && (p.num == null || p.num === num(c.localId)));
    // Utan nummer hos TCGplayer (t.ex. My First Battle) räcker namnet bara om det är unikt i båda seten.
    if (cands.some((p) => p.num == null) && (cands.length > 1 || s.cards.filter((x) => name(x.name) === name(c.name)).length > 1)) cands = cands.filter((p) => p.num != null && !p.tag);
    if (cands.length > 1 && deck) { const own = cands.filter((p) => name(p.tag) === deck); if (own.length) cands = own; }
    if (cands.length > 1) { const plain = cands.filter((p) => !p.tag); if (plain.length === 1) cands = plain; }
    if (cands.length !== 1) continue;
    const id = cands[0].id;
    images[c.id] = { low: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_400w.jpg`, high: `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_1000x1000.jpg` };
    fromTcgp++;
  }
}

const sorted = Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(OUT, JSON.stringify(sorted, null, 1) + "\n");
const left = sets.reduce((n, s) => n + s.missing.filter((c) => !images[c.id]).length, 0);
console.log(`${fromPtcg} nya bilder från Pokémon TCG API, ${fromTcgp} från TCGplayer. ${left} kort saknar fortfarande bild.`);
