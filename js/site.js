// Delade delar för alla sidor: header, footer, API-hjälpare och kortrendering.
import { icon, mountAllScenes } from "./pixel.js";
import { mountBanners } from "./banners.js";
import { mountCardAutocomplete } from "./card-autocomplete.js";
import { langMark } from "./langmark.js";
import "./tracker.js"; // besöksstatistik utan kakor, se js/tracker.js

export const API = "https://api.tcgdex.net/v2/en";
export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Länkar från butiker och nyhetsflöden: bara http(s) släpps igenom, allt annat (t.ex. "javascript:") blir "#".
export const safeUrl = (u) => { if (!u) return "#"; try { const x = new URL(u, location.href); return /^https?:$/.test(x.protocol) ? x.href : "#"; } catch { return "#"; } };
export const fmt = (d) => new Date(d).toLocaleDateString("sv-SE", { day: "numeric", month: "short", year: "numeric" });
export const kr = (n) => (n > 0 && n < 0.5 ? "under 1 kr" : Math.round(n).toLocaleString("sv-SE") + " kr");
// Platshållarkort medan ett rutnät laddar, så att sidan inte hoppar när innehållet kommer.
export const skeleton = (n = 4) => Array.from({ length: n }, () => '<div class="tcard skel" aria-hidden="true"><div class="art"></div><i></i><i></i><i class="short"></i></div>').join("");
export const loading = (text = "Ninjan letar") => `<div class="loading"><span class="bar"></span>${esc(text)}…</div>`;
export { icon };
// Halvfylld cirkel: växlar mellan ljust och mörkt läge.
const THEME_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/></svg>`;
const ICONS = ["★", "✦", "♦", "●"];

const NAV = [
  ["./", "Hem"],
  ["butiker.html#products", "Produkter"],
  ["priser.html", "Kortpriser"],
  ["vardering.html", "Värdering"],
  ["slapp.html", "Kalender"],
  ["set/", "Set"],
  ["nyheter.html", "Nyheter"],
];

// Filnamnet för sidan man är på (artikel.html hör till Nyheter, setsidorna i set/ till Set). Startsidan heter "./",
// så att länkarna går till lootninja.se/ och inte till dubbletten /index.html.
const pageOf = () => (location.pathname.includes("/set/") ? "set/"
  : { "artikel.html": "nyheter.html" }[location.pathname.split("/").pop()] || location.pathname.split("/").pop().replace(/^index\.html$/, "") || "./");

function header() {
  const here = pageOf();
  // På mobilen visas sidans namn i loggan i stället för "Lootninja" (startsidan behåller namnet).
  const mobileTitle = here === "./" ? "Lootninja" : NAV.find(([href]) => href.split("#")[0] === here)?.[1] || "Lootninja";
  return `<a class="skip" href="${esc(location.pathname)}#main">Hoppa till innehållet</a>
  <header class="site-header"><div class="wrap">
    <a class="logo" href="./"><img src="logo.svg" alt=""><span><b class="brand-desk">Lootninja</b><b class="brand-mob">${esc(mobileTitle)}</b><small>Kortsläpp & priser</small></span></a>
    <nav class="main-nav" aria-label="Huvudmeny"><ul>
      ${NAV.map(([href, label]) => `<li><a href="${href}"${href.split("#")[0] === here ? ' aria-current="page"' : ""}>${label}</a></li>`).join("")}
    </ul></nav>
    <form id="header-search" class="header-search" action="${searchTarget()}" role="search">
      <input type="search" name="q" placeholder="Sök kort, t.ex. Pikachu" aria-label="Sök kort">
    </form>
    <button type="button" class="theme-btn" data-theme-toggle aria-label="Växla mellan ljust och mörkt läge" title="Ljust/mörkt läge">${THEME_ICON}</button>
    <button type="button" class="menu-btn" aria-expanded="false" aria-controls="mobile-menu" aria-label="Meny">
      <svg class="burger" width="28" height="28" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18" stroke="currentColor" stroke-width="2.6" stroke-linecap="square"/></svg>
    </button>
  </div></header>`;
}

// Mobilen: hamburgerknappen sitter i headern och öppnar menyn med alla sidor och sökfältet.
function tabbar() {
  const here = pageOf();
  return `<div class="mobile-menu" id="mobile-menu" hidden>
    <div class="mm-sheet" role="dialog" aria-label="Meny">
      <button type="button" class="mm-close" aria-label="Stäng menyn">✕</button>
      <form class="mm-search" action="${searchTarget()}" role="search">
        <input type="search" name="q" placeholder="Sök kort, t.ex. Pikachu" aria-label="Sök kort">
      </form>
      <ul>${NAV.map(([href, label]) => `<li><a href="${href}"${href.split("#")[0] === here ? ' aria-current="page"' : ""}>${label}</a></li>`).join("")}</ul>
      <button type="button" class="mm-theme" data-theme-toggle>${THEME_ICON}<span>Mörkt läge</span></button>
    </div>
  </div>`;
}

function footer() {
  return `<footer class="site-footer">
    <canvas class="scene" data-scene="footer" aria-hidden="true"></canvas>
    <div class="wrap">
    <div class="footer-grid">
      <div class="about">
        <a class="logo" href="./"><img src="logo.svg" alt=""><span><b>Lootninja</b><small>Kortsläpp & priser</small></span></a>
        <p>Ett ideellt hobbyprojekt. Ninjan smyger fram kortsläpp, set och priser – gratis och utan konto. Priser och lager är vägledande och kan innehålla felaktigheter.</p>
      </div>
      <div><h2>Utforska</h2><ul>${NAV.map(([h, l]) => `<li><a href="${h}">${l}</a></li>`).join("")}<li><a href="set/">Alla set</a></li></ul></div>
      <div><h2>Mer</h2><ul>
        <li><a href="om.html">Om Lootninja</a></li>
        <li><a href="om.html#kallor">Alla källor</a></li>
        <li><a href="om.html#bevakning">Så fungerar bevakningen</a></li>
        <li><a href="butiker.html#notiser">Notiser <span class="footer-csoon">Kommer snart</span></a></li>
        <li><a href="villkor.html">Användarvillkor</a></li>
        <li><a href="integritet.html">Integritet och kakor</a></li>
        <li><a href="om.html#rattigheter">Rättigheter</a></li>
      </ul></div>
    </div>
    <p class="footer-legal">Lootninja är ett ideellt hobbyprojekt och självständigt fanprojekt. Varken The Pokémon Company, Nintendo, Creatures, GAME FREAK eller någon butik står bakom sidan.
    All data, priser och lagerstatus samlas in automatiskt och ska ses som vägledande – ta inte allt för 100% sanning då felaktiga priser, fördröjningar i uppdateringar eller tekniska fel kan förekomma. Dubbelkolla alltid direkt hos butiken innan köp.
    Kortbilder, setloggor och namn tillhör respektive rättighetsinnehavare. Landskap, figurer och design är Lootninjas egna.
    © ${new Date().getFullYear()} Lootninja.</p>
  </div></footer>`;
}

// Sökfältet i headern söker kortpriser, utom på värderingssidan där det värderar kortet.
const searchTarget = () => (location.pathname.endsWith("vardering.html") ? "vardering.html" : "priser.html");

export function mountChrome() {
  document.body.insertAdjacentHTML("afterbegin", header());
  document.body.insertAdjacentHTML("beforeend", footer() + tabbar());
  document.querySelectorAll("[data-theme-toggle]").forEach((b) => b.addEventListener("click", () => window.nlTheme?.toggle()));
  window.nlTheme?.apply();
  const menuBtn = $(".menu-btn"), menu = $("#mobile-menu");
  const setMenu = (open) => {
    menu.hidden = !open;
    menuBtn.setAttribute("aria-expanded", open);
    document.body.classList.toggle("menu-open", open);
  };
  // Hamburgaren ligger fast uppe till höger: i sidans topp på raden med loggan, och högst upp i fönstret när man scrollat.
  // Sätts på <html> så att även menyns sökrad (som ligger utanför headern) kan följa knappens läge.
  const placeMenuBtn = () => document.documentElement.style.setProperty("--menu-top", Math.max(8, menuBtn.parentElement.getBoundingClientRect().top + 8) + "px");
  addEventListener("scroll", placeMenuBtn, { passive: true });
  addEventListener("resize", placeMenuBtn);
  placeMenuBtn();
  menuBtn.addEventListener("click", () => setMenu(menu.hidden));
  menu.addEventListener("click", (e) => { if (e.target === menu || e.target.closest("a, .mm-close")) setMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { setMenu(false); menuBtn.focus(); } });
  // Ikoner som anges med data-icon i sidornas HTML.
  document.querySelectorAll("[data-icon]").forEach((el) => el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, +el.dataset.size || 28)));
  mountAllScenes();
  mountBanners();
  const menuInput = $(".mm-search input");
  if (menuInput) mountCardAutocomplete(menuInput, { formAction: searchTarget() });
  const headerInput = $("#header-search input");
  if (headerInput) mountCardAutocomplete(headerInput, { formAction: searchTarget() });
  // Startsidans sökruta (data-games) gäller alla spel och kopplas in av js/home.js.
  document.querySelectorAll(".search-row:not([data-games]) input[type=search]").forEach((inp) => {
    mountCardAutocomplete(inp, { formAction: "priser.html" });
  });
}

// Våra egna datafiler, alltid färska. Delar av sidan som ber om samma fil samtidigt (startsidans listor och
// flödet hämtar båda stock.json varje minut) får samma hämtning i stället för var sin.
const inflight = new Map();
export function liveJSON(url) {
  if (!inflight.has(url)) inflight.set(url, fetch(url, { cache: "no-cache" }).then((r) => r.json()).finally(() => inflight.delete(url)));
  return inflight.get(url);
}

// Adresserna till setsidorna i set/ (scripts/build-set-pages.mjs): { sets: { <tcgdex-id>: url }, releases: { <släpp-id>: url } }.
let setPagesData;
export const setPages = () => (setPagesData ??= fetch("data/set-pages.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => ({ sets: {}, releases: {} })));
// Ett korts set (TCGdex: { id, name }) som länk till setsidan, eller bara namnet om sidan saknas.
export const setLink = (set, pages) => {
  const url = set?.id && pages?.sets?.[set.id];
  return url ? `<a href="${esc(url)}">${esc(set.name)}</a>` : esc(set?.name || "");
};

// Det som går att köpa (data/stock.json) och butikernas status. Bevakningen skriver båda i samma sparning. Är
// stock.json äldre kör bevakningen en version som inte skriver den, och då används hela products.json i stället.
export async function liveStock() {
  const [stock, status] = await Promise.all([liveJSON("data/stock.json").catch(() => null), liveJSON("data/stores-status.json")]);
  return [stock && stock.updated >= status.updated - 60e3 ? stock : await liveJSON("data/products.json"), status];
}

// TCGdex ber att man cachar svar lokalt. Vi sparar dem i webbläsaren i 6 timmar.
const TTL = 6 * 3600e3;
export async function getJSON(url, ttl = TTL) {
  const key = "nl:" + url;
  try {
    const hit = JSON.parse(localStorage.getItem(key));
    if (hit && Date.now() - hit.t < ttl) return hit.d;
  } catch {}
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  const d = await r.json();
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), d })); }
  catch {
    // Fullt lagringsutrymme: rensa våra gamla svar och strunta i att cacha just detta.
    try { Object.keys(localStorage).filter((k) => k.startsWith("nl:")).forEach((k) => localStorage.removeItem(k)); } catch {}
  }
  return d;
}

// Kortlistor: 404 betyder inga träffar, men andra fel (t.ex. att TCGdex är nere) ska nå anroparen
// så att sidan kan säga det i stället för "hittade inga kort".
export const getList = (url) => getJSON(url).catch((e) => (e.message === "404" ? [] : Promise.reject(e)));

// Kortbilder som TCGdex saknar (t.ex. 30th Classic Collection), se data/card-images.json.
let extraCardImgs = {};
export const extraCardImgsReady = fetch("data/card-images.json").then((r) => r.json()).then((d) => (extraCardImgs = d)).catch(() => {});

// Returnerar bildadress för ett kort. Använder TCGdex webp om den finns,
// annars extra kortbild (från data/card-images.json),
// annars TCGplayer-bilden via variants_detailed eller sparad länk.
export function cardImg(c, size = "low") {
  if (!c) return null;
  const extra = extraCardImgs[c.id];
  if (extra) {
    return typeof extra === "string" ? extra : extra[size] || extra.low || extra.high || null;
  }
  const raw = c.image || c.img;
  if (raw) {
    if (typeof raw === "string" && (raw.startsWith("http://") || raw.startsWith("https://")) && (raw.includes("tcgplayer.com") || raw.endsWith(".jpg") || raw.endsWith(".jpeg") || raw.endsWith(".png") || raw.endsWith(".webp"))) {
      return raw;
    }
    return `${raw}/${size}.webp`;
  }
  const tcgplayer = c.tcgplayer
    || c.variants_detailed?.find((v) => v.thirdParty?.tcgplayer)?.thirdParty?.tcgplayer
    || c.variants_detailed?.[0]?.thirdParty?.tcgplayer;
  if (tcgplayer) {
    return `https://product-images.tcgplayer.com/fit-in/437x437/${tcgplayer}.jpg`;
  }
  return null;
}

