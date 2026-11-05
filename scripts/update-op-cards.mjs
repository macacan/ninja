// Bygger One Piece-korten till Kortpriser (priser.html?game=op) från optcgapi.com och sparar:
//   data/op/cards.json         alla kort i bantad form, som sidan söker i direkt i webbläsaren
//   data/op/history/<set>.json en punkt per kort och dag i kronor: [datum, marknadspris, lägsta i lager]
//   data/op/card-trends.json   "Trendar nu", "Dyraste i de senaste seten" och "Sjunker"
// Priserna är TCGplayers (USD), omräknade med ECB:s kurs samma dag. Cardmarket går inte att använda här:
// deras fil skiljer inte på vanlig, parallel och manga (Shanks OP01-120 finns som 15 produkter med samma namn).
// Körs en gång per dygn (se .github/workflows/trends.yml) eller manuellt: node scripts/update-op-cards.mjs
import { readFile } from "node:fs/promises";
import { getJSON, saveGame, sealedImage } from "./lib/prebuilt-cards.mjs";

const API = "https://optcgapi.com/api";
const DIR = new URL("../data/op/", import.meta.url);
const TREND_SETS = 6;     // trendlistorna bygger på de nyaste boosterseten
const MIN_PRICE = 20;     // kronor: billigare kort ger brus i procentuella förändringar

const [sets, setCards, stCards, decks, fx] = await Promise.all([
  getJSON(`${API}/allSets/`), getJSON(`${API}/allSetCards/`), getJSON(`${API}/allSTCards/`), getJSON(`${API}/allDecks/`),
  getJSON("https://api.frankfurter.dev/v1/latest?from=USD&to=SEK"),
]);
const rate = fx?.rates?.SEK;
if (!sets?.length || !setCards?.length || !rate) {
  console.error("optcgapi.com eller växelkursen svarade inte, inget sparades.");
  process.exit(1);
}

// Släppdatum och setkod från TCGplayer via tcgcsv.com (kategori 68), kopplade på koden ("OP-17" = "OP17").
// Saknas de blir setet utan datum, korten påverkas inte.
const groups = (await getJSON("https://tcgcsv.com/tcgplayer/68/groups"))?.results || [];
const code = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
const groupOf = new Map(groups.map((g) => [code(g.abbreviation || ""), g]));
const dated = (id, name) => {
  const g = groupOf.get(code(id));
  // Boosterset (OP, EB, PRB) är huvudset. Starterdeck och promo visas bara i Kortpriser.
  return { id, name, code: g?.abbreviation || id, date: g?.publishedOn?.slice(0, 10) || null, main: /^(OP|EB|PRB)/.test(id), group: g?.groupId };
};

// Boosterseten kommer i släppordning från allSets, starterdecken numreras i ordning (ST-01, ST-02 …).
const deckNames = Object.fromEntries((decks || []).map((d) => [d.structure_deck_id, d.structure_deck_name]));
const setList = [
  ...[...sets].reverse().map((s) => dated(s.set_id, s.set_name)),
  ...Object.keys(deckNames).sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map((id) => dated(id, deckNames[id])),
];
// Boosterset som TCGplayer redan har men optcgapi inte lagt in än (de första dagarna efter ett släpp, eller ett set
// som snart kommer). Setet tas med utan kort och märks pending, så att setsidorna visar det med "Mer info kommer
// snart". Korten och priserna kommer när optcgapi lägger in setet, och då försvinner märkningen av sig själv.
// Grupper med event-kort ("OP18 RE", "OP13 ANN") är inga egna set och hoppas över.
const known = new Set(setList.flatMap((s) => [code(s.id), code(s.code)]));
const pending = groups.filter((g) => /^(OP|EB|PRB)\d+(-EB\d+)?$/i.test(g.abbreviation || "") && !known.has(code(g.abbreviation)))
  .map((g) => ({ id: g.abbreviation.toUpperCase().replace(/^([A-Z]+)(\d+)$/, "$1-$2"), name: g.name, code: g.abbreviation.toUpperCase(),
    date: g.publishedOn?.slice(0, 10) || null, main: true, pending: true, group: g.groupId }))
  .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
