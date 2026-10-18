// Fyller i setloggor som TCGdex saknar, med loggor från Pokémon TCG API (pokemontcg.io).
// Skriver data/set-logos.json: { "<tcgdex-set-id>": "<logga-url>" }. Körs med: node scripts/update-set-logos.mjs
import { writeFile, readFile } from "node:fs/promises";

const OUT = new URL("../data/set-logos.json", import.meta.url);
const tokens = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 2000 * (i + 1))); // pokemontcg.io svarar ibland 502, försök igen
  }
  throw new Error(`Gav upp: ${url}`);
}

const brief = await getJSON("https://api.tcgdex.net/v2/en/sets");
const missing = brief.filter((s) => !s.logo);
const ptcg = (await getJSON("https://api.pokemontcg.io/v2/sets?pageSize=250&select=id,name,releaseDate,images")).data;

// TCGdex-namn saknar releasedatum i listan, så vi hämtar det per set för att kunna skilja liknande namn åt.
const out = JSON.parse(await readFile(OUT, "utf8").catch(() => "{}"));
for (const s of missing) {
  const detail = await getJSON(`https://api.tcgdex.net/v2/en/sets/${s.id}`).catch(() => null);
  const want = tokens(s.name), date = detail?.releaseDate?.replace(/-/g, "/");
  // Alla ord i TCGdex-namnet ska finnas i det andra namnet. Vid flera träffar vinner samma releasedatum, sedan kortast namn.
  const cands = ptcg.filter((p) => p.images?.logo && want.every((w) => tokens(p.name).includes(w)));
  const best = cands.sort((a, b) => (b.releaseDate === date) - (a.releaseDate === date) || a.name.length - b.name.length)[0];
  if (best && (best.releaseDate === date || cands.length === 1)) out[s.id] = best.images.logo;
}
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`${Object.keys(out).length} extra loggor av ${missing.length} set utan logga hos TCGdex.`);
