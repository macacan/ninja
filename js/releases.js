// Släpp: data, koppling till butikernas produkter och vyerna på släppsidan.
//   Data:  releaseData() laddar släppkalendern (data/release-calendar.json) och butikernas produkter en gång.
//   Vyer:  nextHTML (nästa släpp), releaseCard (kompakt kort), detailHTML (allt om ett släpp, i en dialog),
//          galleryHTML + bindGallery (produktrutor med butiker), används också av kalenderns dagvy.
import { esc, kr, releaseSets, daysUntil, clockTime, setLogo, getJSON, API, safeUrl, setPages } from "./site.js";
import { getAnatomyData, matchAnatomy, renderAnatomyModal } from "./anatomy.js";

let anatomyData = null;
getAnatomyData().then((d) => (anatomyData = d)).catch(() => {});

const MON = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];
const MONTH = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
export const LANG = { en: "Engelska", ja: "Japanska", ko: "Koreanska", zh: "Kinesiska", fr: "Franska" };
const d = (s) => new Date(`${s}T12:00:00`);
export const short = (s) => `${d(s).getDate()} ${MON[d(s).getMonth()]}`;
const long = (s) => `${d(s).getDate()} ${MONTH[d(s).getMonth()]} ${d(s).getFullYear()}`;
const inDays = (n) => (n === 0 ? "i dag" : n === 1 ? "i morgon" : n > 0 ? `om ${n} dagar` : `för ${-n} dagar sedan`);
const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
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
    let scored = mine.filter((p) => p.type === it.type && (bulkOk || !BULK.test(p.title))).map((p) => [p, score(p)]);
    let best = Math.max(0, ...scored.map(([, s]) => s));
    if (it.tokens.size && best <= 0) {
      // Butikerna kan ha typat produkten annorlunda. Kräv då att alla utmärkande ord finns med.
      scored = mine.filter((p) => bulkOk || !BULK.test(p.title)).map((p) => [p, score(p)]);
      best = it.tokens.size;
    }
    it.offers = sortOffers(scored.filter(([, s]) => s >= best && (best > 0 || !it.tokens.size)).map(([p]) => p));
    // Officiell bild från pokemon.com om den finns (data/releases.json → images), annars en butiks bild.
    it.official = r.images?.[it.name] || null;
    it.image = it.official || it.offers.find((p) => p.image)?.image || null;
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

// ---------- Butikernas läge ----------
// Per butik: vilka produkttyper som finns i lager och vilka som går att förbeställa.
// waveIndex begränsar till en omgångs produkttyper.
function storesFor(r, ctx, waveIndex = null) {
  const w = waveIndex == null ? null : r.waves[waveIndex];
  const types = w?.products.length ? new Set(w.products.map(typeOf).filter(Boolean)) : null;
  const mine = ctx.mine.get(r.id).filter((p) => !types || types.has(p.type));
  const today = startOfToday();
  const releaseOf = new Map();
  for (const x of r.waves) for (const name of x.products) { const t = typeOf(name); if (t && !releaseOf.has(t)) releaseOf.set(t, d(x.date)); }
  const firstWave = r.waves[0] ? d(r.waves[0].date) : today;
  const notOut = (p) => (releaseOf.get(p.type) || firstWave) > today;
  const by = new Map();
  for (const p of mine) {
    const s = by.get(p.store) || { id: p.store, name: ctx.names[p.store] || p.store, inT: new Set(), preT: new Set(), firstIn: null, firstPre: null, products: [] };
    s.products.push(p);
    if (p.available && notOut(p)) { s.preT.add(p.type); const t = p.firstOrderable || p.firstInStock; if (t) s.firstPre = Math.min(s.firstPre ?? Infinity, t); }
    else if (p.available) { s.inT.add(p.type); if (p.firstInStock) s.firstIn = Math.min(s.firstIn ?? Infinity, p.firstInStock); }
    else if (p.preorder) { s.preT.add(p.type); if (p.firstOrderable) s.firstPre = Math.min(s.firstPre ?? Infinity, p.firstOrderable); }
    by.set(p.store, s);
  }
  const rank = (s) => (s.inT.size ? 0 : s.preT.size ? 1 : 2);
  const t = (s) => (rank(s) === 0 ? s.firstIn : rank(s) === 1 ? s.firstPre : null) ?? Infinity;
  const list = [...by.values()].sort((a, b) => rank(a) - rank(b) || t(a) - t(b) || a.name.localeCompare(b.name, "sv"));
  return { list, inStock: list.filter((s) => rank(s) === 0).length, preorder: list.filter((s) => rank(s) === 1).length };
}

