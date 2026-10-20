// Bygger släppkalendern data/release-calendar.json, som släppsidan läser.
//   node scripts/update-releases.mjs
// Tre källor, i den här ordningen:
//   1. data/releases.json: handskrivna släpp med produktomgångar. Vinner alltid när något krockar.
//   2. Bulbapedia (MediaWiki-API:t): set och produkter som är annonserade men inte släppta än.
//   3. TCGdex: set som redan har släppts, så att nya set kommer med även om ingen skrivit in dem.
// Faller en extern källa bort används det som gick att hämta. Resten av kalendern påverkas inte.
import { readFile, writeFile } from "node:fs/promises";
import { classify } from "./scraper/lib/classify.mjs";

const MANUAL = new URL("../data/releases.json", import.meta.url);
const OUT = new URL("../data/release-calendar.json", import.meta.url);
const UA = "NinjalootBot/1.0 (+https://playapp.tech/om.html#bot)";
const WIKI = "https://bulbapedia.bulbagarden.net/w/api.php";
const TCGDEX = "https://api.tcgdex.net/v2/en";
const RECENT_DAYS = 60; // så länge efter släppet tas ett set från TCGdex med

const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const norm = (s) => String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s) => norm(s).replace(/ /g, "-");
const typeOf = (name) => classify(`Pokémon ${name}`)?.type || null;

async function getJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20000) });
      if (r.ok) return await r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw new Error(`Gav upp: ${url}`);
}

