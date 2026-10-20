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
    const [p, s, e] = await Promise.all(["data/products.json", "data/stores-status.json", "data/events.json"]
      .map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json()).catch(() => ({}))));
    const names = Object.fromEntries((s.stores || []).map((x) => [x.id, x.name]));
    // Samma etiketter som på butikssidan: prissänkt eller nytt den senaste veckan.
    const week = Date.now() - 7 * 864e5, drop = new Map(), fresh = new Set();
    for (const ev of e.events || []) {
      if (ev.at < week) continue;
      if (ev.kind === "prissankt" && !drop.has(ev.product)) drop.set(ev.product, { from: ev.from, at: ev.at });
      if (ev.kind === "ny") fresh.add(ev.product);
    }
    // Prissänkt räknas bara om priset fortfarande är lägre än före sänkningen. Mer än 60 % lägre är
    // nästan alltid ett valutafel (dollar i stället för kronor) och visas inte.
    const dropOf = (x) => { const d = drop.get(x.id); return d && x.price < d.from && x.price >= d.from * 0.4 ? d : null; };
    // Prissänkta (senaste sänkningen först) varvas med det som ändrades senast, så att båda syns
    // oavsett hur många kort som får plats på en rad. En per produkt: samma ETB från fem butiker visas en gång.
    const seen = new Set(), once = (x) => { const k = groupKey(x); return !seen.has(k) && seen.add(k); };
    const inStock = (p.products || []).filter((x) => x.available && x.image);
    const drops = inStock.filter(dropOf).sort((a, b) => dropOf(b).at - dropOf(a).at).filter(once).slice(0, 6);
    const latest = inStock.filter((x) => !dropOf(x)).sort((a, b) => b.lastChange - a.lastChange).filter(once).slice(0, 12 - drops.length);
    const list = [];
    for (let i = 0; list.length < drops.length + latest.length; i++) { if (drops[i]) list.push(drops[i]); if (latest[i]) list.push(latest[i]); }
    el.innerHTML = list.map((x) => productCard(x, names[x.store], { drop: dropOf(x)?.from, isNew: fresh.has(x.id) })).join("")
      || '<div class="msg">Inget i lager just nu.</div>';
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
