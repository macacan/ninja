// Släppkort: ett kort per set med produktomgångar, produktbilder och läget i svenska butiker.
import { $, esc, kr, releaseSets, daysUntil, clockTime, liveStamp, setLogo, getJSON, API, safeUrl } from "./site.js";

const MON = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
const MONTH = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const LANG = { en: "Engelska", ja: "Japanska", ko: "Koreanska", zh: "Kinesiska", fr: "Franska" };
const d = (s) => new Date(`${s}T12:00:00`);
export const short = (s) => `${d(s).getDate()} ${MON[d(s).getMonth()]}`;
const long = (s) => `${d(s).getDate()} ${MONTH[d(s).getMonth()]} ${d(s).getFullYear()}`;
const inDays = (n) => (n === 0 ? "i dag" : n === 1 ? "i morgon" : `om ${n} dagar`);
const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const SHOW_STORES = 8;

// Samma typindelning som bevakningen använder, så att en omgångs produkter kan kopplas till butikernas.
const TYPES = [
  ["Elite Trainer Box", /elite trainer|\betb\b/i], ["Booster Bundle", /booster bundle/i],
  ["Booster Box", /booster ?box|display|booster case/i], ["Ultra-Premium Collection", /ultra[- ]premium|\bupc\b/i],
  ["Premium Collection", /premium collection|special collection/i], ["Collection Box", /collection|kollektion|ex box|\bbox\b/i],
  ["Tin", /\btins?\b/i], ["Blister", /blister|checklane|3[- ]?pack|2[- ]?pack/i], ["Build & Battle", /build (&|and) battle/i],
  ["Deck", /\bdeck\b/i], ["Booster Pack", /booster ?pack|booster\b/i],
];
export const typeOf = (name) => TYPES.find(([, re]) => re.test(name))?.[0] || null;

// ---------- Koppla omgångarnas produktnamn till butikernas produkter ----------
const GENERIC = new Set(["pokemon", "pokémon", "tcg", "the", "and", "och", "med", "mega", "evolution", "collection", "box", "pack", "booster",
  "mini", "tins", "tin", "deck", "premium", "ultra", "kollektion", "eng", "engelsk", "english"]);
const words = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) || [];
// Hela kartonger (case, "12 st", "6 boxes") jämförs inte med en enskild produkt.
const BULK = /\b(case|\d+ ?st|\d+ ?boxes)\b/i;

function productsFor(r, products) {
  const terms = (r.match || [r.set]).map((t) => t.toLowerCase());
  return products.filter((p) => (terms.some((t) => p.title.toLowerCase().includes(t)) || p.set === r.set) && (r.language !== "en" || p.lang === "en"));
}

const rankOffer = (p) => (p.available ? 0 : p.preorder ? 1 : 2);
const sortOffers = (list) => list.sort((a, b) => rankOffer(a) - rankOffer(b) || a.price - b.price);

// Ett item per produktnamn i omgångarna, med de butiksprodukter som motsvarar det.
function itemsFor(r, mine) {
  const setWords = new Set(words(`${r.set} ${(r.match || []).join(" ")}`));
  const own = (name) => new Set(words(name).filter((w) => w.length >= 3 && !GENERIC.has(w) && !setWords.has(w)));
  const all = r.waves.flatMap((w, wi) => w.products.map((name) => ({ name, date: w.date, wave: wi, type: typeOf(name), tokens: own(name) })));
  for (const it of all) {
    // Ord som bara syskonprodukter av samma typ har, t.ex. "center" för Pokémon Center ETB.
    const sib = new Set(all.filter((o) => o !== it && o.type === it.type).flatMap((o) => [...o.tokens]).filter((w) => !it.tokens.has(w)));
    const bulkOk = BULK.test(it.name);
    const score = (p) => { const t = new Set(words(p.title)); return [...it.tokens].filter((w) => t.has(w)).length - [...sib].filter((w) => t.has(w)).length; };
    let cands = mine.filter((p) => p.type === it.type && (bulkOk || !BULK.test(p.title)));
    let scored = cands.map((p) => [p, score(p)]);
    let best = Math.max(0, ...scored.map(([, s]) => s));
    if (it.tokens.size && best <= 0) {
      // Butikerna kan ha typat produkten annorlunda. Kräv då att alla utmärkande ord finns med.
      scored = mine.filter((p) => bulkOk || !BULK.test(p.title)).map((p) => [p, score(p)]);
      best = it.tokens.size;
    }
    it.offers = sortOffers(scored.filter(([, s]) => s >= best && (best > 0 || !it.tokens.size)).map(([p]) => p));
    it.image = it.offers.find((p) => p.image)?.image || null;
    it.upcoming = d(it.date) > startOfToday();
  }
  return all;
}

