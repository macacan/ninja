// Hämtar hur många boosterpaket varje förseglad produkt innehåller från Bulbapedias
// "TCG Series merchandise"-sidor och sparar det i data/product-contents.json.
// Butikssidan räknar sedan fram pris per booster för produkterna.
// Bulbapedias text är CC BY-NC-SA: vi sparar bara fakta (antal paket) och länkar till källan.
// Körs dagligen i GitHub Actions (se .github/workflows/trends.yml): node scripts/update-product-contents.mjs

import { writeFileSync } from "node:fs";

const WIKI = "https://bulbapedia.bulbagarden.net/w/api.php";
const UA = "PackninjaBot/1.0 (https://packninja.se/om.html#bot; daglig hämtning av produktinnehåll)";
// Engelska produkter. "TCG Era"-sidorna gäller Japan och hoppas över.
const PAGES = [
  "Mega Evolution TCG Series merchandise",
  "Scarlet & Violet TCG Series merchandise",
  "Sword & Shield TCG Series merchandise",
  "Sun & Moon TCG Series merchandise",
];

const NUMBERS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, eighteen: 18, twenty: 20, "twenty-four": 24, "thirty-six": 36 };

// Wikitext till läsbar text: mallar som {{TCG|Mega Evolution}} och länkar som [[a|b]] blir sitt visade namn.
function plain(t) {
  let s = t;
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\{\{me\|([^{}|]+)(?:\|[^{}]*)?\}\}/gi, "Mega $1")
      .replace(/\{\{(?:TCG|p|pkmn|ct|tcg|m|ga|rar|e|TCG ID)\|(?:[^{}|]*\|)*([^{}|]+)\}\}/g, "$1")
      .replace(/\{\{[^{}]*\}\}/g, "");
  }
  return s
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g, "$1")
    .replace(/<ref[^>]*\/>|<ref[^>]*>[\s\S]*?<\/ref>/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/'''?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Antal paket i en mening: "nine Mega Evolution booster packs", "36-pack displays", "containing 18 packs".
// "a three card ... booster pack" är antal kort i ett paket och räknas inte.
const COUNT = "\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|eighteen|twenty|twenty-four|thirty-six";
const PACKS_RE = new RegExp(`\\b(${COUNT})(?!\\s*-?\\s*cards?\\b)(?:\\s+(?:(?!cards?\\b)[\\w&'é.:-]+\\s+){0,6}?booster packs?\\b|-packs?(?=\\s+(?:displays?|box(?:es)?)\\b)|\\s+packs\\b)`, "gi");
// Ord som visar att talen i meningen är olika versioner av produkten, inte delar som ska summeras
const ALTERNATIVES = /\b(?:either|or|instead|versions?|designs?|varieties|variants?|options?|whereas|while|half|standard|depending|larger|smaller)\b/i;

function countsIn(sentence) {
  const nums = [...sentence.matchAll(PACKS_RE)].map((m) => (/^\d+$/.test(m[1]) ? +m[1] : NUMBERS[m[1].toLowerCase()])).filter(Boolean);
  if (nums.length > 1 && !ALTERNATIVES.test(sentence)) return [nums.reduce((a, b) => a + b, 0)];
  return [...new Set(nums)];
}

async function wikitext(page) {
  const url = `${WIKI}?action=parse&page=${encodeURIComponent(page)}&prop=wikitext&format=json&formatversion=2&maxlag=5`;
  const r = await fetch(url, { headers: { "user-agent": UA } });
  if (!r.ok) throw new Error(`${page}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${page}: ${j.error.info}`);
  return j.parse.wikitext;
}

// Varje rubrik på sidan är en produkt (eller en grupp av likadana produkter, t.ex. flera tins).
function products(page, text) {
  const out = [];
  const parts = text.split(/^(={2,4})\s*(.+?)\s*\1\s*$/m);
  for (let i = 1; i < parts.length; i += 3) {
    const title = plain(parts[i + 1]);
    const body = plain(parts[i + 2] || "");
    if (!title || !body) continue;
    // Pokémon Center-versionen av en ETB beskrivs i samma avsnitt och har fler paket
    const sentences = body.split(/(?<=[.!?])\s+(?=[A-Z])/);
    const normal = sentences.filter((s) => !/Pok[eé]mon Center/i.test(s));
    const center = sentences.filter((s) => /Pok[eé]mon Center/i.test(s));
    // packs är alla varianter som finns, t.ex. [36, 18] för hel och halv display eller [5, 4] för två sorters tins
    const packs = normal.map(countsIn).find((n) => n.length) || [];
    if (!packs.length || packs.some((n) => n > 40)) continue; // fler än 40 är minipaket (t.ex. Trick or Trade)
    // "two more booster packs" i Pokémon Center-versionen är relativt den vanliga versionen
    const cs = center.find((s) => countsIn(s).length);
    const centerPacks = cs ? (/\b(?:more|additional|extra)\b/i.test(cs) && packs.length === 1 ? packs[0] : 0) + countsIn(cs)[0] : null;
    out.push({
      title,
      packs,
      centerPacks,
    });
  }
  return out;
}

const all = [];
for (const page of PAGES) {
  try {
    const list = products(page, await wikitext(page));
    console.log(`${page}: ${list.length} produkter`);
    all.push(...list);
  } catch (e) {
    console.warn(e.message);
  }
  await new Promise((r) => setTimeout(r, 1500)); // snällt mot Bulbapedia
}

if (all.length) {
  const sources = PAGES.map((p) => `https://bulbapedia.bulbagarden.net/wiki/${encodeURIComponent(p.replace(/ /g, "_"))}`);
  // En produkt per rad: liten fil men ändå läsbar i git-diffar
  const rows = all.map((p) => JSON.stringify(p)).join(",\n");
  writeFileSync(new URL("../data/product-contents.json", import.meta.url), `{"updated":${Date.now()},"license":"Bulbapedia, CC BY-NC-SA","sources":${JSON.stringify(sources)},"products":[\n${rows}\n]}\n`);
  console.log(`Sparade ${all.length} produkter.`);
} else {
  console.warn("Inga produkter hittades, behåller den gamla filen.");
  process.exitCode = 1;
}
