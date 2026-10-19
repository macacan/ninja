// Gratis kortvärdering: sök kort, välj skick, gör en egen pre-grading och se om gradering lönar sig.
// Utgångspriset är Cardmarkets trendpris (via TCGdex). Skick och betyg är tumregler, se "Så räknar vi" på sidan.
import { API, $, esc, kr, getJSON, skeleton, loading, cardImg } from "./site.js";
import { parseCardQuery, resolvePokemonName, loadDataset, filterByNumber, apiNumber } from "./card-autocomplete.js";
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

// ---------- Förhandsvisning per kriterium ----------
// Kortets egen bild med skadorna ritade ovanpå, i kortets mått (63 x 88). Allt ritas en gång och reglaget
// tänder de delar som hör till nivån, så prickar och repor växer fram ju längre man drar.
const KINDS = ["center", "corner", "edge", "surface"];
const CW = 63, CH = 88;
const CORNER_R = [3, 3, 3.6, 5.2, 5.2];
const CENTER_RATIO = [0.55, 0.6, 0.65, 0.7, 0.86];
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const on = (a, b = 4) => `data-a="${a}" data-b="${b}"`;

function overlay(kind) {
  const r = rng(kind.length * 7919 + 17), f = (a, b) => a + r() * (b - a);
  let s = "";
  if (kind === "corner") {
    // Vitning: en vit båge i övre vänstra hörnet som blir bredare och längre för varje nivå.
    [[0.45, 0.6, 0.75], [0.8, 1.8, 0.85], [1.3, 3.4, 0.95]].forEach(([w, len, o], k) => {
      const R = CORNER_R[k + 1], q = R - w / 2;
      s += `<path ${on(k + 1, k === 2 ? 4 : k + 1)} d="M${w / 2} ${R + len}V${R}A${q} ${q} 0 0 1 ${R} ${w / 2}H${R + len}" fill="none" stroke="#fff" stroke-opacity="${o}" stroke-width="${w}" stroke-linecap="round"/>`;
    });
    for (let k = 0; k < 9; k++) {
      const lv = 2 + (k > 4), a = f(0, Math.PI / 2), d = f(0.3, 1.4);
      s += `<circle ${on(lv)} cx="${(CORNER_R[lv] - Math.cos(a) * (CORNER_R[lv] - d)).toFixed(2)}" cy="${(CORNER_R[lv] - Math.sin(a) * (CORNER_R[lv] - d)).toFixed(2)}" r="${f(0.15, 0.32).toFixed(2)}" fill="#fff"/>`;
    }
    // Vikt hörn: flärpen viks in och visar den blå baksidan.
    s += `<g ${on(4)} class="cv-fold"><polygon points="0,0 8,0 0,8" fill="var(--card)"/><polygon points="8,0 0,8 8,8" fill="#2f5fb3"/><line x1="8" y1="0" x2="0" y2="8" stroke="#000" stroke-opacity=".35" stroke-width=".35"/></g>`;
  } else if (kind === "edge") {
    // Vita prickar längs vänsterkanten, fler för varje nivå.
    [2, 3, 5, 6].forEach((n, k) => {
      for (let j = 0; j < n; j++) s += `<circle ${on(k + 1)} cx="${f(0.25, 0.75).toFixed(2)}" cy="${f(28, 60).toFixed(2)}" r="${(f(0.22, 0.42) + k * 0.06).toFixed(2)}" fill="#fff"/>`;
    });
    for (let j = 0; j < 3; j++) { const y = f(29, 55); s += `<line ${on(3)} class="draw" pathLength="1" x1=".35" y1="${y.toFixed(1)}" x2=".35" y2="${(y + f(3, 7)).toFixed(1)}" stroke="#fff" stroke-width=".7" stroke-linecap="round"/>`; }
    for (let j = 0; j < 3; j++) { const y = f(30, 58); s += `<polygon ${on(4)} points="0,${(y - 1.3).toFixed(1)} ${f(1, 1.8).toFixed(1)},${y.toFixed(1)} 0,${(y + 1.5).toFixed(1)}" fill="#f4f1ea" stroke="#000" stroke-opacity=".25" stroke-width=".12"/>`; }
  } else if (kind === "surface") {
    // Repor syns som ljusa streck i vinklat ljus. De ritas fram när de tänds.
    [1, 2, 3, 3].forEach((n, k) => {
      for (let j = 0; j < n; j++) {
        const x = f(8, 52), y = f(10, 78), a = f(-0.9, 0.9), len = f(6, 16) + k * 2;
        const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
        s += `<path ${on(k + 1)} class="draw" pathLength="1" d="M${x.toFixed(1)} ${y.toFixed(1)}Q${((x + x2) / 2 + f(-1.5, 1.5)).toFixed(1)} ${((y + y2) / 2 + f(-1.5, 1.5)).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}" fill="none" stroke="#fff" stroke-opacity="${f(0.65, 0.95).toFixed(2)}" stroke-width="${(0.28 + k * 0.08).toFixed(2)}" stroke-linecap="round"/>`;
      }
    });
    for (let j = 0; j < 2; j++) { const y = f(22, 70).toFixed(1); s += `<line ${on(3)} class="draw" pathLength="1" x1="2" y1="${y}" x2="61" y2="${y}" stroke="#fff" stroke-opacity=".55" stroke-width=".3"/>`; }
    s += `<g ${on(4)}><path class="draw" pathLength="1" d="M4 22Q30 40 59 70" fill="none" stroke="#000" stroke-opacity=".4" stroke-width=".7"/><path class="draw" pathLength="1" d="M4.4 21.4Q30.4 39.4 59.4 69.4" fill="none" stroke="#fff" stroke-opacity=".8" stroke-width=".35"/>
      <circle cx="42" cy="28" r="2.4" fill="#000" fill-opacity=".12" stroke="#fff" stroke-opacity=".7" stroke-width=".3"/></g>`;
  }
  return s;
}

