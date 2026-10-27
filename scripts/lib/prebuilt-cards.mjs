// Gemensamt för kortspelen som Kortpriser läser ur färdigbyggda filer (One Piece, Riftbound):
// egen prishistorik per set, trend (snittet senaste veckan mot månaden) och trendlistorna.
// Varje spel får en mapp i data/ med cards.json, card-trends.json och history/<set>.json.
import { writeFile, readFile, mkdir } from "node:fs/promises";

const HISTORY_DAYS = 400;
const MIN_DAYS = 7;       // så många dagars egen historik krävs innan ett kort får en trend

export async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "LootninjaTrends/1.0" }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  return null;
}

// dir: URL till spelets mapp. sets: [{ id, name }], nyaste först. cards: { id, name, set (set-id), image, sek, low, … }.
// trendSets: set-id:n som trendlistorna bygger på. minPrice: kronor, billigare kort ger brus i procent.
export async function saveGame({ dir, sets, cards, rarities, trendSets, minPrice = 20, rate }) {
  const setName = Object.fromEntries(sets.map((s) => [s.id, s.name]));
  const day = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const today = day(0), oldest = day(HISTORY_DAYS), weekAgo = day(7), monthAgo = day(30);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  await mkdir(new URL("history/", dir), { recursive: true });
  for (const set of new Set(cards.map((c) => c.set))) {
    const f = new URL(`history/${encodeURIComponent(set)}.json`, dir);
    let h = { cards: {} };
    try { h = JSON.parse(await readFile(f, "utf8")); } catch {}
    for (const c of cards.filter((x) => x.set === set)) {
      if (c.sek == null) continue;
      const pts = (h.cards[c.id] ||= []);
      const point = [today, c.sek, c.low ?? null];
      if (pts.at(-1)?.[0] === today) pts[pts.length - 1] = point; else pts.push(point);
      while (pts.length && pts[0][0] < oldest) pts.shift();
      if (pts.length >= MIN_DAYS) {
        const month = pts.filter((p) => p[0] >= monthAgo).map((p) => p[1]);
        const week = pts.filter((p) => p[0] >= weekAgo).map((p) => p[1]);
        if (month.length >= MIN_DAYS && week.length) {
          c.avg30 = Math.round(avg(month) * 100) / 100;
          c.change = Math.round((avg(week) / avg(month) - 1) * 1000) / 10;
        }
      }
    }
    await writeFile(f, JSON.stringify({ updated: Date.now(), set: setName[set] || set, rate, cards: h.cards }) + "\n");
  }

  await writeFile(new URL("cards.json", dir), JSON.stringify({ updated: Date.now(), rate, sets, rarities, cards }) + "\n");

  const inTrend = new Set(trendSets);
  const priced = cards.filter((c) => inTrend.has(c.set) && c.sek != null && c.image).map((c) => ({ ...c, set: setName[c.set], setId: c.set }));
  const imageOk = new Map();
  const hasImage = (c) => {
    if (!imageOk.has(c.image)) imageOk.set(c.image, fetch(c.image, { method: "HEAD", signal: AbortSignal.timeout(10000) }).then((r) => r.ok).catch(() => false));
    return imageOk.get(c.image);
  };
  const pick = async (sorted, n) => {
    const out = [];
    for (const c of sorted) { if (out.length >= n) break; if (await hasImage(c)) out.push(c); }
    return out;
  };
  const movers = priced.filter((c) => c.change != null && c.avg30 >= minPrice);
  const data = {
    updated: Date.now(),
    sets: trendSets.map((id) => setName[id]),
    top: await pick([...priced].sort((a, b) => b.sek - a.sek), 24),
    rising: await pick([...movers].sort((a, b) => b.change - a.change), 24),
    falling: await pick([...movers].sort((a, b) => a.change - b.change), 12),
  };
  await writeFile(new URL("card-trends.json", dir), JSON.stringify(data, null, 1) + "\n");
  return { ...data, movers: movers.length };
}