// En kort lägesetikett för ett släpp eller en omgång: i lager, förbeställ, listad eller inte listad än.
export function pill(r, ctx, waveIndex = null) {
  const { list, inStock, preorder } = storesFor(r, ctx, waveIndex);
  const w = waveIndex == null ? null : r.waves[waveIndex];
  const upcoming = w ? d(w.date) > startOfToday() : nextWave(r) && d(nextWave(r).date) > startOfToday();
  if (inStock) return { cls: "in", text: `I lager · ${plural(inStock, "butik", "butiker")}` };
  if (preorder) return { cls: "pre", text: `Förbeställ · ${plural(preorder, "butik", "butiker")}` };
  if (list.length) return { cls: "out", text: "Slut just nu" };
  return { cls: "none", text: upcoming ? "Inte listad än" : "Inga butiker" };
}
const pillHTML = (p) => `<span class="pill ${p.cls}">${esc(p.text)}</span>`;

// ---------- Datum och status ----------
export const nextWave = (r) => r.waves.find((w) => d(w.date) >= startOfToday()) || null;
const lastWave = (r) => r.waves[r.waves.length - 1] || null;
export const isOver = (r) => r.waves.length > 0 && !nextWave(r);

function status(r) {
  if (!r.waves.length) return "Annonserat, datum inte klart";
  const today = startOfToday();
  const past = r.waves.filter((w) => d(w.date) < today), next = nextWave(r);
  const pre = r.preliminary || next?.preliminary ? " (preliminärt)" : "";
  if (!past.length) return `Släpps ${long(next.date)} · ${inDays(daysUntil(next.date))}${pre}`;
  if (!next) return `Släpptes ${long(r.waves[0].date)}`;
  return `Släpptes ${long(r.waves[0].date)} · nästa omgång ${short(next.date)}, ${inDays(daysUntil(next.date))}${pre}`;
}
const meta = (r) => [r.series, LANG[r.language] || r.language].filter(Boolean).join(" · ");
const waveText = (w, r) => (w.products.length === 1 && w.products[0] === r.set ? "Fristående produkt"
  : w.products.length ? w.products.join(" · ") : r.auto && r.waves.length === 1 ? "Setet släpps" : "Produkter inte klara än");
const logoHTML = (r, ctx, cls) => {
  const logo = ctx.logos.get(r.id);
  return logo ? `<img class="${cls}" src="${esc(logo)}" alt="" loading="lazy" decoding="async">` : `<span class="${cls} wordlogo">${esc(r.set)}</span>`;
};
const dateBox = (s, cls = "") => s
  ? `<span class="datebox ${cls}${d(s) < startOfToday() ? " past" : ""}"><b>${d(s).getDate()}</b><span>${MON[d(s).getMonth()]}</span></span>`
  : `<span class="datebox ${cls} tbd"><b>?</b><span>datum</span></span>`;