function critVisual(i, img) {
  const kind = KINDS[i];
  const pic = `<img src="${esc(img)}" alt="" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp'">`;
  const inner = kind === "center"
    ? `<span class="cv-win">${pic}</span>`
    : `<span class="cv-in">${pic}<svg viewBox="0 0 ${CW} ${CH}" preserveAspectRatio="none" aria-hidden="true">${overlay(kind)}</svg></span>`;
  return `<div class="cv cv-${kind}" data-cv="${i}" aria-hidden="true">${inner}${kind === "corner" || kind === "edge" ? '<span class="cv-zoom">Zoom</span>' : ""}</div>`;
}

function setLevel(cv, lv) {
  const kind = KINDS[+cv.dataset.cv];
  cv.querySelectorAll("[data-a]").forEach((el) => el.classList.toggle("on", +el.dataset.a <= lv && lv <= +el.dataset.b));
  if (kind === "center") {
    // Ramarna: bilden flyttas i ramen så att ena sidan blir smalare, som 60/40.
    const m = 7, d = (CENTER_RATIO[lv] - 0.5) * 2 * m, mh = m * CW / CH, dh = d * 0.5 * CW / CH;
    Object.assign(cv.querySelector(".cv-win").style, { left: `${m + d}%`, right: `${m - d}%`, top: `${mh + dh}%`, bottom: `${mh - dh}%` });
  } else {
    const R = kind === "corner" ? CORNER_R[lv] : CORNER_R[0];
    cv.querySelector(".cv-in").style.borderRadius = `${(R / CW) * 100}% / ${(R / CH) * 100}%`;
  }
}

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
  let list = [];
  if (name && num) {
    // Exakt nummer: 4, 04 och 004 är samma kort, och "004/123" väljer i första hand set med 123 kort.
    list = await filterByNumber(await getJSON(`${API}/cards?${new URLSearchParams({ name, localId: apiNumber(num) })}`).catch(() => []), num, parsed.setTotal);
    if (!list.length) list = (await getJSON(`${API}/cards?${new URLSearchParams({ name })}`).catch(() => [])) || [];
  } else if (num) {
    list = await filterByNumber(await getJSON(`${API}/cards?${new URLSearchParams({ localId: apiNumber(num) })}`).catch(() => []), num, parsed.setTotal);
  } else if (name) {
    list = await getJSON(`${API}/cards?${new URLSearchParams({ name })}`);
  }
  return { list: [...(list || [])].sort((a, b) => !!b.image - !!a.image), title: [name, num && `#${num}`].filter(Boolean).join(" ") };
}

