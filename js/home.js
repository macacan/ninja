import { groupKey } from "./group.js";
import { $, esc, fmt, kr, loading, skeleton, upcomingReleases, daysUntil, latestSets, setCard, setLogo, news, newsItem, productCard, liveStamp, fillRows } from "./site.js";
import { bindSetCards } from "./setcards.js";
import "./restock.js";

// Produkterna i lager som ändrades senast, t.ex. nyss kom in eller fick nytt pris.
// Hämtas om varje minut så att listan följer bevakningen. Visar bara hela rader.
async function homeShop() {
  const el = $("#home-shop");
  if (!el.children.length) el.innerHTML = skeleton(4);
  try {
    const [p, s] = await Promise.all(["data/products.json", "data/stores-status.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json())));
    const names = Object.fromEntries(s.stores.map((x) => [x.id, x.name]));
    // En per produkt: samma ETB från fem butiker ska bara synas en gång.
    const seen = new Set();
    const list = p.products.filter((x) => x.available && x.image).sort((a, b) => b.lastChange - a.lastChange)
      .filter((x) => { const k = groupKey(x); return !seen.has(k) && seen.add(k); }).slice(0, 12);
    el.innerHTML = list.map((x) => productCard(x, names[x.store])).join("") || '<div class="msg">Inget i lager just nu.</div>';
    fillRows(el, 2);
  } catch { el.closest(".wrap") && (el.innerHTML = '<div class="msg">Butikslagret uppdateras snart.</div>'); }
}

async function nextDrop() {
  const el = $("#next-drop");
  try {
    const [r] = await upcomingReleases();
    if (!r) { el.innerHTML = '<div class="msg">Inga kommande släpp inlagda just nu.</div>'; return; }
    const d = daysUntil(r.date);
    const weeks = Math.floor(d / 7), days = d % 7;
    el.innerHTML = `<div class="next-drop px-frame">
      <div class="countdown" aria-label="${d} dagar kvar">
        <div><b>${String(weeks).padStart(2, "0")}</b><small>veckor</small></div>
        <div><b>${String(days).padStart(2, "0")}</b><small>dagar</small></div>
      </div>
      <div><h3>${esc(r.name)}</h3><p>${fmt(r.date)}${r.type ? ` · ${esc(r.type)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</p></div>
      <a class="btn primary small" href="slapp.html">Alla släpp</a>
    </div>`;
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
    const sets = await latestSets(16);
    el.innerHTML = sets.filter((s) => setLogo(s)).slice(0, 12).map(setCard).join("");
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
nextDrop();
homeShop();
setInterval(homeShop, 60e3);
homeSets();
homeNews();
