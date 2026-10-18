// Avgör om en butiksprodukt är en förseglad Pokémon-produkt, och i så fall vilken typ, vilket språk och vilket set.

const POKEMON = /pok[eé]mon/i;

// Ordningen spelar roll: mer specifika typer först.
const TYPES = [
  ["Elite Trainer Box", /elite trainer|\betb\b/i],
  ["Booster Bundle", /booster bundle/i],
  ["Booster Box", /booster ?box|display|36[- ]?pack|booster case/i],
  ["Ultra-Premium Collection", /ultra[- ]premium|\bupc\b/i],
  ["Premium Collection", /premium collection|special collection|super[- ]premium/i],
  ["Collection Box", /collection|kollektion|ex box|\bbox\b/i],
  ["Tin", /\btins?\b|plåtburk/i],
  ["Blister", /blister|checklane|3[- ]?pack|three[- ]pack/i],
  ["Build & Battle", /build (&|and) battle|prerelease/i],
  ["Deck", /\bdeck\b|battle academy|league battle/i],
  ["Booster Pack", /booster ?pack|booster\b|boosterpaket|sleeved booster/i],
];

// Saker som nämner Pokémon men inte är förseglade kortprodukter: tillbehör, kläder, leksaker, spel,
// digitala koder, graderade och lösa kort (t.ex. "025/165"). Officiella TCG-boxar med figur, pin eller
// poster ("Figure Collection", "Pin Collection") innehåller boosterpaket och får vara kvar.
const NOT_SEALED = new RegExp([
  // tillbehör och förvaring
  "display case", "acrylic", "akryl\\w*", "magnetic", "storage", "förvaring\\w*", "protector", "skydd\\w*", "sleeves?", "kortfickor",
  "toploaders?", "binder", "pärm", "portfolio", "album", "playmat", "spelmatta", "deck ?box", "kortlåda", "dice", "tärning\\w*",
  "damage[- ]counters?", "coin set", "myntset", "card case", "kortfodral", "flip box", "flip deck", "alcove", "deck ?case", "deckbox", "ultra pro", "gamegenic", "dragon shield", "ultimate guard",
  // kläder och accessoarer
  "t-?shirt", "tröja", "hoodie", "huvtröja", "keps", "mössa", "cap", "hatt", "strumpor", "socks?", "väska", "bag", "ryggsäck", "backpack",
  "pyjamas", "jacka", "byxor", "halsband", "armband", "örhängen", "smycke\\w*", "nyckelring", "keychain", "pins?(?= set)",
  // leksaker, figurer och prylar
  "plush", "plysch", "light ?up", "gosedjur", "mjukisdjur", "blind ?box", "figure set", "figur", "samlarfigur\\w*", "re-?ment", "collection figure", "battle figure", "funko", "nendoroid", "funism", "statyett", "action figure", "mega construx", "lego",
  "pussel", "puzzle", "mugg", "mug", "flaska", "bottle", "lampa", "lamp", "kudde", "pillow", "filt", "blanket", "ryggsäck",
  // tv-spel och digitalt
  "nintendo switch", "switch 2", "game boy", "3ds", "amiibo", "videospel", "online code", "code[- ]card", "kodkort", "oanvänd kod",
  // böcker, graderat, tomma lådor
  "bok", "book", "graded", "psa ?\\d+", "cgc ?\\d*", "bgs ?\\d*", "tom låda", "empty box", "endast låda", "only box",
].map((w) => `\\b${w}\\b`).join("|") + "|\\b\\d{1,3}\\s*\\/\\s*\\d{2,3}\\b", "i");

const LANGS = [
  ["ja", /japan|japansk|\bjp\b|\bjpn\b|日本/i],
  ["ko", /korea|koreansk|\bkr\b/i],
  ["zh", /kinesisk|chinese|simplified|traditional|\(\s*(ch|cn|chn|sc|tc)\s*\)/i],
  ["fr", /fran[cç]ais|fransk/i],
];

// Tyska produkter tas inte med.
const GERMAN = /\bdeutsch|tysk|\bger\b/i;

export function classify(title, setNames = [], seriesNames = []) {
  if (!title || !POKEMON.test(title) || NOT_SEALED.test(title) || GERMAN.test(title)) return null;
  const type = TYPES.find(([, re]) => re.test(title))?.[0];
  if (!type) return null;
  const lang = LANGS.find(([, re]) => re.test(title))?.[0] || "en";
  // Set som heter som sin serie ("Scarlet & Violet") står ofta med i titeln bara som serienamn,
  // så de får lägst prioritet. Annars vinner det längsta namnet.
  const low = title.toLowerCase();
  const series = new Set(seriesNames.map((s) => s.toLowerCase()));
  // Korta namn som "151" måste stå som eget ord, längre namn räcker att de finns i titeln.
  // "Mega Evolutions" (felstavat serienamn) ska inte tolkas som XY-setet "Evolutions".
  const lowNoMega = low.replace(/mega evolutions?/g, " ");
  const hits = setNames.filter((s) => s === "Evolutions" ? /\bevolutions\b/.test(lowNoMega) && !/prismatic evolutions/.test(low) : (s.length > 3 ? low.includes(s.toLowerCase()) : /^\d{3}$/.test(s) && new RegExp(`\\b${s}\\b`).test(low)));
  const set = hits.sort((a, b) => series.has(a.toLowerCase()) - series.has(b.toLowerCase()) || b.length - a.length)[0] || null;
  return { type, lang, set };
}
