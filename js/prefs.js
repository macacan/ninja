// Besökarens bevakningsval. Sparas bara i den här webbläsaren, inget konto behövs.
const KEY = "nl:prefs";
// Bara http(s)-länkar öppnas från en notis.
const safeUrl = (u) => { if (!u) return "#"; try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : "#"; } catch { return "#"; } };
export const KINDS = {
  ny: "Ny produkt",
  tillbaka: "Tillbaka i lager",
  prissankt: "Prissänkt",
  forbestallning: "Förbeställning öppen",
};
const DEFAULTS = { stores: [], types: [], sets: [], langs: [], kinds: Object.keys(KINDS), maxPrice: 0, browser: false, lastSeen: 0, watch: [] };

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
  if (p.kinds.length && !p.kinds.includes(e.kind)) return false;
  if (p.stores.length && !p.stores.includes(e.store)) return false;
  if (p.types.length && !p.types.includes(e.type)) return false;
  if (p.sets.length && !p.sets.includes(product?.set ?? e.set)) return false;
  if (p.langs?.length && !p.langs.includes(product?.lang ?? e.lang)) return false;
  if (p.maxPrice > 0 && e.price > p.maxPrice) return false;
  return true;
}

export const hasFilters = (p = getPrefs()) =>
  p.stores.length > 0 || p.types.length > 0 || p.sets.length > 0 || p.langs?.length > 0 || p.maxPrice > 0 || p.kinds.length < Object.keys(KINDS).length;

// Webbläsarnotiser medan någon Ninjaloot-flik är öppen. Kollar händelserna varannan minut.
const POLL_MS = 2 * 60e3;
export function startBrowserNotices() {
  const p = getPrefs();
  if (!p.browser || !("Notification" in window) || Notification.permission !== "granted") return;
  const check = async () => {
    const prefs = getPrefs();
    if (!prefs.browser) return;
    let data;
    try { data = await (await fetch("data/events.json", { cache: "no-cache" })).json(); } catch { return; }
    const fresh = data.events.filter((e) => e.at > prefs.lastSeen && matches(e, prefs));
    if (!prefs.lastSeen) { prefs.lastSeen = data.updated; savePrefs(prefs); return; } // första gången: inga gamla notiser
    prefs.lastSeen = Math.max(prefs.lastSeen, ...data.events.map((e) => e.at));
    savePrefs(prefs);
    if (!fresh.length) return;
    if (fresh.length > 3) {
      new Notification("Ninjaloot", { body: `${fresh.length} nya händelser som matchar ditt urval.`, icon: "logo.svg", tag: "nl-summary" });
      return;
    }
    for (const e of fresh) {
      const n = new Notification(`${KINDS[e.kind] || e.kind}: ${e.title}`, { body: `${Math.round(e.price).toLocaleString("sv-SE")} kr`, icon: "logo.svg", tag: `nl-${e.product}-${e.at}` });
      n.onclick = () => { window.open(safeUrl(e.url), "_blank", "noopener"); n.close(); };
    }
  };
  check();
  setInterval(check, POLL_MS);
}
