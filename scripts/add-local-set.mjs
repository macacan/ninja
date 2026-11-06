// Lägger in ett nytt Pokémonset som TCGdex inte har än, så att setsidan kan visa korten från släppdagen.
//   node scripts/add-local-set.mjs <tcgdex-id> <tcgplayer-grupp> <scrydex-id> <serie-id> "<serie>" <släppdatum>
//   node scripts/add-local-set.mjs me06 24831 me6 me "Mega Evolution" 2026-11-06
// Kortlistan kommer från TCGplayer via tcgcsv.com och bilderna från Scrydex (scrydex.com/docs, "Images"). Scriptet
// jämför namnen på varje nummer mot Scrydex setsida och avbryter vid skillnader: Scrydex svarar "finns" även för fel kort.
// Skriver data/sets/<id>.json (local: true) och kortbilderna i data/card-images.json. När TCGdex får setet skriver
// scripts/update-sets.mjs över filen med samma id, och då fungerar värdering och Kortpriser som för andra set.
// Scrydex setadress gissas från namnet: /pokemon/expansions/<set-namn>/<scrydex-id>.
import { readFile, writeFile } from "node:fs/promises";

const [id, group, scrydex, serieId, serieName, releaseDate] = process.argv.slice(2);
if (!releaseDate) throw new Error("Saknar argument, se början av filen.");
const ROOT = new URL("../", import.meta.url);
const UA = { "user-agent": "Mozilla/5.0 (compatible; LootninjaSets/1.0)" };
const get = async (url) => {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
};

const [groups, products] = await Promise.all([get("https://tcgcsv.com/tcgplayer/3/groups"), get(`https://tcgcsv.com/tcgplayer/3/${group}/products`)].map((p) => p.then((r) => r.json())));
const name = groups.results.find((g) => String(g.groupId) === group)?.name.replace(/^[^:]+:\s*/, "");
if (!name) throw new Error(`Hittade inte grupp ${group} hos tcgcsv`);
const field = (p, k) => p.extendedData?.find((e) => e.name === k)?.value;
const rows = products.results.filter((p) => field(p, "Number")).map((p) => {
  const [no, official] = field(p, "Number").split("/");
  return { no, official: +official, name: p.name.replace(/\s+-\s+\d+\/\d+/, ""), rarity: field(p, "Rarity") || null };
}).sort((a, b) => +a.no - +b.no);

// Namnen hos Scrydex, nummer för nummer.
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
const html = await get(`https://scrydex.com/pokemon/expansions/${slug}/${scrydex}`).then((r) => r.text());
const named = new Map([...html.matchAll(new RegExp(`${scrydex}-(\\d+)/small"[^>]*>.*?<span[^>]*>([^<]+)</span><span[^>]*>#\\d+`, "gs"))].map((m) => [+m[1], m[2].replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&").trim()]));
// TCGplayer förkortar en del ("Nidoran F", "Bubbly W Energy"), så första ordet jämförs och Scrydex stavning används.
const first = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").split(/[\s♀♂]/)[0];
const wrong = rows.filter((c) => first(named.get(+c.no) || "") !== first(c.name));
if (wrong.length) throw new Error(`Namnen skiljer sig:\n${wrong.map((c) => `${c.no}: ${c.name} / ${named.get(+c.no)}`).join("\n")}`);

// Kort i två delar heter likadant hos Scrydex, så vänster och höger behålls från TCGplayer.
const cards = rows.map((c) => ({ id: `${id}-${c.no}`, localId: c.no, name: `${named.get(+c.no)}${c.name.match(/ \((Left|Right)\)$/)?.[0] || ""}`, image: null, rarity: c.rarity }));
await writeFile(new URL(`data/sets/${encodeURIComponent(id)}.json`, ROOT), JSON.stringify({
  id, name, serie: { id: serieId, name: serieName }, releaseDate, local: true,
  cardCount: { official: rows[0].official, total: rows.length }, logo: null, symbol: null, cards,
}) + "\n");

const imagesFile = new URL("data/card-images.json", ROOT);
const images = JSON.parse(await readFile(imagesFile, "utf8"));
for (const c of rows) images[`${id}-${c.no}`] = { low: `https://images.scrydex.com/pokemon/${scrydex}-${+c.no}/small`, high: `https://images.scrydex.com/pokemon/${scrydex}-${+c.no}/large` };
await writeFile(imagesFile, JSON.stringify(images, null, 1) + "\n");
console.log(`${name}: ${cards.length} kort (${rows[0].official} i huvudnumreringen), alla namn stämmer mot Scrydex.`);
