// Släppsidan, uppifrån och ner: nästa stora släpp, kommande släpp (lista eller kalender), nyligen släppta och
// en länk till alla set. Allt om ett enskilt släpp (produkter, butiker, omgångar) öppnas i en dialog.
import { $, esc, loading, latestSets, setLogo, setPages, daysUntil } from "./site.js";
import { releaseData, nextWave, detailHTML, fillDetail, bindDetail, pill, pillHTML, LANG, long, short, inDays, dateBox, waveText, meta } from "./releases.js";
import { mountCalendar, MONTHS } from "./calendar.js";
import { getAnatomyData, renderPullRatesModal } from "./anatomy.js";

const RECENT_DAYS = 60; // så länge syns en omgång under "Nyligen släppta"
const startOfToday = () => { const t = new Date(); t.setHours(0, 0, 0, 0); return t; };
const day = (s) => new Date(`${s}T12:00:00`);
const MONTH_TITLE = (s) => { const d = day(s), m = MONTHS[d.getMonth()]; return `${m[0].toUpperCase()}${m.slice(1)} ${d.getFullYear()}`; };

$("#rel-list").innerHTML = loading("Ninjan kollar vad som är på väg");
$("#days").innerHTML = `<div class="day out" style="grid-column:1/-1">${loading("Ninjan bläddrar i kalendern")}</div>`;

