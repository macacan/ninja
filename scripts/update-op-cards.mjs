// Bygger One Piece-korten till Kortpriser (priser.html?game=op) från optcgapi.com och sparar:
//   data/op/cards.json         alla kort i bantad form, som sidan söker i direkt i webbläsaren
//   data/op/history/<set>.json en punkt per kort och dag i kronor: [datum, marknadspris, lägsta i lager]
//   data/op/card-trends.json   "Trendar nu", "Dyraste i de senaste seten" och "Sjunker"
// Priserna är TCGplayers (USD), omräknade med ECB:s kurs samma dag. Cardmarket går inte att använda här:
// deras fil skiljer inte på vanlig, parallel och manga (Shanks OP01-120 finns som 15 produkter med samma namn).
// Körs en gång per dygn (se .github/workflows/trends.yml) eller manuellt: node scripts/update-op-cards.mjs
import { readFile, writeFile } from "node:fs/promises";
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
// TCGplayers produkter per grupp, hämtade en gång (används till setbilden och korten nedan)
const productCache = new Map();
const productsOf = (groupId) => {
  if (!productCache.has(groupId)) productCache.set(groupId, getJSON(`https://tcgcsv.com/tcgplayer/68/${groupId}/products`).then((r) => r?.results || []));
  return productCache.get(groupId);
};
// Setets bild (boosterbox eller starterdeck) från samma TCGplayer-grupp.
for (const s of setList) {
  if (s.group) s.image = sealedImage(await productsOf(s.group));
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
// optcgapi saknar också en del varianter (Shirahoshi EB05-014 Manga, Buggy OP09-051 Manga, Dash Pack-korten …).
// De tas med från TCGplayer, se nedan. Alla set hämtas därför från TCGplayer.
const allCards = [...setCards, ...(stCards || [])];
// Kortet hos båda: set, kortnummer och variant. Inte hela namnet, som optcgapi ibland stavar fel ("Gum-Gum Giant Rifl").
const tcgKey = (set, no, fullName) => `${set}|${no}|${splitName(fullName || "").variant || ""}`;
const tcgCards = new Map(), tcgOnly = [];
for (const set of new Set(allCards.map((c) => c.set_id))) {
  const g = groupOf.get(code(set));
  if (!g) continue;
  const [products, prices] = await Promise.all([productsOf(g.groupId), getJSON(`https://tcgcsv.com/tcgplayer/68/${g.groupId}/prices`)]);
  const price = new Map((prices?.results || []).map((x) => [x.productId, x]));
  for (const p of products) {
    const ex = Object.fromEntries((p.extendedData || []).map((e) => [e.name, e.value]));
    if (!ex.Number || !p.imageUrl) continue;
    const card = { id: `tcg${p.productId}`, image: p.imageUrl.replace(/_\d+w\.jpg$/, "_400w.jpg") };
    tcgCards.set(tcgKey(set, ex.Number, p.name), card);
    tcgOnly.push({ ...card, set, p, ex, price: price.get(p.productId) });
  }
}

// optcgapis kortnummer stämmer inte alltid: promokort i starterdecken heter "P-029_r1" (bildens id), och Buggy (Manga) i OP09
// står som OP05-067 fast bilden och TCGplayer säger OP09-051. Bildens filnamn börjar med kortnumret. Det används när
// TCGplayer har kortet (samma namn) under bildens nummer i setet men inte under optcgapis.
const tcgNames = new Map();
for (const t of tcgOnly) {
  const k = `${t.set}|${t.ex.Number}`;
  if (!tcgNames.has(k)) tcgNames.set(k, new Set());
  tcgNames.get(k).add(splitName(t.p.name).name);
}
const imageNo = (c) => c.card_image?.match(/Card_Images\/([A-Z]+\d*-\d{3})/)?.[1] || null;
const noOf = (c) => {
  const base = (c.card_set_id || "").replace(/_[pr]\d+$/i, ""), img = imageNo(c), name = splitName(c.card_name || "").name;
  const has = (no) => !!tcgNames.get(`${c.set_id}|${no}`)?.has(name);
  return img && img !== base && !has(base) && has(img) ? img : base;
};

// optcgapi har ibland laddat upp samma bildfil för flera versioner av ett kort (Shirahoshi EB05-014 och "Super Rare
// Alternate Art" är byte för byte samma bild, likaså Kaido OP17-062 och "Super Alternate Art"). Bilderna jämförs på
// filstorlek: en bild-url hos optcgapi byts aldrig ut (den har ett slumpat suffix), så storleken sparas i
// image-sizes.json och bara nya bilder behöver frågas efter. Varianterna som krockar får TCGplayers bild i stället.
const SIZES = new URL("image-sizes.json", DIR);
const sizes = await readFile(SIZES, "utf8").then(JSON.parse).catch(() => ({}));
const versions = new Map();
for (const c of allCards) if (c.card_image) {
  const k = `${c.set_id}|${noOf(c)}`;
  if (!versions.has(k)) versions.set(k, []);
  versions.get(k).push(c);
}
const toCheck = [...new Set([...versions.values()].filter((l) => l.length > 1).flat().map((c) => c.card_image))].filter((u) => !(u in sizes));
for (let i = 0; i < toCheck.length; i += 8) {
  await Promise.all(toCheck.slice(i, i + 8).map(async (u) => {
    try {
      const r = await fetch(u, { method: "HEAD", headers: { "user-agent": "LootninjaTrends/1.0" }, signal: AbortSignal.timeout(30000) });
      const n = +r.headers.get("content-length");
      if (r.ok && n) sizes[u] = n;
    } catch {}
  }));
}
const used = new Set([...versions.values()].flat().map((c) => c.card_image));
await writeFile(SIZES, JSON.stringify(Object.fromEntries(Object.entries(sizes).filter(([u]) => used.has(u)).sort())));
const sameImage = new Set();
for (const list of versions.values()) {
  const bySize = new Map();
  for (const c of list) if (sizes[c.card_image]) {
    if (!bySize.has(sizes[c.card_image])) bySize.set(sizes[c.card_image], []);
    bySize.get(sizes[c.card_image]).push(c);
  }
  for (const group of bySize.values()) {
    // Två versioner med samma namn (ingen variant) går inte att skilja åt hos TCGplayer heller
    if (new Set(group.map((c) => c.card_name)).size < 2) continue;
    // Bilden hör till versionen utan variant om det finns en sådan, annars vet vi inte vilken: alla får TCGplayers
    const plain = group.some((c) => !splitName(c.card_name || "").variant);
    for (const c of group) if (!plain || splitName(c.card_name || "").variant) sameImage.add(c);
  }
}

const seen = new Set();
const cards = allCards.map((c) => {
  const { name, variant } = splitName(c.card_name || "");
  // TCGplayers produkt sparas även när optcgapi har bilden (tcg), så att sidan känner igen kortets gamla id
  // "SET/tcg123" från tiden innan optcgapi hade kortet (valvet och bildindexet kan ha det sparat)
  const tcgHit = tcgCards.get(tcgKey(c.set_id, noOf(c), c.card_name)), tcg = c.card_image ? null : tcgHit;
  // Samma bild-id kan återkomma i flera set (återtryck) och ibland två gånger i samma set med olika namn.
  let id = `${c.set_id}/${c.card_image_id ?? tcg?.id ?? null}`;
  if (seen.has(id)) id += `~${(c.card_name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  if (seen.has(id)) return null;
  seen.add(id);
  // Bilden av ett annat kort (Basil Hawkins OP10-109 i ST-36 har Capone Beges bild OP10-103): TCGplayers bild, annars
  // ingen ("" = inte ens den gamla, se keepCards). Hellre kortbaksidan än fel kort.
  const wrong = imageNo(c) && imageNo(c) !== noOf(c);
  const image = (sameImage.has(c) || wrong) && tcgHit ? tcgHit.image : wrong ? "" : c.card_image || tcg?.image || null;
  return {
    id, name, variant, set: c.set_id, no: noOf(c), rarity: c.rarity || null,
    color: c.card_color || null, type: c.card_type || null, cost: num(c.card_cost), power: num(c.card_power),
    counter: num(c.counter_amount), life: num(c.life), attr: c.attribute || null, sub: c.sub_types || null,
    image, sek: sekOf(c.market_price ?? c.inventory_price), low: sekOf(c.inventory_price),
    tcg: tcgHit ? tcgHit.id.slice(3) : null,
  };
}).filter(Boolean);

// Kort som TCGplayer har men optcgapi saknar. optcgapi och TCGplayer namnger inte alltid varianterna lika ("SPR" mot
// "SP", "Manga" mot "Alternate Art"), så ett kort tas bara med när TCGplayer har fler versioner av numret än optcgapi
// och exakt så många saknar motsvarighet. I set där optcgapi ännu saknar bilder tas alla som saknar motsvarighet med.
const inApi = new Set(allCards.map((c) => tcgKey(c.set_id, noOf(c), c.card_name)));
const newSet = new Set(allCards.filter((c) => !c.card_image).map((c) => c.set_id));
const apiCount = new Map(), tcgCount = new Map(), missing = new Map();
for (const c of allCards) apiCount.set(`${c.set_id}|${noOf(c)}`, (apiCount.get(`${c.set_id}|${noOf(c)}`) || 0) + 1);
for (const t of tcgOnly) {
  const k = `${t.set}|${t.ex.Number}`;
  tcgCount.set(k, (tcgCount.get(k) || 0) + 1);
  if (!inApi.has(tcgKey(t.set, t.ex.Number, t.p.name))) missing.set(k, (missing.get(k) || 0) + 1);
}
for (const t of tcgOnly) {
  const id = `${t.set}/${t.id}`, k = `${t.set}|${t.ex.Number}`;
  if (seen.has(id) || inApi.has(tcgKey(t.set, t.ex.Number, t.p.name))) continue;
  if (!newSet.has(t.set) && missing.get(k) > tcgCount.get(k) - (apiCount.get(k) || 0)) continue;
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
