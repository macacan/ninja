// Avgör om en butiksprodukt är en förseglad Pokémon- eller Riftbound-produkt, och i så fall vilken typ, vilket språk och vilket set.
// Riftbound-produkter får game: "rb". Pokémon-produkter har inget game-fält (så har de alltid sparats).

import { readFileSync } from "node:fs";

const POKEMON = /pok[eé]mon/i;

// Höjs när igenkänningen ändras så att fler produkter räknas. Då sparas de nyfunna produkterna tyst
// vid nästa kontroll av varje butik, i stället för att larmas som hundratals "nya" (se engine.mjs).
export const CLASSIFY_VERSION = 9;

// Ordningen spelar roll: mer specifika typer först.
const TYPES = [
  ["Elite Trainer Box", /elite trainer|\betb\b/i],
  ["Booster Bundle", /booster bundle/i],
  ["Booster Box", /(?:booster ?box|booster ?display|display ?box|(?:30|36)[- ]?pack|booster case|display.*(?:30|36)\s*boosters?)(?!.*\(\s*(?:[1-9]|10)\s*(?:kort|cards?)\s*\))/i],
  ["Ultra-Premium Collection", /ultra[- ]premium|\bupc\b/i],
  ["Premium Collection", /premium collection|special collection|super[- ]premium/i],
  ["Collection Box", /collection|kollektion|ex box|\bbox\b|display set|gift box/i],
  ["Tin", /\btins?\b|plåtburk/i],
  ["Blister", /blister|checklane|3[- ]?pack|three[- ]pack/i],
  ["Build & Battle", /build (&|and) battle|prerelease/i],
  ["Deck", /\bdeck\b|battle academy|league battle|starter set|start ?deck/i],
  ["Booster Pack", /booster ?pack|booster\b|boosterpaket|sleeved booster/i],
];

// Saker som nämner Pokémon men inte är förseglade kortprodukter: tillbehör, kläder, leksaker, spel,
// digitala koder, graderade och lösa kort (t.ex. "025/165"). Officiella TCG-boxar med figur, pin eller
// poster ("Figure Collection", "Pin Collection", "Binder Collection") innehåller boosterpaket och får vara kvar.
const NOT_SEALED = new RegExp([
  // tillbehör och förvaring
  "display case", "acrylic\\w*", "akryl\\w*", "magnetic", "magnetisk\\w*", "storage", "förvaring\\w*",
  "protectors?", "protective\\w*", "protection\\w*", "skydd\\w*", "kortskydd\\w*", "crystal box\\w*", "one[- ]touch",
  "sleeves?", "kortfickor", "toploaders?", "binder(?! (?:collection|gift box))", "pärm", "portfolio", "album",
  "playmat", "spelmatta", "deck ?box", "kortlåda", "dice", "tärning\\w*", "kortsdisplay\\w*", "kortdisplay\\w*",
  "damage[- ]counters?", "coin set", "myntset", "card case", "kortfodral", "flip box", "flip deck", "alcove",
  "deck ?case", "deckbox", "ultra pro", "gamegenic", "dragon shield", "ultimate guard", "phoenix shield", "evoretro", "tcglab",
  // singelkort, promos och graderat
  "black star promos?", "singelkort\\w*", "singles?(?! strike)",
  // kläder och accessoarer
  "t-?shirt", "tröja", "hoodie", "huvtröja", "keps", "mössa", "cap", "hatt", "strumpor", "socks?", "väska", "bag", "ryggsäck", "backpack",
  "pyjamas", "jacka", "byxor", "halsband", "armband", "örhängen", "smycke\\w*", "nyckelring", "keychain", "pins?(?= set)",
  // leksaker, figurer och prylar
  "plush", "plysch", "light ?up", "gosedjur", "mjukisdjur", "blind ?box", "figure set", "figur", "samlarfigur\\w*", "re-?ment", "collection figure", "battle figure", "funko", "nendoroid", "funism", "statyett", "action figure", "mega construx", "lego",
  "pussel", "puzzle", "jigsaw", "kylskåpsmagnet\\w*", "mugg", "mug", "flaska", "bottle", "lampa", "lamp", "kudde", "pillow", "filt", "blanket", "ryggsäck",
  // tv-spel och digitalt
  "nintendo switch", "switch 2", "game boy", "3ds", "amiibo", "videospel", "online code", "code[- ]card", "code in a box", "kodkort", "oanvänd kod",
  // biljetter till turneringar och prerelease-event (har ofta veckodag och datum i namnet)
  "biljett\\w*", "tickets?", "turnering\\w*", "anmälan", "deltagaravgift", "entry fee", "duck race", "raffle",
  // tjänster där butiken öppnar packet live åt köparen
  "öppnas live", "live[- ]?öppning", "live opening", "pack ?battle", "packbattle",
  "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag",
  // böcker, graderat, tomma lådor
  "bok", "book", "graded", "psa ?\\d+", "cgc ?\\d*", "bgs ?\\d*", "tom låda", "empty box", "endast låda", "only box",
].map((w) => `(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`).join("|") + "|(?<![\\p{L}\\p{N}])\\d{1,3}[a*]?\\s*\\/\\s*\\d{2,3}(?![\\p{L}\\p{N}])", "iu");