// Bild från TCGdex med ninja-ikonen som reserv om bilden saknas eller inte laddar.
export function art(i, src, alt, kind = "") {
  const ic = `<span aria-hidden="true">${ICONS[i % 4]}</span>`;
  if (!src) return `<div class="art ${kind}">${ic}</div>`;
  return `<div class="art ${kind}"><img src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async"
    onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${ICONS[i % 4]}'}))"></div>`;
}

// Loggor för set som TCGdex saknar, se scripts/update-set-logos.mjs.
let extraLogos = {};
export const extraLogosReady = fetch("data/set-logos.json").then((r) => r.json()).then((d) => (extraLogos = d)).catch(() => {});

export const setLogo = (s) => (s.logo ? `${s.logo}.webp` : extraLogos[s.id] || null);

// Setets logga. Finns ingen logga alls blir det en textlogga i samma stil, så att alla kort ser likadana ut.
export function setArt(s) {
  const logo = s.image || setLogo(s);
  const word = `<span class="wordmark"><b>${esc(s.name)}</b>${s.serie?.name ? `<small>${esc(s.serie.name)}</small>` : ""}</span>`;
  if (!logo) return `<div class="art logo">${word}</div>`;
  return `<div class="art logo"><img src="${esc(logo)}" alt="${esc(s.name)}" loading="lazy" decoding="async"
    onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'wordmark',innerHTML:this.dataset.w}))" data-w="${esc(word.replace(/^<span class="wordmark">|<\/span>$/g, ""))}"></div>`;
}

