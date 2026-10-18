// Tryck på ett set: en ruta med alla kort i setet, pris i kronor och sortering.
// Namn, bild och nummer kommer från TCGdex. Priserna från data/card-history/<set>.json.
import { esc, kr, fmt, loading, getJSON, API, setLogo, cardImg } from "./site.js";
import { openCardPrice } from "./cardprice.js";

const SORTS = {
  "price-desc": ["Dyrast först", (a, b) => (b.price ?? -1) - (a.price ?? -1)],
  "price-asc": ["Billigast först", (a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)],
  number: ["Kortnummer", (a, b) => String(a.localId).localeCompare(String(b.localId), "sv", { numeric: true })],
  name: ["Namn A–Ö", (a, b) => a.name.localeCompare(b.name, "sv")],
};

let dlg = null;
let current = null; // { set, cards, date, sort } för den öppna rutan

// Senaste punkten per kort: [datum, trendpris i kr, lägsta pris i kr].
async function prices(setId) {
  const h = await fetch(`data/card-history/${encodeURIComponent(setId)}.json`, { cache: "no-cache" })
    .then((r) => (r.ok ? r.json() : { cards: {} })).catch(() => ({ cards: {} }));
  const out = new Map();
  let date = null;
  for (const [id, pts] of Object.entries(h.cards || {})) {
    const last = pts[pts.length - 1];
    if (!last) continue;
    out.set(id, last[1] ?? last[2] ?? null);
    if (!date || last[0] > date) date = last[0];
  }
  return { prices: out, date };
}

function sorted() {
  const [, cmp] = SORTS[current.sort];
  return current.cards.slice().sort(cmp);
}