// Lösa kort som inte har ett kortnummer med snedstreck, i alla spel. Butikerna skriver dem som
// "Charizard (LC 3) Legendary Collection - Reverse - Poor", "Charizard 4 - Celebrations: Classic Collection - Classic Collection",
// "Mega Charizard X ex #023 – …", "Lillie's Ribombee - (Prerelease) 183 SV: Scarlet & Violet Promo Cards" eller "Wooloo Holo - …".
// En förseglad box i skadad förpackning ("(damaged)") har skicket i parentes och räknas inte.
const SINGLE = new RegExp([
  // skick eller sällsynthet sist, efter ett bindestreck
  "\\s[-–]\\s*(?:poor|played|(?:lightly|light|moderately|heavily) played|good|excellent|near mint|nm|mint|damaged|lp|mp|hp)\\s*$",
  "\\s[-–]\\s*(?:common|uncommon|(?:holo |double |ultra |illustration |special illustration |hyper |secret )?rare|classic collection)\\s*$",
  // set och kortnummer i parentes ("(LC 3)"), kortnummer med # ("#023"), "Promo Cards" sist
  "\\((?!(?:max|vol|set|ser|nr)\\b)[a-z]{1,4} \\d{1,3}\\)", "#\\d{1,3}\\b", "\\bpromo cards\\s*$",
  // "Wooloo Holo - …": kortnamn följt av Holo eller Reverse och ett bindestreck
  "^[\\p{L}'. ]{2,30} (?:reverse )?holo\\s+[-–]",
].join("|"), "iu");

const LANGS = [
  ["ja", /japan|japansk|\bjp\b|\bjpn\b|日本/i],
  ["ko", /korea|koreansk|\bkr\b|\bkor\b/i],
  ["zh", /kinesisk|chinese|simplified|traditional|\bcn\b|\bchn\b|\(\s*(ch|cn|chn|sc|tc)\s*\)/i],
  ["fr", /fran[cç]ais|fransk/i],
  // Sist, så att en japansk eller kinesisk markering vinner om titeln råkar innehålla båda.
  ["en", /\beng\b|\beng\.|engelsk|english|\(\s*en\s*\)/i],
];

// Tyska produkter tas inte med.
const GERMAN = /\bdeutsch|tysk|\bger\b/i;