function resultTile(c, i) {
  const img = c.image ? `${c.image}/low.webp` : "img/kortbaksida.webp";
  const isBack = !c.image;
  return `<div class="ctile plain" data-id="${esc(c.id)}" role="button" tabindex="0" aria-label="Välj ${esc(c.name)}">
    <span class="cimg${isBack ? " has-back" : ""}">
      <img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');">
      ${isBack ? `<span class="csoon">Kommer snart bilder</span>` : ""}
    </span>
    <span class="cname">${esc(c.name)}</span>
    <span class="cset">#${esc(c.localId || "")} · ${esc(c.id.split("-")[0].toUpperCase())}</span>
  </div>`;
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
  $("#val-results").hidden = false;
  $("#vr-grid").innerHTML = skeleton(6);
  const my = ++searchId;
  try {
    const { list: all, title } = await findCards(q);
    // Skannat kort: filtrera på setets storlek och sortera efter hur lika bilderna är fotot.
    const { list, sure } = photo ? await rankByLook(photo, await narrowByTotal(all, total)) : { list: all, sure: false };
    if (my !== searchId) return;
    // Är träffen tydlig eller finns bara ett enda matchande kort öppnas kortet direkt.
    found = list; shown = PAGE;
    $("#vr-title").textContent = title ? `Välj ditt kort: ${title}` : "Välj ditt kort";
    renderResults();
    if (sure || (list.length === 1 && !photo)) pick(list[0].id);
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
        ${CRITERIA.map(([n, hint, opts], i) => `<div class="crit-s">
          ${critVisual(i, img)}
          <div class="crit-body">
            <label for="crit-${i}"><b>${n}</b><small>${hint}</small></label>
            <input type="range" id="crit-${i}" class="crit-range" min="0" max="4" step="1" value="${state.crit[i]}" data-crit="${i}" aria-valuetext="${esc(opts[state.crit[i]][0])}">
            <span class="crit-ends"><span>Perfekt</span><span>Skadat</span></span>
            <output class="crit-val" for="crit-${i}" data-lv="${state.crit[i]}">${esc(opts[state.crit[i]][0])}</output>
          </div>
        </div>`).join("")}
        <label class="crit"><span><b>Kostnad för gradering</b><small>Avgift och frakt per kort, i kronor</small></span>
          <input type="number" min="0" step="50" inputmode="numeric" data-cost value="${state.cost}"></label>
      </div>
      <div class="val-out" id="val-out">${outputHTML()}</div>
    </div>
    <p class="hint">Priser från Cardmarket via TCGdex${cm.updated ? `, uppdaterade ${esc(String(cm.updated).slice(0, 10))}` : ""}. Allt är vägledande uppskattningar. <a href="priser.html?q=${encodeURIComponent(c.name)}">Se alla priser för ${esc(c.name)}</a>.</p>`;
  $("#val-card").querySelectorAll("[data-cv]").forEach((cv) => setLevel(cv, state.crit[+cv.dataset.cv]));
}

function setCrit(input) {
  const i = +input.dataset.crit, lv = +input.value, text = CRITERIA[i][2][lv][0];
  if (state.crit[i] === lv) return;
  state.crit[i] = lv;
  input.setAttribute("aria-valuetext", text);
  const out = input.parentNode.querySelector(".crit-val");
  out.textContent = text; out.dataset.lv = lv;
  setLevel($(`#val-card [data-cv="${i}"]`), lv);
  $("#val-out").innerHTML = outputHTML();
}

async function pick(id) {
  history.replaceState(null, "", `?id=${encodeURIComponent(id)}`);
  const box = $("#val-card");
  box.innerHTML = loading("Ninjan värderar");
  if (!cardModal.open) cardModal.showModal();
  box.scrollTop = 0; cardModal.scrollTop = 0;
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
const modal = $("#val-modal"), cardModal = $("#val-card-modal"), vmInput = $("#vm-q");
function openModal() {
  if (!modal.open) modal.showModal();
  $("#vm-empty").hidden = !$("#val-results").hidden;
}
// Rensa: tömmer sökrutan, träffarna och det valda kortet, och börjar om.
function clearAll() {
  searchId++;
  vmInput.value = "";
  found = []; shown = 0;
  $("#vr-grid").innerHTML = ""; $("#vr-count").textContent = "";
  $("#val-results").hidden = true;
  $("#val-card").innerHTML = "";
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
cardModal.addEventListener("click", (e) => { if (e.target === cardModal || e.target.closest(".cm-close")) cardModal.close(); });
// Stängs värderingen och sökträffarna finns kvar under, går adressen tillbaka till sökningen.
cardModal.addEventListener("close", () => history.replaceState(null, "", modal.open && vmInput.value.trim() ? `?q=${encodeURIComponent(vmInput.value.trim())}` : location.pathname));

// ---------- Händelser ----------
// Sökningen sker i headerns sökfält, som på den här sidan söker kort att värdera.
const input = $("#header-search input");
$("#header-search").addEventListener("submit", (e) => {
  e.preventDefault();
  const cardId = $("#header-search input[name='cardId']")?.value;
  if (cardId) {
    $("#header-search input[name='cardId']").remove();
    pick(cardId);
    return;
  }
  search(input.value);
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
// Tryck en gång på ett kort: knappen "Värdera detta kort" visas mitt på kortet. Knappen öppnar värderingen.
// Tryck utanför kortet döljer knappen igen.
let armed = null;
function disarm() {
  armed?.classList.remove("armed");
  armed?.querySelector(".ctile-go")?.remove();
  armed = null;
}
function arm(tile) {
  if (armed === tile) return;
  disarm();
  armed = tile;
  tile.classList.add("armed");
  tile.querySelector(".cimg").insertAdjacentHTML("beforeend", '<button type="button" class="ctile-go">Värdera detta kort</button>');
  tile.querySelector(".ctile-go").focus({ preventScroll: true });
}
$("#vr-grid").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-id]");
  if (!tile) return;
  if (e.target.closest(".ctile-go")) { const id = tile.dataset.id; disarm(); pick(id); return; }
  arm(tile);
});
$("#vr-grid").addEventListener("keydown", (e) => {
  const tile = e.target.closest("[data-id]");
  if (tile && e.target === tile && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); arm(tile); }
  if (e.key === "Escape" && armed) { e.stopPropagation(); e.preventDefault(); const t = armed; disarm(); t.focus(); }
});
document.addEventListener("click", (e) => { if (armed && !armed.contains(e.target)) disarm(); });
$("#vr-more").addEventListener("click", () => { disarm(); shown += PAGE; renderResults(); });
$("#val-card").addEventListener("change", (e) => {
  if (e.target.name !== "cond") return;
  state.cond = +e.target.value;
  $("#val-out").innerHTML = outputHTML();
});
$("#val-card").addEventListener("input", (e) => {
  if (e.target.dataset.crit != null) return setCrit(e.target);
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
