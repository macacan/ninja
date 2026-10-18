// Gratis kortvärdering: sök kort, välj skick, gör en egen pre-grading och se om gradering lönar sig.
// Utgångspriset är Cardmarkets trendpris (via TCGdex). Skick och betyg är tumregler, se "Så räknar vi" på sidan.
import { API, $, esc, kr, getJSON, skeleton, loading, cardImg } from "./site.js";
import { parseCardQuery, resolvePokemonName, loadDataset } from "./card-autocomplete.js";
import { recordCard, mountRecent } from "./recent.js";
import { mountCardAutocomplete } from "./card-autocomplete.js";
import { CONDITIONS, DEFAULT_COND, gradeMult } from "./valuation.js";
import { openScanner, narrowByTotal, rankByLook } from "./card-scanner.js";

// Fyra kriterier, fem svar vardera med delbetyg.
const CRITERIA = [
  ["Centrering", "Hur jämna ramarna är runt bilden", [["Nästan perfekt (55/45)", 10], ["Bra (60/40)", 9], ["Märkbart sned (65/35)", 8], ["Tydligt sned (70/30)", 6], ["Mycket sned", 4]]],
  ["Hörn", "Titta efter vitning och avrundning", [["Skarpa, ingen vitning", 10], ["Minimal vitning", 9], ["Lite vitning", 8], ["Tydlig vitning eller rundade", 6], ["Skadade eller vikta", 4]]],
  ["Kanter", "Vita prickar och hack längs kanten", [["Rena och raka", 10], ["Någon liten prick", 9], ["Några vita prickar", 8], ["Tydlig kantvitning", 6], ["Sprickor eller flagor", 4]]],
  ["Yta", "Repor och trycklinjer i vinklat ljus", [["Inga repor eller linjer", 10], ["Enstaka hårfin repa", 9], ["Några lätta repor", 8], ["Tydliga repor eller trycklinjer", 6], ["Intryck, veck eller skador", 4]]],
];

const state = { card: null, rate: null, cond: DEFAULT_COND, crit: CRITERIA.map(() => 1), cost: 400 };
let found = [], shown = 0, searchId = 0;
const PAGE = 12;

async function getRate() {
  if (state.rate) return state.rate;
  try { state.rate = (await getJSON("https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK")).rates.SEK; } catch {}
  return state.rate;
}

// ---------- Sök ----------
async function findCards(raw) {
  const parsed = parseCardQuery(raw);
  const data = await loadDataset().catch(() => null);
  const name = parsed.textPart ? (resolvePokemonName(parsed.textPart, data) || parsed.textPart) : "";
  const num = parsed.numPart;
  const clean = num ? num.toLowerCase().replace(/^0+/, "") : null;
  const sameNum = (c) => { const id = String(c.localId || "").toLowerCase(); return id === num.toLowerCase() || id.replace(/^0+/, "") === clean || id.endsWith(`/${num}`) || id.endsWith(`/${clean}`); };
  let list = [];
  if (name && num) {
    list = await getJSON(`${API}/cards?${new URLSearchParams({ name, localId: num })}`).catch(() => []);
    if (!list?.length) {
      const all = ((await getJSON(`${API}/cards?${new URLSearchParams({ name })}`).catch(() => [])) || []);
      const matches = all.filter(sameNum);
      list = matches.length ? matches : all;
    }
  } else if (num) {
    list = await getJSON(`${API}/cards?${new URLSearchParams({ localId: num })}`).catch(() => []);
  } else if (name) {
    list = await getJSON(`${API}/cards?${new URLSearchParams({ name })}`);
  }
  return { list: [...(list || [])].sort((a, b) => !!b.image - !!a.image), title: [name, num && `#${num}`].filter(Boolean).join(" ") };
}

function resultTile(c, i) {
  const img = c.image ? `${c.image}/low.webp` : "img/kortbaksida.webp";
  const isBack = !c.image;
  return `<button type="button" class="ctile plain" data-id="${esc(c.id)}" aria-label="Värdera ${esc(c.name)}">
    <span class="cimg${isBack ? " has-back" : ""}">
      <img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');">
      ${isBack ? `<span class="csoon">Kommer snart bilder</span>` : ""}
    </span>
    <span class="cname">${esc(c.name)}</span>
    <span class="cset">#${esc(c.localId || "")} · ${esc(c.id.split("-")[0].toUpperCase())}</span>
    <span class="crar">Värdera det här</span>
  </button>`;
}