setList.unshift(...pending);
// Setets bild (boosterbox eller starterdeck) från samma TCGplayer-grupp.
for (const s of setList) {
  if (s.group) s.image = sealedImage((await getJSON(`https://tcgcsv.com/tcgplayer/68/${s.group}/products`))?.results);
  delete s.group;
}

// "Shanks (OP01-120) (Alternate Art)" → namn "Shanks", variant "Alternate Art". Nummer i parentes ("(001)",
// "(OP01-120)") säger inget som inte redan står i kortnumret och tas bort.
function splitName(full) {
  const parts = [...full.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim()).filter((p) => !/^\d{1,3}$|^[A-Z]{2,3}\d{2}-\d{3}$/.test(p));
  // Några kort heter "Buggy - OP09-051" eller "Sabo - P-073": samma sak, numret står redan i kortnumret.
  return { name: full.replace(/\s*\([^()]*\)/g, "").replace(/\s+-\s+[A-Z]{1,3}\d{0,2}-\d{3}$/, "").trim(), variant: parts.join(" · ") || null };
}
const num = (v) => (v == null || v === "" || v === "-" ? null : isNaN(+v) ? String(v) : +v);
const sekOf = (usd) => (usd == null ? null : Math.round(usd * rate * 100) / 100);

// Nya set har ofta kort men inga bilder hos optcgapi de första veckorna. Då hämtas bilden från TCGplayers produkt
// med samma kortnummer och variant (optcgapi använder TCGplayers namn, t.ex. "Nami (OP01-016) (SP)"). Produktens id blir
// då kortets id, så att två versioner av samma kort inte krockar när bild-id saknas. Bilderna av nya kort har ofta
// en SAMPLE-stämpel hos TCGplayer. optcgapis egna bilder ersätter dem automatiskt när de kommer. (One Pieces
// officiella kortbilder går inte att visa på andra sajter: Cross-Origin-Resource-Policy: same-site.)
// I sådana set saknar optcgapi också ofta några kort (t.ex. ledarna i EB05). De tas med från TCGplayer, se nedan.
const allCards = [...setCards, ...(stCards || [])];
// Kortet hos båda: set, kortnummer och variant. Inte hela namnet, som optcgapi ibland stavar fel ("Gum-Gum Giant Rifl").
const tcgKey = (set, no, fullName) => `${set}|${no}|${splitName(fullName || "").variant || ""}`;
const tcgCards = new Map(), tcgOnly = [];
// Ett set som en gång hämtats från TCGplayer fortsätter med det, annars tappar det korten som bara finns där (och deras
// priser) den dag optcgapi har bilder till alla sina kort.
const hadTcg = await readFile(new URL("cards.json", DIR), "utf8").then((t) => JSON.parse(t).cards.filter((c) => c.tcg).map((c) => c.set)).catch(() => []);
for (const set of new Set([...allCards.filter((c) => !c.card_image).map((c) => c.set_id), ...hadTcg])) {
  const g = groupOf.get(code(set));
  if (!g) continue;
  const [products, prices] = await Promise.all([
    getJSON(`https://tcgcsv.com/tcgplayer/68/${g.groupId}/products`), getJSON(`https://tcgcsv.com/tcgplayer/68/${g.groupId}/prices`)]);
  const price = new Map((prices?.results || []).map((x) => [x.productId, x]));
  for (const p of products?.results || []) {
    const ex = Object.fromEntries((p.extendedData || []).map((e) => [e.name, e.value]));
    if (!ex.Number || !p.imageUrl) continue;
    const card = { id: `tcg${p.productId}`, image: p.imageUrl.replace(/_\d+w\.jpg$/, "_400w.jpg") };
    tcgCards.set(tcgKey(set, ex.Number, p.name), card);
    tcgOnly.push({ ...card, set, p, ex, price: price.get(p.productId) });
  }
}

