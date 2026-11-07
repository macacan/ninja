// Riftbound-kort som finns både som vanligt (overnumbered) och signerat: "Ekko, Boy Who Shattered Time" 168/167 och
// Signature 168*/167. Korten har samma konstverk, så skannern kan inte skilja dem åt och låter en välja.
// Egen fil i stället för en ny export i site.js (se js/langmark.js).
// T1-buntarnas "Signature Edition" är inga signerade kort och räknas inte.
export const isSignature = (c) => /(^|\s)Signature$/.test(c?.variant || "");

// Kortet utan signatur till ett signerat kort, och tvärtom: samma set och namn, och numret utan stjärnan.
// Några kort har fått ett annat nummer hos TCGplayer (Jarvan IV 179*/176), då används varianten (Overnumbered).
export function signaturePairs(cards) {
  const pairs = new Map();
  for (const s of cards) {
    if (!isSignature(s)) continue;
    const same = cards.filter((c) => c !== s && c.set === s.set && c.name === s.name && !isSignature(c));
    const base = same.find((c) => c.no === String(s.no || "").replace(/\*/g, ""))
      || same.find((c) => c.variant === s.variant.replace(/Signature$/, "Overnumbered"));
    if (!base) continue;
    pairs.set(s.id, base.id);
    pairs.set(base.id, s.id);
  }
  return pairs;
}

export const signatureBadge = (c) => (isSignature(c) ? `<span class="csig" title="Signerat kort" aria-label="Signature">✍ Signature</span>` : "");