let ctx;
try {
  ctx = await releaseData();
} catch {
  $("#rel-list").innerHTML = '<div class="msg">Släppen kunde inte laddas. Försök igen om en stund.</div>';
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

// ---------- Nästa stora släpp ----------
// Nästa nya set (inga omgångar släppta än). Finns inget sådant visas närmaste kommande omgång i stället.
const today = startOfToday();
const byNext = (a, b) => nextWave(a).date.localeCompare(nextWave(b).date);
const upcoming = ctx.releases.filter((r) => nextWave(r)).sort(byNext);
const hero = upcoming.find((r) => day(r.waves[0].date) >= today) || upcoming[0];

// Kalenderfil (.ics) med släppdagen och förreleasen, så att man kan lägga in den i mobilens kalender.
function icsFor(r, w) {
  const ymd = (s) => s.replace(/-/g, "");
  const next = (s) => { const d = day(s); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };
  const txt = (s) => s.replace(/[\\,;]/g, (c) => `\\${c}`);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const url = `https://lootninja.se/slapp.html?rel=${encodeURIComponent(r.id)}`;
  const ev = (uid, from, to, title) => ["BEGIN:VEVENT", `UID:${uid}@lootninja.se`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(from)}`,
    `DTEND;VALUE=DATE:${ymd(next(to))}`, `SUMMARY:${txt(title)}`, `URL:${url}`, "END:VEVENT"];
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Lootninja//Släpp//SV", "CALSCALE:GREGORIAN",
    ...ev(`${r.id}-${w.date}`, w.date, w.date, `${r.set} släpps`)];
  if (r.prerelease && day(r.prerelease.to) >= today) lines.push(...ev(`${r.id}-forrelease`, r.prerelease.from, r.prerelease.to, `${r.set}: förrelease i spelbutiker`));
  return [...lines, "END:VCALENDAR"].join("\r\n");
}

function renderHero() {
  if (!hero) return;
  const w = nextWave(hero), wi = hero.waves.indexOf(w), n = daysUntil(w.date), logo = ctx.logos.get(hero.id);
  const pre = hero.prerelease && day(hero.prerelease.to) >= today ? hero.prerelease : null;
  $("#rel-hero").innerHTML = `
    <div class="rh-count" aria-label="${esc(inDays(n))}">${n > 0 ? `<b>${n}</b><span>${n === 1 ? "dag kvar" : "dagar kvar"}</span>` : `<b>!</b><span>${esc(inDays(n))}</span>`}</div>
    <div class="rh-main">
      <span class="kicker">Nästa stora släpp${w.preliminary || hero.preliminary ? " · preliminärt datum" : ""}</span>
      <h2>${esc(hero.set)}</h2>
      <p class="rh-meta">${esc([meta(hero), long(w.date)].filter(Boolean).join(" · "))}</p>
      ${pre ? `<p class="rh-pre">Förrelease i spelbutiker ${short(pre.from)}–${short(pre.to)}</p>` : ""}
      <div class="rh-actions">
        ${pillHTML(pill(hero, ctx, wi))}
        <button type="button" class="btn small primary" data-open="${esc(hero.id)}" data-wave="${wi}">Produkter och butiker</button>
        <a class="btn small" href="butiker.html#notiser">Få notis</a>
        <button type="button" class="btn small" data-ics>Lägg i kalendern</button>
      </div>
    </div>
    ${logo ? `<img class="rh-logo" src="${esc(logo)}" alt="" loading="lazy">` : ""}`;
  $("#rel-hero [data-ics]").addEventListener("click", () => {
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([icsFor(hero, w)], { type: "text/calendar" })), download: `${hero.id}.ics` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}
renderHero();

// ---------- Kommande och nyligen släppta ----------
// En rad per omgång (och en för förreleasen), sorterat på datum. Språkfiltret gäller både listan och "Nyligen släppta".
let lang = "";
const rows = [];
for (const r of ctx.releases) {
  r.waves.forEach((w, wi) => rows.push({ r, w, wi, date: w.date }));
  if (r.prerelease) rows.push({ r, date: r.prerelease.from, to: r.prerelease.to, pre: true });
}
const announced = ctx.releases.filter((r) => !r.waves.length);
const isUpcoming = (x) => day(x.to || x.date) >= today;
const isRecent = (x) => !isUpcoming(x) && !x.pre && (today - day(x.date)) / 864e5 <= RECENT_DAYS;

function rowHTML(x) {
  const { r } = x, logo = ctx.logos.get(r.id);
  const tags = [r.language !== "en" ? LANG[r.language] : "", x.w?.preliminary || r.preliminary ? "Preliminärt" : ""].filter(Boolean);
  const what = x.pre ? `Förrelease i spelbutiker ${short(x.date)}–${short(x.to)}` : waveText(x.w, r);
  return `<li class="rel-row${x.pre ? " is-pre" : ""}">
    ${dateBox(x.date)}
    <div class="rr-main">
      <div class="rr-title">${logo ? `<img src="${esc(logo)}" alt="" loading="lazy">` : ""}<b>${esc(r.set)}</b>${tags.map((t) => `<span class="rr-tag">${esc(t)}</span>`).join("")}</div>
      <p class="rr-prod">${esc(what)}</p>
    </div>
    <div class="rr-side">
      ${x.pre ? "" : pillHTML(pill(r, ctx, x.wi))}
      <button type="button" class="btn small" data-open="${esc(r.id)}"${x.pre ? "" : ` data-wave="${x.wi}"`}>Visa</button>
    </div>
  </li>`;
}

function renderLists() {
  const mine = (r) => !lang || r.language === lang;
  const next = rows.filter((x) => isUpcoming(x) && mine(x.r)).sort((a, b) => a.date.localeCompare(b.date) || !!b.pre - !!a.pre);
  const months = new Map();
  for (const x of next) { const k = x.date.slice(0, 7); if (!months.has(k)) months.set(k, []); months.get(k).push(x); }
  const ann = announced.filter(mine);
  $("#rel-list").innerHTML = [...months].map(([k, list]) => `<h3 class="rel-month">${esc(MONTH_TITLE(`${k}-01`))}</h3>
      <ul class="rel-rows">${list.map(rowHTML).join("")}</ul>`).join("")
    + (ann.length ? `<h3 class="rel-month">Datum inte klart</h3><ul class="rel-rows">${ann.map((r) => `<li class="rel-row">${dateBox(null)}
      <div class="rr-main"><div class="rr-title"><b>${esc(r.set)}</b><span class="rr-tag">${esc(LANG[r.language] || "")}</span></div><p class="rr-prod">Annonserat</p></div>
      <div class="rr-side">${pillHTML(pill(r, ctx))}<button type="button" class="btn small" data-open="${esc(r.id)}">Visa</button></div></li>`).join("")}</ul>` : "")
    || '<p class="rel-empty">Inga kommande släpp inlagda just nu.</p>';
  const recent = rows.filter((x) => isRecent(x) && mine(x.r)).sort((a, b) => b.date.localeCompare(a.date));
  $("#rel-recent").hidden = !recent.length;
  $("#rel-recent-count").textContent = recent.length ? `(${recent.length})` : "";
  $("#rel-recent-list").innerHTML = recent.length ? `<ul class="rel-rows">${recent.map(rowHTML).join("")}</ul>` : "";
}

// Språkfiltret visas bara när det finns släpp på mer än ett språk.
const langs = [...new Set(ctx.releases.filter((r) => nextWave(r) || !r.waves.length).map((r) => r.language))];
if (langs.length > 1) {
  $("#rel-filter").innerHTML = [["", "Alla"], ...langs.map((l) => [l, LANG[l] || l])]
    .map(([v, t]) => `<button type="button" data-lang="${esc(v)}" aria-pressed="${v === lang}">${esc(t)}</button>`).join("");
  $("#rel-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (!b) return;
    lang = b.dataset.lang;
    $("#rel-filter").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
    renderLists();
  });
}
renderLists();

// Lista eller kalender. Valet sparas till nästa besök.
function setView(v) {
  $("#rel-list").hidden = v === "cal";
  $("#rel-filter").hidden = v === "cal";
  $("#kalender").hidden = v !== "cal";
  $("#rel-view").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.view === v));
  try { localStorage.setItem("nl:rel-view", v); } catch {}
}
$("#rel-view").addEventListener("click", (e) => { const b = e.target.closest("[data-view]"); if (b) setView(b.dataset.view); });
let savedView = "list";
try { savedView = localStorage.getItem("nl:rel-view") || "list"; } catch {}
setView(savedView === "cal" ? "cal" : "list");

// Länk direkt till ett släpp: slapp.html?rel=delta-reign
const linked = new URLSearchParams(location.search).get("rel");
if (linked) openRelease(linked);

// ---------- Kalender ----------
// Varje omgång blir en händelse. Äldre set från TCGdex läggs till, så att det går att bläddra bakåt.
const events = new Map();
const add = (k, it) => { if (!events.has(k)) events.set(k, []); events.get(k).push(it); };
for (const r of ctx.releases) r.waves.forEach((w, wi) => {
  add(w.date, {
    kind: w.products.length ? "drop" : "set", release: r.id, wave: wi,
    title: w.products.length && !(w.products.length === 1 && w.products[0] === r.set) ? `${r.set}: ${w.products.join(" · ")}` : r.set,
    sub: [w.products.length ? (w.products.length === 1 ? "" : `${w.products.length} produkter`) : "nytt set", r.language !== "en" ? LANG[r.language] : ""].filter(Boolean).join(" · "),
    logo: !w.products.length ? ctx.logos.get(r.id) : null, setLogo: ctx.logos.get(r.id),
  });
});
const known = new Set(ctx.releases.flatMap((r) => [r.tcgdex, r.set.toLowerCase()]).filter(Boolean));
const [sets, pages] = await Promise.all([latestSets(24).catch(() => []), setPages()]);
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
        : pages.sets?.[it.setId] ? `<a class="btn small" href="${esc(pages.sets[it.setId])}">Allt om setet</a>`
        : `<a class="btn small" href="priser.html?set=${encodeURIComponent(it.setId)}">Kort och priser</a>`}
    </li>`).join("")}</ul>`;
  dayModal.showModal();
}
dayModal.addEventListener("click", (e) => { if (e.target === dayModal || e.target.closest(".cm-close")) dayModal.close(); });
mountCalendar(events, openDay);

const anatModal = $("#anat-modal");
if (anatModal) {
  anatModal.addEventListener("click", (e) => {
    if (e.target === anatModal || e.target.closest(".cm-close")) { anatModal.close(); return; }
    if (e.target.closest("[data-show-odds]")) {
      getAnatomyData().then((d) => { anatModal.querySelector(".anat-modal-body").innerHTML = renderPullRatesModal(d); });
    }
  });
}
