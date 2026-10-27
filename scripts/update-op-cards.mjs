// Bygger One Piece-korten till Kortpriser (priser.html?game=op) från optcgapi.com och sparar:
//   data/op/cards.json         alla kort i bantad form, som sidan söker i direkt i webbläsaren
//   data/op/history/<set>.json en punkt per kort och dag i kronor: [datum, marknadspris, lägsta i lager]
//   data/op/card-trends.json   "Trendar nu", "Dyraste i de senaste seten" och "Sjunker"
// Priserna är TCGplayers (USD), omräknade med ECB:s kurs samma dag. Cardmarket går inte att använda här:
// deras fil skiljer inte på vanlig, parallel och manga (Shanks OP01-120 finns som 15 produkter med samma namn).
// Körs en gång per dygn (se .github/workflows/trends.yml) eller manuellt: node scripts/update-op-cards.mjs
import { getJSON, saveGame } from "./lib/prebuilt-cards.mjs";

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

// Boosterseten kommer i släppordning från allSets, starterdecken numreras i ordning (ST-01, ST-02 …).
const deckNames = Object.fromEntries((decks || []).map((d) => [d.structure_deck_id, d.structure_deck_name]));
const setList = [
  ...[...sets].reverse().map((s) => ({ id: s.set_id, name: s.set_name })),
  ...Object.keys(deckNames).sort((a, b) => b.localeCompare(a, "en", { numeric: true })).map((id) => ({ id, name: deckNames[id] })),
];

// "Shanks (OP01-120) (Alternate Art)" → namn "Shanks", variant "Alternate Art". Nummer i parentes ("(001)",
// "(OP01-120)") säger inget som inte redan står i kortnumret och tas bort.
function splitName(full) {
  const parts = [...full.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim()).filter((p) => !/^\d{1,3}$|^[A-Z]{2,3}\d{2}-\d{3}$/.test(p));
  // Några kort heter "Buggy - OP09-051" eller "Sabo - P-073": samma sak, numret står redan i kortnumret.
  return { name: full.replace(/\s*\([^()]*\)/g, "").replace(/\s+-\s+[A-Z]{1,3}\d{0,2}-\d{3}$/, "").trim(), variant: parts.join(" · ") || null };
}
const num = (v) => (v == null || v === "" || v === "-" ? null : isNaN(+v) ? String(v) : +v);
const sekOf = (usd) => (usd == null ? null : Math.round(usd * rate * 100) / 100);

const seen = new Set();
const cards = [...setCards, ...(stCards || [])].map((c) => {
  const { name, variant } = splitName(c.card_name || "");
  // Samma bild-id kan återkomma i flera set (återtryck) och ibland två gånger i samma set med olika namn.
  let id = `${c.set_id}/${c.card_image_id}`;
  if (seen.has(id)) id += `~${(c.card_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (seen.has(id)) return null;
  seen.add(id);
  return {
    id, name, variant, set: c.set_id, no: c.card_set_id, rarity: c.rarity || null,
    color: c.card_color || null, type: c.card_type || null, cost: num(c.card_cost), power: num(c.card_power),
    counter: num(c.counter_amount), life: num(c.life), attr: c.attribute || null, sub: c.sub_types || null,
    image: c.card_image || null, sek: sekOf(c.market_price ?? c.inventory_price), low: sekOf(c.inventory_price),
  };
}).filter(Boolean);

const ORDER = [["L", "Leader"], ["C", "Common"], ["UC", "Uncommon"], ["R", "Rare"], ["SR", "Super Rare"], ["SEC", "Secret Rare"], ["TR", "Treasure Rare"], ["P", "Promo"], ["PR", "Promo (PR)"]];
const present = new Set(cards.map((c) => c.rarity));
const data = await saveGame({
  dir: DIR, sets: setList, cards, rate, minPrice: MIN_PRICE,
  rarities: ORDER.filter(([k]) => present.has(k)),
  trendSets: setList.filter((s) => !s.id.startsWith("ST-")).slice(0, TREND_SETS).map((s) => s.id),
});
console.log(`${cards.length} One Piece-kort från ${setList.length} set. Dyrast: ${data.top[0]?.name} (${data.top[0]?.sek} kr). ${data.movers ? `Stiger mest: ${data.rising[0]?.name} (+${data.rising[0]?.change} %).` : "Ingen trend än, historiken är för kort."}`);