function renderResults() {
  $("#vr-grid").innerHTML = found.slice(0, shown).map(resultTile).join("") || '<div class="msg">Hittade inga kort. Prova bara namnet, till exempel "Pikachu".</div>';
  $("#vr-more").hidden = shown >= found.length;
  $("#vr-count").textContent = found.length ? `${found.length} kort` : "";
}

// Från skannern: total är antalet kort i setet ("4/102" ger 102) och photo bilden av kortet.
async function search(raw, total = null, photo = null) {
  const q = raw.trim();
  if (!q) return;
  openModal();
  $("#vm-q").value = q;
  $("#vm-empty").hidden = true;
  history.replaceState(null, "", `?q=${encodeURIComponent(q)}`);
  $("#val-card").hidden = true;
  $("#val-results").hidden = false;
  $("#vr-grid").innerHTML = skeleton(6);
  const my = ++searchId;
  try {
    const { list: all, title } = await findCards(q);
    // Skannat kort: filtrera på setets storlek och sortera efter hur lika bilderna är fotot.
    const { list, sure } = photo ? await rankByLook(photo, await narrowByTotal(all, total)) : { list: all, sure: false };
    if (my !== searchId) return;
    // Är träffen tydlig eller finns bara ett enda matchande kort öppnas kortet direkt.
    if (sure || (list.length === 1 && !photo)) {
      $("#val-results").hidden = true;
      pick(list[0].id);
      $("#val-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    found = list; shown = PAGE;
    $("#vr-title").textContent = title ? `Välj ditt kort: ${title}` : "Välj ditt kort";
    renderResults();
  } catch {
    if (my === searchId) $("#vr-grid").innerHTML = '<div class="msg">Kunde inte nå TCGdex just nu. Försök igen om en stund.</div>';
  }
}

// ---------- Värdering ----------
const baseEur = (c) => { const cm = c.pricing?.cardmarket || {}; return cm.trend ?? cm.avg ?? cm["trend-holo"] ?? null; };
const baseSek = () => { const e = baseEur(state.card); return e != null && state.rate ? e * state.rate : null; };
function estGrade() {
  const s = CRITERIA.map(([, , opts], i) => opts[state.crit[i]][1]);
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  return Math.max(1, Math.min(10, Math.round((avg + Math.min(...s)) / 2)));
}
const round = (n) => Math.round(n / 10) * 10 || Math.round(n);

function outputHTML() {
  const base = baseSek();
  if (base == null) return '<div class="msg">Cardmarket har inget pris för det här kortet än, så vi kan inte värdera det.</div>';
  const [cname, , cmult] = CONDITIONS[state.cond];
  const raw = base * cmult, g = estGrade();
  const gv = base * gradeMult(g), cost = Math.max(0, +state.cost || 0), gain = gv - raw - cost;
  const verdict = gain > 200 ? ["good", "Lönar sig sannolikt", `Räkna med cirka ${kr(gain)} mer än att sälja ograderat, efter kostnaden.`]
    : gain > 0 ? ["mid", "Lönar sig knappt", `Vinsten blir bara cirka ${kr(gain)}. Ett lägre betyg än väntat gör det till en förlust.`]
    : ["bad", "Lönar sig inte", g >= 9 ? "Kortet är för billigt för att gradering ska löna sig." : "Med det betyget du bedömer blir det inte värt kostnaden."];
  const tier = (label, v, on) => `<li class="vt${on ? " on" : ""}"><span>${label}</span><b>${kr(round(v))}</b></li>`;
  return `<div class="vo-main"><span class="vo-label">Ungefärligt värde ${cname === "Near Mint" ? "i nyskick" : cname === "Mint" ? "i skick mint" : `i skick ${esc(cname.toLowerCase())}`}</span>
      <b class="vo-price">ca ${kr(round(raw))}</b>
      <small>Cardmarkets trendpris i nyskick: ${kr(round(base))}${state.card.pricing?.cardmarket?.low != null ? ` · lägsta annons ${kr(round(state.card.pricing.cardmarket.low * state.rate))}` : ""}</small></div>
    <ul class="vo-tiers" aria-label="Riktvärden per betyg">
      ${tier("Ograderat (ditt skick)", raw, false)}${tier("Betyg 8", base * gradeMult(8), g === 8)}${tier("Betyg 9", base * gradeMult(9), g === 9)}${tier("Betyg 10", base * gradeMult(10), g === 10)}
    </ul>
    <p class="hint">Riktvärden. Graderade priser skiljer mycket mellan kort, så jämför med sålda priser för just ditt kort innan du betalar för gradering.</p>
    <div class="vo-grade"><div class="vo-gnum" aria-label="Ditt estimerade betyg"><b>${g}</b><span>/ 10</span></div>
      <div><b>Ditt estimerade betyg</b><p class="muted">Vår egen uppskattning av dina svar, inte en officiell gradering. Det svagaste kriteriet väger tyngst, precis som hos graderingsbolagen.</p></div></div>
    <div class="verdict ${verdict[0]}"><b>${verdict[1]}</b><span>${verdict[2]}</span></div>`;
}

function renderCard() {
  const c = state.card, cm = c.pricing?.cardmarket || {};
  const img = c.image ? `${c.image}/high.webp` : "img/kortbaksida.webp";
  const isBack = !c.image;
  $("#val-card").innerHTML = `<div class="val-top">
      <div class="val-img${isBack ? " has-back" : ""}"><img src="${esc(img)}" alt="${esc(c.name)}" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');">${isBack ? `<span class="val-soon">Kommer snart bilder</span>` : ""}</div>
      <div class="val-info">
        <h2>${esc(c.name)}</h2>
        <p class="muted">${esc(c.set?.name || "")} · #${esc(c.localId || "")}${c.rarity && c.rarity !== "None" ? ` · ${esc(c.rarity)}` : ""}</p>
        <h3>2. Välj skick</h3>
        <div class="chips" role="radiogroup" aria-label="Kortets skick">${CONDITIONS.map(([n, d], i) => `<label class="chip"><input type="radio" name="cond" value="${i}"${i === state.cond ? " checked" : ""}><span><b>${n}</b><small>${d}</small></span></label>`).join("")}</div>
      </div>
    </div>
    <div class="val-bottom">
      <div class="val-grade">
        <h3>3. Pre-grading</h3>
        <p class="muted">Titta på kortet i bra ljus och svara ärligt. Din bedömning ger ett eget betyg från 1 till 10.</p>
        ${CRITERIA.map(([n, hint, opts], i) => `<label class="crit"><span><b>${n}</b><small>${hint}</small></span>
          <select data-crit="${i}">${opts.map(([t], k) => `<option value="${k}"${k === state.crit[i] ? " selected" : ""}>${t}</option>`).join("")}</select></label>`).join("")}
        <label class="crit"><span><b>Kostnad för gradering</b><small>Avgift och frakt per kort, i kronor</small></span>
          <input type="number" min="0" step="50" inputmode="numeric" data-cost value="${state.cost}"></label>
      </div>
      <div class="val-out" id="val-out">${outputHTML()}</div>
    </div>
    <p class="hint">Priser från Cardmarket via TCGdex${cm.updated ? `, uppdaterade ${esc(String(cm.updated).slice(0, 10))}` : ""}. Allt är vägledande uppskattningar. <a href="priser.html?q=${encodeURIComponent(c.name)}">Se alla priser för ${esc(c.name)}</a>.</p>`;
}

async function pick(id) {
  openModal();
  $("#vm-empty").hidden = true;
  history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
  const box = $("#val-card");
  box.hidden = false;
  box.innerHTML = loading("Ninjan värderar");
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  try {
    const [card] = await Promise.all([getJSON(`${API}/cards/${encodeURIComponent(id)}`), getRate()]);
    Object.assign(state, { card, cond: DEFAULT_COND, crit: CRITERIA.map(() => 1) });
    recordCard({ id: card.id, name: card.name, set: card.set?.name, localId: card.localId, total: card.set?.cardCount?.official, image: card.image, eur: baseEur(card) });
    renderCard();
  } catch {
    box.innerHTML = '<div class="msg">Kortet kunde inte laddas just nu. Försök igen om en stund.</div>';
  }
}

// ---------- Värderingsfönstret ----------
const modal = $("#val-modal"), vmInput = $("#vm-q");
function openModal() {
  if (!modal.open) modal.showModal();
  $("#vm-empty").hidden = !$("#val-results").hidden || !$("#val-card").hidden;
}
// Rensa: tömmer sökrutan, träffarna och det valda kortet, och börjar om.
function clearAll() {
  searchId++;
  vmInput.value = "";
  found = []; shown = 0;
  $("#vr-grid").innerHTML = ""; $("#vr-count").textContent = "";
  $("#val-results").hidden = true;
  $("#val-card").hidden = true; $("#val-card").innerHTML = "";
  state.card = null;
  $("#vm-empty").hidden = false;
  history.replaceState(null, "", location.pathname);
  vmInput.focus();
}
mountCardAutocomplete(vmInput, { onSelect: (val, cardId) => (cardId ? pick(cardId) : search(val)) });
$("#vm-form").addEventListener("submit", (e) => { e.preventDefault(); search(vmInput.value); });
$("#vm-clear").addEventListener("click", clearAll);
modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest(".cm-close")) modal.close(); });
modal.addEventListener("close", () => history.replaceState(null, "", location.pathname));

