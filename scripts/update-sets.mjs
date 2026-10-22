// Hämtar alla fysiska set och deras kortlistor från TCGdex till data/sets/<set-id>.json, som setsidorna byggs av
// (scripts/build-set-pages.mjs). Körs en gång per dygn i .github/workflows/trends.yml, eller: node scripts/update-sets.mjs
// Gamla set ändras inte, så de hämtas bara en gång. Set från de senaste 120 dagarna, set utan datum och set där
// antalet kort ändrats hämtas om varje gång.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const API = "https://api.tcgdex.net/v2/en";
const DIR = new URL("../data/sets/", import.meta.url);
const FRESH_DAYS = 120;
const CONCURRENCY = 4;

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "LootninjaSets/1.0" }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}

async function pool(items, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (i < items.length) await fn(items[i++]); }));
}

const list = await getJSON(`${API}/sets`);
if (!list?.length) throw new Error("TCGdex svarade inte med någon setlista");
await mkdir(DIR, { recursive: true });

const fresh = new Date(Date.now() - FRESH_DAYS * 864e5).toISOString().slice(0, 10);
let fetched = 0, kept = 0, skipped = 0;
await pool(list, async (brief) => {
  const file = new URL(`${encodeURIComponent(brief.id)}.json`, DIR);
  const old = JSON.parse(await readFile(file, "utf8").catch(() => "null"));
  if (old && old.releaseDate && old.releaseDate < fresh && old.cardCount?.total === brief.cardCount?.total) { kept++; return; }
  const s = await getJSON(`${API}/sets/${encodeURIComponent(brief.id)}`);
  // TCG Pocket är ett mobilspel utan kort i butik.
  if (!s || s.serie?.id === "tcgp" || !s.cards?.length) { skipped++; return; }
  const out = {
    id: s.id, name: s.name, serie: s.serie ? { id: s.serie.id, name: s.serie.name } : null,
    releaseDate: s.releaseDate || null, cardCount: { official: s.cardCount?.official ?? null, total: s.cardCount?.total ?? s.cards.length },
    logo: s.logo ? `${s.logo}.webp` : null, symbol: s.symbol ? `${s.symbol}.webp` : null,
    cards: s.cards.map((c) => ({ id: c.id, localId: c.localId, name: c.name, image: c.image || null })),
  };
  await writeFile(file, JSON.stringify(out) + "\n");
  fetched++;
});
console.log(`${list.length} set hos TCGdex: ${fetched} hämtade, ${kept} oförändrade, ${skipped} hoppade över (TCG Pocket eller tomma).`);
