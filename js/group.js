// Avgör vilka butiksprodukter som är samma produkt, t.ex. "Pokémon TCG: Pitch Black Booster Pack" hos en
// butik och "Pitch Black Booster" hos en annan. Används både av bevakningen (Node) och av sidan (webbläsaren),
// så filen får inte använda något som bara finns på ena stället.

// Typer där set + typ + språk (+ variant) räcker för att det ska vara samma produkt.
const SIMPLE = new Set(["Booster Pack", "Booster Box", "Elite Trainer Box", "Booster Bundle", "Build & Battle"]);
// Andra kortspel (game i produkten): namn, typer där set + typ + språk räcker, ord som inte skiljer produkter åt,
// typnamn i rubriken och ord som butikerna sätter först i namnet. Riftbound: Vault och Pre-Rift Kit finns bara i
// en sort per set, decken skiljs åt av championnamnen. One Piece: ett starterdeck är sitt eget set (ST-xx).
const GAMES = {
  rb: { name: "Riftbound", simple: new Set(["Booster Pack", "Booster Box", "Bundle", "Prerelease Kit", "Proving Grounds"]),
    stop: new Set("riftbound league legends lol tcg champion showdown set one runeterra vs max kund".split(" ")),
    label: { "Booster Box": "Booster Display", Bundle: "Vault", "Prerelease Kit": "Pre-Rift Kit" },
    prefix: /^(?:\s*(?:riftbound|league of legends|lol|tcg|set one)\s*[:\-–]?\s*)+/i },
  op: { name: "One Piece", simple: new Set(["Booster Pack", "Booster Box", "Deck"]),
    stop: new Set("one piece tcg bandai extra starter max kund per exemplar person cards".split(" ")),
    label: { Deck: "Starter Deck" },
    prefix: /^(?:\s*(?:one piece|card game|tcg|bandai)\s*[:\-–]?\s*)+/i },
};
// One Piece-produkter utan set har en egen kod: "IB-07" / "Illustration Box Volume 7", "DP13", "TS-02", "AC-01".
const opCode = (p) => {
  const t = fold(p.title), m = t.match(/\b(ib|dp|ts|ac|df|sd|ld|gc)[- ]?0?(\d{1,2})\b/);
  if (m) return `${m[1]}${+m[2]}`;
  const vol = p.type === "Illustration Box" && t.match(/vol(?:ume)?\.?\s*(\d+)/);
  return vol ? `ib${+vol[1]}` : "";
};

// Ord som inte säger något om vilken produkt det är.
const STOP = new Set(("pokemon tcg trading card cards game the and och med for of a an i en ett av till pa kort samlarkort " +
  "scarlet violet sword shield sun moon mega evolution xy black white sv swsh sm me series serie " +
  "japansk japanese japan jp jpn engelsk english eng svensk ny new nytt sealed forseglad forsegl st stk pcs styck " +
  "box boxes boxar lada collection kollektion premium special pack packs paket booster boosters tin tins blister " +
  "deck decks bundle elite trainer etb display ultra upc build battle edition version utgava").split(" "));

export const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// Varianter som gör två annars lika produkter olika.
function variants(title) {
  const t = fold(title);
  const v = [];
  if (/pokemon center|\bpc\b/.test(t)) v.push("pc");
  if (/sleeved/.test(t)) v.push("sleeved");
  if (/\bcase\b|\(\s*\d+\s*(boxes|boxar|st)\s*\)|hel kartong|\bkartong\b/.test(t)) v.push("case");
  if (/\bhalf\b|half booster|halv/.test(t)) v.push("half");
  if (/\bmini\b/.test(t)) v.push("mini");
  return v;
}

// Namnord som skiljer samlarboxar åt (t.ex. "sylveon", "greninja", "poster", "binder").
function nameTokens(title, set, game) {
  const setWords = new Set(fold(set).split(/[^a-z0-9]+/));
  const t = fold(title).replace(/\((max|begransat|limit)[^)]*\)/g, " ");
  // Serienummer ("Series 2", "Vol. 3") och bokstavsvarianter ("Charizard X" / "Y") skiljer produkter åt.
  const extra = [...t.matchAll(/(?:series|serie|vol\.?|volume|wave|del)\s*(\d+)/g)].map((m) => `s${m[1]}`)
    .concat([...t.matchAll(/\b([xyz])\b(?=\s*(?:ex|gx|\)|$|\s))/g)].map((m) => m[1]));
  const words = t.replace(/\(.*?\)/g, (m) => (/ex|gx|v\b|vmax|vstar/.test(m) ? m : " "))
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w) && !GAMES[game]?.stop.has(w) && !setWords.has(w) && w !== "max" && !/^\d+$/.test(w) && !/^[a-z]{1,4}\d+[a-z]?$/.test(w));
  return [...new Set([...extra, ...words])].sort();
}

// Set som heter som en hel serie. Står bara serienamnet i titeln kan det vara vilket set som helst i serien
// (t.ex. japanska "Mega Brave"), så då räcker inte set + typ för att det ska vara samma produkt.
const SERIES_LIKE = new Set(["mega evolution", "scarlet & violet", "sword & shield", "sun & moon", "xy", "black & white"]);

