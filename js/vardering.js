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

// ---------- Skadorna på kortbilden ----------
// Reglagen är steglösa (0 till 4) och ritar skadorna direkt på det stora kortet, i kortets mått 63 x 88.
// Varje prick och repa har en egen tröskel, så det blir gradvis fler ju längre man drar.
const CW = 63, CH = 88, BX = 3.6, BY = 2.6; // ramens bredd i procent av kortet
const CENTER_RATIO = [0.53, 0.6, 0.65, 0.7, 0.9];
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const clamp01 = (n) => Math.max(0, Math.min(1, n));
const lerpArr = (arr, x) => { const i = Math.min(arr.length - 2, Math.floor(x)); return arr[i] + (arr[i + 1] - arr[i]) * (x - i); };
const f2 = (n) => n.toFixed(2);
let dmg = null;

// Punkt på kortets kant: t går ett varv runt kortet, d är avståndet in från kanten.
function edgePoint(t, d) {
  const p = t * 2 * (CW + CH);
  if (p < CW) return [p, d];
  if (p < CW + CH) return [CW - d, p - CW];
  if (p < 2 * CW + CH) return [2 * CW + CH - p, CH - d];
  return [d, 2 * (CW + CH) - p];
}

function buildDamage(box, src) {
  const r = rng(4711), f = (a, b) => a + r() * (b - a);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${CW} ${CH}`);
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("class", "vd-svg");
  svg.setAttribute("aria-hidden", "true");
  const add = (parent, tag, attrs) => { const el = document.createElementNS(NS, tag); for (const k in attrs) el.setAttribute(k, attrs[k]); parent.appendChild(el); return el; };
  add(add(add(svg, "defs", {}), "filter", { id: "vd-soft", x: "-20%", y: "-20%", width: "140%", height: "140%" }), "feGaussianBlur", { stdDeviation: ".14" });
  const soft = add(svg, "g", { filter: "url(#vd-soft)" });

  // Hörn: vitningen följer hörnets rundning. Hörnen slits olika mycket, som på riktiga kort.
  const corners = [[0, 0, 1, 1], [CW, 0, -1, 1], [CW, CH, -1, -1], [0, CH, 1, -1]].map(([x, y, sx, sy]) => ({
    g: add(soft, "g", { transform: `translate(${x} ${y}) scale(${sx} ${sy})` }), w: f(0.6, 1.15),
  }));
  corners.forEach((c) => {
    c.path = add(c.g, "path", { fill: "none", stroke: "#fff", "stroke-linecap": "round" });
    c.dots = Array.from({ length: 7 }, () => ({ el: add(c.g, "circle", { fill: "#fff" }), t: f(1.2, 3.8), a: f(0.05, 1.5), d: f(0.2, 1.3), r: f(0.15, 0.32) }));
  });

  // Kanter: små vita prickar runt hela kortet, sedan längre vitnade partier och till sist flagor.
  const dots = Array.from({ length: 70 }, () => {
    const t = f(0, 1), [x, y] = edgePoint(t, f(0.1, 0.45));
    return { el: add(soft, "circle", { cx: f2(x), cy: f2(y), fill: "#fff" }), t: 0.4 + Math.pow(r(), 0.8) * 3.4, r: f(0.18, 0.42) };
  });
  const runs = Array.from({ length: 10 }, () => {
    const t = f(0, 1), len = f(0.015, 0.04), pts = [];
    for (let k = 0; k <= 6; k++) pts.push(edgePoint(t + (len * k) / 6, 0.3).map(f2).join(" "));
    return { el: add(soft, "path", { d: `M${pts.join("L")}`, fill: "none", stroke: "#fff", "stroke-width": ".6", "stroke-linecap": "round", pathLength: "1", "stroke-dasharray": "1" }), t: f(2.2, 3.7) };
  });
  const chips = Array.from({ length: 5 }, () => {
    const t = f(0, 1), [x1, y1] = edgePoint(t, 0), [x2, y2] = edgePoint(t + 0.004, f(0.9, 1.6)), [x3, y3] = edgePoint(t + 0.008, 0);
    return { el: add(svg, "polygon", { points: `${f2(x1)},${f2(y1)} ${f2(x2)},${f2(y2)} ${f2(x3)},${f2(y3)}`, fill: "#efe9dc" }), t: f(3.3, 3.95) };
  });

  // Yta: tunna repor åt olika håll, sedan trycklinjer, ett veck och ett intryck.
  const scratch = add(svg, "g", { class: "vd-scratch" });
  const scratches = Array.from({ length: 26 }, () => {
    const x = f(6, 50), y = f(6, 80), a = f(-Math.PI, Math.PI), len = f(4, 15);
    const x2 = Math.max(1, Math.min(62, x + Math.cos(a) * len)), y2 = Math.max(1, Math.min(87, y + Math.sin(a) * len));
    const d = `M${f2(x)} ${f2(y)}Q${f2((x + x2) / 2 + f(-1.2, 1.2))} ${f2((y + y2) / 2 + f(-1.2, 1.2))} ${f2(x2)} ${f2(y2)}`;
    return { el: add(scratch, "path", { d, fill: "none", stroke: "#fff", "stroke-opacity": f2(f(0.25, 0.6)), "stroke-width": f2(f(0.1, 0.22)), "stroke-linecap": "round", pathLength: "1", "stroke-dasharray": "1" }), t: 0.3 + Math.pow(r(), 0.9) * 3.3 };
  });
  const lines = [f(18, 40), f(48, 74)].map((y, k) => ({ el: add(scratch, "line", { x1: "1.5", y1: f2(y), x2: "61.5", y2: f2(y + f(-0.4, 0.4)), stroke: "#fff", "stroke-opacity": ".4", "stroke-width": ".22", pathLength: "1", "stroke-dasharray": "1" }), t: 2.5 + k * 0.4 }));
  const crease = [["#000", ".35", ".55", 0], ["#fff", ".7", ".25", -0.45]].map(([c, o, w, off]) => ({
    el: add(scratch, "path", { d: `M${-1 + off} ${24 + off}Q${30 + off} ${36 + off} ${64 + off} ${62 + off}`, fill: "none", stroke: c, "stroke-opacity": o, "stroke-width": w, pathLength: "1", "stroke-dasharray": "1" }), t: 3.4,
  }));
  // Intrycket är en mjuk skugga med en ljus kant mot ljuset, inte en ritad ring.
  const grad = add(svg.querySelector("defs"), "radialGradient", { id: "vd-dent", cx: ".42", cy: ".4", r: ".6" });
  add(grad, "stop", { offset: "0", "stop-color": "#000", "stop-opacity": ".22" });
  add(grad, "stop", { offset: ".7", "stop-color": "#000", "stop-opacity": ".06" });
  add(grad, "stop", { offset: "1", "stop-color": "#fff", "stop-opacity": ".35" });
  const dent = add(scratch, "ellipse", { cx: "40", cy: "30", rx: "2.4", ry: "1.9", fill: "url(#vd-dent)", filter: "url(#vd-soft)" });

  // Vikt hörn nere till höger: hörnet klipps bort och flärpen visar kortets blå baksida.
  const flap = add(svg, "polygon", { fill: "#2b59a8" });
  const flapLine = add(svg, "line", { stroke: "#000", "stroke-opacity": ".3", "stroke-width": ".3" });

  // Centrering: insidan av kortet flyttas i ramen. Under den ligger ramens egen färg.
  const card = box.querySelector(".vd-card");
  card.insertAdjacentHTML("beforeend", `<span class="vd-fill"></span><span class="vd-shift"><img src="${esc(src)}" alt="" referrerpolicy="no-referrer"></span>`);
  card.appendChild(svg);
  const fill = card.querySelector(".vd-fill"), shift = card.querySelector(".vd-shift");
  shift.style.clipPath = `inset(${BY}% ${BX}%)`;
  sampleBorder(src).then((c) => { fill.style.background = c; });

  dmg = { card, corners, dots, runs, chips, scratches, lines, crease, dent, flap, flapLine, fill, shift };
}

// Ramens färg läses från kortbilden. Går det inte blir den neutral gul, som på de flesta kort.
function sampleBorder(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const cv = document.createElement("canvas"); cv.width = 200; cv.height = 280;
        const g = cv.getContext("2d"); g.drawImage(img, 0, 0, 200, 280);
        const px = g.getImageData(4, 90, 3, 100).data; // mitt i vänsterramen
        let R = 0, G = 0, B = 0;
        for (let i = 0; i < px.length; i += 4) { R += px[i]; G += px[i + 1]; B += px[i + 2]; }
        const n = px.length / 4;
        resolve(`rgb(${Math.round(R / n)},${Math.round(G / n)},${Math.round(B / n)})`);
      } catch { resolve("#e8c547"); }
    };
    img.onerror = () => resolve("#e8c547");
    img.src = src;
  });
}

function drawDamage() {
  if (!dmg) return;
  const [cen, cor, edg, sur] = state.crit;
  const ramp = (L, t, w = 0.5) => clamp01((L - t) / w);

  // Centrering
  const dx = (lerpArr(CENTER_RATIO, cen) - 0.5) * 2 * BX, dy = dx * 0.45;
  dmg.shift.style.transform = `translate(${f2(dx)}%, ${f2(dy)}%)`;
  dmg.fill.style.opacity = cen > 0.05 ? 1 : 0;

  // Hörn: rundningen växer från ungefär 2,8 till 5,5 enheter.
  const R = 2.85 + Math.max(0, cor - 1.6) * 1.1;
  dmg.card.parentNode.style.borderRadius = `${f2((R / CW) * 100)}% / ${f2((R / CH) * 100)}%`;
  dmg.corners.forEach((c) => {
    const w = Math.min(1.5, cor * c.w * 0.38), len = cor * c.w * 1.1, q = Math.max(0.1, R - w / 2);
    c.path.setAttribute("d", `M${f2(w / 2)} ${f2(R + len)}V${f2(R)}A${f2(q)} ${f2(q)} 0 0 1 ${f2(R)} ${f2(w / 2)}H${f2(R + len)}`);
    c.path.setAttribute("stroke-width", f2(w));
    c.path.setAttribute("stroke-opacity", f2(clamp01(cor * 0.9)));
    c.dots.forEach((d) => {
      const k = ramp(cor, d.t);
      d.el.setAttribute("cx", f2(R - Math.cos(d.a) * (R - d.d) * 1.1));
      d.el.setAttribute("cy", f2(R - Math.sin(d.a) * (R - d.d) * 1.1));
      d.el.setAttribute("r", f2(d.r * k));
    });
  });
  const s = ramp(cor, 3.25, 0.75) * 8;
  dmg.card.style.clipPath = s > 0.05 ? `polygon(0 0,100% 0,100% ${f2(100 - (s / CH) * 100)}%,${f2(100 - (s / CW) * 100)}% 100%,0 100%)` : "";
  dmg.flap.setAttribute("points", s > 0.05 ? `${f2(CW - s)},${CH} ${CW},${f2(CH - s)} ${f2(CW - s)},${f2(CH - s)}` : "");
  dmg.flapLine.setAttribute("x1", f2(CW - s)); dmg.flapLine.setAttribute("y1", CH);
  dmg.flapLine.setAttribute("x2", CW); dmg.flapLine.setAttribute("y2", f2(CH - s));
  dmg.flapLine.style.opacity = s > 0.05 ? 1 : 0;

  // Kanter
  dmg.dots.forEach((d) => d.el.setAttribute("r", f2(d.r * ramp(edg, d.t, 0.35))));
  dmg.runs.forEach((d) => d.el.setAttribute("stroke-dashoffset", f2(1 - ramp(edg, d.t, 0.6))));
  dmg.chips.forEach((d) => { d.el.style.opacity = ramp(edg, d.t, 0.25); });

  // Yta
  dmg.scratches.forEach((d) => d.el.setAttribute("stroke-dashoffset", f2(1 - ramp(sur, d.t, 0.6))));
  dmg.lines.forEach((d) => d.el.setAttribute("stroke-dashoffset", f2(1 - ramp(sur, d.t, 0.5))));
  dmg.crease.forEach((d) => d.el.setAttribute("stroke-dashoffset", f2(1 - ramp(sur, d.t, 0.45))));
  dmg.dent.style.opacity = ramp(sur, 3.75, 0.25);
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
  const s = CRITERIA.map(([, , opts], i) => lerpArr(opts.map((o) => o[1]), state.crit[i]));
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
      <div class="val-img${isBack ? " has-back" : ""}"><span class="vd-card"><img src="${esc(img)}" alt="${esc(c.name)}" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.closest('.val-img').classList.add('has-back');"></span>${isBack ? `<span class="val-soon">Kommer snart bilder</span>` : ""}</div>
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
          <div class="crit-head"><label for="crit-${i}">${n}</label><output class="crit-val" for="crit-${i}">${esc(opts[Math.round(state.crit[i])][0])}</output></div>
          <small>${hint}</small>
          <input type="range" id="crit-${i}" class="crit-range" min="0" max="100" step="any" value="${state.crit[i] * 25}" data-crit="${i}" aria-valuetext="${esc(opts[Math.round(state.crit[i])][0])}">
        </div>`).join("")}
        <label class="crit"><span><b>Kostnad för gradering</b><small>Avgift och frakt per kort, i kronor</small></span>
          <input type="number" min="0" step="50" inputmode="numeric" data-cost value="${state.cost}"></label>
      </div>
      <div class="val-out" id="val-out">${outputHTML()}</div>
    </div>
    <p class="hint">Priser från Cardmarket via TCGdex${cm.updated ? `, uppdaterade ${esc(String(cm.updated).slice(0, 10))}` : ""}. Allt är vägledande uppskattningar. <a href="priser.html?q=${encodeURIComponent(c.name)}">Se alla priser för ${esc(c.name)}</a>.</p>`;
  buildDamage($("#val-card .val-img"), img);
  $("#val-card").querySelectorAll(".crit-range").forEach(paintRange);
  drawDamage();
}

// Den fyllda delen av reglaget följer tummen.
const paintRange = (input) => input.style.setProperty("--p", `${input.value}%`);

function setCrit(input) {
  const i = +input.dataset.crit, L = +input.value / 25, text = CRITERIA[i][2][Math.round(L)][0];
  state.crit[i] = L;
  paintRange(input);
  input.setAttribute("aria-valuetext", text);
  input.parentNode.querySelector(".crit-val").textContent = text;
  drawDamage();
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