function tile(c) {
  const src = c.image ? `${c.image}/low.webp` : "";
  return `<li class="sm-card" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="Visa ${esc(c.name)} i stort format">
    <span class="sm-img${src ? "" : " has-back"}">${src
      ? `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');if(!this.parentNode.querySelector('.sm-soon')){const s=document.createElement('span');s.className='sm-soon';s.textContent='Kommer snart bilder';this.parentNode.append(s);}">`
      : `<img src="img/kortbaksida.webp" alt="Kortets baksida" loading="lazy" decoding="async"><span class="sm-soon">Kommer snart bilder</span>`
    }</span>
    <b>${esc(c.name)}</b>
    <small>#${esc(c.localId)}</small>
    <span class="sm-price${c.price == null ? " none" : ""}">${c.price == null ? "Inget pris ännu" : kr(c.price)}</span>
  </li>`;
}

function renderCards() {
  const priced = current.cards.filter((c) => c.price != null).length;
  dlg.querySelector(".sm-count").innerHTML = `<b>${current.cards.length}</b> kort · <b>${priced}</b> med pris${current.date ? ` · priser ${fmt(current.date)}` : ""}`;
  dlg.querySelector(".sm-grid").innerHTML = sorted().map(tile).join("")
    || '<li class="msg">Setet har inga kort i vår lista ännu.</li>';
}

// ---------- Zoom: kortet växer från rutnätet till mitten ----------
// Klicka på ett kort: det flyttas och förstoras från sin plats i rutnätet till mitten av skärmen (FLIP-animation).
// Pilarna, tangentbordet och svep bläddrar bland setets kort i den ordning de står just nu. Esc eller klick utanför stänger,
// och då flyger kortet tillbaka till sin plats.
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const EASE = "cubic-bezier(.2,.8,.2,1)";
const cardSrc = (c, size) => (c.image ? `${c.image}/${size}.webp` : "img/kortbaksida.webp");

let zdlg = null, zlist = [], zi = 0, zbusy = false, ztoken = 0;
const zq = (s) => zdlg.querySelector(s);
const tileOf = (id) => dlg?.querySelector(`.sm-card[data-id="${CSS.escape(id)}"]`);

function zoomDialog() {
  if (zdlg) return zdlg;
  zdlg = document.createElement("dialog");
  zdlg.className = "zoom-dlg";
  zdlg.setAttribute("aria-label", "Kortet i stort format");
  zdlg.innerHTML = `<button type="button" class="zm-close" aria-label="Stäng">✕</button>
    <button type="button" class="zm-nav prev" aria-label="Föregående kort">‹</button>
    <button type="button" class="zm-nav next" aria-label="Nästa kort">›</button>
    <div class="zm-stage">
      <div class="zm-tilt"><div class="zm-card"><img class="zm-img" alt="" decoding="async"><span class="zm-holo"></span><span class="zm-glare"></span></div></div>
      <div class="zm-info">
        <span class="zm-count"></span>
        <h3 class="zm-name"></h3>
        <p class="zm-sub"></p>
        <div class="zm-row"><button type="button" class="zm-price" aria-haspopup="dialog"></button><span class="zm-hint">Tryck på priset för historik och värdering</span></div>
      </div>
    </div>`;
  document.body.append(zdlg);
  zdlg.addEventListener("cancel", (e) => { e.preventDefault(); closeZoom(); });
  zdlg.addEventListener("click", (e) => {
    if (e.target === zdlg || e.target.classList.contains("zm-stage") || e.target.closest(".zm-close")) closeZoom();
    else if (e.target.closest(".zm-price")) openCardPrice(zlist[zi].id);
    else if (e.target.closest(".zm-nav.prev")) go(-1);
    else if (e.target.closest(".zm-nav.next")) go(1);
  });
  zdlg.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
  });
  // Lutning efter pekaren och glans (inte på pekskärm).
  const card = zq(".zm-card"), tilt = zq(".zm-tilt");
  card.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    tilt.style.transform = `rotateY(${x * 20}deg) rotateX(${-y * 20}deg)`;
    card.style.setProperty("--gx", `${(x + 0.5) * 100}%`); card.style.setProperty("--gy", `${(y + 0.5) * 100}%`);
  });
  card.addEventListener("pointerleave", () => { tilt.style.transform = ""; });
  // Svep åt sidan bläddrar.
  let sx = null;
  zq(".zm-stage").addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
  zq(".zm-stage").addEventListener("touchend", (e) => {
    if (sx == null) return;
    const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
  }, { passive: true });
  return zdlg;
}

function showImage(c) {
  const img = zq(".zm-img");
  img.alt = c.name;
  // Saknas bilden hos TCGdex visas kortets baksida i stället, som i rutnätet.
  img.onerror = () => { img.onerror = null; img.src = "img/kortbaksida.webp"; };
  img.src = cardSrc(c, "low"); // finns redan i webbläsaren från rutnätet
  if (c.image) {
    const hi = new Image(), id = c.id;
    hi.onload = () => { if (zlist[zi]?.id === id) img.src = hi.src; };
    hi.src = cardSrc(c, "high");
  }
  // Förladda grannarna så att bläddringen går snabbt.
  [zlist[zi - 1], zlist[zi + 1]].forEach((n) => { if (n?.image) new Image().src = cardSrc(n, "high"); });
}

function fillInfo(c) {
  const t = ++ztoken;
  zq(".zm-count").textContent = `${zi + 1} / ${zlist.length}`;
  zq(".zm-name").textContent = c.name;
  zq(".zm-sub").textContent = `#${c.localId} · ${current.set.name}`;
  zq(".zm-price").innerHTML = c.price == null ? "Visa pris" : `<b>${kr(c.price)}</b>`;
  zq(".zm-nav.prev").disabled = zi === 0;
  zq(".zm-nav.next").disabled = zi === zlist.length - 1;
  getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).then((d) => {
    if (t === ztoken && d?.rarity && d.rarity !== "None") zq(".zm-sub").textContent = `#${c.localId} · ${current.set.name} · ${d.rarity}`;
  }).catch(() => {});
}

function openZoom(index, fromEl) {
  zlist = sorted(); zi = index; zbusy = false;
  const d = zoomDialog(), card = zq(".zm-card");
  fillInfo(zlist[zi]); showImage(zlist[zi]);
  d.showModal();
  const dur = reduceMotion ? 1 : 520;
  d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduceMotion ? 1 : 240 });
  // FLIP: börja där kortet låg i rutnätet och växer till sin plats i mitten.
  const to = card.getBoundingClientRect(), from = fromEl?.getBoundingClientRect();
  if (from && from.width) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2), s = from.width / to.width;
    card.animate([{ transform: `translate(${dx}px,${dy}px) scale(${s})` }, { transform: "none" }], { duration: dur, easing: EASE });
  } else {
    card.animate([{ transform: "scale(.85)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: dur, easing: EASE });
  }
  zq(".zm-info").animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: reduceMotion ? 1 : 340, delay: reduceMotion ? 0 : 220, easing: EASE, fill: "backwards" });
  zq(".zm-card").focus?.();
}

