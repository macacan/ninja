import { groupKey } from "./group.js";
import { $, esc, fmt, skeleton, upcomingReleases, daysUntil, latestSets, setCard, setLogo, setPages, news, newsItem, productCard, fillRows, liveStock, getJSON } from "./site.js";
import { getPrefs } from "./prefs.js";
import { bindSetCards } from "./setcards.js";
import "./restock.js";

// "Vad är ditt kort värt?": på mobilen fäller rubriken ut sökfältet och sätter markören i det.
$(".pb-toggle")?.addEventListener("click", (e) => {
  const band = e.currentTarget.closest(".price-band");
  const open = band.classList.toggle("is-open");
  e.currentTarget.setAttribute("aria-expanded", String(open));
  if (open) band.querySelector("input[type=search]")?.focus();
});

// Dina bevakade: produkterna man bevakar med klockan på butikssidan, hämtade om varje minut.
// En per produkt: butiken med lägst pris i lager, annars lägst pris för förbeställning. Syns bara om man bevakar något.
async function homeWatch() {
  const wrap = $("#home-watch-wrap"), el = $("#home-watch");
  const watch = new Set(getPrefs().watch || []);
  wrap.hidden = !watch.size;
  if (!watch.size) return;
  if (!el.children.length) el.innerHTML = skeleton(4);
  try {
    const [p, s] = await liveStock();
    const names = Object.fromEntries((s.stores || []).map((x) => [x.id, x.name]));
    const best = new Map();
    for (const x of p.products || []) {
      const k = groupKey(x);
      if (!watch.has(k) || !(x.available || x.preorder)) continue;
      const cur = best.get(k);
      if (!cur || (x.available && !cur.available) || (!!x.available === !!cur.available && x.price < cur.price)) best.set(k, x);
    }
    const list = [...best.values()].sort((a, b) => !!b.available - !!a.available || a.price - b.price);
    el.innerHTML = list.map((x) => productCard(x, names[x.store])).join("")
      || '<div class="msg">Inget av det du bevakar finns i lager just nu.</div>';
  } catch { el.innerHTML = '<div class="msg">Butikslagret uppdateras snart.</div>'; }
}

// De fyra senaste prissänkningarna som gör butiken billigast, med produkten från lagret så att kortet stämmer.
async function homeDrops() {
  const el = $("#home-drops");
  el.innerHTML = skeleton(4);
  try {
    const [{ events }, [p, s]] = await Promise.all([getJSON("data/events.json"), liveStock()]);
    const names = Object.fromEntries((s.stores || []).map((x) => [x.id, x.name]));
    const byId = new Map((p.products || []).map((x) => [x.id, x]));
    const seen = new Set(), list = [];
    for (const e of events.filter((x) => x.kind === "prissankt").sort((a, b) => b.at - a.at)) {
      const x = byId.get(e.product);
      if (!x || seen.has(e.product) || !(x.available || x.preorder)) continue;
      seen.add(e.product);
      list.push(productCard(x, names[x.store], { drop: e.from }));
      if (list.length === 4) break;
    }
    el.innerHTML = list.join("") || '<div class="msg">Inga prissänkningar just nu.</div>';
  } catch { el.innerHTML = '<div class="msg">Prissänkningarna kunde inte laddas.</div>'; }
}

async function nextDrop() {
  const el = $("#next-drop");
  try {
    // De två närmaste släppen, alltid två om det finns så många i kalendern.
    const next = (await upcomingReleases()).sort((a, b) => new Date(a.date) - new Date(b.date)).slice(0, 2);
    if (!next.length) { el.innerHTML = '<div class="msg">Inga kommande släpp inlagda just nu.</div>'; return; }
    el.innerHTML = next.map((r) => {
      const d = daysUntil(r.date);
      return `<div class="next-drop px-frame">
        <div class="countdown" aria-label="${d} dagar kvar">
          <div><b>${String(d).padStart(2, "0")}</b><small>dagar kvar</small></div>
        </div>
        <div><h3>${esc(r.name)}</h3><p>${fmt(r.date)}${r.type ? ` · ${esc(r.type)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</p></div>
        <a class="btn primary small" href="slapp.html">Alla släpp</a>
      </div>`;
    }).join("");
  } catch { el.innerHTML = '<div class="msg">Kunde inte läsa släppkalendern.</div>'; }
}

async function homeNews() {
  const el = $("#home-news");
  try {
    const d = await news();
    el.innerHTML = d.articles.slice(0, 3).map(newsItem).join("") || '<div class="msg">Inga nyheter ännu.</div>';
  } catch { el.innerHTML = '<div class="msg">Nyheterna kunde inte laddas.</div>'; }
}

async function homeSets() {
  const el = $("#home-sets");
  el.innerHTML = skeleton(4);
  try {
    const [sets, pages] = await Promise.all([latestSets(16), setPages()]);
    // Senaste set: fem stycken, på en rad på dator (se #home-sets i style.css).
    el.innerHTML = sets.filter((s) => setLogo(s)).slice(0, 5).map((s, i) => setCard(s, i, pages)).join("");
    bindSetCards(el);
    fillRows(el, 2);
  } catch { el.innerHTML = '<div class="msg">Kunde inte nå TCGdex just nu.</div>'; }
}

// Landskapet börjar under tickern och ligger bakom navbaren, så att himlen syns bakom menyn.
// Höjden följer headern, som är olika hög på dator och mobil.
const heroUnderHeader = () => {
  const header = document.querySelector(".site-header"), hero = document.querySelector(".hero");
  if (header && hero) hero.style.marginTop = `-${header.offsetHeight}px`;
};
heroUnderHeader();
addEventListener("resize", heroUnderHeader);
homeDrops();
nextDrop();
homeWatch();
setInterval(homeWatch, 60e3);
homeSets();
homeNews();
