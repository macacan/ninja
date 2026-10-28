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
