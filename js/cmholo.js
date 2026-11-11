// Reverse holo för Pokémonkort, ur Cardmarkets priser i TCGdex (card.pricing.cardmarket).
// Cardmarket har en produktsida per kort. Annonser markerade som foil är för Pokémon reverse holo, och deras priser
// ligger i fälten "-holo". Kortets vanliga pris gäller kortet som det trycktes: vanligt, eller holo för en holo rare
// (t.ex. Charizard δ, Crystal Guardians 4/100: holo som vanligt pris, reverse holo som foil).
// TCGdex lista över versioner (variants) saknar ofta reverse holo, så valet bygger på Cardmarkets annonser i stället.

// Mitten av värdena (medianen)
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Priset för reverse holo i euro, eller null när kortet inte säljs som reverse holo.
// Trendpriserna hoppar mycket när få exemplar säljs (Charizard δ: reverse holo har trend 265 € men snitt 580–810 €), så
// båda versionerna jämförs med medianen av trend och snitt (alla, 7 och 30 dagar). Reverse holo kräver minst två
// priser och ett snittpris: kort utan reverse holo har ofta trend 0 och inga snitt. Den är aldrig billigare än kortets
// vanliga version, så en klart lägre median är felmärkta annonser (t.ex. Base Set Charizard, som inte finns som
// reverse holo) och ger inget val. Kort som TCGdex listar som reverse holo får en större marginal. Priset som visas är
// medianen, men aldrig under kortets vanliga trendpris.
export function reverseEur(card) {
  const cm = card?.pricing?.cardmarket || {}, base = cm.trend ?? cm.avg;
  const rev = [cm["trend-holo"], cm["avg-holo"], cm["avg7-holo"], cm["avg30-holo"]].filter((v) => v > 0);
  const plain = [cm.trend, cm.avg, cm.avg7, cm.avg30].filter((v) => v > 0);
  if (base == null || !plain.length || rev.length < 2 || !(cm["avg-holo"] > 0 || cm["avg30-holo"] > 0)) return null;
  const r = median(rev), p = median(plain);
  if (r < p * (card.variants?.reverse ? 0.5 : 0.9)) return null;
  return Math.round(Math.max(r, base) * 100) / 100;
}

// Namnet på kortets vanliga version: Holo för kort som bara trycktes som holo, annars Vanlig
export const baseLabel = (card) => (card?.variants?.holo && !card.variants.normal ? "Holo" : "Vanlig");

// Pristabellerna för ett Pokémonkort i Kortprisers stora vy och setsidornas prisruta. sek(belopp, valuta) ger
// beloppet i kronor. Tom text när källan saknar priser.
const priceRow = (sek, label, v, cur) => (v == null ? "" : `<tr><th>${label}</th><td>${sek(v, cur)}</td></tr>`);
export function cardmarketTable(card, sek) {
  const cm = card?.pricing?.cardmarket || {};
  // Priset kommer från TCGplayer (fixCardPricing i js/site.js), som har en egen tabell.
  if ((cm.trend == null && cm.avg == null) || cm.fromTcgplayer) return "";
  const r = (label, v) => priceRow(sek, label, v, "EUR");
  return `<h3>Cardmarket (Europa)</h3><table class="cm-table">${r("Trend", cm.trend)}${r("Snitt", cm.avg)}${r("Lägsta", cm.low)}${r("Snitt 1 dag", cm.avg1)}${r("Snitt 7 dagar", cm.avg7)}${r("Snitt 30 dagar", cm.avg30)}${r("Reverse holo", reverseEur(card))}</table>`;
}
const TP_LABEL = { normal: "Vanlig", holofoil: "Holo", reverseHolofoil: "Reverse holo", "reverse-holofoil": "Reverse holo", "1stEditionHolofoil": "1st edition holo" };
export function tcgplayerTable(card, sek) {
  const rows = Object.entries(card?.pricing?.tcgplayer || {}).filter(([, v]) => v && typeof v === "object" && v.marketPrice != null)
    .map(([k, v]) => priceRow(sek, TP_LABEL[k] || k, v.marketPrice, "USD")).join("");
  return rows ? `<h3>TCGplayer (USA)</h3><table class="cm-table">${rows}</table>` : "";
}

// Versionerna kortet trycktes i, t.ex. "Finns bara som holo" (ex-kort) eller "Finns som vanlig och reverse holo".
// Reverse holo räknas också när Cardmarket säljer kortet så (reverseEur). null när TCGdex saknar uppgiften.
export function versionNote(card) {
  const v = card?.variants;
  if (!v) return null;
  const names = [v.normal && "vanlig", v.holo && "holo", (v.reverse || reverseEur(card) != null) && "reverse holo"].filter(Boolean);
  if (!names.length) return null;
  return names.length === 1 ? `Finns bara som ${names[0]}` : `Finns som ${names.slice(0, -1).join(", ")} och ${names.at(-1)}`;
}
