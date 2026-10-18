import { $, esc, loading, skeleton, fillRows, allReleases, latestSets, setCard, setLogo } from "./site.js";
import { mountReleases, releaseData, galleryHTML, bindGallery, short } from "./releases.js";
import { bindSetCards } from "./setcards.js";

mountReleases($("#releases")).catch(() => { $("#releases").innerHTML = '<div class="msg">Släppen kunde inte laddas.</div>'; });

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const pad = (n) => String(n).padStart(2, "0");
const key = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`;
const now = new Date();
const todayKey = key(now.getFullYear(), now.getMonth(), now.getDate());

let byDate = new Map(), sets = [];
let view = { y: now.getFullYear(), m: now.getMonth() };

// Startmånad från adressen (#2026-11), så att en månad går att länka till.
const fromHash = location.hash.match(/^#(\d{4})-(\d{2})$/);
if (fromHash) view = { y: +fromHash[1], m: +fromHash[2] - 1 };

function add(date, item) {
  const k = String(date).slice(0, 10);
  if (!byDate.has(k)) byDate.set(k, []);
  byDate.get(k).push(item);
}

const thumb = (src) => `<img src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">`;
const chip = (it) => it.kind === "set"
  ? `<li class="ev ev-set" title="${esc(it.name)} släpps">${it.logo ? `<img src="${esc(it.logo)}" alt="" loading="lazy">` : ""}<span>${esc(it.name)}</span></li>`
  : `<li class="ev ev-drop" title="${esc(it.name)}${it.type ? ` · ${esc(it.type)}` : ""}">${it.images?.length ? `<span class="ev-imgs">${it.images.slice(0, 3).map(thumb).join("")}</span>` : ""}<span>${esc(it.name)}</span></li>`;

function render() {
  const { y, m } = view;
  $("#cal-title").textContent = `${MONTHS[m][0].toUpperCase()}${MONTHS[m].slice(1)} ${y}`;
  $("#agenda-title").textContent = `I ${MONTHS[m]}`;
  // Veckan börjar på måndag.
  const first = new Date(y, m, 1), lead = (first.getDay() + 6) % 7;
  const daysIn = new Date(y, m + 1, 0).getDate();
  const cells = Math.ceil((lead + daysIn) / 7) * 7;
  let html = "";
  for (let i = 0; i < cells; i++) {
    const d = new Date(y, m, i - lead + 1);
    const k = key(d.getFullYear(), d.getMonth(), d.getDate());
    const inMonth = d.getMonth() === m;
    const items = byDate.get(k) || [];
    const cls = ["day", inMonth ? "" : "out", k === todayKey ? "today" : "", items.length ? "has" : "", (i % 7) > 4 ? "weekend" : ""].filter(Boolean).join(" ");
    html += `<div class="${cls}" role="gridcell"${items.length ? ` tabindex="0" data-day="${k}"` : ""} aria-label="${d.getDate()} ${MONTHS[d.getMonth()]}${items.length ? `, ${items.length} släpp` : ""}">
      <span class="num">${d.getDate()}</span>
      ${items.length ? `<ul class="evs">${items.map(chip).join("")}</ul><span class="dots" aria-hidden="true">${items.map((it) => `<i class="${it.kind === "set" ? "lg-set" : "lg-drop"}"></i>`).join("")}</span>` : ""}
    </div>`;
  }
  $("#days").innerHTML = html;

  // Lista för månaden: tydlig även på mobilen där rutorna är små.
  const monthKeys = [...byDate.keys()].filter((k) => k.startsWith(`${y}-${pad(m + 1)}`)).sort();
  $("#agenda").innerHTML = monthKeys.length ? monthKeys.map((k) => {
    const d = new Date(`${k}T12:00:00`);
    return `<li class="ag ${k < todayKey ? "past" : ""}">
      <div class="ag-date"><b>${d.getDate()}</b><span>${MONTHS[d.getMonth()].slice(0, 3)}</span></div>
      <ul>${byDate.get(k).map((it) => `<li>${it.kind === "set" && it.logo ? `<img src="${esc(it.logo)}" alt="" loading="lazy">` : it.images?.length ? `<span class="ag-imgs">${it.images.slice(0, 3).map(thumb).join("")}</span>` : `<i class="${it.kind === "set" ? "lg-set" : "lg-drop"}"></i>`}
        <span><b>${esc(it.name)}</b>${it.kind === "set" ? " · nytt set" : it.type ? ` · ${esc(it.type)}` : ""}${it.note ? `<small>${esc(it.note)}</small>` : ""}</span></li>`).join("")}</ul>
      <button type="button" class="btn small ag-open" data-day="${k}">Visa produkter</button>
    </li>`;
  }).join("") : `<li class="msg">Inga släpp inlagda i ${MONTHS[m]}.</li>`;
  history.replaceState(null, "", `#${y}-${pad(m + 1)}`);
}