// Många butiker skriver inte "Pokémon" i titeln ("30th Celebration Elite Trainer Box"). Då räcker det med
// ett känt setnamn, en japansk/kinesisk setkod eller ett Pokémon-namn, så länge det inte är ett annat kortspel.
const OTHER_TCG = /one piece|\bop-?\d{2}\b|yu[- ]?gi[- ]?oh|magic:? the gathering|\bmtg\b|lorcana|digimon|flesh (?:and|&) blood|dragon ball|weiss schwarz|union arena|star wars unlimited|riftbound|grand archive|metazoo|gundam|sorcery|altered|vanguard|battle spirits|shadowverse|final fantasy|kayou|naruto|hololive/i;
// Pokémon-set från Japan och Kina som inte finns under engelskt namn hos TCGdex, plus vanliga produktnamn.
const POKE_WORDS = /\b(?:mega evolution|30th celebration|terastal|shiny treasure|raging surf|abyss eye|black crystal|gem pack|mega (?:brave|symphonia|dream|inferno)|inferno x|pok[eé] ?ball|first partners?|lumiose|paldea\w*|night wanderer|stellar miracle|battle partners|hot wind arena|super electric breaker|cyber judge|wild force|crimson haze|mask of change|ruler of the black flame|snow hazard|clay burst|triplet beat|violet ex|scarlet ex|storm emerald\w*|azure legends)\b/i;
// Setkoder som "SV4a", "SV8a", "M2", "M1L", "CSV5C", "CSV9.5C" (i parentes eller som eget ord).
const SET_CODE = /\((?:c?sv\d{1,2}(?:\.\d)?[a-z]?c?|m\d{1,2}[a-z]?|s\d{1,2}[a-z]?)\)|\bc?sv\d{1,2}(?:\.\d)?[a-z]c?\b|\bcsv\d/i;
// Setnamn som också är vanliga ord och därför inte räcker som bevis.
const VAGUE_SETS = new Set(["dragon", "platinum", "emerald", "sample", "jungle", "fossil", "generations", "expedition", "unleashed", "wizards black star promos", "jumbo cards", "best of game", "w promotional", "miscellaneous promos"]);
// Set som ofta bara är en del av ett produktnamn ("Team Rocket's Mewtwo ex"). Räknas som bevis, men förlorar mot andra set i titeln.
const LOW_PRIORITY_SETS = new Set(["team rocket"]);

// Riftbound (League of Legends Trading Card Game). Lösa kort har sällan en typ i namnet ("Ahri, Inquisitive SFD 227*/221")
// och sorteras bort av NOT_SEALED eller av att ingen typ passar. Ordningen spelar roll, som i TYPES.
const RIFTBOUND = /riftbound|league of legends/i;
const RB_TYPES = [
  ["Booster Box", /booster ?(?:display|box)|sealed case/i],
  ["Bundle", /vault|bundle/i],
  ["Proving Grounds", /proving grounds/i],
  ["Prerelease Kit", /pre-?rift|prerelease/i],
  ["Deck", /\bdecks?\b/i],
  ["Collection Box", /gift box|collection|\bbox\b/i],
  ["Booster Pack", /booster/i],
];
// Huvudseten i släppordning. Nya set läggs till här (se data/rb/sets.json).
const RB_SETS = ["Origins", "Spiritforged", "Unleashed", "Vendetta", "Radiance", "Legacy"];
const isRiftbound = (title, hint = "") => RIFTBOUND.test(title) || (!POKEMON.test(title) && RIFTBOUND.test(hint));

let MONS = null;
function pokemonNames() {
  if (MONS) return MONS;
  try {
    const d = JSON.parse(readFileSync(new URL("../../../data/pokemon-names.json", import.meta.url), "utf8"));
    MONS = new Set((d.pokemon || []).map((p) => p.name.toLowerCase()).filter((n) => n.length >= 4));
  } catch { MONS = new Set(); }
  return MONS;
}

// Snabb kontroll utan typ: ser titeln ut att handla om Pokémon? Används av adaptrarna innan klassningen.
// strict (för URL:er i stora sitemaps): bara ordet Pokémon, japanska/kinesiska setnamn och setkoder.
// Engelska setnamn och Pokémon-namn ger för många träffar i stora spelbutiker ("Base Set", "Black Bolt",
// "Team Up", "Golem", "Kabuto"). Produktsidans titel kontrolleras sedan utan strict.
export function looksPokemonTitle(title, setNames = [], { strict = false } = {}) {
  if (!title) return false;
  if (RIFTBOUND.test(title)) return true;
  if (strict) return POKEMON.test(title) || (!OTHER_TCG.test(title) && (POKE_WORDS.test(title) || SET_CODE.test(title)));
  const low = title.toLowerCase();
  const hits = setNames.filter((s) => s.length > 3 ? low.includes(s.toLowerCase()) : /^\d{3}$/.test(s) && new RegExp(`\\b${s}\\b`).test(low));
  return looksPokemon(title, hits);
}

