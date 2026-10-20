// Släppsidan, uppifrån och ner: tidslinje, alla släpp, annonserade släpp, kalender och alla set.
// Allt om ett enskilt släpp (produkter, butiker, omgångar) öppnas i en dialog.
import { $, esc, loading, skeleton, fillRows, latestSets, setCard, setLogo } from "./site.js";
import { releaseData, nextWave, isOver, timelineHTML, releaseCard, detailHTML, fillDetail, bindDetail, pill, LANG } from "./releases.js";
import { mountCalendar, MONTHS } from "./calendar.js";
import { bindSetCards } from "./setcards.js";

const RECENT_DAYS = 45; // så länge ligger ett avslutat släpp kvar bland de aktuella
const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const day = (s) => new Date(`${s}T12:00:00`);

$("#releases").innerHTML = loading("Ninjan kollar vad som är på väg");
$("#latest").innerHTML = skeleton(8);
$("#days").innerHTML = `<div class="day out" style="grid-column:1/-1">${loading("Ninjan bläddrar i kalendern")}</div>`;

let ctx;
try {
  ctx = await releaseData();
} catch {
  $("#releases").innerHTML = '<div class="msg">Släppen kunde inte laddas. Försök igen om en stund.</div>';
  throw new Error("Släppen kunde inte laddas");
}

// ---------- Dialog med allt om ett släpp ----------
const modal = $("#rel-modal");
bindDetail(modal, ctx);
function openRelease(id, wave = null) {
  const r = ctx.byId.get(id);
  if (!r) return;
  const body = modal.querySelector(".rm-body");
  body.innerHTML = detailHTML(r, ctx, wave);
  fillDetail(body.querySelector(".rd"), r, ctx, wave);
  if (!modal.open) modal.showModal();
  body.scrollTop = 0;
}
modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest(".cm-close")) modal.close(); });
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-open]");
  if (!b) return;
  dayModal.open && dayModal.close();
  openRelease(b.dataset.open, b.dataset.wave ? +b.dataset.wave : null);
});

// ---------- Nästa släpp och aktuella släpp ----------
const today = startOfToday();
const upcoming = ctx.releases.filter((r) => nextWave(r)).sort((a, b) => nextWave(a).date.localeCompare(nextWave(b).date));
const recent = ctx.releases.filter((r) => isOver(r) && (today - day(r.waves.at(-1).date)) / 864e5 <= RECENT_DAYS)
  .sort((a, b) => b.waves.at(-1).date.localeCompare(a.waves.at(-1).date));
const announced = ctx.releases.filter((r) => !r.waves.length);

// Tidslinjen: ◀ ▶ bläddrar ett släpp i taget, "Nu" går tillbaka till aktuellt släpp.
let tlShift = 0;
function renderTimeline(focus = null) {
  const { nav, list } = timelineHTML(ctx.releases, ctx, tlShift);
  $("#tl-nav").innerHTML = nav;
  $("#next-release").innerHTML = list;
  // Behåll fokus på knappen som trycktes, eller närmaste som fortfarande går att trycka på.
  if (focus) {
    const btns = [...$("#tl-nav").querySelectorAll("button")];
    (btns.find((b) => b.dataset.tl === focus && !b.disabled) || btns.find((b) => !b.disabled))?.focus();
  }
}
$("#tl-nav").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tl]");
  if (!b || b.disabled) return;
  tlShift = b.dataset.tl === "now" ? 0 : tlShift + +b.dataset.tl;
  renderTimeline(b.dataset.tl);
});
renderTimeline();
$("#releases").innerHTML = [...upcoming, ...recent].map((r) => releaseCard(r, ctx)).join("")
  || '<div class="msg">Inga släpp inlagda just nu.</div>';
$("#announced").innerHTML = announced.length ? `<div class="section"><h2>Annonserat, datum inte klart</h2></div>
  <ul class="ann">${announced.map((r) => `<li><button type="button" data-open="${esc(r.id)}"><b>${esc(r.set)}</b><span>${esc(LANG[r.language] || "")}</span>${pillHTML(pill(r, ctx))}</button></li>`).join("")}</ul>` : "";
