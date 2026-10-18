import { API, $, esc, kr, getJSON, skeleton, liveStamp, cardImg } from "./site.js";
import { mountChart } from "./pricechart.js";
import { recordCard, mountRecent } from "./recent.js";
import { mountCardAutocomplete, parseCardQuery, resolvePokemonName, loadDataset } from "./card-autocomplete.js";

// ---------- Valuta ----------
let rates = null;
async function getRates() {
  if (rates) return rates;
  try {
    const [eur, usd] = await Promise.all(["EUR", "USD"].map((c) => getJSON(`https://api.frankfurter.dev/v1/latest?from=${c}&to=SEK`)));
    rates = { EUR: eur.rates.SEK, USD: usd.rates.SEK };
  } catch { rates = { EUR: null, USD: null }; }
  return rates;
}
// Alla priser visas i kronor. Går kursen inte att hämta visas hellre inget pris än ett i fel valuta.
const sek = (v, cur = "EUR") => (v == null || !rates?.[cur] ? "–" : kr(v * rates[cur]));

// ---------- Holo-nivå ----------
// Vanliga kort får bara en ljusreflex, holo får regnbågsglans och specialkort en starkare effekt.
function finish(c) {
  const r = (c.rarity || "").toLowerCase();
  if (/special|illustration|secret|hyper|ultra|rainbow|gold|full art|shiny|ace spec|mega hyper|double rare|\bex\b|\bgx\b|vmax|vstar|radiant|crown/.test(r)) return "rainbow";
  if (/holo|rare/.test(r) && !/^rare$/.test(r) || c.variants?.holo && !c.variants?.normal) return "holo";
  return "plain";
}

// ---------- Kortrutor ----------
const change = (pct) => (pct == null ? "" : `<span class="chg ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toLocaleString("sv-SE")} %</span>`);
let current = [];   // korten som visas just nu, för att kunna bläddra i den stora vyn