function looksPokemon(title, hits) {
  if (POKEMON.test(title)) return true;
  if (OTHER_TCG.test(title)) return false;
  if (hits.some((s) => !VAGUE_SETS.has(s.toLowerCase())) || POKE_WORDS.test(title) || SET_CODE.test(title)) return true;
  const words = title.toLowerCase().match(/[\p{L}'.-]+/gu) || [];
  return words.some((w) => pokemonNames().has(w));
}

const langOf = (text) => LANGS.find(([, re]) => re.test(text))?.[0] || null;

// hint: butikens taggar, produkttyp, kategorier och adress. Används bara för språket, och bara när titeln
// inte säger något. Säger ingen av dem något blir det engelska, markerat som gissat (langGuess).
export function classify(title, setNames = [], seriesNames = [], hint = "") {
  if (!title || NOT_SEALED.test(title) || SINGLE.test(title) || GERMAN.test(title)) return null;
  if (isRiftbound(title, hint)) return classifyRiftbound(title, hint);
  const type = TYPES.find(([, re]) => re.test(title))?.[0];
  if (!type) return null;
  // Set som heter som sin serie ("Scarlet & Violet") står ofta med i titeln bara som serienamn,
  // så de får lägst prioritet. Annars vinner det längsta namnet.
  const low = title.toLowerCase();
  const series = new Set(seriesNames.map((s) => s.toLowerCase()));
  // Korta namn som "151" måste stå som eget ord, längre namn räcker att de finns i titeln.
  // "Mega Evolutions" (felstavat serienamn) ska inte tolkas som XY-setet "Evolutions".
  const lowNoMega = low.replace(/mega evolutions?/g, " ");
  const hits = setNames.filter((s) => s === "Evolutions" ? /\bevolutions\b/.test(lowNoMega) && !/prismatic evolutions/.test(low) : (s.length > 3 ? low.includes(s.toLowerCase()) : /^\d{3}$/.test(s) && new RegExp(`\\b${s}\\b`).test(low)));
  if (!looksPokemon(title, hits)) return null;
  const lang = langOf(title) || (hint && langOf(hint));
  // Flera set i titeln, t.ex. "Black Bolt & White Flare - Black Bolt Elite Trainer Box": setet som står sist,
  // närmast produktnamnet, är produktens set. Serienamn och vaga ord ("Dragon") kommer sist. Överlappar två
  // namn i titeln ("30th Celebrations" innehåller både "30th Celebration" och "Celebrations") vinner det längsta.
  const span = (s) => { const i = low.lastIndexOf(s.toLowerCase()); return [i, i + s.length]; };
  const weak = (s) => series.has(s.toLowerCase()) * 2 + (VAGUE_SETS.has(s.toLowerCase()) || LOW_PRIORITY_SETS.has(s.toLowerCase()));
  const set = hits.sort((a, b) => {
    const w = weak(a) - weak(b);
    if (w) return w;
    const [as, ae] = span(a), [bs, be] = span(b);
    return as < be && bs < ae ? b.length - a.length : be - ae || b.length - a.length;
  })[0] || null;
  return lang ? { type, lang, set } : { type, lang: "en", langGuess: true, set };
}

// Setet är det som står sist i titeln ("Origins Proving Grounds" → Origins).
function classifyRiftbound(title, hint) {
  const type = RB_TYPES.find(([, re]) => re.test(title))?.[0];
  if (!type) return null;
  const low = title.toLowerCase();
  const set = RB_SETS.filter((s) => low.includes(s.toLowerCase())).sort((a, b) => low.lastIndexOf(b.toLowerCase()) - low.lastIndexOf(a.toLowerCase()))[0] || null;
  const lang = langOf(title) || (hint && langOf(hint));
  return { game: "rb", type, set, ...(lang ? { lang } : { lang: "en", langGuess: true }) };
}
