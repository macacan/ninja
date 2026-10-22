// Räknar fram "trendande" och "dyraste" kort ur TCGdex (priser från Cardmarket) och sparar data/card-trends.json.
// Körs en gång per dygn (se .github/workflows/trends.yml) eller manuellt: node scripts/update-card-trends.mjs
// Läser de senaste fysiska seten kort för kort, några åt gången, så att TCGdex inte belastas i onödan.
import { writeFile, readFile, mkdir } from "node:fs/promises";

const API = "https://api.tcgdex.net/v2/en";
const OUT = new URL("../data/card-trends.json", import.meta.url);
const SETS = 10;          // så många av de senaste seten tas med (trender och prishistorik)
const TREND_SETS = 6;     // trendlistorna bygger på de nyaste av dem
const HISTORY_DAYS = 400;
const CONCURRENCY = 6;
const MIN_PRICE = 2;      // euro: billigare kort ger brus i procentuella förändringar

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "LootninjaTrends/1.0" }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < items.length) { const x = items[i++]; out.push(await fn(x)); } }));
  return out;
}

const sets = (await getJSON(`${API}/sets?sort:field=releaseDate&sort:order=DESC&pagination:page=1&pagination:itemsPerPage=20`)) || [];
const details = (await pool(sets, (s) => getJSON(`${API}/sets/${s.id}`))).filter((s) => s && s.serie?.id !== "tcgp" && s.cards?.length)
  .sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || "")).slice(0, SETS);

const cards = (await pool(details.flatMap((s) => s.cards.map((c) => c.id)), (id) => getJSON(`${API}/cards/${id}`))).filter(Boolean);

const slim = (c) => {
  const cm = c.pricing?.cardmarket || {};
  return {
    id: c.id, name: c.name, image: c.image || null, set: c.set?.name, localId: c.localId, rarity: c.rarity,
    eur: cm.trend ?? cm.avg ?? null, avg7: cm.avg7 ?? null, avg30: cm.avg30 ?? null,
    change: cm.avg7 && cm.avg30 ? Math.round((cm.avg7 / cm.avg30 - 1) * 1000) / 10 : null,
  };
};
// ---------- Prishistorik i kronor, en fil per set: data/card-history/<set>.json ----------
// TCGdex har bara dagens priser och snitt. Historiken byggs därför upp av oss, en punkt per kort och dag,
// omräknad till kronor med ECB:s kurs samma dag: [datum, trendpris, lägsta pris].
const rate = (await getJSON("https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK"))?.rates?.SEK;
if (rate) {
  const today = new Date().toISOString().slice(0, 10);
  const oldest = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  const dir = new URL("../data/card-history/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const sek = (v) => (v == null ? null : Math.round(v * rate * 100) / 100);
  for (const s of details) {
    const f = new URL(`${encodeURIComponent(s.id)}.json`, dir);
    let h = { cards: {} };
    try { h = JSON.parse(await readFile(f, "utf8")); } catch {}
    for (const c of cards.filter((x) => x.set?.id === s.id)) {
      const cm = c.pricing?.cardmarket || {};
      const price = sek(cm.trend ?? cm.avg ?? cm["trend-holo"]);
      if (price == null) continue;
      const pts = (h.cards[c.id] ||= []);
      const point = [today, price, sek(cm.low)];
      if (pts.at(-1)?.[0] === today) pts[pts.length - 1] = point; else pts.push(point);
      while (pts.length && pts[0][0] < oldest) pts.shift();
    }
    // Sällsyntheten per kort visas på setsidorna (scripts/build-set-pages.mjs).
    const rarity = { ...h.rarity };
    for (const c of cards) if (c.set?.id === s.id && c.rarity) rarity[c.id] = c.rarity;
    await writeFile(f, JSON.stringify({ updated: Date.now(), set: s.name, rate, cards: h.cards, rarity }) + "\n");
  }
}

const trendSets = new Set(details.slice(0, TREND_SETS).map((s) => s.id));
const priced = cards.filter((c) => trendSets.has(c.set?.id)).map(slim).filter((c) => c.eur != null && c.image);

// TCGdex anger ibland en bildadress som inte finns ännu (nya set). Ta bara med kort vars bild går att ladda.
const imageOk = new Map();
async function hasImage(c) {
  if (!imageOk.has(c.id)) imageOk.set(c.id, fetch(`${c.image}/low.webp`, { method: "HEAD", signal: AbortSignal.timeout(10000) }).then((r) => r.ok).catch(() => false));
  return imageOk.get(c.id);
}
async function pick(sorted, n) {
  const out = [];
  for (const c of sorted) { if (out.length >= n) break; if (await hasImage(c)) out.push(c); }
  return out;
}
const movers = priced.filter((c) => c.change != null && c.avg30 >= MIN_PRICE);
const data = {
  updated: Date.now(),
  sets: details.slice(0, TREND_SETS).map((s) => s.name),
  // Dyraste korten i de senaste seten.
  top: await pick([...priced].sort((a, b) => b.eur - a.eur), 24),
  // Störst ökning: 7-dagarssnittet jämfört med 30-dagarssnittet.
  rising: await pick([...movers].sort((a, b) => b.change - a.change), 24),
  falling: await pick([...movers].sort((a, b) => a.change - b.change), 12),
};
await writeFile(OUT, JSON.stringify(data, null, 1) + "\n");
console.log(`${cards.length} kort lästa från ${details.length} set. Dyrast: ${data.top[0]?.name} (${data.top[0]?.eur} €). Stiger mest: ${data.rising[0]?.name} (+${data.rising[0]?.change} %).`);
