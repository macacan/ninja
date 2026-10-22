// Fyller i setloggor som TCGdex saknar, med loggor från Pokémon TCG API (pokemontcg.io) och, för kommande släpp,
// Bulbapedia.
// Skriver data/set-logos.json: { "<tcgdex-set-id>": "<logga-url>" }. Körs med: node scripts/update-set-logos.mjs
import { writeFile, readFile, mkdir } from "node:fs/promises";

const OUT = new URL("../data/set-logos.json", import.meta.url);
// Set vars namn skiljer sig för mycket för att matchas automatiskt: TCGdex-id → Pokémon TCG API-id.
const ALIAS = { sve: "sve", svp: "svp", exu: "ex10" };
const tokens = (s) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);

const UA = "PackninjaBot/1.0 (+https://lootninja.se/om.html#bot)"; // samma som släppkalendern (update-releases.mjs)

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 2000 * (i + 1))); // pokemontcg.io svarar ibland 502, försök igen
  }
  throw new Error(`Gav upp: ${url}`);
}

const brief = await getJSON("https://api.tcgdex.net/v2/en/sets");
const missing = brief.filter((s) => !s.logo);
// Svarar pokemontcg.io inte fortsätter vi ändå, så att Bulbapedia-delen för kommande släpp körs.
const ptcg = (await getJSON("https://api.pokemontcg.io/v2/sets?pageSize=250&select=id,name,releaseDate,images").catch(() => null))?.data || [];

// TCGdex-namn saknar releasedatum i listan, så vi hämtar det per set för att kunna skilja liknande namn åt.
const out = JSON.parse(await readFile(OUT, "utf8").catch(() => "{}"));
for (const s of missing) {
  const detail = await getJSON(`https://api.tcgdex.net/v2/en/sets/${s.id}`).catch(() => null);
  const want = tokens(s.name), date = detail?.releaseDate?.replace(/-/g, "/");
  // Alla ord i TCGdex-namnet ska finnas i det andra namnet. Vid flera träffar vinner samma releasedatum, sedan kortast namn.
  const cands = ptcg.filter((p) => p.images?.logo && want.every((w) => tokens(p.name).includes(w)));
  if (ALIAS[s.id]) { const a = ptcg.find((p) => p.id === ALIAS[s.id]); if (a?.images?.logo) out[s.id] = a.images.logo; continue; }
  const best = cands.sort((a, b) => (b.releaseDate === date) - (a.releaseDate === date) || a.name.length - b.name.length)[0];
  if (best && (best.releaseDate === date || cands.length === 1)) out[s.id] = best.images.logo;
}
// Kommande släpp som TCGdex inte har än (data/release-calendar.json): loggan så fort Pokémon TCG API har ett set
// med exakt samma namn. Sparas under släppets id. Japanska och andra språk finns inte där.
const calendar = JSON.parse(await readFile(new URL("../data/release-calendar.json", import.meta.url), "utf8").catch(() => "{}")).releases || [];
for (const r of calendar) {
  if (r.tcgdex || r.logo || out[r.id] || (r.language || "en") !== "en") continue;
  const hit = ptcg.find((p) => p.images?.logo && tokens(p.name).join(" ") === tokens(r.set).join(" "));
  if (hit) out[r.id] = hit.images.logo;
}

// Det som är kvar: setsidans huvudbild på Bulbapedia ("<set> (TCG)"), som är loggan, även för japanska set. Bara
// filer med "logo" i namnet godtas, så att en produkt- eller boosterbild aldrig blir logga. Bilden sparas hos oss
// (img/set-logos/) i stället för att länkas, så att Bulbapedias server inte belastas av våra besökare.
const left = calendar.filter((r) => !r.tcgdex && !r.logo && !out[r.id]);
if (left.length) {
  const titles = left.map((r) => `${r.set} (TCG)`);
  const q = await getJSON(`https://bulbapedia.bulbagarden.net/w/api.php?action=query&format=json&formatversion=2&prop=pageimages&piprop=original&redirects=1&titles=${encodeURIComponent(titles.join("|"))}`).catch(() => null);
  const byTitle = new Map(titles.map((t, i) => [t, left[i]]));
  for (const n of [...(q?.query?.normalized || []), ...(q?.query?.redirects || [])]) if (byTitle.has(n.from)) byTitle.set(n.to, byTitle.get(n.from));
  for (const page of q?.query?.pages || []) {
    const r = byTitle.get(page.title), src = page.original?.source;
    if (!r || !src || !/logo/i.test(decodeURIComponent(src.split("/").pop()))) continue;
    try {
      const img = await fetch(src, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30000) });
      const ext = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg", "image/svg+xml": "svg" }[img.headers.get("content-type")?.split(";")[0]];
      if (!img.ok || !ext) continue;
      await mkdir(new URL("../img/set-logos/", import.meta.url), { recursive: true });
      await writeFile(new URL(`../img/set-logos/${r.id}.${ext}`, import.meta.url), Buffer.from(await img.arrayBuffer()));
      out[r.id] = `img/set-logos/${r.id}.${ext}`;
    } catch {}
  }
}
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`${Object.keys(out).length} extra loggor av ${missing.length} set utan logga hos TCGdex.`);