const seen = new Set();
const cards = allCards.map((c) => {
  const { name, variant } = splitName(c.card_name || "");
  // TCGplayers produkt sparas även när optcgapi har bilden (tcg), så att sidan känner igen kortets gamla id
  // "SET/tcg123" från tiden innan optcgapi hade kortet (valvet och bildindexet kan ha det sparat)
  const tcgHit = tcgCards.get(tcgKey(c.set_id, c.card_set_id, c.card_name)), tcg = c.card_image ? null : tcgHit;
  // Samma bild-id kan återkomma i flera set (återtryck) och ibland två gånger i samma set med olika namn.
  let id = `${c.set_id}/${c.card_image_id ?? tcg?.id ?? null}`;
  if (seen.has(id)) id += `~${(c.card_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (seen.has(id)) return null;
  seen.add(id);
  return {
    id, name, variant, set: c.set_id, no: c.card_set_id, rarity: c.rarity || null,
    color: c.card_color || null, type: c.card_type || null, cost: num(c.card_cost), power: num(c.card_power),
    counter: num(c.counter_amount), life: num(c.life), attr: c.attribute || null, sub: c.sub_types || null,
    image: c.card_image || tcg?.image || null, sek: sekOf(c.market_price ?? c.inventory_price), low: sekOf(c.inventory_price),
    tcg: tcgHit ? tcgHit.id.slice(3) : null,
  };
}).filter(Boolean);

// Kort som TCGplayer har men optcgapi saknar (samma nummer och variant), i seten som hämtas från TCGplayer ovan
const inApi = new Set(allCards.map((c) => tcgKey(c.set_id, c.card_set_id, c.card_name)));
for (const t of tcgOnly) {
  const id = `${t.set}/${t.id}`;
  if (seen.has(id) || inApi.has(tcgKey(t.set, t.ex.Number, t.p.name))) continue;
  seen.add(id);
  const { name, variant } = splitName(t.p.name);
  cards.push({
    id, name, variant, set: t.set, no: t.ex.Number, rarity: t.ex.Rarity || null,
    color: t.ex.Color?.replace(/;/g, " ") || null, type: t.ex.CardType || null, cost: num(t.ex.Cost), power: num(t.ex.Power),
    counter: num(t.ex.Counterplus), life: num(t.ex.Life), attr: t.ex.Attribute || null, sub: t.ex.Subtypes || null,
    image: t.image, sek: sekOf(t.price?.marketPrice ?? t.price?.lowPrice), low: sekOf(t.price?.lowPrice),
    tcg: String(t.p.productId),
  });
}

// optcgapi kan ha korten innan setet står i deras setlista: då är setet inte längre väntande
const withCards = new Set(cards.map((c) => c.set));
for (const s of setList) if (s.pending && withCards.has(s.id)) delete s.pending;

const ORDER = [["L", "Leader"], ["C", "Common"], ["UC", "Uncommon"], ["R", "Rare"], ["SR", "Super Rare"], ["SEC", "Secret Rare"], ["TR", "Treasure Rare"], ["P", "Promo"], ["PR", "Promo (PR)"]];
const present = new Set(cards.map((c) => c.rarity));
const data = await saveGame({
  dir: DIR, sets: setList, cards, rate, minPrice: MIN_PRICE,
  rarities: ORDER.filter(([k]) => present.has(k)),
  trendSets: setList.filter((s) => !s.id.startsWith("ST-") && !s.pending).slice(0, TREND_SETS).map((s) => s.id),
});
console.log(`${cards.length} One Piece-kort från ${setList.length} set. Dyrast: ${data.top[0]?.name} (${data.top[0]?.sek} kr). ${data.movers ? `Stiger mest: ${data.rising[0]?.name} (+${data.rising[0]?.change} %).` : "Ingen trend än, historiken är för kort."}`);