export function card(title, date, tag, extra, i, soon, artHtml, badge, attrs = "", href = "") {
  return `<article class="tcard"${attrs ? ` ${attrs}` : ""}>${badge ? `<span class="badge ${badge.hot ? "hot" : ""}">${esc(badge.text)}</span>` : ""}${artHtml || art(i)}
    <h3>${href ? `<a class="stretch" href="${esc(href)}">${esc(title)}</a>` : esc(title)}</h3>
    <span class="tag ${soon ? "soon" : ""}">${esc(tag)}</span>
    <div class="meta"><span>${date ? fmt(date) : "Datum ej satt"}</span><span>${esc(extra)}</span></div></article>`;
}

// Set som släppts de senaste 60 dagarna får en "Nytt"-etikett. Setet länkar till sin sida i set/ (pages = setPages()),
// och sökmotorerna hittar sidorna den vägen. Har setet ingen sida än öppnar ett tryck alla kort i en ruta (setcards.js).
export const setCard = (s, i, pages) => {
  const age = s.releaseDate ? -daysUntil(s.releaseDate) : 999, page = pages?.sets?.[s.id];
  return card(s.name, s.releaseDate, s.serie?.name || "Set", `${s.cardCount?.official ?? "?"} kort`, i, false, setArt(s, i), age <= 60 ? { text: "Nytt" } : null,
    page ? "" : `data-set="${esc(s.id)}" role="button" tabindex="0" aria-label="Visa alla kort i ${esc(s.name)}"`, page);
};