function step(n) {
  const d = new Date(view.y, view.m + n, 1);
  view = { y: d.getFullYear(), m: d.getMonth() };
  render();
}
$("#prev").addEventListener("click", () => step(-1));
$("#next").addEventListener("click", () => step(1));
$("#today").addEventListener("click", () => { view = { y: now.getFullYear(), m: now.getMonth() }; render(); });
document.addEventListener("keydown", (e) => {
  if (e.target.closest("input,select,textarea")) return;
  if (e.key === "ArrowLeft") step(-1);
  if (e.key === "ArrowRight") step(1);
});

function renderSets() {
  const q = $("#q").value.toLowerCase();
  $("#latest").innerHTML = sets.filter((s) => s.name.toLowerCase().includes(q)).map(setCard).join("")
    || '<div class="msg">Inga set matchade.</div>';
  if (!q) fillRows($("#latest"), 4);
  else [...$("#latest").children].forEach((c) => (c.hidden = false));
}
$("#q").addEventListener("input", renderSets);
bindSetCards($("#latest"));

$("#days").innerHTML = `<div class="day out" style="grid-column:1/-1">${loading("Ninjan bläddrar i kalendern")}</div>`;
$("#latest").innerHTML = skeleton(10);
const [releases, latest] = await Promise.all([allReleases().catch(() => []), latestSets(24).catch(() => [])]);
// Produktbilder och butiksläge från bevakningen.
const rd = await releaseData().catch(() => null);
for (const r of releases) {
  const set = rd?.releases.find((x) => x.id === r.id);
  const wave = set ? set.waves.findIndex((w) => w.date === r.date) : -1;
  const items = wave >= 0 ? rd.items.get(r.id).filter((it) => it.wave === wave) : [];
  add(r.date, { kind: "drop", name: r.name, type: r.type, note: r.note, id: r.id, wave, set: r.set, items, images: items.map((it) => it.image).filter(Boolean) });
}
// Ett set som redan finns som omgång samma dag visas bara en gång.
const dropSets = new Set(releases.map((r) => `${r.date}|${r.set.toLowerCase()}`));
for (const s of latest) if (s.releaseDate && !dropSets.has(`${s.releaseDate}|${s.name.toLowerCase()}`)) add(s.releaseDate, { kind: "set", name: s.name, logo: setLogo(s), setId: s.id, cards: s.cardCount?.official });
sets = latest.slice(0, 20);
render();
renderSets();

// ---------- Tryck på en dag: produkter, priser och butiker för dagens släpp ----------
const modal = $("#day-modal");
const lookup = (key) => { const [k, i] = key.split("|"); return byDate.get(k)[+i].items; };
function openDay(k) {
  const d = new Date(`${k}T12:00:00`);
  const list = byDate.get(k) || [];
  modal.querySelector(".dm-body").innerHTML = `<p class="dm-date">${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</p>
    ${list.map((it, i) => it.kind === "set" ? `<section class="dm-item">
        <div class="dm-head">${it.logo ? `<img class="dm-logo" src="${esc(it.logo)}" alt="">` : ""}<div><h3>${esc(it.name)}</h3><p class="muted">Nytt set${it.cards ? ` · ${it.cards} kort` : ""}</p></div></div>
        <a class="btn small primary" href="priser.html?set=${encodeURIComponent(it.setId)}">Se kort och priser</a></section>`
      : `<section class="dm-item">
        <div class="dm-head"><div><h3>${esc(it.set)}</h3><p class="muted">${it.items.length} ${it.items.length === 1 ? "produkt" : "produkter"} släpps ${short(k)}${it.note ? ` · ${esc(it.note)}` : ""}</p></div></div>
        ${galleryHTML(it.items, `${k}|${i}`)}
        <div class="dm-actions"><button type="button" class="btn small" data-show="${esc(it.id)}" data-wave="${it.wave}">Visa i släppkortet</button>
        <a class="btn small" href="butiker.html#notiser">Få notis</a></div></section>`).join("")}`;
  modal.showModal();
}
if (rd) bindGallery(modal, lookup, rd.names);
$("#days").addEventListener("click", (e) => { const day = e.target.closest("[data-day]"); if (day) openDay(day.dataset.day); });
$("#days").addEventListener("keydown", (e) => { const day = e.target.closest("[data-day]"); if (day && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDay(day.dataset.day); } });
$("#agenda").addEventListener("click", (e) => { const a = e.target.closest("[data-day]"); if (a) openDay(a.dataset.day); });
modal.addEventListener("click", (e) => {
  if (e.target === modal || e.target.closest(".cm-close")) return modal.close();
  const show = e.target.closest("[data-show]");
  if (show) {
    modal.close();
    const art = document.getElementById(`rel-${show.dataset.show}`);
    if (!art) return;
    const w = art.querySelector(`.wave[data-i="${show.dataset.wave}"]`);
    if (w && w.getAttribute("aria-pressed") !== "true") w.click();
    art.scrollIntoView({ behavior: "smooth", block: "start" });
  }
});