// ---------- Bulbapedia ----------
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "November 6, 2026" → "2026-11-06". "TBD", "N/A" och bara månad ger null.
function isoDate(s) {
  const m = String(s || "").match(/([a-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  const mi = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return mi < 0 ? null : `${m[3]}-${String(mi + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}
// Wikitext till ren text: {{tt|ja|en}} → en, {{TCG|X}} → X, [[a|b]] → b, kommentarer och fetstil bort.
const clean = (v) => String(v || "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/\{\{tt\|[^|}]*\|([^}]*)\}\}/gi, "$1")
  .replace(/\{\{[^|}]*\|([^}|]*)(\|[^}]*)?\}\}/g, "$1")
  .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
  .replace(/'''?/g, "").trim();
function infobox(wikitext) {
  const box = wikitext.match(/\{\{\s*(\w*Infobox)\s*\n([\s\S]*?)\n\}\}/);
  if (!box) return null;
  const f = { kind: box[1] };
  for (const line of box[2].split("\n")) { const m = line.match(/^\|\s*([\w]+)\s*=\s*(.*)$/); if (m) f[m[1]] = m[2]; }
  return f;
}
// "'''Japanese''': September 16, 2026<br>'''English''': ..." → { en: "...", ja: "..." }
function releaseDates(v) {
  const out = {};
  const parts = String(v || "").split(/<br\s*\/?>/i);
  for (const p of parts) {
    const lang = /japanese/i.test(p) ? "ja" : /chinese|korean|thai|indonesian/i.test(p) ? null : "en";
    if (lang && !out[lang]) out[lang] = isoDate(p);
  }
  return out;
}

async function fromBulbapedia() {
  const list = await getJSON(`${WIKI}?action=query&list=embeddedin&eititle=Template:Upcoming_notice&einamespace=0&eilimit=500&format=json&formatversion=2`);
  const titles = list.query.embeddedin.map((p) => p.title).filter((t) => t.endsWith("(TCG)"));
  if (!titles.length) return { sets: [], products: [] };
  const pages = (await getJSON(`${WIKI}?action=query&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&titles=${encodeURIComponent(titles.slice(0, 50).join("|"))}`)).query.pages;
  const sets = [], products = [];
  for (const p of pages) {
    const f = infobox(p.revisions?.[0]?.slots?.main?.content || "");
    if (!f) continue;
    const url = `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(p.title.replace(/ /g, "_"))}`;
    if (f.kind === "TCGExpansionInfobox") {
      const name = clean(f.setname || f.transsetname);
      // Platshållarnamn som "FLO" (setet har inget namn än) hoppas över.
      if (!name || /^[A-Z0-9]{2,4}$/.test(name)) continue;
      const enAnnounced = !/^n\/?a$/i.test(clean(f.enrelease ?? f.release ?? ""));
      const language = enAnnounced ? "en" : "ja";
      const date = isoDate(clean(language === "en" ? f.release ?? f.enrelease : f.jarelease));
      sets.push({ set: language === "ja" ? clean(f.transsetname || name) : name, language, date, url });
    } else if (f.title) {
      const name = clean(f.title);
      const dates = releaseDates(f.release);
      const language = dates.en !== undefined ? "en" : dates.ja !== undefined ? "ja" : "en";
      products.push({ name, parent: f.expansion ? clean(f.expansion) : null, language, date: dates[language] ?? null, url });
    }
  }
  return { sets, products };
}

// Officiella expansionstabeller från Bulbapedias "List of Pokémon Trading Card Game expansions"
async function expansionListFromBulbapedia() {
  const secRes = await getJSON(`${WIKI}?action=parse&page=List_of_Pok%C3%A9mon_Trading_Card_Game_expansions&prop=sections&format=json&formatversion=2`);
  const targetSections = (secRes.parse?.sections || []).filter((s) => /Scarlet &amp; Violet|Mega Evolution/i.test(s.line));
  const list = [];
  for (const s of targetSections) {
    const r = await getJSON(`${WIKI}?action=parse&page=List_of_Pok%C3%A9mon_Trading_Card_Game_expansions&section=${s.index}&prop=wikitext&format=json&formatversion=2`);
    const rows = (r.parse?.wikitext || "").split(/\|-\s*(?:style="background:#FFF")?/);
    const series = s.line.replace(/&amp;/g, "&").replace(/\s*Series\s*$/i, "").trim();
    for (const row of rows) {
      const nameMatch = row.match(/\{\{TCG\|([^|}]+)/);
      const dateMatch = row.match(/([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/);
      if (nameMatch && dateMatch) {
        const name = nameMatch[1].trim();
        const date = isoDate(dateMatch[1]);
        if (!name || !date) continue;
        list.push({
          set: name,
          date,
          series,
          language: "en",
          url: `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(name.replace(/ /g, "_"))}_(TCG)`,
        });
      }
    }
  }
  return list;
}

// ---------- TCGdex ----------
async function fromTcgdex() {
  const list = await getJSON(`${TCGDEX}/sets?sort:field=releaseDate&sort:order=DESC&pagination:page=1&pagination:itemsPerPage=50`);
  const details = await Promise.all(list.map((s) => getJSON(`${TCGDEX}/sets/${encodeURIComponent(s.id)}`).catch(() => null)));
  return details.filter((s) => s?.releaseDate && s.serie?.id !== "tcgp");
}

// ---------- Ihopslagning ----------
const manual = JSON.parse(await readFile(MANUAL, "utf8"));
const releases = manual.releases.map((r) => ({ ...r, waves: r.waves.map((w) => ({ ...w, products: [...w.products] })) }));
const keyOf = (set, language) => `${norm(set)}|${language || "en"}`;
const find = (set, language) => releases.find((r) => keyOf(r.set, r.language) === keyOf(set, language)
  || (r.match || []).some((m) => keyOf(m, r.language) === keyOf(set, language)));
const sources = { manual: true, bulbapedia: false, tcgdex: false };

function ensure(set, language, extra = {}) {
  let r = find(set, language);
  if (!r) {
    r = { id: slug(`${set}${language !== "en" ? `-${language}` : ""}`), set, language, match: [set], auto: true, waves: [], ...extra };
    releases.push(r);
  }
  return r;
}
// Lägger till en produkt i en omgång, om setet inte redan har en produkt av samma typ eller med samma namn.
function addProduct(r, date, name, preliminary) {
  const all = r.waves.flatMap((w) => w.products);
  const t = typeOf(name);
  if (all.some((p) => norm(p) === norm(name) || (t && typeOf(p) === t && !r.auto))) return;
  let w = r.waves.find((x) => x.date === date);
  if (!w) { w = { date, products: [], auto: true, ...(preliminary ? { preliminary: true } : {}) }; r.waves.push(w); }
  w.products.push(name);
}

try {
  const { sets, products } = await fromBulbapedia();
  for (const s of sets) {
    const r = ensure(s.set, s.language, { source: s.url });
    if (!r.auto) continue; // handskrivna set har redan sina datum
    r.source ||= s.url;
    if (s.date && !r.waves.length) r.waves.push({ date: s.date, products: [], auto: true });
    if (!s.date) r.announced = true;
  }
  for (const p of products) {
    const parent = p.parent && find(p.parent, p.language);
    // Japanska fristående produkter säljs sällan i svenska butiker och tas inte med.
    if (!parent && p.language !== "en") continue;
    const r = parent || ensure(p.name, p.language, { source: p.url });
    // "Delta Reign Build & Battle Box" heter "Build & Battle Box" under Delta Reign.
    const name = parent ? p.name.replace(new RegExp(`^${parent.set.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`, "i"), "") || p.name : p.name;
    if (p.date) addProduct(r, p.date, name);
    else if (r.auto && !r.waves.length) r.announced = true;
  }
  const expSets = await expansionListFromBulbapedia().catch(() => []);
  for (const s of expSets) {
    const r = ensure(s.set, s.language, { series: s.series, source: s.url });
    if (!r.auto) continue;
    r.source ||= s.url;
    r.series ||= s.series;
    if (s.date && !r.waves.length) r.waves.push({ date: s.date, products: [], auto: true });
  }
  sources.bulbapedia = true;
} catch (e) { console.warn(`Bulbapedia: ${e.message}`); }

try {
  for (const s of await fromTcgdex()) {
    const existing = find(s.name, "en");
    if (existing) { existing.tcgdex ||= s.id; existing.series ||= s.serie?.name; continue; }
    if (s.releaseDate < daysAgo(RECENT_DAYS)) continue;
    const r = ensure(s.name, "en", { tcgdex: s.id, series: s.serie?.name });
    if (!r.waves.some((w) => w.date === s.releaseDate)) r.waves.push({ date: s.releaseDate, products: [], auto: true });
  }
  sources.tcgdex = true;
} catch (e) { console.warn(`TCGdex: ${e.message}`); }

for (const r of releases) {
  r.waves.sort((a, b) => a.date.localeCompare(b.date));
  if (r.waves.length) delete r.announced;
}
// Automatiska set utan datum och utan produkter tas bara med som "annonserade".
const out = releases.filter((r) => r.waves.length || r.announced)
  .sort((a, b) => (a.waves[0]?.date || "9999").localeCompare(b.waves[0]?.date || "9999"));

const prev = JSON.parse(await readFile(OUT, "utf8").catch(() => "{}"));
const body = { releases: out, sources };
// Spara bara om innehållet ändrats, så att det inte blir en commit varje timme i onödan.
if (JSON.stringify({ releases: prev.releases, sources: prev.sources }) !== JSON.stringify(body)) {
  await writeFile(OUT, JSON.stringify({ _info: "Byggs av scripts/update-releases.mjs. Ändra inte här, ändra i data/releases.json.", updated: Date.now(), ...body }, null, 1) + "\n");
  console.log(`Sparade ${out.length} släpp (${out.filter((r) => r.auto).length} automatiska).`);
} else console.log(`Oförändrat: ${out.length} släpp.`);