// Går en produkt att köpa före sitt släppdatum räknas den som förbeställning.
const isPre = (p, it) => (p.preorder && !p.available) || (p.available && it?.upcoming);
const isIn = (p, it) => p.available && !it?.upcoming;
function itemPrice(it) {
  const inS = it.offers.filter((p) => isIn(p, it)), pre = it.offers.filter((p) => isPre(p, it));
  if (inS.length) return { cls: "in", text: `Från ${kr(Math.min(...inS.map((p) => p.price)))}` };
  if (pre.length) return { cls: "pre", text: `Förbeställ från ${kr(Math.min(...pre.map((p) => p.price)))}` };
  if (it.offers.length) return { cls: "out", text: "Slut just nu" };
  return { cls: "none", text: "Inte listad än" };
}
const storeCount = (it) => new Set(it.offers.map((p) => p.store)).size;
const img = (src, cls = "") => src
  ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'ph'}))">`
  : '<span class="ph" aria-hidden="true"></span>';

// Rutor med bild, pris och antal butiker. Tryck på en ruta för att se butikerna som säljer den.
export function galleryHTML(items, key) {
  if (!items.length) return "";
  return `<div class="rg" data-key="${esc(key)}">${items.map((it, i) => {
    const pr = itemPrice(it), n = storeCount(it);
    return `<button type="button" class="rg-tile" data-item="${i}" aria-expanded="false"${it.offers.length ? "" : " disabled"}>
      <span class="rg-img">${img(it.image)}</span>
      <span class="rg-date">${short(it.date)}</span>
      <b>${esc(it.name)}</b>
      <span class="rg-price ${pr.cls}">${pr.text}</span>
      <small>${n ? `${n} ${n === 1 ? "butik" : "butiker"}` : "Vi säger till när den dyker upp"}</small>
    </button>`;
  }).join("")}</div><div class="rg-offers" hidden></div>`;
}

const offerStatus = (p, it) => (isIn(p, it) ? ["in", "I lager"] : isPre(p, it) ? ["pre", "Förbeställ"] : ["out", "Slut"]);
function offerRow(p, names, withStore = true, it = null) {
  const [cls, label] = offerStatus(p, it);
  return `<li class="of${p.available || p.preorder ? "" : " is-out"}">
    ${img(p.image, "of-img")}
    <span class="of-main">${withStore ? `<b>${esc(names[p.store] || p.store)}</b>` : ""}<span class="of-title">${esc(p.title)}</span></span>
    <span class="rs-st ${cls}">${label}</span>
    <span class="of-price">${kr(p.price)}</span>
    <a class="btn small${p.available || p.preorder ? " primary" : ""}" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener nofollow">${isIn(p, it) ? "Köp" : isPre(p, it) ? "Förbeställ" : "Till butiken"}</a>
  </li>`;
}
function offersHTML(it, names) {
  return `<div class="rg-offers-head"><b>${esc(it.name)}</b><span class="muted">${storeCount(it)} ${storeCount(it) === 1 ? "butik" : "butiker"} · ${it.upcoming ? `släpps ${short(it.date)} · ` : ""}billigast först</span>
    <button type="button" class="link rg-close">Stäng</button></div>
    <ul class="of-list">${it.offers.map((p) => offerRow(p, names, true, it)).join("")}</ul>`;
}

