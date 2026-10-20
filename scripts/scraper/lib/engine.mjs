// Bevakningens motor: läser en butik, slår ihop med senast kända läge och hittar förändringar.
// Används både av run.mjs (en körning över alla butiker) och daemon.mjs (löpande, varannan minut).
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { Host } from "./http.mjs";
import { classify, CLASSIFY_VERSION, looksPokemonTitle } from "./classify.mjs";
import { notify } from "./notify.mjs";
import { shopify } from "../adapters/shopify.mjs";
import { woocommerce } from "../adapters/woocommerce.mjs";
import { generic } from "../adapters/generic.mjs";
import { groupKey, groupProducts, lowestInStock } from "../../../js/group.js";

const ROOT = new URL("../../../", import.meta.url);
const file = (p) => new URL(p, ROOT);
// Bara vanliga webbadresser sparas. En "javascript:"- eller "data:"-adress från en butik kunde annars bli en farlig länk på sidan.
const webUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const readJSON = async (p, fallback) => { try { return JSON.parse(await readFile(file(p), "utf8")); } catch { return fallback; } };
// Skriv till en temporär fil och byt namn, så att sidan aldrig läser en halvskriven fil.
// Stora filer sparas utan indrag (hälften så stora att ladda och att spara i git).
async function writeJSON(p, d, compact = false) {
  const tmp = file(`${p}.tmp`);
  await writeFile(tmp, (compact ? JSON.stringify(d) : JSON.stringify(d, null, 1)) + "\n");
  // På Windows kan namnbytet nekas en kort stund om en annan process (t.ex. webbservern) läser filen.
  for (let i = 0; ; i++) {
    try { await rename(tmp, file(p)); return; }
    catch (e) { if (i >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e; await new Promise((r) => setTimeout(r, 200 * (i + 1))); }
  }
}

const ADAPTERS = { shopify, woocommerce, generic };
const ROBOTS_MAX_AGE = 6 * 3600e3;
const MAX_EVENTS = 500;
// En produkt som försvinner ur butikens lista och kommer tillbaka inom två veckor är inte "ny".
const GONE_DAYS = 14;
// Samma produkt ger högst en prissänkningsnotis per vecka, om priset inte går under den förra sänkningen.
const DROP_COOLDOWN = 7 * 864e5;

export async function createEngine({ statuses } = {}) {
  // Butiker med status "forbjuden" eller "okand" hämtas aldrig, oavsett inställning.
  const ALLOWED = ["tillstand", "ej-forbjuden", "inga-bilder"];
  const allowedStatuses = (statuses || process.env.SCRAPE_STATUSES || ALLOWED.join(",")).split(",").filter((s) => ALLOWED.includes(s));
  const { stores } = await readJSON("scripts/scraper/stores.json", { stores: [] });
  const state = await readJSON("scripts/scraper/state.json", {});
  const cfg = await readJSON("scripts/scraper/config.json", {});
  const products = new Map(); // butik → produkter
  for (const p of (await readJSON("data/products.json", { products: [] })).products) {
    if (!products.has(p.store)) products.set(p.store, []);
    products.get(p.store).push(p);
  }
  let events = (await readJSON("data/events.json", { events: [] })).events;
  const status = Object.fromEntries((await readJSON("data/stores-status.json", { stores: [] })).stores.map((s) => [s.id, s]));
  const hosts = new Map();
  // Ny version av igenkänningen: varje butiks nästa lyckade kontroll sparar nyfunna produkter tyst.
  if (state.classifyVersion !== CLASSIFY_VERSION) {
    state.classifyVersion = CLASSIFY_VERSION;
    state.reclassify = stores.map((s) => s.id);
    // Sitemap-butiker: sidor som avvisades men vars adress ser ut som en Pokémon-produkt läses om snart
    // (som om de vore över en vecka gamla), så att den nya igenkänningen hinner pröva dem.
    const slug = (u) => { try { return decodeURIComponent(new URL(u).pathname).replace(/[-_/]+/g, " "); } catch { return u; } };
    for (const s of stores) for (const [u, v] of Object.entries(state[s.id]?.pages || {})) {
      if (v?.k === "x" && looksPokemonTitle(slug(u), state.sets?.names || [])) v.t = 0;
    }
  }
  // Prishistorik: lägsta pris i lager per produktgrupp och dag. Sparas i data/price-history.json.
  const history = (await readJSON("data/price-history.json", { days: {} })).days || {};
  const HISTORY_DAYS = 180;
  const storeName = Object.fromEntries(stores.map((s) => [s.id, s.name]));

  // Setnamn från TCGdex, för att tagga produkter med rätt set. Uppdateras högst en gång per dygn.
  if (!state.sets?.series || Date.now() - state.sets.t > 864e5) {
    try {
      const [sets, series] = await Promise.all(["sets", "series"].map(async (p) => (await fetch(`https://api.tcgdex.net/v2/en/${p}`)).json()));
      state.sets = { t: Date.now(), names: [...new Set(sets.map((s) => s.name))], series: series.map((s) => s.name) };
    } catch { state.sets ||= { t: 0, names: [], series: [] }; }
  }

  // En Host per butik som lever kvar mellan varven, så att pauser och robots.txt följer med.
  async function hostFor(store) {
    const h = hosts.get(store.id);
    if (h && Date.now() - h.at < ROBOTS_MAX_AGE) return h.host;
    const host = await new Host(store.domain).init();
    if (h) { host.last = h.host.last; host.delay = Math.max(host.delay, h.host.delay); }
    hosts.set(store.id, { host, at: Date.now() });
    return host;
  }

  async function scrape(store, { pagesPerRun = 25, sitemapMaxAge = 0 } = {}) {
    const t0 = Date.now();
    try {
      const host = await hostFor(store);
      const before = host.requests;
      // Upp till 40 sidor: stora Shopify-butiker (Aquitaz, Dragon's Lair, RGB Kingz) har över 3 000 produkter.
      const ctx = { maxPages: 40, pagesPerRun, sitemapMaxAge, state: (state[store.id] ||= {}), setNames: state.sets.names, listing: store.listing };
      const raw = await ADAPTERS[store.platform](host, ctx);
      const list = [], same = new Set();
      for (const r of raw) {
        const c = classify(r.title, state.sets.names, state.sets.series);
        if (!c || !(r.price > 0)) continue;
        // Bara svenska priser. Butiker med flera språkversioner (t.ex. /fi/, /dk/) visar annars euro och danska kronor.
        if (r.currency && r.currency.toUpperCase() !== "SEK") continue;
        // Samma produkt under två adresser (t.ex. språkversioner eller dubbla listningar) räknas en gång.
        const twin = `${r.title.trim().toLowerCase()}|${r.price}`;
        if (same.has(twin)) continue;
        same.add(twin);
        // Butiker vars villkor skyddar bilderna (status "inga-bilder") visas utan produktbild.
        const image = store.status === "inga-bilder" ? null : webUrl(r.image);
        const url = webUrl(r.url);
        if (!url) continue;
        list.push({ id: `${store.id}:${r.pid}`, store: store.id, title: r.title.trim(), url, price: Math.round(r.price * 100) / 100,
          currency: r.currency, available: r.available, preorder: !!r.preorder, image, ...c, isNew: r.isNew });
      }
      return { ok: true, products: list, partial: raw.partial, known: raw.known, requests: host.requests - before, ms: Date.now() - t0, delay: host.delay };
    } catch (e) {
      return { ok: false, error: e.message.slice(0, 160), ms: Date.now() - t0, blocked: !!e.blocked, retryAfter: e.retryAfter || 0 };
    }
  }

  // Senaste kända läge för produkter som försvunnit ur butikens lista (state.gone[butik][id]).
  const gone = (state.gone ||= {});
  function tombstone(storeId, id) {
    const t = gone[storeId]?.[id];
    return t && Date.now() - t.goneAt < GONE_DAYS * 864e5 ? t : null;
  }

  // Slår ihop ett resultat med butikens senast kända läge och returnerar nya händelser.
  function apply(store, res, extra = {}) {
    const now = Date.now();
    const old = products.get(store.id) || [];
    const found = [];
    const prev = status[store.id];
    if (res.ok) {
      const oldById = new Map(old.map((p) => [p.id, p]));
      // Bara den allra första lyckade kontrollen av en butik är tyst. Tidigare räckte ett enda fel (timeout)
      // för att nästa lyckade kontroll också blev tyst, och då missades påfyllningar.
      const firstRun = !prev?.lastOkAt && !prev?.ok && !old.length;
      const quiet = (state.reclassify || []).includes(store.id);
      const fresh = new Map(res.products.map((p) => [p.id, p]));
      const merged = [];
      for (const p of res.products) {
        // Fanns produkten nyss men föll bort ur listan (sidbyte under läsning, tillfälligt dold)
        // jämför vi med hur den såg ut då, så att den inte larmas som ny.
        const o = oldById.get(p.id) || tombstone(store.id, p.id);
        if (gone[store.id]?.[p.id]) delete gone[store.id][p.id];
        const isNew = p.isNew ?? true;
        delete p.isNew;
        p.firstSeen = o?.firstSeen || now;
        p.lastChange = o && o.available === p.available && o.price === p.price ? o.lastChange : now;
        // När produkten först kom i lager och först gick att förbeställa. Okänt (null) om den redan
        // var det första gången vi såg butiken, eftersom vi då inte vet när det hände.
        const brandNew = !firstRun && !(quiet && !o) && (!o || isNew);
        p.firstInStock = o?.firstInStock ?? (p.available && (o ? !o.available : brandNew) ? now : null);
        p.firstOrderable = o?.firstOrderable ?? (p.preorder && (o ? !o.preorder : brandNew) ? now : null);
        // Första gången vi ser en butik sparar vi bara läget, så att ingen får hundratals "nya" notiser.
        if (!firstRun) {
          const base = { at: now, store: store.id, product: p.id, group: groupKey(p), title: p.title, url: p.url, price: p.price, type: p.type, set: p.set, lang: p.lang };
          if (!o && isNew && !quiet && (p.available || p.preorder)) found.push({ ...base, kind: p.preorder && !p.available ? "forbestallning" : "ny" });
          else if (o && !o.available && !o.preorder && p.preorder && !p.available) found.push({ ...base, kind: "forbestallning" });
          else if (o && !o.available && p.available) found.push({ ...base, kind: "tillbaka" });
          // Mer än 60 % billigare är nästan alltid fel valuta (dollar i stället för kronor), inte en rea.
          else if (o && (p.available || p.preorder) && p.price < o.price * 0.99 && p.price >= o.price * 0.4) {
            // Pris som pendlar (rea av och på) ska inte ge en ny notis varje varv.
            const last = o.lastDrop;
            if (!last || now - last.at > DROP_COOLDOWN || p.price < last.price * 0.99) {
              found.push({ ...base, kind: "prissankt", from: o.price });
              p.lastDrop = { price: p.price, at: now };
            }
          }
        }
        // Priset blev över tre gånger högre: det gamla var i fel valuta (dollarpriser från Shopify Markets,
        // se adapters/shopify.mjs). Ta bort produktens falska prissänkningar och orimligt låga historikpunkter.
        if (o && o.price > 0 && p.price > o.price * 3) {
          delete p.lastDrop;
          events = events.filter((ev) => !(ev.product === p.id && ev.kind === "prissankt"));
          const pts = history[groupKey(p)];
          if (pts) history[groupKey(p)] = pts.filter(([, v]) => v >= p.price * 0.35);
        } else p.lastDrop ||= o?.lastDrop;
        merged.push(p);
      }
      // Delvis genomläsning (sitemap-butiker): behåll produkter vi inte hann läsa om, om de finns kvar i sitemapen.
      if (res.partial) for (const o of old) if (!fresh.has(o.id) && (!res.known || res.known.has(o.url) || res.known.has(o.id.split(":").slice(1).join(":")))) merged.push(o);
      // Det som föll bort sparas en tid som gravsten.
      const keep = new Set(merged.map((p) => p.id));
      for (const o of old) if (!keep.has(o.id)) (gone[store.id] ||= {})[o.id] = { ...o, goneAt: now };
      for (const [id, t] of Object.entries(gone[store.id] || {})) if (now - t.goneAt > GONE_DAYS * 864e5) delete gone[store.id][id];
      products.set(store.id, merged);
      if (quiet) state.reclassify = state.reclassify.filter((id) => id !== store.id);
      events = [...found, ...events].slice(0, MAX_EVENTS);
    }
    status[store.id] = {
      id: store.id, name: store.name, domain: store.domain, status: store.status,
      checkedAt: now, ok: res.ok, lastOkAt: res.ok ? now : prev?.lastOkAt ?? null, count: (products.get(store.id) || []).length,
      error: res.ok ? null : res.error, blocked: !!res.blocked,
      note: res.blocked ? "Butiken har ett botskydd som stoppar oss. Bevakningen är pausad." : null, ...extra,
    };
    return found;
  }

  // Två sparningar får aldrig gå samtidigt (de skriver samma temporära filer).
  let saving = null;
  async function save() {
    while (saving) await saving.catch(() => {});
    saving = doSave();
    try { return await saving; } finally { saving = null; }
  }

  async function doSave() {
    const now = Date.now();
    const all = stores.flatMap((s) => products.get(s.id) || []);
    const statusList = stores.map((s) => status[s.id] && allowedStatuses.includes(s.status)
      ? status[s.id]
      : { id: s.id, name: s.name, domain: s.domain, status: s.status, checkedAt: status[s.id]?.checkedAt ?? null, ok: status[s.id]?.ok ?? null,
        count: (products.get(s.id) || []).length, error: null, note: allowedStatuses.includes(s.status) ? null : s.note });
    await mkdir(file("data/"), { recursive: true });
    await writeJSON("data/products.json", { updated: now, products: all }, true);
    // Dagens lägsta pris i lager per grupp. Under dagen behålls det lägsta vi sett.
    const today = new Date(now).toLocaleDateString("sv-SE");
    const oldest = new Date(now - HISTORY_DAYS * 864e5).toLocaleDateString("sv-SE");
    for (const [key, members] of groupProducts(all)) {
      const low = lowestInStock(members);
      if (low == null) continue;
      const pts = (history[key] ||= []);
      const last = pts[pts.length - 1];
      if (last && last[0] === today) last[1] = Math.min(last[1], low);
      else pts.push([today, low]);
      while (pts.length && pts[0][0] < oldest) pts.shift();
    }
    await writeJSON("data/price-history.json", { updated: now, days: history }, true);
    await writeJSON("data/events.json", { updated: now, events });
    await writeJSON("data/stores-status.json", { updated: now, stores: statusList });
    await writeJSON("data/notify.json", { ntfyTopic: process.env.NTFY_TOPIC || cfg.ntfyTopic || null });
    await writeJSON("scripts/scraper/state.json", state, true);
    return all.length;
  }

  return {
    stores, cfg, allowed: stores.filter((s) => allowedStatuses.includes(s.status)),
    scrape, apply, save, hostFor,
    notify: (list) => notify(list, storeName, cfg),
  };
}