function tile(c, i) {
  const img = c.image ? `${c.image}/low.webp` : "img/kortbaksida.webp";
  const isBack = !c.image;
  return `<button type="button" class="ctile ${finish(c)}" data-i="${i}" aria-label="Visa ${esc(c.name)} större">
    <span class="cimg${isBack ? " has-back" : ""}">
      <img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');">
      ${isBack ? `<span class="csoon">Kommer snart bilder</span>` : ""}
      <i class="glare"></i>
    </span>
    <span class="cname">${esc(c.name)}</span>
    <span class="cset">${esc(c.set || "")}${c.localId ? ` · #${esc(c.localId)}` : ""}</span>
    <span class="crow"><span class="cprice">${c.eur != null ? sek(c.eur) : "<small>Inget pris</small>"}</span>${change(c.change)}</span>
    ${c.rarity && c.rarity !== "None" ? `<span class="crar">${esc(c.rarity)}</span>` : ""}
  </button>`;
}

// Gör ett fullständigt TCGdex-kort till samma form som korten i trendfilen.
function slim(c) {
  const cm = c.pricing?.cardmarket || {};
  return {
    id: c.id, name: c.name, image: c.image, set: c.set?.name, localId: c.localId, rarity: c.rarity, variants: c.variants,
    eur: cm.trend ?? cm.avg ?? cm["trend-holo"] ?? null, avg7: cm.avg7 ?? null, avg30: cm.avg30 ?? null,
    change: cm.avg7 && cm.avg30 ? Math.round((cm.avg7 / cm.avg30 - 1) * 1000) / 10 : null, full: c,
  };
}

function renderGrid(el, list, offset = 0) {
  el.innerHTML = list.map((c, i) => tile(c, offset + i)).join("") || '<div class="msg">Hittade inga kort som matchar.</div>';
}

// ---------- Startvy: trender ----------
async function landing() {
  for (const id of ["#rising", "#top", "#falling"]) $(id).innerHTML = skeleton(6);
  try {
    const t = await (await fetch("data/card-trends.json", { cache: "no-cache" })).json();
    await getRates();
    current = [...t.rising, ...t.top, ...t.falling];
    let i = 0;
    for (const [id, list] of [["#rising", t.rising.slice(0, 12)], ["#top", t.top.slice(0, 12)], ["#falling", t.falling.slice(0, 6)]]) {
      $(id).innerHTML = list.map((c) => tile(c, current.indexOf(c, i))).join("");
    }
    $("#top-sets").textContent = `Från ${t.sets.join(", ")}.`;
  } catch {
    $("#landing").innerHTML = '<div class="msg">Trenderna har inte räknats fram än. Kör <code>node scripts/update-card-trends.mjs</code>.</div>';
  }
}

// ---------- Sök ----------
const RANGE = { "": [0, Infinity], "0-50": [0, 50], "50-250": [50, 250], "250-1000": [250, 1000], "1000-": [1000, Infinity] };
const PAGE = 24;
let found = [], loaded = [], searchId = 0;

async function loadDetails(from, to) {
  const ids = found.slice(from, to);
  const cards = await Promise.all(ids.map((c) => getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));
  return cards.filter(Boolean).map(slim);
}

function applyView() {
  const [lo, hi] = RANGE[$("#range").value];
  const sort = $("#sort").value;
  const kronor = (c) => (c.eur != null && rates?.EUR ? c.eur * rates.EUR : c.eur ?? -1);
  let list = loaded.filter((c) => { const v = kronor(c); return lo === 0 && hi === Infinity ? true : v >= lo && v < hi; });
  const cmp = {
    "price-desc": (a, b) => (b.eur ?? -1) - (a.eur ?? -1),
    "price-asc": (a, b) => (a.eur ?? Infinity) - (b.eur ?? Infinity),
    rising: (a, b) => (b.change ?? -999) - (a.change ?? -999),
    falling: (a, b) => (a.change ?? 999) - (b.change ?? 999),
    number: (a, b) => String(a.localId).localeCompare(String(b.localId), "sv", { numeric: true }),
  }[sort];
  list = list.sort(cmp);
  current = list;
  renderGrid($("#prices"), list);
  $("#res-count").textContent = `${list.length} av ${found.length} kort${loaded.length < found.length ? " (fler finns)" : ""}`;
  $("#more").hidden = loaded.length >= found.length;
}

async function search() {
  const rawQ = $("#pq").value.trim(), rarity = $("#rarity").value, set = $("#set").value;
  const parsed = parseCardQuery(rawQ);
  const data = await loadDataset().catch(() => null);
  const resolvedName = parsed.textPart ? (resolvePokemonName(parsed.textPart, data) || parsed.textPart) : "";

  const params = new URLSearchParams();
  if (rawQ) params.set("q", rawQ);
  if (rarity) params.set("rarity", rarity);
  if (set) params.set("set", set);
  for (const k of ["range", "sort"]) if ($(`#${k}`).value) params.set(k, $(`#${k}`).value);
  history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);

  const hasQuery = rawQ || rarity || set;
  $("#landing").hidden = !!hasQuery;
  $("#results").hidden = !hasQuery;
  if (!hasQuery) return;

  const my = ++searchId;
  if (parsed.numPart && resolvedName) {
    $("#res-title").textContent = `${resolvedName} #${parsed.numPart}`;
  } else if (parsed.numPart && !resolvedName) {
    $("#res-title").textContent = `Kortnummer #${parsed.numPart}`;
  } else if (resolvedName) {
    $("#res-title").textContent = `Kort som heter "${resolvedName}"`;
  } else if (set) {
    $("#res-title").textContent = $("#set").selectedOptions[0].textContent;
  } else {
    $("#res-title").textContent = rarity;
  }

  $("#prices").innerHTML = skeleton(8);
  try {
    let list = [];
    if (set) {
      // Ett helt set: hämta setets kortlista och filtrera på namn och/eller kortnummer
      const s = await getJSON(`${API}/sets/${encodeURIComponent(set)}`);
      const cleanNum = parsed.numPart ? parsed.numPart.toLowerCase().replace(/^0+/, "") : null;
      list = (s.cards || []).filter((c) => {
        const nameMatch = !resolvedName || c.name.toLowerCase().includes(resolvedName.toLowerCase());
        if (!nameMatch) return false;
        if (parsed.numPart) {
          const idStr = String(c.localId || "").toLowerCase();
          return idStr === parsed.numPart.toLowerCase() || idStr.replace(/^0+/, "") === cleanNum || idStr.endsWith("/" + parsed.numPart) || idStr.endsWith("/" + cleanNum);
        }
        return true;
      });
      if (rarity) {
        const all = await Promise.all(list.map((c) => getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));
        list = all.filter((c) => c && c.rarity === rarity);
      }
    } else {
      if (parsed.numPart && resolvedName) {
        // 1. Sök direkt i API med både namn och localId (t.ex. "Pikachu" och "37")
        const p = new URLSearchParams();
        p.set("name", resolvedName);
        p.set("localId", parsed.numPart);
        if (rarity) p.set("rarity", `eq:${rarity}`);
        list = await getJSON(`${API}/cards?${p}`).catch(() => []);

        // 2. Om API-svaret var tomt p.g.a. ledande nollor eller format som "037/197",
        // hämta korten för Pokémonen och matcha kortnumret lokalt
        if (!list || !list.length) {
          const p2 = new URLSearchParams();
          p2.set("name", resolvedName);
          if (rarity) p2.set("rarity", `eq:${rarity}`);
          const all = await getJSON(`${API}/cards?${p2}`).catch(() => []);
          const cleanNum = parsed.numPart.toLowerCase().replace(/^0+/, "");
          const matches = all.filter((c) => {
            const idStr = String(c.localId || "").toLowerCase();
            return idStr === parsed.numPart.toLowerCase() || idStr.replace(/^0+/, "") === cleanNum || idStr.endsWith("/" + parsed.numPart) || idStr.endsWith("/" + cleanNum);
          });
          // Om numret inte matchade något kortnummer (t.ex. användaren sökte på set "151" eller liknande),
          // visa alla kort för Pokémonen i stället för tom lista
          list = matches.length ? matches : all;
        }
      } else if (parsed.numPart && !resolvedName) {
        // Enbart kortnummer angivet (t.ex. "37" eller "037")
        const p = new URLSearchParams();
        p.set("localId", parsed.numPart);
        if (rarity) p.set("rarity", `eq:${rarity}`);
        list = await getJSON(`${API}/cards?${p}`).catch(() => []);
      } else {
        // Vanlig namnsökning
        const p = new URLSearchParams();
        if (resolvedName) p.set("name", resolvedName);
        if (rarity) p.set("rarity", `eq:${rarity}`);
        list = await getJSON(`${API}/cards?${p}`);
      }
    }
    if (my !== searchId) return;
    // Kort med bild först, så att listan inte fylls av bildlösa promokort.
    found = [...list].sort((a, b) => !!b.image - !!a.image);
    await getRates();
    loaded = await loadDetails(0, PAGE);
    if (my === searchId) applyView();
  } catch {
    $("#prices").innerHTML = '<div class="msg">Kunde inte nå TCGdex just nu. Försök igen om en stund.</div>';
  }
}

