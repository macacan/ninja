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

// Setets bild till startsidan och set-sidan: boosterboxen ur TCGplayers produkter (tcgcsv.com), annars ett boosterpaket,
// annars första förseglade produkten (starterdeck). DON!!-kort och lådor med flera boxar (Case) räknas inte.
export function sealedImage(products) {
  const sealed = (products || []).filter((p) => p.imageUrl && !p.extendedData?.some((e) => e.name === "Number") && !/DON!!|case|event|kit/i.test(p.name));
  const p = sealed.find((x) => /booster (box|display)$|edition box$/i.test(x.name)) || sealed.find((x) => /booster pack$|edition pack$/i.test(x.name)) || sealed[0];
  return p?.imageUrl.replace("_200w", "_400w") || null;
}

// Ett kort som en gång lagts in ska finnas kvar med samma id, oavsett vad källorna gör. Id:t ligger sparat i valv, prishistorik
// och skannerns bildindex, och en källa kan byta id eller tappa kort (EB05 tappade sina TCGplayer-kort och 19 id den dag
// optcgapi fick alla bilder). Kort matchas på set, nummer och variant. De som inte kom med i dag behåller sitt senaste
// pris, märks stale och får inga nya punkter i historiken. Samma sak med ett set som fallit ur källans lista.
async function keepCards(dir, cards, sets) {
  let prev;
  try { prev = JSON.parse(await readFile(new URL("cards.json", dir), "utf8")); } catch { return; }
  const key = (c) => `${c.set}|${c.no}|${c.variant || ""}`;
  const old = new Map();
  for (const c of prev.cards) { if (!old.has(key(c))) old.set(key(c), []); old.get(key(c)).push(c); }
  const inherit = (c, p) => {
    c.id = p.id;
    c.image ||= p.image;
    c.sek ??= p.sek;
    c.low ??= p.low;
    if (p.tcg != null) c.tcg ??= p.tcg;
  };
  // Först korten som har kvar sitt id, så att två kort med samma nyckel inte byter id med varandra
  const moved = cards.filter((c) => {
    const list = old.get(key(c)), i = list?.findIndex((p) => p.id === c.id) ?? -1;
    if (i < 0) return true;
    inherit(c, list.splice(i, 1)[0]);
    return false;
  });
  for (const c of moved) {
    const p = old.get(key(c))?.shift();
    if (p) inherit(c, p);
  }
  const left = [...old.values()].flat();
  cards.push(...left.map((p) => ({ ...p, stale: true })));
  // Ett helt nytt kort kan ha fått ett id som ett äldre kort redan har
  const used = new Set();
  for (const c of cards) {
    while (used.has(c.id)) c.id += "~";
    used.add(c.id);
  }
  const ids = new Set(sets.map((s) => s.id));
  sets.push(...prev.sets.filter((s) => !ids.has(s.id) && left.some((c) => c.set === s.id)));
  const fresh = left.filter((p) => !p.stale);
  if (fresh.length) console.warn(`::warning::${fresh.length} kort saknas hos källan och behölls med senaste priset: ${fresh.slice(0, 20).map((c) => `${c.no} ${c.name}`).join(", ")}`);
}

// dir: URL till spelets mapp. sets: [{ id, name }], nyaste först. cards: { id, name, set (set-id), image, sek, low, … }.
// trendSets: set-id:n som trendlistorna bygger på. minPrice: kronor, billigare kort ger brus i procent.
export async function saveGame({ dir, sets, cards, rarities, trendSets, minPrice = 20, rate }) {
  await keepCards(dir, cards, sets);
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
      if (c.sek == null || c.stale) continue;
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
  // Setlistan för startsidan och set-sidan, utan korten: datum, kod, antal kort och om det är ett huvudset.
  const count = {};
  for (const c of cards) count[c.set] = (count[c.set] || 0) + 1;
  // Set utan kort tas bara med när de väntar på sin kortlista (pending, se update-op-cards.mjs)
  const setRows = sets.filter((s) => count[s.id] || s.pending).map((s) => ({ ...s, count: count[s.id] || 0 }))
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  await writeFile(new URL("sets.json", dir), JSON.stringify({ updated: Date.now(), sets: setRows }, null, 1) + "\n");
  // Bara kortnamnen, små nog för startsidans sökruta som avgör vilket spel en sökning gäller (js/game-guess.js).
  const names = [...new Set(cards.map((c) => c.name.toLowerCase()))].sort();
  await writeFile(new URL("names.json", dir), JSON.stringify(names) + "\n");

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
