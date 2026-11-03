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