$("#more").addEventListener("click", async () => {
  $("#more").disabled = true;
  loaded = loaded.concat(await loadDetails(loaded.length, loaded.length + PAGE));
  $("#more").disabled = false;
  applyView();
});
$("#price-form").addEventListener("submit", (e) => { e.preventDefault(); search(); });
for (const id of ["#range", "#sort"]) $(id).addEventListener("change", () => (loaded.length ? applyView() : null));
for (const id of ["#set", "#rarity"]) $(id).addEventListener("change", search);

mountCardAutocomplete($("#pq"), {
  onSelect: (val) => {
    $("#pq").value = val;
    search();
  },
  onLiveChange: (val) => {
    if (!val && !$("#set").value && !$("#rarity").value) {
      $("#results").hidden = true;
      $("#landing").hidden = false;
      const params = new URLSearchParams(location.search);
      params.delete("q");
      history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);
      return;
    }
    search();
  },
});

// ---------- Stor vy med holo-effekt ----------
const modal = $("#card-modal");
let shownIndex = -1;

async function openCard(i) {
  const c = current[i];
  if (!c) return;
  shownIndex = i;
  const body = modal.querySelector(".cm-body");
  body.innerHTML = `<div class="cm-load">Hämtar kortet…</div>`;
  if (!modal.open) modal.showModal();
  const full = c.full || (await getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).catch(() => null)) || {};
  if (shownIndex !== i) return;
  await getRates();
  const cm = full.pricing?.cardmarket || {}, tp = full.pricing?.tcgplayer || {};
  recordCard({ id: c.id, name: c.name, set: full.set?.name, localId: full.localId || c.localId, total: full.set?.cardCount?.official, image: c.image || full.image, eur: cm.trend ?? cm.avg ?? null });
  const fin = finish({ ...c, variants: full.variants });
  const row = (label, v, cur) => (v == null ? "" : `<tr><th>${label}</th><td>${sek(v, cur)}</td></tr>`);
  const tpRows = Object.entries(tp).filter(([, v]) => v && typeof v === "object" && v.marketPrice != null)
    .map(([k, v]) => row({ normal: "Vanlig", holofoil: "Holo", reverseHolofoil: "Reverse holo", "1stEditionHolofoil": "1st edition holo" }[k] || k, v.marketPrice, "USD")).join("");
  const facts = [
    full.set?.name && `<li><b>Set</b>${esc(full.set.name)}${full.localId ? ` · #${esc(full.localId)}` : ""}</li>`,
    full.rarity && `<li><b>Sällsynthet</b>${esc(full.rarity)}</li>`,
    full.illustrator && `<li><b>Illustratör</b>${esc(full.illustrator)}</li>`,
    full.hp && `<li><b>HP</b>${esc(full.hp)}${full.types?.length ? ` · ${esc(full.types.join(", "))}` : ""}</li>`,
    full.variants && `<li><b>Varianter</b>${Object.entries({ normal: "Vanlig", reverse: "Reverse holo", holo: "Holo", firstEdition: "1st edition" }).filter(([k]) => full.variants[k]).map(([, v]) => v).join(", ") || "–"}</li>`,
  ].filter(Boolean).join("");
  body.innerHTML = `
    <div class="cm-card-wrap">
      <div class="cm-card ${fin}" style="--rx:0deg;--ry:0deg;--mx:50%;--my:50%">
        ${full.image ? `<img src="${esc(full.image)}/high.webp" alt="${esc(full.name || c.name)}" onload="this.parentNode.classList.add('loaded')" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');">` : `<img src="img/kortbaksida.webp" alt="Kortets baksida" onload="this.parentNode.classList.add('loaded')"><span class="csoon" style="position:absolute;inset:auto 12px 14px;padding:6px 12px;font-size:0.8rem">Kommer snart bilder</span>`}
        <i class="cm-holo"></i><i class="cm-glare"></i>
      </div>
      <span class="cm-finish">${fin === "rainbow" ? "Specialkort · regnbågsglans" : fin === "holo" ? "Holo" : "Vanlig yta"}</span>
      <ul class="cm-facts">${facts}</ul>
    </div>
    <div class="cm-info">
      <h2 id="cm-name">${esc(full.name || c.name)}</h2>
      <div class="cm-price">${c.eur != null ? sek(c.eur) : "Inget pris ännu"} ${change(c.change)}</div>
      <p class="muted">Cardmarkets trendpris i kronor. Vägledande, uppdateras dagligen.</p>
      <div class="pchart"></div>
      ${cm.trend != null || cm.avg != null ? `<h3>Cardmarket (Europa)</h3><table class="cm-table">${row("Trend", cm.trend, "EUR")}${row("Snitt", cm.avg, "EUR")}${row("Lägsta", cm.low, "EUR")}${row("Snitt 1 dag", cm.avg1, "EUR")}${row("Snitt 7 dagar", cm.avg7, "EUR")}${row("Snitt 30 dagar", cm.avg30, "EUR")}${row("Trend holo", cm["trend-holo"] || null, "EUR")}</table>` : ""}
      ${tpRows ? `<h3>TCGplayer (USA)</h3><table class="cm-table">${tpRows}</table>` : ""}
      <div class="cm-links">
        <a class="btn primary small" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(full.name || c.name)}" target="_blank" rel="noopener">Cardmarket ↗</a>
        <a class="btn small" href="https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(full.name || c.name)}" target="_blank" rel="noopener">TCGplayer ↗</a>
      </div>
    </div>`;
  if (full.id) mountChart(body.querySelector(".pchart"), full, rates?.EUR).catch(() => {});
  modal.querySelector(".prev").hidden = i <= 0;
  modal.querySelector(".next").hidden = i >= current.length - 1;
}

// Kortet lutar efter pekaren och glansen följer med, ENBART när pekaren är på själva kortet.
function resetCard(card) {
  if (!card) return;
  card.classList.remove("active");
  card.style.setProperty("--rx", "0deg");
  card.style.setProperty("--ry", "0deg");
  card.style.setProperty("--mx", "50%");
  card.style.setProperty("--my", "50%");
}

modal.addEventListener("pointermove", (e) => {
  const card = modal.querySelector(".cm-card");
  if (!card) return;
  // Animera och tilta enbart när muspekaren befinner sig direkt över kortets bild
  const isOverCard = !!e.target.closest(".cm-card");
  if (!isOverCard) {
    if (card.classList.contains("active")) resetCard(card);
    return;
  }
  const r = card.getBoundingClientRect();
  const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  card.style.setProperty("--ry", `${(x - 0.5) * 24}deg`);
  card.style.setProperty("--rx", `${(0.5 - y) * 24}deg`);
  card.style.setProperty("--mx", `${x * 100}%`);
  card.style.setProperty("--my", `${y * 100}%`);
  card.classList.add("active");
});
modal.addEventListener("pointerleave", () => {
  resetCard(modal.querySelector(".cm-card"));
});
modal.addEventListener("click", (e) => {
  if (e.target === modal || e.target.closest(".cm-close")) modal.close();
  if (e.target.closest(".prev")) openCard(shownIndex - 1);
  if (e.target.closest(".next")) openCard(shownIndex + 1);
});
modal.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" && shownIndex > 0) openCard(shownIndex - 1);
  if (e.key === "ArrowRight" && shownIndex < current.length - 1) openCard(shownIndex + 1);
});
document.addEventListener("click", (e) => {
  const t = e.target.closest(".ctile");
  if (t) openCard(+t.dataset.i);
});

// ---------- Start ----------
async function fillFilters() {
  try {
    const [rarities, sets] = await Promise.all([getJSON(`${API}/rarities`),
      getJSON(`${API}/sets?sort:field=releaseDate&sort:order=DESC&pagination:page=1&pagination:itemsPerPage=60`)]);
    $("#rarity").insertAdjacentHTML("beforeend", rarities.filter((r) => r !== "None").map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join(""));
    $("#set").insertAdjacentHTML("beforeend", sets.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join(""));
  } catch {}
}

mountRecent($("#recent"), { eyebrow: "Nyligen sökta", title: "Senast sökta kort", hint: "Korten du senast öppnat. Sparas bara i den här webbläsaren." });
await fillFilters();
const p = new URLSearchParams(location.search);
for (const [k, id] of [["q", "#pq"], ["rarity", "#rarity"], ["set", "#set"], ["range", "#range"], ["sort", "#sort"]]) if (p.get(k)) $(id).value = p.get(k);
if (p.get("q") || p.get("rarity") || p.get("set")) search(); else landing();