// De senaste fysiska seten. TCG Pocket är ett mobilspel utan butikssläpp och hoppas över.
export async function latestSets(n = 16) {
  const recent = await getJSON(`${API}/sets?sort:field=releaseDate&sort:order=DESC&pagination:page=1&pagination:itemsPerPage=${n * 2}`);
  const [details] = await Promise.all([Promise.all(recent.map((s) => getJSON(`${API}/sets/${encodeURIComponent(s.id)}`).catch(() => null))), extraLogosReady]);
  const list = details.filter((s) => s && s.serie?.id !== "tcgp")
    .sort((a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""));
  // Delset med samma logga som huvudsetet (t.ex. "30th Classic Collection") visas inte två gånger:
  // vi behåller setet med flest kort.
  const byLogo = new Map();
  for (const s of list) {
    const logo = setLogo(s);
    if (!logo) continue;
    const o = byLogo.get(logo);
    if (!o || (s.cardCount?.total || 0) > (o.cardCount?.total || 0)) byLogo.set(logo, s);
  }
  return list.filter((s) => !setLogo(s) || byLogo.get(setLogo(s)) === s).slice(0, n);
}

// Släppkalendern: ett objekt per set med produktomgångar (waves). data/release-calendar.json byggs av
// scripts/update-releases.mjs (handskrivna data/releases.json plus automatiskt hittade släpp).
// Saknas den används de handskrivna släppen direkt.
let releaseData;
export function releaseSets() {
  const load = (f) => fetch(f, { cache: "no-cache" }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => d.releases || []);
  releaseData ??= load("data/release-calendar.json").catch(() => load("data/releases.json"));
  return releaseData;
}

