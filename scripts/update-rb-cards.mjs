// Bygger Riftbound-korten till Kortpriser (priser.html?game=rb) och sparar dem i data/rb/ (se lib/prebuilt-cards.mjs).
// Kort och priser kommer från TCGplayer via tcgcsv.com (kategori 89), som har alla set, även de nyaste.
// Riots egna, skarpare kortbilder hämtas från Riftcodex (api.riftcodex.com) där kortet finns där, kopplat på TCGplayer-id,
// och annars från Riots kortgalleri, kopplat på set och kortnummer. Sist används TCGplayers bild.
// Priserna är TCGplayers (USD), omräknade med ECB:s kurs samma dag.
// Körs en gång per dygn (se .github/workflows/trends.yml) eller manuellt: node scripts/update-rb-cards.mjs
import { getJSON, saveGame, sealedImage } from "./lib/prebuilt-cards.mjs";

const TCG = "https://tcgcsv.com/tcgplayer/89";
const DIR = new URL("../data/rb/", import.meta.url);
const TREND_SETS = 4;     // trendlistorna bygger på de nyaste huvudseten
const MAIN_SET = 150;     // så många kort krävs för att ett set ska räknas som huvudset (inte promo eller bundle)
const MIN_PRICE = 10;

const [groups, fx] = await Promise.all([getJSON(`${TCG}/groups`), getJSON("https://api.frankfurter.dev/v1/latest?from=USD&to=SEK")]);
const rate = fx?.rates?.SEK;
if (!groups?.results?.length || !rate) {
  console.error("tcgcsv.com eller växelkursen svarade inte, inget sparades.");
  process.exit(1);
}

// Riots bilder från Riftcodex, sida för sida. Saknas de används TCGplayers bild.
const riot = new Map();
for (let page = 1; page < 100; page++) {
  const d = await getJSON(`https://api.riftcodex.com/cards?size=100&page=${page}`);
  for (const c of d?.items || []) if (c.tcgplayer_id && c.media?.image_url) riot.set(String(c.tcgplayer_id), c.media.image_url);
  if (!d || page >= d.pages) break;
}

// Riots officiella kortgalleri (riftbound.leagueoflegends.com/card-gallery) har nya set och Signature-kort som
// Riftcodex ännu inte kopplat till TCGplayer. Kopplas på setets namn och kortnumret ("RAD-173*/167" → "radiance|173*/167").
const RIOT = "https://content.publishing.riotgames.com/publishing-content/v2.0/public/channel/riftbound_website/list/riftbound_gallery_cards?locale=en_US";
const cardKey = (set, no) => `${set.toLowerCase().replace(/^origins: /, "")}|${String(no).replace(/^0+(?=\d)/, "")}`;
const gallery = new Map();
for (let from = 0; from < 10000; from += 200) {
  const d = await getJSON(`${RIOT}&from=${from}&limit=200`);
  for (const c of d?.data || []) {
    const no = c.publicCode?.split("-").slice(1).join("-"), url = c.cardImage?.url;
    if (no && url && c.set?.value?.label) gallery.set(cardKey(c.set.value.label, no), url);
  }
  if (!d?.data?.length || !d.linkdata?.next) break;
}

const ext = (p, name) => p.extendedData?.find((e) => e.name === name)?.value ?? null;
const num = (v) => (v == null || v === "" ? null : isNaN(+v) ? String(v) : +v);
const sekOf = (usd) => (usd == null ? null : Math.round(usd * rate * 100) / 100);
// "Jinx, Demolitionist (Alternate Art)" → namn "Jinx, Demolitionist", variant "Alternate Art".
const splitName = (full) => ({
  name: full.replace(/\s*\([^()]*\)/g, "").trim(),
  variant: [...full.matchAll(/\(([^()]*)\)/g)].map((m) => m[1].trim()).join(" · ") || null,
});

const sets = [], cards = [];
for (const g of [...groups.results].sort((a, b) => (b.publishedOn || "").localeCompare(a.publishedOn || ""))) {
  const [products, prices] = await Promise.all([getJSON(`${TCG}/${g.groupId}/products`), getJSON(`${TCG}/${g.groupId}/prices`)]);
  // Bara lösa kort, de har ett kortnummer. Boxar, booster och deck saknar det.
  const singles = (products?.results || []).filter((p) => ext(p, "Number"));
  if (!singles.length) continue;
  const id = String(g.groupId);
  sets.push({ id, name: g.name, code: g.abbreviation || null, date: g.publishedOn?.slice(0, 10) || null, main: singles.length >= MAIN_SET && !/promo/i.test(g.name), image: sealedImage(products?.results) });
  // Ett kort kan ha pris både som vanligt och som foil. Vanligt pris visas i första hand.
  const price = {};
  for (const p of prices?.results || []) (price[p.productId] ||= {})[p.subTypeName] = p;
  for (const p of singles) {
    const pr = price[p.productId] || {}, main = pr.Normal?.marketPrice != null ? pr.Normal : pr.Foil || pr.Normal || {};
    const { name, variant } = splitName(p.name);
    cards.push({
      id: String(p.productId), name, variant, set: id, no: ext(p, "Number"), rarity: ext(p, "Rarity"),
      type: ext(p, "Card Type"), domain: ext(p, "Domain"), energy: num(ext(p, "Energy Cost")), power: num(ext(p, "Power Cost")),
      might: num(ext(p, "Might")), tags: ext(p, "Tag")?.replace(/;/g, ", ") || null,
      image: riot.get(String(p.productId)) || gallery.get(cardKey(g.name, ext(p, "Number"))) || p.imageUrl?.replace("_200w", "_400w") || null,
      sek: sekOf(main.marketPrice ?? main.midPrice), low: sekOf(main.lowPrice),
      foil: main === pr.Foil ? null : sekOf(pr.Foil?.marketPrice),
    });
  }
}

const ORDER = ["Common", "Uncommon", "Rare", "Epic", "Showcase", "Promo"];
const present = [...new Set(cards.map((c) => c.rarity).filter((r) => r && r !== "None"))].sort((a, b) => ((ORDER.indexOf(a) + 1) || 99) - ((ORDER.indexOf(b) + 1) || 99));
const data = await saveGame({
  dir: DIR, sets, cards, rate, minPrice: MIN_PRICE,
  rarities: present.map((r) => [r, r]),
  trendSets: sets.filter((s) => s.main).slice(0, TREND_SETS).map((s) => s.id),
});
console.log(`${cards.length} Riftbound-kort från ${sets.length} set (${riot.size} med Riots bild via Riftcodex, ${gallery.size} i Riots galleri). Dyrast: ${data.top[0]?.name} (${data.top[0]?.sek} kr). ${data.movers ? `Stiger mest: ${data.rising[0]?.name} (+${data.rising[0]?.change} %).` : "Ingen trend än, historiken är för kort."}`);
