import { $, esc, kr, fmt, ago, loading, liveStamp, releaseSets, safeUrl } from "./site.js";
import { langMark } from "./langmark.js";
import { groupKey, groupProducts, groupTitle, lowestInStock } from "./group.js";
import { typeOf } from "./releases.js";
import { getPrefs, savePrefs, matches, KINDS } from "./prefs.js";
import { pushState, enablePush, disablePush, syncPush } from "./push.js";
const KIND = {
  ny: { label: "Nytt", cls: "k-new" },
  tillbaka: { label: "Tillbaka i lager", cls: "k-back" },
  prissankt: { label: "Prissänkt", cls: "k-drop" },
  forbestallning: { label: "Förbeställning", cls: "k-pre" },
};
const PAGE = 48;
let products = [], events = [], stores = [], storeName = {}, storeLogos = {}, shown = PAGE, eventKind = "";

const load = (p) => fetch(p, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// ---------- Händelser ----------
function renderEvents() {
  const mine = $("#only-mine").checked, prefs = getPrefs();
  const byId = new Map(products.map((p) => [p.id, p]));
  const list = events.filter((e) => (!eventKind || e.kind === eventKind) && (!mine || matches(e, prefs, byId.get(e.product)))).slice(0, 120);
  $("#events").innerHTML = list.length ? list.map((e) => {
    const k = KIND[e.kind] || { label: e.kind, cls: "" };
    // Produktens bild med händelsen som etikett ovanpå. Produkter som försvunnit ur butiken saknar bild.
    // Produkttypen syns under bilden och tar över om bilden saknas eller inte laddar.
    const p = byId.get(e.product), img = p?.image;
    return `<li class="event">
      <div class="ev-img"><span class="ev-noimg">${esc(p?.type || e.type || "Förseglat")}</span>${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span class="kind ${k.cls}">${k.label}</span></div>
      <div class="ev-body">
        <a href="${esc(safeUrl(e.url))}" target="_blank" rel="noopener nofollow">${esc(e.title)}</a>
        <span class="muted">${esc(storeName[e.store] || e.store)} · ${ago(new Date(e.at).toISOString())}</span>
      </div>
      <span class="ev-price">${e.kind === "prissankt" ? `<s>${kr(e.from)}</s> ` : ""}<b>${kr(e.price)}</b></span>
    </li>`;
  }).join("") : '<li class="msg">Inga händelser ännu. De dyker upp när bevakningen ser något nytt, något som kommer tillbaka i lager eller ett sänkt pris.</li>';
}

// ---------- Produkter ----------
const PRICE = { "": [0, Infinity], "0-50": [0, 50], "50-100": [50, 100], "100-200": [100, 200], "200-500": [200, 500], "500-1000": [500, 1000], "1000-": [1000, Infinity] };
const LANG = { en: "Engelska", ja: "Japanska", ko: "Koreanska", zh: "Kinesiska", fr: "Franska" };
const TYPE_LABEL = { "Booster Pack": "Boosterpaket", "Booster Box": "Boosterbox", "Elite Trainer Box": "Elite Trainer Box (ETB)", Blister: "Blister", Tin: "Tin" };
let recentDrop = new Map();
let groups = new Map(), priceHist = {}, releaseDates = new Map();
const pressed = (id) => $(id).getAttribute("aria-pressed") === "true";

// Produkter som klarar alla filter. Tillgänglighet styrs av snabbfiltren: inget valt betyder allt, även slut.
// Sökningen bryr sig inte om accenter, så att "pokemon" hittar "Pokémon".
const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
function filtered() {
  const q = fold($("#f-q").value.trim());
  const v = (id) => $(id).value;
  const [lo, hi] = PRICE[v("#f-price")];
  const inS = pressed("#c-in"), pre = pressed("#c-pre"), watchOnly = pressed("#c-watch");
  const watch = new Set(getPrefs().watch || []);
  const words = q.split(/\s+/).filter(Boolean);
  const selStores = picked("f-store"), selSets = picked("f-set");
  return products.filter((p) => (!selStores.length || selStores.includes(p.store)) && (!v("#f-type") || p.type === v("#f-type"))
    && (!selSets.length || selSets.includes(p.set)) && (!v("#f-lang") || p.lang === v("#f-lang"))
    && p.price >= lo && p.price < hi
    && ((!inS && !pre) || (inS && p.available) || (pre && p.preorder && !p.available))
    && (!watchOnly || watch.has(groupKey(p)))
    && words.every((w) => fold(`${p.title} ${p.set || ""}`).includes(w)));
}

// En produktgrupp som kort: lägsta pris, läget i butikerna och en utfällbar jämförelse.
function groupInfo(key) {
  const all = groups.get(key) || [];
  const inStock = all.filter((m) => m.available), pre = all.filter((m) => m.preorder && !m.available), out = all.filter((m) => !m.available && !m.preorder);
  const low = lowestInStock(all);
  const lowPre = pre.length ? Math.min(...pre.map((m) => m.price)) : null;
  return { key, all, inStock, pre, out, low, lowPre, last: Math.max(...all.map((m) => m.lastChange || 0)), stores: new Set(all.map((m) => m.store)).size };
}

function sparkline(points) {
  if (points.length < 2) return "";
  const W = 220, H = 48, xs = points.map((_, i) => (i / (points.length - 1)) * W);
  const vals = points.map((p) => p[1]), max = Math.max(...vals), min = Math.min(...vals), span = max - min || 1;
  const y = (v) => 4 + (1 - (v - min) / span) * (H - 8);
  // Trappsteg: priset gäller tills nästa mätning.
  let d = `M0 ${y(vals[0])}`;
  for (let i = 1; i < vals.length; i++) d += ` H${xs[i]} V${y(vals[i])}`;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d} V${H} H0 Z" class="spark-fill"/><path d="${d}" class="spark-line"/>
    <circle cx="${W}" cy="${y(vals[vals.length - 1])}" r="3" class="spark-dot"/></svg>`;
}

function historyBox(g) {
  const pts = priceHist[g.key] || [];
  if (!pts.length) return `<div class="ghist muted">Ingen prishistorik i lager ännu. Vi sparar det lägsta priset varje dag.</div>`;
  const min = Math.min(...pts.map((p) => p[1]));
  const minDay = pts.find((p) => p[1] === min)[0];
  const atLow = g.low != null && g.low <= min;
  return `<div class="ghist">
    <span class="muted">Lägsta pris i lager sedan ${fmt(pts[0][0])}</span>
    <b>${kr(min)}</b><span class="muted">${fmt(minDay)}</span>
    ${atLow ? '<span class="atlow">✓ Lägsta priset just nu</span>' : g.low != null ? `<span class="muted">Nu ${kr(g.low)}</span>` : ""}
    ${sparkline(pts)}
    ${pts.length > 1 ? `<span class="spark-axis"><span>${fmt(pts[0][0])}</span><span>${fmt(pts[pts.length - 1][0])}</span></span>` : ""}
  </div>`;
}

// "i dag 14:32", "i går 09:05" eller "18 okt. 14:32".
function when(t) {
  const d = new Date(t), now = new Date();
  const time = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return `i dag ${time}`;
  if (d.toDateString() === yesterday.toDateString()) return `i går ${time}`;
  return `${d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" })} ${time}`;
}

function storeRows(g) {
  const rank = (m) => (m.available ? 0 : m.preorder ? 1 : 2);
  // En rad per butik: butikens bästa erbjudande.
  const best = new Map();
  for (const m of g.all) { const o = best.get(m.store); if (!o || rank(m) < rank(o) || (rank(m) === rank(o) && m.price < o.price)) best.set(m.store, m); }
  const rows = [...best.values()];
  // Ett pris långt under de andra butikernas är ofta ett annat språk eller en annan produkt med liknande namn.
  const prices = rows.map((m) => m.price).sort((a, b) => a - b);
  const median = rows.length >= 3 ? prices[Math.floor(prices.length / 2)] : null;
  // Butiken som senast ändrade sitt pris får en markering.
  const changed = rows.filter((m) => m.priceChange).sort((a, b) => b.priceChange.at - a.priceChange.at)[0];
  return rows.sort((a, b) => rank(a) - rank(b) || a.price - b.price).map((m) => {
    const st = m.available ? ["in", "I lager"] : m.preorder ? ["pre", "Förbeställning"] : ["out", "Slut"];
    const lang = m.langGuess ? "Språk ej angivet" : LANG[m.lang] || m.lang;
    const pc = m === changed ? m.priceChange : null;
    const up = pc && m.price > pc.from;
    return `<li class="srow${pc ? " changed" : ""}">
      ${pc ? `<span class="srow-chg ${up ? "up" : "down"}"><span aria-hidden="true">${up ? "▲" : "▼"}</span> Senast ändrat pris ${when(pc.at)} · var ${kr(pc.from)}</span>` : ""}
      <span class="srow-name">${esc(storeName[m.store] || m.store)}<small class="srow-lang${m.langGuess ? " guess" : ""}">${esc(lang)}</small></span><span class="srow-price">${kr(m.price)}</span>
      <span class="rs-st ${st[0]}">${st[1]}</span>
      ${rank(m) < 2 ? `<a class="btn small gold" href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener nofollow">Köp</a>` : `<a class="srow-link" href="${esc(safeUrl(m.url))}" target="_blank" rel="noopener nofollow">Till butiken</a>`}
      ${median && m.price < median * 0.55 ? '<span class="srow-warn">Ovanligt lågt pris – kontrollera språk och produkt hos butiken</span>' : ""}
    </li>`;
  }).join("");
}

function groupCard(g, open) {
  const lead = g.inStock[0] || g.pre[0] || g.all[0];
  const img = g.all.find((m) => m.image)?.image;
  const watched = (getPrefs().watch || []).includes(g.key);
  const meta = [TYPE_LABEL[lead.type] || lead.type, lead.set, lead.lang !== "en" ? LANG[lead.lang] || lead.lang : ""].filter(Boolean).join(" · ");
  const price = g.low != null ? `Från <b>${kr(g.low)}</b> i lager` : g.lowPre != null ? `Förbeställ från <b>${kr(g.lowPre)}</b>` : `Slut överallt · senast <b>${kr(Math.min(...g.all.map((m) => m.price)))}</b>`;
  const rel = releaseDates.get(`${(lead.set || "").toLowerCase()}|${lead.type}`);
  const badge = !g.inStock.length && !g.pre.length ? '<span class="pbadge out">Slut</span>' : !g.inStock.length ? '<span class="pbadge pre">Förbeställ</span>'
    : g.all.some((m) => recentDrop.has(m.id)) ? '<span class="pbadge sale">Prissänkt</span>' : "";
  const title = groupTitle(g.all);

  return `<article class="gcard${open ? " open" : ""}" data-key="${esc(g.key)}">
    <div class="pimg">${img ? `<img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="noimg"><b>${esc(lead.type)}</b>Bild finns hos butiken</span>`}${badge}${langMark(lead.lang)}
      <button type="button" class="bell" aria-pressed="${watched}" aria-label="${watched ? "Sluta bevaka" : "Bevaka"} ${esc(title)}"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6zm-2 15a2 2 0 0 0 4 0" fill="${watched ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg></button>
    </div>
    <div class="gbody">
      <h3>${esc(title)}</h3>
      <span class="gmeta">${esc(meta)}</span>
      <div class="gprice">${price}</div>
      ${g.last ? `<span class="gupdated">Senast uppdaterad ${ago(new Date(g.last).toISOString())}</span>` : ""}
      <div class="gchips">
        ${g.inStock.length ? `<span class="c in">I lager ${new Set(g.inStock.map((m) => m.store)).size}</span>` : ""}
        ${g.pre.length ? `<span class="c pre">Förbeställ ${new Set(g.pre.map((m) => m.store)).size}</span>` : ""}
        ${g.out.length ? `<span class="c out">Slut ${new Set(g.out.map((m) => m.store)).size}</span>` : ""}
        ${rel ? `<span class="c rel">Släpps ${rel}</span>` : ""}
      </div>
      <button type="button" class="gtoggle" aria-expanded="${!!open}">${open ? "Stäng jämförelsen" : `Jämför ${g.stores} ${g.stores === 1 ? "butik" : "butiker"}`}<span class="garrow" aria-hidden="true">${open ? "▲" : "▼"}</span></button>
      <div class="gdetail"${open ? "" : " hidden"}>${open ? `${historyBox(g)}<ul class="srows">${storeRows(g)}</ul>
        <button type="button" class="gtoggle gclose" aria-expanded="true"><span class="garrow" aria-hidden="true">▲</span>Stäng jämförelsen</button>` : ""}</div>
    </div>
  </article>`;
}

const openGroups = new Set();
function renderProducts() {
  const list = filtered();
  const grid = $("#products");
  grid.className = "ggrid";
  const cols = getComputedStyle(grid).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
  const take = Math.ceil(shown / cols) * cols;
  // Per produkt: grupper där minst en butik klarar filtren, men jämförelsen visar alla butiker.
  const keys = [...new Set(list.map(groupKey))].map(groupInfo);
  const sort = $("#f-sort").value;
  const price = (g) => g.low ?? g.lowPre ?? Infinity;
  keys.sort(sort === "price-asc" ? (a, b) => price(a) - price(b) : sort === "price-desc" ? (a, b) => price(b) - price(a)
    : sort === "name" ? (a, b) => groupTitle(a.all).localeCompare(groupTitle(b.all), "sv") : sort === "stores" ? (a, b) => b.stores - a.stores || b.last - a.last
    : (a, b) => b.last - a.last);
  $("#count").textContent = `${keys.length.toLocaleString("sv-SE")} produkter`;
  grid.innerHTML = keys.slice(0, take).map((g) => groupCard(g, openGroups.has(g.key))).join("") || '<div class="msg">Inga produkter matchar. Prova att ta bort ett filter.</div>';
  $("#more").hidden = keys.length <= take;
}

function updateWatchCount() { $("#watch-count").textContent = (getPrefs().watch || []).length; }

$("#products").addEventListener("click", (e) => {
  const card = e.target.closest(".gcard"); if (!card) return;
  const key = card.dataset.key;
  if (e.target.closest(".gtoggle")) {
    if (openGroups.has(key)) openGroups.delete(key); else openGroups.add(key);
    const fromBottom = !!e.target.closest(".gclose");
    card.outerHTML = groupCard(groupInfo(key), openGroups.has(key));
    // Stängd från knappen längst ner: listan försvinner, så visa kortet igen i stället för tom yta.
    if (fromBottom) document.querySelector(`#products .gcard[data-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  if (e.target.closest(".bell")) {
    const p = getPrefs();
    const set = new Set(p.watch || []);
    if (set.has(key)) set.delete(key); else set.add(key);
    p.watch = [...set];
    savePrefs(p);
    syncPush();
    card.outerHTML = groupCard(groupInfo(key), openGroups.has(key));
    updateWatchCount();
    if (pressed("#c-watch")) renderProducts();
  }
});

for (const id of ["#c-in", "#c-pre", "#c-watch"]) {
  $(id).addEventListener("click", () => { $(id).setAttribute("aria-pressed", String(!pressed(id))); shown = PAGE; renderProducts(); });
}

// Flervalsfilter för Set och Butik. Ingen ikryssad betyder alla. Panelen stängs när man klickar utanför.
const picked = (id) => [...document.querySelectorAll(`#${id} input:checked`)].map((b) => b.value);
function multiFill(id, items) {
  $(`#${id}`).innerHTML = items.map((x) => `<label class="chk"><input type="checkbox" value="${esc(x.value)}">
    <span>${esc(x.text)}</span>${x.count ? `<small>${x.count}</small>` : ""}</label>`).join("");
  $(`#${id}`).addEventListener("change", () => {
    const on = picked(id), first = document.querySelector(`#${id} input:checked`)?.closest(".chk").querySelector("span").textContent;
    $(`#${id}-sum`).textContent = !on.length ? "Alla" : on.length === 1 ? first : `${on.length} valda`;
    shown = PAGE; renderProducts();
  });
}
function closeMulti(except = null) {
  document.querySelectorAll(".mdrop-btn").forEach((btn) => {
    if (btn === except) return;
    btn.setAttribute("aria-expanded", "false");
    btn.nextElementSibling.hidden = true;
  });
}
document.querySelectorAll(".mdrop-btn").forEach((btn) => btn.addEventListener("click", () => {
  const panel = btn.nextElementSibling, open = panel.hidden;
  closeMulti(btn);
  panel.hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
}));
document.addEventListener("click", (e) => { if (!e.target.closest(".mdrop")) closeMulti(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMulti(); });
// ---------- Butiker ----------
const STATUS = { tillstand: "Tillstånd", "ej-forbjuden": "Bevakas", "inga-bilder": "Bevakas, utan bilder", okand: "Ej kontrollerad", forbjuden: "Bevakas inte" };
function renderStores() {
  const order = { tillstand: 0, "ej-forbjuden": 1, "inga-bilder": 1, okand: 2, forbjuden: 3 };
  $("#stores").innerHTML = [...stores].sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name, "sv")).map((s) => {
    const active = ["tillstand", "ej-forbjuden", "inga-bilder"].includes(s.status);
    const state = !active ? (s.note || "") : s.ok === false ? `Kunde inte läsas senast` : s.checkedAt ? `Kollad ${ago(new Date(s.checkedAt).toISOString())}` : "Inte kollad än";
    // Butikens egen ikon (se scripts/update-store-logos.mjs), annars första bokstaven.
    const logo = storeLogos[s.id];
    return `<li class="store ${active ? "" : "off"}">
      <span class="slogo">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('b'),{textContent:this.dataset.l}))" data-l="${esc(s.name[0])}">` : `<b>${esc(s.name[0])}</b>`}</span>
      <div><b class="sdom" title="${esc(s.name)}">${esc(s.domain)}</b>${active ? `<span class="muted">${s.count} produkter</span>` : ""}</div>
      <span class="st ${active ? "on" : s.status === "forbjuden" ? "no" : ""}">${STATUS[s.status]}</span>
      <span class="muted when">${esc(state)}</span>
    </li>`;
  }).join("");
}

// ---------- Flikar och filter ----------
const TABS = ["products", "events", "stores", "notiser"];
function showTab(tab) {
  document.querySelectorAll("#seg button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tab === tab));
  for (const t of TABS) $(`#tab-${t}`).hidden = t !== tab;
  if (tab === "notiser" && groups.size) refreshSummary();
  history.replaceState(null, "", `#${tab}`);
}
$("#seg").addEventListener("click", (e) => { const b = e.target.closest("[data-tab]"); if (b) showTab(b.dataset.tab); });
$("#event-filter").addEventListener("click", (e) => {
  const b = e.target.closest("[data-kind]"); if (!b) return;
  eventKind = b.dataset.kind;
  document.querySelectorAll("#event-filter button").forEach((x) => x.setAttribute("aria-pressed", x === b));
  renderEvents();
});
$("#filters").addEventListener("input", () => { shown = PAGE; renderProducts(); });
// Rullgardinerna blir lika breda som det valda alternativet, så att filterraden hålls kompakt.
function fitSelect(sel) {
  const probe = document.createElement("span");
  probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${getComputedStyle(sel).font}`;
  probe.textContent = sel.selectedOptions[0]?.text || "";
  document.body.append(probe);
  sel.style.width = `${probe.offsetWidth + 20}px`;
  probe.remove();
}
const fitAll = () => document.querySelectorAll(".drop select").forEach(fitSelect);
$("#filters").addEventListener("change", (e) => { if (e.target.matches(".drop select")) fitSelect(e.target); });
document.fonts?.ready.then(fitAll);

// Kort- eller listvy. Valet sparas till nästa besök.
function setView(v) {
  $("#products").dataset.view = v;
  document.querySelectorAll("#view button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.v === v));
  try { localStorage.setItem("nl:view2", v); } catch {}
}
$("#view")?.addEventListener("click", (e) => { const b = e.target.closest("[data-v]"); if (b) setView(b.dataset.v); });
// Listvyn är standard. Ett sparat val går före standarden. Nyckeln bytte namn så att gamla kortval inte gäller.
let savedView = "list";
try { savedView = localStorage.getItem("nl:view2") || "list"; } catch {}
setView(savedView === "grid" ? "grid" : "list");
$("#filters").addEventListener("submit", (e) => e.preventDefault());
$("#more").addEventListener("click", () => { shown += PAGE; renderProducts(); });

$("#events").innerHTML = loading("Ninjan kollar butikerna");
$("#products").innerHTML = loading("Ninjan kollar butikerna");
try {
  const [p, e, s] = await Promise.all([load("data/products.json"), load("data/events.json"), load("data/stores-status.json")]);
  products = p.products; events = e.events; stores = s.stores;
  groups = groupProducts(products);
  priceHist = (await load("data/price-history.json").catch(() => ({ days: {} }))).days || {};
  storeLogos = await load("data/store-logos.json").catch(() => ({}));
  // "Släpps 6 nov" på produkter vars omgång inte har kommit än.
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (const r of await releaseSets().catch(() => [])) for (const w of r.waves) {
    const day = new Date(`${w.date}T12:00:00`);
    if (day < today) continue;
    for (const name of w.products) {
      const t = typeOf(name), k = `${r.set.toLowerCase()}|${t}`;
      if (t && !releaseDates.has(k)) releaseDates.set(k, fmt(w.date).replace(/ \d{4}$/, ""));
    }
  }
  updateWatchCount();
  storeName = Object.fromEntries(stores.map((x) => [x.id, x.name]));
  const used = new Set(products.map((x) => x.store));
  const perStore = products.reduce((a, x) => ((a[x.store] = (a[x.store] || 0) + 1), a), {});
  multiFill("f-store", stores.filter((x) => used.has(x.id)).sort((a, b) => a.name.localeCompare(b.name, "sv"))
    .map((x) => ({ value: x.id, text: x.name, count: perStore[x.id] })));
  const opts = (id, values, label = (x) => x) => $(id).insertAdjacentHTML("beforeend", values.map((x) => `<option value="${esc(x)}">${esc(label(x))}</option>`).join(""));
  opts("#f-type", [...new Set(products.map((x) => x.type))].sort());
  const perSet = products.reduce((a, x) => (x.set && (a[x.set] = (a[x.set] || 0) + 1), a), {});
  multiFill("f-set", Object.keys(perSet).sort((a, b) => a.localeCompare(b, "sv")).map((s) => ({ value: s, text: s, count: perSet[s] })));
  opts("#f-lang", [...new Set(products.map((x) => x.lang))].sort(), (l) => LANG[l] || l.toUpperCase());
  // Etiketter på korten: prissänkt eller nytt den senaste veckan.
  const week = Date.now() - 7 * 864e5;
  for (const ev of events) {
    if (ev.at < week) continue;
    // Mer än 60 % lägre är nästan alltid ett valutafel (dollar i stället för kronor), inte en rea.
    if (ev.kind === "prissankt" && !recentDrop.has(ev.product) && ev.price >= ev.from * 0.4) recentDrop.set(ev.product, ev.from);
  }
  // Sökning från länk, t.ex. butiker.html?q=Delta Reign#products
  const q = new URLSearchParams(location.search).get("q");
  if (q) $("#f-q").value = q;
  renderEvents(); renderProducts(); renderStores(); fitAll();
  // Produkterna visas först, om inte länken pekar på en annan flik (t.ex. butiker.html#events).
  const start = location.hash.slice(1);
  renderPrefs();
  showTab(TABS.includes(start) ? start : "products");
} catch (err) {
  console.error(err);
  const msg = "Butiksdatan kunde inte laddas. Kör bevakningen först (se README).";
  $("#events").innerHTML = `<li class="msg">${msg}</li>`;
  $("#products").innerHTML = `<div class="msg">${msg}</div>`;
}

// ---------- Notiser och urval ----------
// Kryssrutor: alla ikryssade betyder "alla" och sparas som en tom lista. Ingen ikryssad sparas som "__none__".
function checkList(id, items, selected, label = (x) => x, count = null) {
  const all = !selected.length;
  $(`#${id}`).innerHTML = items.map((v) => `<label class="chk"><input type="checkbox" value="${esc(v)}"${all || selected.includes(v) ? " checked" : ""}>
    <span>${esc(label(v))}</span>${count ? `<small>${count(v)}</small>` : ""}</label>`).join("");
}
function boxes(id) { return [...document.querySelectorAll(`#${id} input`)]; }
function checked(id) {
  const all = boxes(id), on = all.filter((b) => b.checked).map((b) => b.value);
  return on.length === all.length ? [] : on.length ? on : ["__none__"];
}
function countText(id, allWord = "Alla") { const all = boxes(id), on = all.filter((b) => b.checked).length; return on === all.length ? allWord : `${on} av ${all.length}`; }

// Utkastet av valen, direkt från formuläret (innan man sparar).
function draftPrefs() {
  return { ...getPrefs(), kinds: checked("p-kinds"), stores: checked("p-stores"), sets: checked("p-sets"), langs: checked("p-langs"), types: checked("p-types"),
    maxPrice: Math.max(0, Number($("#p-max").value) || 0) };
}
function productMatches(x, p) { return (!p.stores.length || p.stores.includes(x.store)) && (!p.sets.length || p.sets.includes(x.set))
  && (!p.types.length || p.types.includes(x.type)) && (!p.langs?.length || p.langs.includes(x.lang)) && (!p.maxPrice || x.price <= p.maxPrice); }

function refreshSummary() {
  const p = draftPrefs();
  $("#sum-stores").textContent = `${boxes("p-stores").filter((b) => b.checked).length} av ${boxes("p-stores").length}`;
  $("#sum-kinds").textContent = countText("p-kinds");
  $("#sum-sets").textContent = countText("p-sets");
  const more = [countText("p-langs") !== "Alla" && `${countText("p-langs")} språk`, countText("p-types") !== "Alla" && `${countText("p-types")} typer`, p.maxPrice && `max ${kr(p.maxPrice)}`].filter(Boolean);
  $("#sum-more").textContent = more.join(" · ") || "Alla";
  $("#sum-channels").textContent = pushState() === "on" ? "Pushnotiser på" : "Inget valt";
  const n = products.filter((x) => productMatches(x, p)).length;
  $("#p-match").innerHTML = `<b>${n.toLocaleString("sv-SE")}</b> av ${products.length.toLocaleString("sv-SE")} förseglade produkter matchar dina val.`;
  renderWatchList();
}

function renderPrefs() {
  const p = getPrefs();
  const active = stores.filter((s) => s.checkedAt && s.ok && !["forbjuden", "okand"].includes(s.status)).sort((a, b) => a.name.localeCompare(b.name, "sv"));
  const perStore = products.reduce((a, x) => ((a[x.store] = (a[x.store] || 0) + 1), a), {});
  checkList("p-stores", active.map((s) => s.id), p.stores, (id) => storeName[id] || id, (id) => perStore[id] || 0);
  checkList("p-kinds", Object.keys(KINDS), p.kinds.length === Object.keys(KINDS).length ? [] : p.kinds, (k) => KINDS[k]);
  const perSet = products.reduce((a, x) => (x.set && (a[x.set] = (a[x.set] || 0) + 1), a), {});
  checkList("p-sets", Object.keys(perSet).sort((a, b) => a.localeCompare(b, "sv")), p.sets, (s) => s, (s) => perSet[s]);
  checkList("p-langs", [...new Set(products.map((x) => x.lang))].sort(), p.langs || [], (l) => LANG[l] || l.toUpperCase());
  checkList("p-types", [...new Set(products.map((x) => x.type))].sort(), p.types);
  $("#p-max").value = p.maxPrice || "";
  updatePushButton();
  refreshSummary();
}

$("#tab-notiser").addEventListener("change", refreshSummary);
$("#tab-notiser").addEventListener("input", (e) => {
  if (e.target.id === "p-max") refreshSummary();
  // Sök i långa listor.
  if (e.target.matches(".acc-find")) {
    const q = e.target.value.trim().toLowerCase();
    for (const l of document.querySelectorAll(`#${e.target.dataset.for} .chk`)) l.hidden = q && !l.textContent.toLowerCase().includes(q);
  }
});
$("#tab-notiser").addEventListener("click", (e) => {
  const all = e.target.closest("[data-all]"), none = e.target.closest("[data-none]");
  if (all || none) {
    for (const b of boxes((all || none).dataset.all || (all || none).dataset.none)) if (!b.closest(".chk").hidden) b.checked = !!all;
    refreshSummary();
  }
  const rm = e.target.closest("[data-unwatch]");
  if (rm) {
    const p = getPrefs();
    p.watch = (p.watch || []).filter((k) => k !== rm.dataset.unwatch);
    savePrefs(p);
    syncPush();
    updateWatchCount();
    refreshSummary();
    renderProducts();
  }
});

function renderWatchList() {
  const keys = getPrefs().watch || [];
  $("#sum-watch").textContent = keys.length;
  $("#watch-list").innerHTML = keys.length ? keys.map((k) => {
    const g = groups.has(k) ? groupInfo(k) : null;
    const price = g ? (g.low != null ? `Från ${kr(g.low)} i lager` : g.lowPre != null ? `Förbeställ från ${kr(g.lowPre)}` : "Slut överallt") : "Finns inte längre i butikerna";
    return `<li><span><b>${esc(g ? groupTitle(g.all) : k)}</b><small>${price}</small></span><button type="button" class="btn small" data-unwatch="${esc(k)}">Sluta bevaka</button></li>`;
  }).join("") : '<li class="muted">Inga ännu. Tryck på klockan på en produkt under Produkter för att bevaka den.</li>';
}

$("#p-save").addEventListener("click", () => {
  savePrefs(draftPrefs());
  syncPush();
  $("#p-status").textContent = "Sparat.";
  setTimeout(() => ($("#p-status").textContent = ""), 2500);
  renderEvents();
});
$("#p-reset").addEventListener("click", () => {
  const p = getPrefs();
  Object.assign(p, { kinds: Object.keys(KINDS), types: [], stores: [], sets: [], langs: [], maxPrice: 0 });
  savePrefs(p);
  syncPush();
  renderPrefs();
  renderEvents();
});

function updatePushButton() {
  const btn = $("#p-push"), state = pushState();
  $("#p-push-ios").hidden = state !== "ios-install";
  btn.hidden = state === "ios-install";
  btn.disabled = state === "unsupported" || state === "denied";
  btn.textContent = { on: "Stäng av pushnotiser", off: "Slå på pushnotiser", denied: "Notiser är blockerade i webbläsaren", unsupported: "Webbläsaren stöder inte pushnotiser" }[state] || "Slå på pushnotiser";
  btn.classList.toggle("primary", state === "off");
  $("#p-push-note").textContent = state === "denied" ? "Tillåt notiser för lootninja.se i webbläsarens inställningar och ladda om sidan." : "";
}
$("#p-push").addEventListener("click", async () => {
  const btn = $("#p-push");
  btn.disabled = true;
  let note = "";
  try {
    if (pushState() === "on") { await disablePush(); note = "Pushnotiserna är avstängda."; }
    else if (await enablePush()) note = "Klart! Notiserna följer urvalet nedan. Spara när du ändrar något.";
  } catch {
    note = "Det gick inte att slå på notiserna just nu. Försök igen om en stund.";
  }
  btn.disabled = false;
  updatePushButton();
  if (note) $("#p-push-note").textContent = note;
  refreshSummary();
});
syncPush();

$("#only-mine").addEventListener("change", renderEvents);
document.addEventListener("click", (e) => { const a = e.target.closest("[data-goto]"); if (a) { e.preventDefault(); showTab(a.dataset.goto); } });