// Varje omgång som en egen rad, t.ex. "30th Celebration: Battle Deck" den 30 oktober.
export async function allReleases() {
  // Ett set utan inlagda produkter ("Setet släpps") eller en fristående produkt visas med bara sitt namn.
  const named = (r, w) => (!w.products.length || (w.products.length === 1 && w.products[0] === r.set) ? r.set : `${r.set}: ${w.products.join(" · ")}`);
  return (await releaseSets()).flatMap((r) => r.waves.map((w) => ({
    name: named(r, w), set: r.set, id: r.id, date: w.date, language: r.language,
    type: !w.products.length ? "Nytt set" : named(r, w) === r.set ? "Fristående produkt" : w.products.length === 1 ? w.products[0] : `${w.products.length} produkter`,
    note: w.preliminary || r.preliminary ? "preliminärt datum" : "", products: w.products,
  }))).sort((a, b) => a.date.localeCompare(b.date));
}

// Kommande omgångar, närmast först.
export async function upcomingReleases() {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  return (await allReleases()).filter((r) => new Date(r.date) >= today);
}

export function daysUntil(date) {
  const d = new Date(date); d.setHours(0, 0, 0, 0);
  const t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 864e5);
}

// Tar emot ISO-sträng eller millisekunder.
export function ago(t) {
  const min = Math.round((Date.now() - new Date(t)) / 60000);
  if (min < 1) return "nyss";
  if (min < 60) return `${min} min sedan`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} tim sedan`;
  return `${Math.round(h / 24)} dagar sedan`;
}

let newsCache;
export function news() {
  newsCache ??= fetch("data/news.json", { cache: "no-cache" }).then((r) => r.json());
  return newsCache;
}

// Kort, stabilt id för en artikel (byggt på länken), så att den kan öppnas på artikel.html?id=…
export function articleId(link) {
  let h = 2166136261;
  for (let i = 0; i < link.length; i++) { h ^= link.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
// Nyheterna länkar direkt till källan i en ny flik. artikel.html finns kvar för gamla länkar.
const articleLink = (a) => `href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener"`;