// Kopplar klick på rutorna i en behållare. lookup(key) ger items för rutnätet.
export function bindGallery(root, lookup, names) {
  root.addEventListener("click", (e) => {
    const close = e.target.closest(".rg-close");
    const tile = e.target.closest(".rg-tile");
    if (!tile && !close) return;
    const grid = (tile || close).closest(".rg, .rg-offers").parentElement.querySelector(".rg");
    const panel = grid.nextElementSibling;
    const was = tile?.getAttribute("aria-expanded") === "true";
    grid.querySelectorAll(".rg-tile").forEach((t) => t.setAttribute("aria-expanded", "false"));
    if (close || was) { panel.hidden = true; return; }
    tile.setAttribute("aria-expanded", "true");
    panel.innerHTML = offersHTML(lookup(grid.dataset.key)[+tile.dataset.item], names);
    panel.hidden = false;
    panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });
}

// ---------- Data, laddas en gång och delas av släppkort och kalender ----------
let dataPromise = null;
export function releaseData() {
  return (dataPromise ||= (async () => {
    const [releases, products, status] = await Promise.all([
      releaseSets(),
      fetch("data/products.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ products: [] })),
      fetch("data/stores-status.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ stores: [] })),
    ]);
    const names = Object.fromEntries(status.stores.map((s) => [s.id, s.name]));
    const items = new Map(), mine = new Map();
    for (const r of releases) { const m = productsFor(r, products.products); mine.set(r.id, m); items.set(r.id, itemsFor(r, m)); }
    return { releases, products, names, items, mine };
  })());
}

function status(r) {
  const today = startOfToday();
  const past = r.waves.filter((w) => d(w.date) < today), next = r.waves.find((w) => d(w.date) >= today);
  const pre = r.preliminary || next?.preliminary ? " (preliminärt)" : "";
  if (!past.length) return `${long(next.date)} · ${inDays(daysUntil(next.date))}${pre}`;
  if (!next) return `Släpptes ${long(r.waves[0].date)}`;
  return `Släpptes ${long(r.waves[0].date)} · nästa omgång ${short(next.date)}, ${inDays(daysUntil(next.date))}${pre}`;
}

// Butikernas läge för ett set, eventuellt bara för en omgångs produkttyper.
function storesFor(r, mineAll, names, waveTypes) {
  const mine = mineAll.filter((p) => !waveTypes || waveTypes.has(p.type));
  // Går en produkt att köpa före sitt släppdatum är det i praktiken en förbeställning.
  const today = startOfToday();
  const releaseOf = new Map();
  for (const w of r.waves) for (const name of w.products) { const t = typeOf(name); if (t && !releaseOf.has(t)) releaseOf.set(t, d(w.date)); }
  const firstWave = d(r.waves[0].date);
  const notOut = (p) => (releaseOf.get(p.type) || firstWave) > today;
  const by = new Map();
  for (const p of mine) {
    const s = by.get(p.store) || { id: p.store, name: names[p.store] || p.store, inT: new Set(), preT: new Set(), firstIn: null, firstPre: null, products: [] };
    s.products.push(p);
    if (p.available && notOut(p)) { s.preT.add(p.type); const t = p.firstOrderable || p.firstInStock; if (t) s.firstPre = Math.min(s.firstPre ?? Infinity, t); }
    else if (p.available) { s.inT.add(p.type); if (p.firstInStock) s.firstIn = Math.min(s.firstIn ?? Infinity, p.firstInStock); }
    else if (p.preorder) { s.preT.add(p.type); if (p.firstOrderable) s.firstPre = Math.min(s.firstPre ?? Infinity, p.firstOrderable); }
    by.set(p.store, s);
  }
  const rank = (s) => (s.inT.size ? 0 : s.preT.size ? 1 : 2);
  const t = (s) => (rank(s) === 0 ? s.firstIn : rank(s) === 1 ? s.firstPre : null) ?? Infinity;
  const list = [...by.values()].sort((a, b) => rank(a) - rank(b) || t(a) - t(b) || a.name.localeCompare(b.name, "sv"));
  return { list, orderable: list.filter((s) => rank(s) < 2).length };
}

function storeRow(s, names) {
  const st = s.inT.size ? ["in", "I lager"] : s.preT.size ? ["pre", "Förbeställning"] : ["listed", "Listad"];
  const items = s.inT.size ? `I lager: ${[...s.inT].join(", ")}` : s.preT.size ? `Förbeställ: ${[...s.preT].join(", ")}` : "Slut just nu";
  const when = s.inT.size && s.firstIn ? `Först i lager ${clockTime(s.firstIn)}` : s.preT.size && s.firstPre ? `Beställbar sedan ${clockTime(s.firstPre)}` : "";
  const thumbs = sortOffers([...s.products]).filter((p) => p.image).slice(0, 3);
  return `<li class="rs">
    <button type="button" class="rs-btn" aria-expanded="false">
      <span class="rs-top"><b>${esc(s.name)}</b><span class="rs-st ${st[0]}">${st[1]}</span></span>
      <span class="rs-items">${esc(items)}</span>
      ${when ? `<span class="rs-when">${when}</span>` : ""}
      <span class="rs-foot"><span class="rs-thumbs">${thumbs.map((p) => img(p.image)).join("")}</span><span class="rs-more">${s.products.length} ${s.products.length === 1 ? "produkt" : "produkter"} <i aria-hidden="true"></i></span></span>
    </button>
    <ul class="of-list rs-products" hidden>${sortOffers([...s.products]).map((p) => offerRow(p, names, false)).join("")}</ul>
  </li>`;
}

function card(r, ctx) {
  const today = startOfToday();
  const next = r.waves.find((w) => d(w.date) >= today) || r.waves[r.waves.length - 1];
  const head = r.waves.every((w) => d(w.date) < today) ? r.waves[0] : next;
  const logo = ctx.logos.get(r.tcgdex) || null;
  const items = ctx.items.get(r.id);
  const meta = [r.series, LANG[r.language] || r.language, r.preliminary ? "Preliminärt datum" : ""].filter(Boolean).join(" · ");
  return `<article class="rel" id="rel-${esc(r.id)}" data-id="${esc(r.id)}">
    <div class="rel-date${d(head.date) < today ? " past" : ""}"><b>${d(head.date).getDate()}</b><span>${MON[d(head.date).getMonth()]}</span></div>
    <div class="rel-main">
      <span class="rel-meta">${esc(meta)}</span>
      <h3>${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : ""}<span>${esc(r.set)}</span></h3>
      <p class="rel-status">${esc(status(r))}</p>
      ${r.about ? `<p class="rel-about">${esc(r.about)}</p>` : ""}
      ${r.prerelease ? `<p class="rel-pre">Förrelease i spelbutiker ${short(r.prerelease.from)}–${short(r.prerelease.to)}</p>` : ""}
      <h4>Omgångar</h4>
      <div class="waves" role="group" aria-label="Omgångar">
        ${r.waves.map((w, i) => {
          const th = items.filter((it) => it.wave === i && it.image).slice(0, 4);
          return `<button type="button" class="wave${d(w.date) < today ? " done" : ""}" data-i="${i}" aria-pressed="false">
          <span class="wd">${short(w.date)}</span><span class="wp">${esc(w.products.join(" · "))}${w.preliminary ? ' <em>preliminärt</em>' : ""}</span>
          <span class="wthumbs" aria-hidden="true">${th.map((it) => img(it.image)).join("")}</span></button>`;
        }).join("")}
      </div>
      <h4 class="rel-gh">Produkter <span class="muted">· tryck på en produkt för att jämföra butikerna</span></h4>
      <div class="rel-gallery"></div>
      <h4>I svenska butiker</h4>
      <div class="rel-stores"></div>
      <div class="rel-cta">
        <a class="btn primary small" href="butiker.html#notiser">Få notis när ${esc(r.set)} kommer in</a>
        <a class="btn small" href="butiker.html?q=${encodeURIComponent(r.match?.[0] || r.set)}#products">Se produkter och priser</a>
      </div>
    </div>
  </article>`;
}

function renderGallery(el, r, ctx, waveIndex = null) {
  const key = `${r.id}|${waveIndex ?? ""}`;
  el.innerHTML = galleryHTML(ctx.lookup(key), key);
}

function renderStores(el, r, ctx, waveIndex = null, showAll = false) {
  const w = waveIndex == null ? null : r.waves[waveIndex];
  const types = w ? new Set(w.products.map(typeOf).filter(Boolean)) : null;
  const { list, orderable } = storesFor(r, ctx.mine.get(r.id), ctx.names, types);
  const scope = w ? `Visar produkterna från ${short(w.date)}` : "Visar hela setet · tryck på en omgång ovan för att se bara den";
  if (!list.length) {
    el.innerHTML = `<p class="rel-sum">${scope}</p><p class="msg">Ingen svensk butik har listat det än. Vi säger till så fort någon gör det.</p>`;
    return;
  }
  const rows = showAll ? list : list.slice(0, SHOW_STORES);
  el.innerHTML = `<p class="rel-sum">${scope} · tryck på en butik för att se dess produkter</p>
    <p class="rel-count"><b>${list.length}</b> ${list.length === 1 ? "butik listar" : "butiker listar"} det · <b>${orderable}</b> går att beställa</p>
    <ul class="rs-list">${rows.map((s) => storeRow(s, ctx.names)).join("")}</ul>
    ${list.length > SHOW_STORES && !showAll ? `<button type="button" class="btn small more-stores">Visa alla ${list.length} butiker</button>` : ""}`;
}

// Väljer en omgång i ett släppkort (används också från kalendern).
export function selectWave(art, i) {
  const wave = art.querySelector(`.wave[data-i="${i}"]`);
  wave?.click();
}

export async function mountReleases(root, stampEl) {
  const data = await releaseData();
  const { releases, products, names, items, mine } = data;
  // Setloggor från TCGdex (eller reservkällan) för set som har ett TCGdex-id.
  const logos = new Map();
  await Promise.all(releases.filter((r) => r.tcgdex).map(async (r) => {
    try { logos.set(r.tcgdex, setLogo(await getJSON(`${API}/sets/${encodeURIComponent(r.tcgdex)}`))); } catch {}
  }));
  const lookup = (key) => { const [id, w] = key.split("|"); return items.get(id).filter((it) => w === "" || it.wave === +w); };
  const ctx = { names, logos, items, mine, lookup };

  const today = startOfToday();
  const recent = (r) => r.waves.some((w) => (d(w.date) - today) / 864e5 > -45);
  const nextDate = (r) => (r.waves.find((w) => d(w.date) >= today) || r.waves[r.waves.length - 1]).date;
  const shown = releases.filter(recent).sort((a, b) => nextDate(a).localeCompare(nextDate(b)));
  root.innerHTML = shown.map((r) => card(r, ctx)).join("") || '<div class="msg">Inga släpp inlagda just nu.</div>';
  for (const el of root.querySelectorAll(".rel")) {
    const r = releases.find((x) => x.id === el.dataset.id);
    renderGallery(el.querySelector(".rel-gallery"), r, ctx);
    renderStores(el.querySelector(".rel-stores"), r, ctx);
  }
  if (stampEl) liveStamp(stampEl, products.updated, "Butiker uppdaterade");
  bindGallery(root, lookup, names);

  root.addEventListener("click", (e) => {
    const art = e.target.closest(".rel"); if (!art) return;
    const r = releases.find((x) => x.id === art.dataset.id);
    // Tryck på en omgång för att filtrera produkter och butiker, tryck igen för hela setet.
    const wave = e.target.closest(".wave");
    if (wave) {
      const on = wave.getAttribute("aria-pressed") !== "true";
      art.querySelectorAll(".wave").forEach((b) => b.setAttribute("aria-pressed", "false"));
      wave.setAttribute("aria-pressed", String(on));
      renderGallery(art.querySelector(".rel-gallery"), r, ctx, on ? +wave.dataset.i : null);
      renderStores(art.querySelector(".rel-stores"), r, ctx, on ? +wave.dataset.i : null);
    }
    if (e.target.closest(".more-stores")) {
      const pressed = art.querySelector('.wave[aria-pressed="true"]');
      renderStores(art.querySelector(".rel-stores"), r, ctx, pressed ? +pressed.dataset.i : null, true);
    }
    // Tryck på en butik för att fälla ut dess produkter.
    const sb = e.target.closest(".rs-btn");
    if (sb) {
      const open = sb.getAttribute("aria-expanded") !== "true";
      sb.setAttribute("aria-expanded", String(open));
      sb.nextElementSibling.hidden = !open;
      sb.closest(".rs").classList.toggle("open", open);
    }
  });
  return data;
}