// ---------- Vyer ----------
// Det allra närmaste släppet, stort överst på sidan.
export function nextHTML(r, ctx) {
  const w = nextWave(r), wi = r.waves.indexOf(w);
  const days = daysUntil(w.date);
  return `<div class="next-rel">
    ${dateBox(w.date, "big")}
    <div class="next-main">
      <span class="kicker">Nästa släpp · ${esc(inDays(days))}</span>
      <h3>${esc(r.set)}</h3>
      <p>${esc(waveText(w, r))}</p>
      <div class="next-foot">${pillHTML(pill(r, ctx, wi))}<button type="button" class="btn small primary" data-open="${esc(r.id)}" data-wave="${wi}">Produkter och butiker</button></div>
    </div>
    ${ctx.logos.get(r.id) ? `<img class="next-logo" src="${esc(ctx.logos.get(r.id))}" alt="" loading="lazy">` : ""}
  </div>`;
}

// ---------- Tidslinje ----------
// Ett steg per datum, med alla set som släpps då. Utgångsläget visar aktuellt släpp (det senaste som
// släppts, dagens räknas in) och de två närmaste kommande. Stegen räknas om vid varje sidladdning, så på
// en släppdag flyttas tidslinjen ett steg fram av sig själv. shift bläddrar bakåt eller framåt därifrån.
const TL_SIZE = 3;
export function timelineSteps(releases) {
  const byDate = new Map();
  for (const r of releases) r.waves.forEach((w, wi) => {
    if (!byDate.has(w.date)) byDate.set(w.date, []);
    byDate.get(w.date).push({ r, wi, w });
  });
  const dates = [...byDate.keys()].sort();
  const endOfToday = +startOfToday() + 864e5;
  return { dates, byDate, current: dates.findLastIndex((s) => +d(s) < endOfToday) };
}

// Ger { nav, list }: bläddringsknapparna och själva tidslinjen.
export function timelineHTML(releases, ctx, shift = 0) {
  const { dates, byDate, current } = timelineSteps(releases);
  const start = Math.max(0, Math.max(current, 0) + shift);
  const label = (j) => (j < current ? "Släppt" : j === current ? "Aktuellt" : j === current + 1 ? "Nästa" : "Kommande");
  const nav = `<button type="button" class="cal-nav" data-tl="-1" aria-label="Tidigare släpp"${start <= 0 ? " disabled" : ""}>◀</button>
    <button type="button" class="btn small" data-tl="now"${shift === 0 ? " disabled" : ""}>Nu</button>
    <button type="button" class="cal-nav" data-tl="1" aria-label="Senare släpp"${start + TL_SIZE >= dates.length ? " disabled" : ""}>▶</button>`;
  const steps = Array.from({ length: TL_SIZE }, (_, k) => start + k).map((j) => {
    const s = dates[j];
    if (!s) return `<li class="tl-step empty"><span class="tl-dot" aria-hidden="true"></span><div class="tl-card"><span class="kicker">${label(j)}</span><p class="muted">Inget mer inlagt än.</p></div></li>`;
    const released = j <= current;
    return `<li class="tl-step ${j === current ? "current" : released ? "past" : "upcoming"}">
      <span class="tl-dot" aria-hidden="true"></span>
      <div class="tl-card">
        <header class="tl-head">${dateBox(s)}
          <div><span class="kicker">${label(j)} · ${released ? "släpptes " : ""}${esc(inDays(daysUntil(s)))}</span><h3>${esc(long(s))}</h3></div>
        </header>
        <ul class="tl-rel">${byDate.get(s).map(({ r, wi, w }) => `<li>
          <div><b>${esc(r.set)}</b><span>${esc(waveText(w, r))}${w.preliminary || r.preliminary ? " · preliminärt" : ""}</span></div>
          ${pillHTML(pill(r, ctx, wi))}
          <button type="button" class="btn small" data-open="${esc(r.id)}" data-wave="${wi}">Produkter och butiker</button>
        </li>`).join("")}</ul>
      </div>
    </li>`;
  });
  return { nav, list: `<ol class="tl" aria-label="Släpptidslinje">${steps.join("")}</ol>` };
}