export function groupKey(p) {
  // Nycklarna för andra spel börjar med spelet ("rb|", "op|"), så att de aldrig krockar med Pokémon.
  // Pokémon-nycklarna är oförändrade.
  const g = GAMES[p.game];
  if (g) {
    const set = p.set || "", v = variants(p.title).join("+");
    const base = `${p.game}|${slug(set) || "x"}|${slug(p.type)}|${p.lang || "en"}|${v}`;
    if (set && g.simple.has(p.type)) return base;
    const code = p.game === "op" ? opCode(p) : "";
    return `${base}|${code || nameTokens(p.title, set, p.game).slice(0, 4).join("-")}`;
  }
  const set = p.set || "";
  const lang = p.lang || "en";
  const v = variants(p.title).join("+");
  const extra = SERIES_LIKE.has(fold(set)) ? nameTokens(p.title, set).slice(0, 4).join("-") : "";
  // Blister med 1, 2 eller 3 paket är olika produkter.
  if (p.type === "Blister") {
    const n = fold(p.title).match(/(\d)\s*-?\s*(?:pack|p|pk|paket)\b/)?.[1] || (/checklane/i.test(p.title) ? "cl" : "");
    return `${slug(set) || "x"}|blister|${lang}|${v}|${n}${set ? "" : `|${nameTokens(p.title, set).slice(0, 6).join("-")}`}`;
  }
  if (set && SIMPLE.has(p.type)) return `${slug(set)}|${slug(p.type)}|${lang}|${v}${extra ? `|${extra}` : ""}`;
  return `${slug(set) || "x"}|${slug(p.type)}|${lang}|${v}|${nameTokens(p.title, set).slice(0, 6).join("-")}`;
}

const LABEL = { "Build & Battle": "Build & Battle Box" };

// Ett läsbart namn för gruppen. Enkla typer får ett rent namn, samlarboxar får butikens kortaste namn.
export function groupTitle(members) {
  const p = members[0];
  const v = variants(p.title);
  const g = GAMES[p.game];
  if (g && p.set && g.simple.has(p.type)) {
    // Ett One Piece-starterdeck heter som sitt set ("Starter Deck 35: RED/BLACK Sabo").
    const name = p.type === "Deck" && /starter deck/i.test(p.set) ? p.set : `${p.set} ${g.label[p.type] || p.type}`;
    return `${g.name} ${name}` + (v.includes("case") ? " – hel kartong" : "");
  }
  if (p.set && SIMPLE.has(p.type)) {
    const base = `${p.set} ${v.includes("pc") ? "Pokémon Center " : ""}${LABEL[p.type] || p.type}`;
    return base + (v.includes("sleeved") ? " (Sleeved)" : "") + (v.includes("half") ? " (Half)" : "") + (v.includes("case") ? " – hel kartong" : "");
  }
  const clean = (t) => t.replace(/^[\s,;:–-]+/, "").replace(/^\s*pok[eé]mon(\s+tcg)?\s*[:\-–]?\s*/i, "").replace(/\((max|begränsat|limit)[^)]*\)/gi, "")
    .replace(/\s{2,}/g, " ").trim();
  const shortest = members.map((m) => m.title).sort((a, b) => a.length - b.length)[0];
  // "Riftbound: League of Legends TCG - Set One: Origins Champion Deck - Jinx" → "Riftbound Origins Champion Deck - Jinx"
  if (g) return `${g.name} ${clean(shortest.replace(g.prefix, ""))}`;
  return clean(shortest);
}

export function groupProducts(products) {
  const groups = new Map();
  for (const p of products) {
    const k = groupKey(p);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }
  return groups;
}

// Lägsta pris bland butiker som har produkten i lager (inte förbeställning).
export const lowestInStock = (members) => {
  const prices = members.filter((m) => m.available).map((m) => m.price);
  return prices.length ? Math.min(...prices) : null;
};

// Prissänkning eller bara prisuppdatering? En butik som sänker räknas som prissänkt bara när den blir billigast:
// lägre än alla andra butiker som har produkten i lager (eller, om den bara går att förbeställa, lägre än alla
// andra som har den i lager eller tar förbeställningar). Sänker en dyr butik men är fortfarande dyrare än någon
// annan är det en vanlig prisuppdatering: ingen markering, ingen notis och produkten flyttas inte överst.
// others: samma produkt hos andra butiker (övriga medlemmar i gruppen).
export function undercuts(p, others) {
  if (!p.available && !p.preorder) return false;
  const rivals = others.filter((o) => o !== p && o.price > 0 && (p.available ? o.available : o.available || o.preorder));
  return rivals.every((o) => p.price < o.price);
}

// En sänkning som gör butiken billigast (se undercuts). Över 60 % lägre är nästan alltid fel valuta, inte en rea.
export const isLeadDrop = (p, others) => !!p.priceChange && p.price < p.priceChange.from && p.price >= p.priceChange.from * 0.4 && undercuts(p, others);

// När produkten senast ändrades på ett sätt som ska flytta den överst i "Senast ändrad": nytt i lager, förbeställning
// eller en prissänkning som gör butiken billigast. En vanlig prisuppdatering räknas inte, då gäller tiden innan.
export function changedAt(p, others) {
  const priceOnly = p.priceChange && p.lastChange === p.priceChange.at;
  if (!priceOnly || isLeadDrop(p, others)) return p.lastChange || 0;
  return Math.max(p.firstInStock || 0, p.firstOrderable || 0);
}