// Större artikelkort för nyhetssidans rutnät. TCG Pocket (mobilspelet) märks som digitalt.
export const articleCard = (a) => `<article class="acard">
  <div class="acard-img">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span class="acard-src">${esc(a.source)}</span></div>
  <div class="acard-body">
    <span class="src">${fmt(a.date)}${a.digital ? ' <span class="tag-digital">Digitalt</span>' : ""}</span>
    <h3><a class="stretch" ${articleLink(a)}>${esc(a.title)}<span class="sr-only"> (öppnas hos ${esc(a.source)} i en ny flik)</span></a></h3>
    ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}
    <span class="acard-more">Läs hos ${esc(a.source)} <i aria-hidden="true">↗</i></span>
  </div>
</article>`;

export const newsItem = (a) => `<article class="news">
  <div class="news-img">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</div>
  <div class="news-body">
    <span class="src">${esc(a.source)} · ${fmt(a.date)}</span>
    <h3><a class="stretch" ${articleLink(a)}>${esc(a.title)}<span class="sr-only"> (öppnas hos ${esc(a.source)} i en ny flik)</span></a></h3>
    ${a.summary ? `<p>${esc(a.summary)}</p>` : ""}
  </div>
</article>`;

// Produktkort i butiksstil. flags: { drop: tidigare pris om priset sänkts nyligen, isNew: nytt nyligen }.
export function productCard(p, storeName, flags = {}) {
  const badge = !p.available && !p.preorder ? '<span class="pbadge out">Slut</span>'
    : p.preorder && !p.available ? '<span class="pbadge pre">Förbeställ</span>'
    : flags.drop ? '<span class="pbadge sale">Prissänkt</span>'
    : flags.isNew ? '<span class="pbadge new">Nytt</span>' : "";
  return `<article class="pcard${p.available || p.preorder ? "" : " is-out"}">
    <div class="pimg">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : `<span class="noimg"><b>${esc(p.type || "Förseglat")}</b>Bild finns hos butiken</span>`}${badge}${langMark(p.lang)}</div>
    <div class="pbody">
      <span class="pstore">${esc(storeName || p.store)}${{ rb: " · Riftbound", op: " · One Piece" }[p.game] || ""}${p.lang && p.lang !== "en" ? ` · ${esc(p.lang.toUpperCase())}` : ""}</span>
      <h3><a class="stretch" href="${esc(safeUrl(p.url))}" target="_blank" rel="noopener nofollow">${esc(p.title)}</a></h3>
      <div class="pfoot"><span class="pprice">${kr(p.price)}${flags.drop ? ` <s>${kr(flags.drop)}</s>` : ""}</span>${p.lastChange ? `<span class="ptime" title="Senast ändrad">${ago(p.lastChange)}</span>` : ""}</div>
    </div>
  </article>`;
}

mountChrome();

// Klockslag, med datum om det inte är i dag.
export function clockTime(t) {
  const d = new Date(t), today = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
  return today ? time : `${d.toLocaleDateString("sv-SE", { day: "numeric", month: "short" })} ${time}`;
}

// "Uppdaterad 2 min sedan · 16:08" med grön livepunkt. Räknar upp av sig själv.
const stamps = new Map();
export function liveStamp(el, t, label = "Uppdaterad") {
  if (!el || !t) return;
  stamps.set(el, { t, label });
  el.className = `stamp${Date.now() - t < 30 * 60e3 ? " is-live" : ""}`;
  el.innerHTML = `<i aria-hidden="true"></i>${label} ${ago(t)} · ${clockTime(t)}`;
}
setInterval(() => stamps.forEach((v, el) => liveStamp(el, v.t, v.label)), 30e3);

// Visar bara hela rader i ett rutnät, så att ingen rad blir halvtom. Räknar om när bredden ändras.
export function fillRows(el, maxRows = 2) {
  const apply = () => {
    const items = [...el.children].filter((c) => !c.classList.contains("msg"));
    const cols = getComputedStyle(el).gridTemplateColumns.split(" ").filter(Boolean).length || 1;
    const full = Math.floor(items.length / cols) * cols;
    const keep = full ? Math.min(full, cols * maxRows) : items.length;
    items.forEach((c, i) => (c.hidden = i >= keep));
  };
  apply();
  if (!el._rowObserver) { el._rowObserver = new ResizeObserver(apply); el._rowObserver.observe(el); }
}