// Kompakt kort per set: rubrik, status och en rad per omgång. Allt annat finns i detaljvyn.
export function releaseCard(r, ctx) {
  const today = startOfToday();
  const { list, inStock, preorder } = storesFor(r, ctx);
  const flags = [r.preliminary ? "Preliminärt datum" : "", r.auto ? "Automatiskt inlagt" : ""].filter(Boolean);
  return `<article class="rc${isOver(r) ? " over" : ""}" id="rel-${esc(r.id)}">
    <header class="rc-head">
      ${logoHTML(r, ctx, "rc-logo")}
      <div><h3>${esc(r.set)}</h3><span class="rc-meta">${esc(meta(r))}${flags.map((f) => ` · <em>${esc(f)}</em>`).join("")}</span></div>
    </header>
    <p class="rc-status">${esc(status(r))}</p>
    ${r.prerelease ? `<p class="rc-note">Förrelease i spelbutiker ${short(r.prerelease.from)}–${short(r.prerelease.to)}</p>` : ""}
    ${r.waves.length ? `<ol class="rc-waves">${r.waves.map((w, i) => `<li class="${d(w.date) < today ? "done" : ""}">
      <button type="button" data-open="${esc(r.id)}" data-wave="${i}">
        <span class="rc-date">${short(w.date)}</span>
        <span class="rc-prod">${esc(waveText(w, r))}${w.preliminary ? " <em>preliminärt</em>" : ""}</span>
        ${pillHTML(pill(r, ctx, i))}
      </button></li>`).join("")}</ol>` : ""}
    <footer class="rc-foot">
      <span class="rc-count">${list.length ? `<b>${list.length}</b> ${list.length === 1 ? "butik listar" : "butiker listar"} det${inStock ? ` · <b>${inStock}</b> i lager` : ""}${preorder ? ` · <b>${preorder}</b> förbeställ` : ""}` : "Ingen svensk butik har listat det än"}</span>
      <button type="button" class="btn small primary" data-open="${esc(r.id)}">Produkter och butiker</button>
    </footer>
  </article>`;
}

// Rutor med bild, pris och antal butiker. Tryck på en ruta för att se butikerna som säljer den.
export function galleryHTML(items, key) {
  if (!items.length) return "";
  return `<div class="rg" data-key="${esc(key)}">${items.map((it, i) => {
    const pr = itemPrice(it), n = storeCount(it);
    return `<button type="button" class="rg-tile" data-item="${i}" aria-expanded="false"${it.offers.length ? "" : " disabled"}>
      <span class="rg-img${it.official ? " official" : ""}">${img(it.image)}</span>
      <span class="rg-date">${short(it.date)}</span>
      <b>${esc(it.name)}</b>
      <span class="rg-price ${pr.cls}">${pr.text}</span>
      <small>${n ? plural(n, "butik", "butiker") : "Vi säger till när den dyker upp"}</small>
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
  const anat = anatomyData ? matchAnatomy(it.name, typeOf(it.name), anatomyData) : null;
  const lowPrice = it.offers.length ? Math.min(...it.offers.map((o) => o.price)) : null;
  const perPack = (anat?.packs && lowPrice) ? Math.round(lowPrice / anat.packs) : null;
  const anatBanner = anat ? `<div class="rg-anat-bar">
    <div class="rg-anat-info">
      <div>
        <b>${anat.packs ? `${anat.packs} boosterpaket` : "Förseglad produkt"}${perPack ? ` · ca ${perPack} kr/pack` : ""}</b>
        <small>${anat.promos?.length ? `${anat.promos.length} st promokort (${anat.promos.map((p) => p.name).join(", ")})` : anat.promoNote || (anat.accessories?.[0] || "")}</small>
      </div>
    </div>
    <button type="button" class="btn small gold rg-anat-btn" data-anat-title="${esc(it.name)}" data-anat-type="${esc(typeOf(it.name))}" data-anat-price="${lowPrice || ""}">Vad ingår?</button>
  </div>` : "";

  return `<div class="rg-offers-head"><b>${esc(it.name)}</b><span class="muted">${plural(storeCount(it), "butik", "butiker")} · ${it.upcoming ? `släpps ${short(it.date)} · ` : ""}billigast först</span>
    <button type="button" class="link rg-close">Stäng</button></div>
    ${anatBanner}
    <ul class="of-list">${it.offers.map((p) => offerRow(p, names, true, it)).join("")}</ul>`;
}

