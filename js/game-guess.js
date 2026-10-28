// Startsidans sökruta söker i alla tre spelen: den avgör själv om "Charizard", "Luffy" eller "Jinx" är ett
// Pokémon-, One Piece- eller Riftbound-kort och skickar sökningen till Kortpriser med rätt spel (?game=).
// Kortnamnen för One Piece och Riftbound står i data/<spel>/names.json (scripts/lib/prebuilt-cards.mjs).
import { loadDataset } from "./card-autocomplete.js";

const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const words = (s) => fold(s).split(/[^a-z0-9']+/).filter(Boolean);

let lists = null;
export function loadGameNames() {
  lists ??= Promise.all([
    loadDataset().then((d) => (d.pokemon || []).map((p) => words(p.name))),
    ...["op", "rb"].map((g) => fetch(`data/${g}/names.json`).then((r) => r.json()).then((n) => n.map(words)).catch(() => [])),
  ]).then(([pokemon, op, rb]) => ({ pokemon, op, rb }));
  return lists;
}

// Hur väl sökorden passar ett kortnamn: 3 om orden står i följd i namnet ("luffy" i "Monkey.D.Luffy"),
// 1 om sista ordet bara är början på ett ord ("jin" i "Jinx, Loose Cannon"), annars 0.
function fit(q, name) {
  let best = 0;
  for (let i = 0; i + q.length <= name.length; i++) {
    const head = q.slice(0, -1).every((w, j) => name[i + j] === w);
    if (!head) continue;
    const last = q.at(-1), w = name[i + q.length - 1];
    if (w === last) return 3;
    if (w.startsWith(last)) best = 1;
  }
  return best;
}

// Förslag i sökrutan för One Piece och Riftbound: kortnamn ur data/<spel>/cards.json med grundversionens bild,
// i samma form som Pokémonförslagen (findMatches i js/card-autocomplete.js). Filen hämtas först när den behövs.
const LABEL = { op: "One Piece", rb: "Riftbound" };
const cardLists = {};
const gameCards = (g) => (cardLists[g] ??= fetch(`data/${g}/cards.json`).then((r) => r.json()).then((d) => {
  const by = new Map();
  for (const c of d.cards) {
    const k = c.name.toLowerCase(), o = by.get(k);
    if (!o) by.set(k, { name: c.name, w: words(c.name), image: c.image, variant: !!c.variant, sek: c.sek, count: 1 });
    else {
      o.count++;
      // Grundversionen (utan variant) visas, med sin bild och sitt pris.
      if ((o.variant && !c.variant && c.image) || (!o.image && c.image)) Object.assign(o, { image: c.image, variant: !!c.variant, sek: c.sek });
    }
  }
  return [...by.values()];
}).catch(() => { delete cardLists[g]; return []; }));

export const approx = (sek) => `${Math.max(1, Math.round(sek)).toLocaleString("sv-SE").replace(/\u00a0/g, " ")} kr`;
export async function gameSuggestions(g, query, max = 6) {
  const q = words(query);
  if (!LABEL[g] || !q.length) return null;
  const t = fold(query).trim();
  const hits = (await gameCards(g)).map((c) => [c, fit(q, c.w)]).filter(([, s]) => s > 0)
    // Helt ord före början av ett ord, sedan kort med flest versioner (de mest kända), sedan kortast namn.
    .sort(([a, x], [b, y]) => y - x || b.count - a.count || a.name.length - b.name.length)
    .slice(0, max).map(([c]) => c);
  if (!hits.length) return null;
  return {
    label: `${LABEL[g]}-kort`, cards: [], parsed: null,
    bestMatch: hits.find((c) => fold(c.name).startsWith(t))?.name || null,
    pokemon: hits.map((c) => ({ name: c.name, val: c.name, thumb: c.image,
      sub: [LABEL[g], `${c.count} ${c.count === 1 ? "version" : "versioner"}`, c.sek != null && `ca ${approx(c.sek)}`].filter(Boolean).join(" · ") })),
  };
}

// "pokemon", "op" eller "rb". names: svaret från loadGameNames(), utan dem blir det Pokémon.
export function guessGame(query, names) {
  const t = fold(query);
  if (/one ?piece|\b(?:op|st|eb|prb)\d{2}-?\d{3}\b/.test(t)) return "op";
  if (/riftbound|league of legends/.test(t)) return "rb";
  if (/pokemon/.test(t)) return "pokemon";
  // Kortnummer och tillägg som "ex" säger inget om spelet.
  const q = words(t).filter((w) => !/\d/.test(w) && !["ex", "gx", "v", "vmax", "vstar"].includes(w));
  if (!q.length || !names) return "pokemon";
  const score = (list) => list.reduce((m, n) => (m === 3 ? m : Math.max(m, fit(q, n))), 0);
  // Pokémon vinner lika lägen: där finns flest kort och flest sökningar.
  let best = "pokemon", top = score(names.pokemon);
  for (const g of ["op", "rb"]) {
    const s = score(names[g]);
    if (s > top) { best = g; top = s; }
  }
  return best;
}