function pillHTML(p) { return `<span class="pill ${p.cls}">${esc(p.text)}</span>`; }

// Länk direkt till ett släpp: slapp.html?rel=delta-reign
const linked = new URLSearchParams(location.search).get("rel");
if (linked) openRelease(linked);

// ---------- Kalender ----------
// Varje omgång blir en händelse. Äldre set från TCGdex läggs till, så att det går att bläddra bakåt.
const events = new Map();
const add = (k, it) => { if (!events.has(k)) events.set(k, []); events.get(k).push(it); };
for (const r of ctx.releases) r.waves.forEach((w, wi) => {
  const items = ctx.lookup(`${r.id}|${wi}`);
  add(w.date, {
    kind: w.products.length ? "drop" : "set", release: r.id, wave: wi,
    title: w.products.length && !(w.products.length === 1 && w.products[0] === r.set) ? `${r.set}: ${w.products.join(" · ")}` : r.set,
    sub: [w.products.length ? (w.products.length === 1 ? "" : `${w.products.length} produkter`) : "nytt set", r.language !== "en" ? LANG[r.language] : ""].filter(Boolean).join(" · "),
    logo: !w.products.length ? ctx.logos.get(r.id) : null, setLogo: ctx.logos.get(r.id), images: items.map((it) => it.image).filter(Boolean),
  });
});
const known = new Set(ctx.releases.flatMap((r) => [r.tcgdex, r.set.toLowerCase()]).filter(Boolean));
const sets = await latestSets(24).catch(() => []);
for (const s of sets) if (s.releaseDate && !known.has(s.id) && !known.has(s.name.toLowerCase())) {
  add(s.releaseDate, { kind: "set", setId: s.id, title: s.name, sub: `nytt set${s.cardCount?.official ? ` · ${s.cardCount.official} kort` : ""}`, logo: setLogo(s) });
}

// Tryck på en dag: ett släpp öppnas direkt, flera listas först.
const dayModal = $("#day-modal");
function openDay(k) {
  const list = events.get(k) || [];
  if (list.length === 1 && list[0].release) return openRelease(list[0].release, list[0].wave);
  const d = day(k);
  dayModal.querySelector(".dm-body").innerHTML = `<p class="kicker">${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}</p>
    <ul class="dm-list">${list.map((it) => `<li>
      ${it.logo || it.setLogo ? `<img src="${esc(it.logo || it.setLogo)}" alt="" loading="lazy">` : `<span class="dm-dot">${it.kind === "set" ? '<i class="lg-set"></i>' : '<i class="lg-drop"></i>'}</span>`}
      <span><b>${esc(it.title)}</b><small>${esc(it.sub || "")}</small></span>
      ${it.release ? `<button type="button" class="btn small primary" data-open="${esc(it.release)}" data-wave="${it.wave}">Visa</button>`
        : `<a class="btn small" href="priser.html?set=${encodeURIComponent(it.setId)}">Kort och priser</a>`}
    </li>`).join("")}</ul>`;
  dayModal.showModal();
}
dayModal.addEventListener("click", (e) => { if (e.target === dayModal || e.target.closest(".cm-close")) dayModal.close(); });
mountCalendar(events, openDay);

// ---------- Alla set ----------
const shownSets = sets.slice(0, 20);
function renderSets() {
  const q = $("#q").value.toLowerCase();
  $("#latest").innerHTML = shownSets.filter((s) => s.name.toLowerCase().includes(q)).map(setCard).join("")
    || '<div class="msg">Inga set matchade.</div>';
  if (!q) fillRows($("#latest"), 4);
  else [...$("#latest").children].forEach((c) => (c.hidden = false));
}
$("#q").addEventListener("input", renderSets);
bindSetCards($("#latest"));
renderSets();