// Kopplar klick på rutorna i en behållare. lookup(key) ger items för rutnätet.
export function bindGallery(root, lookup, names) {
  root.addEventListener("click", (e) => {
    const anatBtn = e.target.closest(".rg-anat-btn");
    if (anatBtn) {
      e.stopPropagation();
      const t = anatBtn.dataset.anatTitle;
      const ty = anatBtn.dataset.anatType;
      const pr = anatBtn.dataset.anatPrice ? +anatBtn.dataset.anatPrice : null;
      const a = matchAnatomy(t, ty, anatomyData);
      const dlg = document.querySelector("#anat-modal");
      if (dlg) {
        dlg.querySelector(".anat-modal-body").innerHTML = renderAnatomyModal(t, a, pr);
        if (!dlg.open) dlg.showModal();
      }
      return;
    }
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
      <span class="rs-foot"><span class="rs-thumbs">${thumbs.map((p) => img(p.image)).join("")}</span><span class="rs-more">${plural(s.products.length, "produkt", "produkter")} <i aria-hidden="true"></i></span></span>
    </button>
    <ul class="of-list rs-products" hidden>${sortOffers([...s.products]).map((p) => offerRow(p, names, false)).join("")}</ul>
  </li>`;
}

function storesHTML(r, ctx, waveIndex, showAll) {
  const { list, inStock, preorder } = storesFor(r, ctx, waveIndex);
  if (!list.length) return `<p class="msg">Ingen svensk butik har listat ${waveIndex == null ? "det" : "den här omgången"} än. Vi säger till så fort någon gör det.</p>`;
  const rows = showAll ? list : list.slice(0, SHOW_STORES);
  return `<p class="rd-count"><b>${list.length}</b> ${list.length === 1 ? "butik" : "butiker"} · <b>${inStock}</b> i lager · <b>${preorder}</b> förbeställ · tryck på en butik för att se dess produkter</p>
    <ul class="rs-list">${rows.map((s) => storeRow(s, ctx.names)).join("")}</ul>
    ${list.length > SHOW_STORES && !showAll ? `<button type="button" class="btn small more-stores">Visa alla ${list.length} butiker</button>` : ""}`;
}

// Allt om ett släpp: omgångar som filter, produkter och butiker. Visas i en dialog.
export function detailHTML(r, ctx, waveIndex = null) {
  const today = startOfToday();
  return `<div class="rd" data-id="${esc(r.id)}">
    <header class="rd-head">
      ${logoHTML(r, ctx, "rd-logo")}
      <div><span class="rc-meta">${esc(meta(r))}</span><h2>${esc(r.set)}</h2><p class="rc-status">${esc(status(r))}</p></div>
    </header>
    ${r.about ? `<p class="rd-about">${esc(r.about)}</p>` : ""}
    ${r.prerelease ? `<p class="rc-note">Förrelease i spelbutiker ${short(r.prerelease.from)}–${short(r.prerelease.to)}</p>` : ""}
    ${r.waves.length > 1 ? `<div class="rd-tabs" role="tablist" aria-label="Omgångar">
      <button type="button" role="tab" data-tab="" aria-selected="${waveIndex == null}">Alla</button>
      ${r.waves.map((w, i) => `<button type="button" role="tab" data-tab="${i}" aria-selected="${waveIndex === i}" class="${d(w.date) < today ? "done" : ""}">${short(w.date)}</button>`).join("")}
    </div>` : ""}
    <section class="rd-sec"><h3>Produkter</h3><div class="rd-gallery"></div></section>
    <section class="rd-sec"><h3>I svenska butiker</h3><div class="rd-stores"></div></section>
    <div class="rd-cta">
      <a class="btn primary small" href="butiker.html#notiser">Få notis när ${esc(r.set)} kommer in</a>
      <a class="btn small" href="butiker.html?q=${encodeURIComponent(r.match?.[0] || r.set)}#products">Alla produkter och priser</a>
      ${r.tcgdex ? `<a class="btn small" href="priser.html?set=${encodeURIComponent(r.tcgdex)}">Kort och priser</a>` : ""}
      ${ctx.pages?.releases?.[r.id] ? `<a class="btn small" href="${esc(ctx.pages.releases[r.id])}">Allt om ${esc(r.set)}</a>` : ""}
    </div>
    ${r.source ? `<p class="rd-src">Källa: <a href="${esc(safeUrl(r.source))}" target="_blank" rel="noopener">Bulbapedia</a></p>` : ""}
  </div>`;
}

// Fyller produkter och butiker i en detaljvy, för hela släppet eller en omgång.
export function fillDetail(root, r, ctx, waveIndex = null, showAll = false) {
  const key = `${r.id}|${waveIndex ?? ""}`;
  const items = ctx.lookup(key);
  root.querySelector(".rd-gallery").innerHTML = galleryHTML(items, key)
    || `<p class="msg">${r.waves[waveIndex ?? 0]?.products.length === 0 ? "Vilka produkter som ingår är inte klart än. Butikernas listningar syns nedan." : "Inga produkter inlagda."}</p>`;
  root.querySelector(".rd-stores").innerHTML = storesHTML(r, ctx, waveIndex, showAll);
  root.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === String(waveIndex ?? ""))));
}

// Klick i en detaljvy: byt omgång, visa alla butiker, fäll ut en butik.
export function bindDetail(root, ctx) {
  bindGallery(root, ctx.lookup, ctx.names);
  root.addEventListener("click", (e) => {
    const rd = e.target.closest(".rd"); if (!rd) return;
    const r = ctx.byId.get(rd.dataset.id);
    const tab = e.target.closest("[data-tab]");
    const current = () => { const t = rd.querySelector('[data-tab][aria-selected="true"]'); return t && t.dataset.tab !== "" ? +t.dataset.tab : null; };
    if (tab) fillDetail(rd, r, ctx, tab.dataset.tab === "" ? null : +tab.dataset.tab);
    if (e.target.closest(".more-stores")) fillDetail(rd, r, ctx, current(), true);
    const sb = e.target.closest(".rs-btn");
    if (sb) {
      const open = sb.getAttribute("aria-expanded") !== "true";
      sb.setAttribute("aria-expanded", String(open));
      sb.nextElementSibling.hidden = !open;
      sb.closest(".rs").classList.toggle("open", open);
    }
  });
}

// ---------- Data, laddas en gång och delas av alla vyer ----------
let dataPromise = null;
export function releaseData() {
  return (dataPromise ||= (async () => {
    const [releases, products, status, pages] = await Promise.all([
      releaseSets(),
      fetch("data/products.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ products: [] })),
      fetch("data/stores-status.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ stores: [] })),
      setPages(),
    ]);
    const names = Object.fromEntries(status.stores.map((s) => [s.id, s.name]));
    const items = new Map(), mine = new Map(), byId = new Map(releases.map((r) => [r.id, r]));
    for (const r of releases) { const m = productsFor(r, products.products); mine.set(r.id, m); items.set(r.id, itemsFor(r, m)); }
    // Setloggor från TCGdex (eller reservkällan) för set som har ett TCGdex-id.
    const logos = new Map();
    await Promise.all(releases.filter((r) => r.tcgdex).map(async (r) => {
      try { const logo = setLogo(await getJSON(`${API}/sets/${encodeURIComponent(r.tcgdex)}`)); if (logo) logos.set(r.id, logo); } catch {}
    }));
    const lookup = (key) => { const [id, w] = key.split("|"); return items.get(id).filter((it) => w === "" || it.wave === +w); };
    return { releases, byId, products, names, items, mine, logos, lookup, pages };
  })());
}