// ---------- Händelser ----------
// Sökningen sker i headerns sökfält, som på den här sidan söker kort att värdera.
const input = $("#header-search input");
$("#header-search").addEventListener("submit", (e) => {
  e.preventDefault();
  const cardId = $("#header-search input[name='cardId']")?.value;
  if (cardId) {
    $("#header-search input[name='cardId']").remove();
    $("#val-results").hidden = true;
    pick(cardId);
    $("#val-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  search(input.value);
  $("#val-results")?.scrollIntoView({ behavior: "smooth", block: "start" });
});
// "Värdera kort" i hero-delen öppnar sökfältet i headern (på mobilen är det dolt bakom en knapp).
$("#val-search-open")?.addEventListener("click", () => { openModal(); vmInput.focus(); });
const startScan = () => openScanner(({ name, number, total, canvas }) => {
  const q = [name, number].filter(Boolean).join(" ");
  input.value = q;
  search(q, total, canvas);
});
$("#scan-open")?.addEventListener("click", startScan);
$("#vm-scan")?.addEventListener("click", startScan);
$("#vr-grid").addEventListener("click", (e) => { const t = e.target.closest("[data-id]"); if (t) pick(t.dataset.id); });
$("#vr-more").addEventListener("click", () => { shown += PAGE; renderResults(); });
$("#val-card").addEventListener("change", (e) => {
  if (e.target.name === "cond") state.cond = +e.target.value;
  else if (e.target.dataset.crit != null) state.crit[+e.target.dataset.crit] = +e.target.value;
  else return;
  $("#val-out").innerHTML = outputHTML();
});
$("#val-card").addEventListener("input", (e) => {
  if (e.target.dataset.cost == null) return;
  state.cost = +e.target.value || 0;
  $("#val-out").innerHTML = outputHTML();
});

// Klick på ett kort i hero-bannern värderar det direkt.
document.addEventListener("click", (e) => {
  const pickBtn = e.target.closest("[data-val-pick]");
  if (pickBtn) pick(pickBtn.dataset.valPick);
});


mountRecent($("#recent"), { eyebrow: "Nyligen kollade", title: "Senast värderade kort", onPick: (id) => pick(id) });

const params = new URLSearchParams(location.search);
if (params.get("id")) pick(params.get("id"));
else if (params.get("q")) { input.value = params.get("q"); search(params.get("q")); }


// Hero-bannern visar tre slumpade dyra kort varje gång sidan laddas (utan priser, de värderas när man klickar).
const HERO_POOL = ["sv03.5-199", "swsh7-215", "sv04.5-234", "sv08-238", "sv08.5-161", "sv08.5-156", "sv10.5b-172", "sv10.5w-173", "swsh11-186", "swsh7-194", "swsh7-218"];
(async () => {
  const slots = [...document.querySelectorAll(".val-hero-stage .val-card-3d")];
  if (!slots.length) return;
  const ids = HERO_POOL.slice().sort(() => Math.random() - 0.5).slice(0, slots.length);
  const cards = await Promise.all(ids.map((id) => getJSON(`${API}/cards/${encodeURIComponent(id)}`).catch(() => null)));
  slots.forEach((el, i) => {
    const c = cards[i];
    if (!c?.image) return;
    el.dataset.valPick = c.id;
    el.title = `Klicka för att värdera ${c.name}`;
    el.setAttribute("aria-label", `Värdera ${c.name}`);
    const img = el.querySelector("img");
    img.alt = c.name;
    img.src = `${c.image}/high.webp`;
  });
})();
