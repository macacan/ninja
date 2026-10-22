// Fyller i kortbilder som TCGdex saknar (t.ex. Shiny Vault, Trainer Gallery, Shining Legends, McDonald's och
// promokort) i data/card-images.json: { "<tcgdex-kort-id>": { low, high } }. Körs med: node scripts/update-card-images.mjs
// Källor, i ordning:
//   1. Pokémon TCG API:s öppna data på GitHub (PokemonTCG/pokemon-tcg-data). Kortet matchas på nummer och namn,
//      eller bara på namn när numreringen skiljer sig och namnet är unikt i båda seten.
//   2. Scrydex (scrydex.com/docs, "Images"), som har nyare set och promos. Adressen gissas från setets id och
//      används bara om bilden faktiskt finns. Gissningar som inte fanns prövas igen efter RECHECK_DAYS dagar.
// Kort som redan har en bild hos TCGdex eller i card-images.json rörs inte.
import { readFile, writeFile, readdir } from "node:fs/promises";

const ROOT = new URL("../", import.meta.url);
const OUT = new URL("data/card-images.json", ROOT);
const STATE = new URL("scripts/card-images-state.json", ROOT);
const PTCG = "https://raw.githubusercontent.com/PokemonTCG/pokemon-tcg-data/master";
const RECHECK_DAYS = 30;
const CONCURRENCY = 4;

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
// true/false, eller null om servern inte gick att nå (då sparas inget, och adressen prövas nästa gång).
const exists = (url) => fetch(url, { method: "HEAD", signal: AbortSignal.timeout(15000) }).then((r) => r.ok).catch(() => null);
async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const tokens = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
const name = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "");
// "SV001" och "SV1", "001" och "1" är samma nummer. TCGdex skriver "?" som "%3F".
const num = (n) => decodeURIComponent(String(n)).toUpperCase().replace(/^([A-Z]*)0*(\d)/, "$1$2");
const sameName = (a, b) => { const x = name(a), y = name(b); return x === y || x.includes(y) || y.includes(x); };

const images = await readJSON(OUT, {});
const state = await readJSON(STATE, { checked: {} });
const today = new Date().toISOString().slice(0, 10);
const recheck = new Date(Date.now() - RECHECK_DAYS * 864e5).toISOString().slice(0, 10);

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

// ---------- 2. Scrydex ----------
const scrydexSet = (s) => [s.ptcg?.id, /^(\d{4})[a-z]+$/.test(s.id) ? `mcd${s.id.slice(2, 4)}` : null, s.id].filter(Boolean);
const guesses = sets.flatMap((s) => s.missing.filter((c) => !images[c.id] && !(state.checked[c.id] >= recheck))
  .map((c) => ({ c, ids: [...new Set(scrydexSet(s))].map((sid) => `${sid}-${num(c.localId)}`) })));
let fromScrydex = 0;
await pool(guesses, async ({ c, ids }) => {
  let unreachable = false;
  for (const id of ids) {
    const low = `https://images.scrydex.com/pokemon/${id}/small`, ok = await exists(low);
    if (ok) { images[c.id] = { low, high: `https://images.scrydex.com/pokemon/${id}/large` }; fromScrydex++; delete state.checked[c.id]; return; }
    if (ok === null) unreachable = true;
  }
  if (!unreachable) state.checked[c.id] = today;
});

const sorted = Object.fromEntries(Object.entries(images).sort(([a], [b]) => a.localeCompare(b)));
await writeFile(OUT, JSON.stringify(sorted, null, 1) + "\n");
await writeFile(STATE, JSON.stringify({ checked: Object.fromEntries(Object.entries(state.checked).sort()) }, null, 1) + "\n");
const left = sets.reduce((n, s) => n + s.missing.filter((c) => !images[c.id]).length, 0);
console.log(`${fromPtcg} bilder från Pokémon TCG API, ${fromScrydex} från Scrydex. ${left} kort saknar fortfarande bild.`);
