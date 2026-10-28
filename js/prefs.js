// Besökarens bevakningsval. Sparas i den här webbläsaren, inget konto behövs. Med pushnotiser på skickas en kopia
// av urvalet till servern, så att notiserna kan filtreras där (js/push.js).
const KEY = "nl:prefs";
export const KINDS = {
  ny: "Ny produkt",
  tillbaka: "Tillbaka i lager",
  prissankt: "Prissänkt",
  forbestallning: "Förbeställning öppen",
};
export const GAMES = { pk: "Pokémon", op: "One Piece", rb: "Riftbound" };
const DEFAULTS = { stores: [], types: [], sets: [], langs: [], games: [], kinds: Object.keys(KINDS), maxPrice: 0, push: false, watch: [] };
// Spelen man får besked om. Till skillnad från de andra listorna betyder en tom lista bara Pokémon, så att
// de som slog på notiser innan Riftbound fanns inte plötsligt får Riftbound-notiser. Samma regel i notify.mjs.
export const gamesOf = (p) => (p.games?.length ? p.games : ["pk"]);

export function getPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { ...DEFAULTS }; }
}
export function savePrefs(p) {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch {}
}

// Tom lista betyder "alla". Produkt kan saknas för gamla händelser, då räcker händelsens egna fält.
export function matches(e, p = getPrefs(), product = null) {
  // Produkter man bevakar med klockan ger alltid besked, oavsett övriga val.
  if (e.group && (p.watch || []).includes(e.group)) return true;
  if (!gamesOf(p).includes((product ?? e).game || "pk")) return false;
  if (p.kinds.length && !p.kinds.includes(e.kind)) return false;
  if (p.stores.length && !p.stores.includes(e.store)) return false;
  if (p.types.length && !p.types.includes(e.type)) return false;
  if (p.sets.length && !p.sets.includes(product?.set ?? e.set)) return false;
  if (p.langs?.length && !p.langs.includes(product?.lang ?? e.lang)) return false;
  if (p.maxPrice > 0 && e.price > p.maxPrice) return false;
  return true;
}

export const hasFilters = (p = getPrefs()) =>
  gamesOf(p).join() !== "pk" || p.stores.length > 0 || p.types.length > 0 || p.sets.length > 0 || p.langs?.length > 0 || p.maxPrice > 0 || p.kinds.length < Object.keys(KINDS).length;
