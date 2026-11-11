// Räknar fram "trendande" och "dyraste" kort ur TCGdex (priser från Cardmarket) och sparar data/card-trends.json.
// Körs en gång per dygn (se .github/workflows/trends.yml) eller manuellt: node scripts/update-card-trends.mjs
// Läser de senaste fysiska seten kort för kort, några åt gången, så att TCGdex inte belastas i onödan.
import { writeFile, readFile, mkdir, readdir } from "node:fs/promises";

const API = "https://api.tcgdex.net/v2/en";
const OUT = new URL("../data/card-trends.json", import.meta.url);
const SETS = 10;          // så många av de senaste seten tas med (trender och prishistorik)
const OLDER_SETS = 6;     // äldre set som fylls på per körning så att alla set får priser och "Dyraste korten"
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

// Utöver de senaste seten fylls några äldre set på varje dygn (saknade först, sedan nyaste serierna/äldst uppdaterade),
// så att även Scarlet & Violet, Sword & Shield, Base Set m.fl. får priser och "Dyraste korten" på sina setsidor.
const histDir = new URL("../data/card-history/", import.meta.url);
const setsDir = new URL("../data/sets/", import.meta.url);
await mkdir(histDir, { recursive: true });
const recentIds = new Set(details.map((s) => s.id));
const localFiles = (await readdir(setsDir).catch(() => [])).filter((f) => f.endsWith(".json"));
const candidates = [];
for (const f of localFiles) {
  const s = JSON.parse(await readFile(new URL(f, setsDir), "utf8").catch(() => "null"));
  if (!s?.id || s.local || !s.cards?.length || recentIds.has(s.id) || ["tcgp", "tk", "mc"].includes(s.serie?.id)) continue;
  const h = JSON.parse(await readFile(new URL(`${encodeURIComponent(s.id)}.json`, histDir), "utf8").catch(() => "null"));
  const hasPrices = Object.keys(h?.cards || {}).length > 0;
  const updated = hasPrices ? (h.updated || 1) : 0;
  candidates.push({ s, updated });
}
candidates.sort((a, b) => (a.updated > 0) - (b.updated > 0)
  || (a.updated === 0 ? (b.s.releaseDate || "").localeCompare(a.s.releaseDate || "") : a.updated - b.updated));
const olderDetails = candidates.slice(0, OLDER_SETS).map((x) => x.s);
const allSets = [...details, ...olderDetails];

const cards = (await pool(allSets.flatMap((s) => s.cards.map((c) => c.id)), (id) => getJSON(`${API}/cards/${id}`))).filter(Boolean);

// Kurserna: euro och dollar till kronor (ECB via Frankfurter).
const rate = (await getJSON("https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK"))?.rates?.SEK;
const usdRate = (await getJSON("https://api.frankfurter.dev/v1/latest?from=USD&to=SEK"))?.rates?.SEK;

// ---------- Kort som delar Cardmarket-produkt ----------
// I nya set kopplar TCGdex ibland alla versioner av ett kort till samma Cardmarket-produkt (Delta Reign: Mega Rayquaza ex
// #084 Double rare, #138 Special illustration rare och #141 Mega Hyper Rare fick alla Double rare-kortets 4 €).
// Produkten hör då till kortet med lägst nummer. De andra får TCGplayers marknadspris, omräknat till euro, tills
// TCGdex ger dem en egen produkt. Listan sparas i data/cm-shared.json så att sajten gör samma byte för livepriserna.
const byNo = (a, b) => String(a.localId).localeCompare(String(b.localId), "en", { numeric: true });
const sharedIds = new Set();
for (const s of allSets) {
  const groups = new Map();
  for (const c of cards.filter((x) => x.set?.id === s.id)) {
    const pid = c.pricing?.cardmarket?.idProduct;
    if (pid) groups.set(pid, [...(groups.get(pid) || []), c]);
  }
  for (const g of groups.values()) if (g.length > 1) g.sort(byNo).slice(1).forEach((c) => sharedIds.add(c.id));
}
const usdToEur = (v) => (v == null || !rate || !usdRate ? null : Math.round((v * usdRate / rate) * 100) / 100);
for (const c of cards.filter((x) => sharedIds.has(x.id))) {
  const tp = Object.values(c.pricing?.tcgplayer || {}).find((v) => v && typeof v === "object" && v.marketPrice != null);
  c.pricing.cardmarket = tp ? { unit: "EUR", trend: usdToEur(tp.marketPrice), avg: usdToEur(tp.marketPrice), low: usdToEur(tp.lowPrice), fromTcgplayer: true } : {};
}

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
// Kurserna till sidorna (fxRates i js/site.js). Svarar Frankfurter inte ligger gårdagens kvar.
if (rate && usdRate) await writeFile(new URL("../data/rates.json", import.meta.url), JSON.stringify({ updated: Date.now(), EUR: rate, USD: usdRate }) + "\n");
if (rate) {
  const today = new Date().toISOString().slice(0, 10);
  const oldest = new Date(Date.now() - HISTORY_DAYS * 864e5).toISOString().slice(0, 10);
  const dir = new URL("../data/card-history/", import.meta.url);
  await mkdir(dir, { recursive: true });
  const sek = (v) => (v == null ? null : Math.round(v * rate * 100) / 100);
  for (const s of allSets) {
    const f = new URL(`${encodeURIComponent(s.id)}.json`, dir);
    let h = { cards: {} };
    try { h = JSON.parse(await readFile(f, "utf8")); } catch {}
    const wasShared = new Set(h.cmShared || []);
    for (const c of cards.filter((x) => x.set?.id === s.id)) {
      const cm = c.pricing?.cardmarket || {};
      // Historiken för ett kort som just upptäckts dela produkt är den andra versionens priser och börjar om.
      if (sharedIds.has(c.id) && !wasShared.has(c.id)) delete h.cards[c.id];
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
    const cmShared = cards.filter((c) => c.set?.id === s.id && sharedIds.has(c.id)).map((c) => c.id);
    await writeFile(f, JSON.stringify({ updated: Date.now(), set: s.name, rate, cards: h.cards, rarity, ...(cmShared.length ? { cmShared } : {}) }) + "\n");
  }
  // Alla kort med delad produkt, även i set som inte lästes i dag.
  const all = {};
  for (const f of (await readdir(dir)).filter((x) => x.endsWith(".json"))) {
    const h = JSON.parse(await readFile(new URL(f, dir), "utf8").catch(() => "null"));
    for (const id of h?.cmShared || []) all[id] = 1;
  }
  await writeFile(new URL("../data/cm-shared.json", import.meta.url), JSON.stringify(all) + "\n");
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