async function closeZoom() {
  if (zbusy || !zdlg?.open) return;
  zbusy = true;
  const card = zq(".zm-card"), c = zlist[zi];
  const src = tileOf(c.id)?.querySelector(".sm-img");
  const from = src?.getBoundingClientRect(), to = card.getBoundingClientRect();
  const dur = reduceMotion ? 1 : 380;
  const anims = [zdlg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: "ease-in", fill: "forwards" })];
  const visible = from && from.width && from.bottom > 0 && from.top < innerHeight;
  if (visible) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2), s = from.width / to.width;
    anims.push(card.animate([{ transform: "none" }, { transform: `translate(${dx}px,${dy}px) scale(${s})` }], { duration: dur, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }));
  } else {
    anims.push(card.animate([{ transform: "none", opacity: 1 }, { transform: "scale(.85)", opacity: 0 }], { duration: dur, fill: "forwards" }));
  }
  // Står animationstiden still (t.ex. dold flik) stängs rutan ändå efter tidsgränsen.
  await Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => {}))), wait(dur + 300)]);
  anims.forEach((a) => a.cancel());
  zdlg.close();
  zbusy = false;
  tileOf(c.id)?.focus({ preventScroll: true });
}

async function go(dir) {
  const n = zi + dir;
  if (zbusy || n < 0 || n >= zlist.length) return;
  zbusy = true;
  const card = zq(".zm-card");
  const out = card.animate([{ transform: "none", opacity: 1 }, { transform: `translateX(${-80 * dir}px) rotateY(${28 * dir}deg) scale(.94)`, opacity: 0 }], { duration: reduceMotion ? 1 : 180, easing: "ease-in", fill: "forwards" });
  await Promise.race([out.finished.catch(() => {}), wait(320)]);
  zi = n;
  fillInfo(zlist[zi]); showImage(zlist[zi]);
  const inn = card.animate([{ transform: `translateX(${80 * dir}px) rotateY(${-28 * dir}deg) scale(.94)`, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: reduceMotion ? 1 : 300, easing: EASE });
  out.cancel();
  await Promise.race([inn.finished.catch(() => {}), wait(450)]);
  tileOf(zlist[zi].id)?.scrollIntoView({ block: "nearest" }); // håller rutnätet i takt med bläddringen
  zbusy = false;
}

function dialog() {
  if (dlg) return dlg;
  dlg = document.createElement("dialog");
  dlg.className = "card-modal set-modal";
  dlg.setAttribute("aria-label", "Alla kort i setet");
  dlg.innerHTML = `<button type="button" class="cm-close" aria-label="Stäng">✕</button><div class="sm-body"></div>`;
  document.body.append(dlg);
  dlg.addEventListener("click", (e) => { if (e.target === dlg || e.target.closest(".cm-close")) dlg.close(); });
  const zoomFrom = (li) => {
    const i = sorted().findIndex((c) => c.id === li.dataset.id);
    if (i >= 0) openZoom(i, li.querySelector(".sm-img"));
  };
  dlg.addEventListener("click", (e) => { const li = e.target.closest(".sm-card[data-id]"); if (li && current) zoomFrom(li); });
  dlg.addEventListener("keydown", (e) => {
    const li = e.target.closest?.(".sm-card[data-id]");
    if (li && current && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); zoomFrom(li); }
  });
  dlg.addEventListener("change", (e) => {
    if (!e.target.matches(".sm-sort") || !current) return;
    current.sort = e.target.value;
    renderCards();
  });
  return dlg;
}

// Öppnar rutan för ett set. id är TCGdex set-id, t.ex. "me03".
export async function openSet(id) {
  const d = dialog();
  const body = d.querySelector(".sm-body");
  body.innerHTML = loading("Ninjan räknar korten");
  d.showModal();
  try {
    const [set, p] = await Promise.all([getJSON(`${API}/sets/${encodeURIComponent(id)}`), prices(id)]);
    const cards = (set.cards || []).map((c) => ({ ...c, price: p.prices.get(c.id) ?? null }));
    current = { set, cards, date: p.date, sort: "price-desc" };
    const logo = setLogo(set);
    body.innerHTML = `<div class="sm-head">${logo ? `<img class="sm-logo" src="${esc(logo)}" alt="">` : ""}
        <div><h3>${esc(set.name)}</h3><p class="muted">${esc(set.serie?.name || "")}</p></div></div>
      <div class="sm-bar"><span class="sm-count"></span>
        <label>Sortera <select class="sm-sort">${Object.entries(SORTS).map(([k, [label]]) => `<option value="${k}">${label}</option>`).join("")}</select></label></div>
      <ul class="sm-grid"></ul>`;
    renderCards();
  } catch {
    body.innerHTML = '<div class="msg">Korten kunde inte laddas just nu.</div>';
  }
}

// Ett klick på ett set i en behållare öppnar setets kort. Fungerar även för set som läggs till senare.
export function bindSetCards(root) {
  const open = (e) => {
    const el = e.target.closest("[data-set]");
    if (el) openSet(el.dataset.set);
  };
  root.addEventListener("click", open);
  root.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.closest("[data-set]")) { e.preventDefault(); open(e); }
  });
}
