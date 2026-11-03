import { API, $, esc, kr, getJSON, getList, skeleton, liveStamp, cardImg, setPages, setLink } from "./site.js";
import { mountChart } from "./pricechart.js";
import { recordCard, mountRecent } from "./recent.js";
import { mountCardAutocomplete, parseCardQuery, resolvePokemonName, loadDataset, sameNumber, filterByNumber, apiNumber } from "./card-autocomplete.js";
import { langMark } from "./langmark.js";
import { apiFor, findJapanese } from "./japanese.js";
import { track } from "./tracker.js";
import { gameSuggestions } from "./game-guess.js";

// ---------- Spel ----------
// Pokémon söks direkt mot TCGdex. One Piece och Riftbound söks i färdigbyggda filer i data/<spel>/
// (scripts/update-op-cards.mjs, scripts/update-rb-cards.mjs) med TCGplayers priser, redan omräknade till kronor.
// Sökningen gäller bara det valda spelet. Valet står i adressen (?game=op) och sparas i webbläsaren.
const enc = encodeURIComponent;
const GAMES = {
  op: {
    h1: "Kortpriser för One Piece-kort", back: "img/kortbaksida-op.webp", placeholder: "Sök kort, t.ex. Luffy eller OP01-120",
    rarities: { L: "Leader", C: "Common", UC: "Uncommon", R: "Rare", SR: "Super Rare", SEC: "Secret Rare", TR: "Treasure Rare", P: "Promo", PR: "Promo (PR)" },
    // Parallel, manga, SP och alternativ bild glänser mest, Leader och Super Rare får vanlig holo.
    finish: (c) => (c.variant || ["SEC", "TR"].includes(c.rarity) ? "rainbow" : ["L", "SR"].includes(c.rarity) ? "holo" : "plain"),
    facts: (c) => [["Färg", c.color], ["Typ", c.type], c.type === "Leader" ? ["Liv", c.life] : ["Kostnad", c.cost], ["Power", c.power], ["Counter", c.counter || null], ["Attribut", c.attr], ["Typer", c.sub]],
    setLabel: (s) => `${s.id} · ${s.name}`,
    cardmarket: (c) => `https://www.cardmarket.com/en/OnePiece/Products/Search?searchString=${enc(c.no || c.name)}`,
    tcgplayer: (c) => `https://www.tcgplayer.com/search/one-piece-card-game/product?q=${enc(`${c.name} ${c.no || ""}`.trim())}`,
  },
  rb: {
    h1: "Kortpriser för Riftbound-kort", back: "img/kortbaksida-rb.png", placeholder: "Sök kort, t.ex. Jinx eller Ahri", details: true,
    rarities: {},
    // Signature, Ultimate och alternativ bild glänser mest, Rare får vanlig holo.
    finish: (c) => (c.variant || ["Showcase", "Epic"].includes(c.rarity) ? "rainbow" : c.rarity === "Rare" ? "holo" : "plain"),
    facts: (c) => [["Typ", c.type], ["Domän", c.domain?.replace(/;/g, ", ")], ["Energi", c.energy], ["Power", c.power || null], ["Might", c.might || null], ["Taggar", c.tags]],
    setLabel: (s) => s.name,
    cardmarket: (c) => `https://www.cardmarket.com/en/Riftbound/Products/Search?searchString=${enc(c.name)}`,
    tcgplayer: (c) => `https://www.tcgplayer.com/search/riftbound-league-of-legends-trading-card-game/product?q=${enc(c.name)}`,
  },
};
const GAME_KEY = "nl:price-game";
const known = (g) => (GAMES[g] ? g : "pokemon");
let game = (() => {
  const g = new URLSearchParams(location.search).get("game");
  if (g) return known(g);
  try { return known(localStorage.getItem(GAME_KEY)); } catch { return "pokemon"; }
})();
// Det valda spelets inställningar, eller null för Pokémon.
const prebuilt = () => GAMES[game] || null;
const isJa = () => !prebuilt() && $("#lang").value === "ja";

const gameData = {};
const gameCards = (g) => (gameData[g] ??= fetch(`data/${g}/cards.json`, { cache: "no-cache" }).then((r) => r.json()).then((d) => {
  const names = Object.fromEntries(d.sets.map((s) => [s.id, s.name]));
  d.cards = d.cards.map((c) => preSlim({ ...c, set: names[c.set] || c.set, setId: c.set }, g));
  return d;
}).catch((e) => { delete gameData[g]; throw e; }));
// Illustratör (data/rb/details.json, från Riots kortgalleri). Hämtas först när man öppnar ett kort.
const gameDetails = {};
const detailsOf = (g) => (gameDetails[g] ??= fetch(`data/${g}/details.json`, { cache: "no-cache" }).then((r) => r.json())
  .catch(() => { delete gameDetails[g]; return {}; }));
// Samma form som Pokémonkorten i rutnätet: localId är kortnumret och priset ligger i kronor (sek).
const preSlim = (c, g) => ({ ...c, game: g, localId: c.no });
// Spelets egen kortbaksida när kortet saknar bild (eller bilden inte går att ladda).
const backOf = (c) => GAMES[c.game]?.back || "img/kortbaksida.webp";
const rarityName = (c) => GAMES[c.game]?.rarities[c.rarity] || c.rarity;

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
// Kortets pris för sortering och visning: de färdigbyggda spelen har redan kronor, Pokémonkorten euro.
const value = (c) => (GAMES[c.game] ? c.sek : c.eur);
const priceText = (c) => (GAMES[c.game] ? kr(c.sek) : sek(c.eur));

// ---------- Holo-nivå ----------
// Vanliga kort får bara en ljusreflex, holo får regnbågsglans och specialkort en starkare effekt.
function finish(c) {
  if (GAMES[c.game]) return GAMES[c.game].finish(c);
  const r = (c.rarity || "").toLowerCase();
  if (/special|illustration|secret|hyper|ultra|rainbow|gold|full art|shiny|ace spec|mega hyper|double rare|\bex\b|\bgx\b|vmax|vstar|radiant|crown/.test(r)) return "rainbow";
  if (/holo|rare/.test(r) && !/^rare$/.test(r) || c.variants?.holo && !c.variants?.normal) return "holo";
  return "plain";
}

// ---------- Kortrutor ----------
const change = (pct) => (pct == null ? "" : `<span class="chg ${pct >= 0 ? "up" : "down"}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toLocaleString("sv-SE")} %</span>`);
let current = [];   // korten som visas just nu, för att kunna bläddra i den stora vyn

function tile(c, i) {
  const src = cardImg(c, "low");
  const img = src || backOf(c);
  const isBack = !src;
  return `<button type="button" class="ctile ${finish(c)}" data-i="${i}" aria-label="Visa ${esc(c.name)} större">
    <span class="cimg${isBack ? " has-back" : ""}">
      <img src="${esc(img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.src='${backOf(c)}';this.parentNode.classList.add('has-back');">
      ${isBack ? `<span class="csoon">Bilder kommer snart</span>` : ""}
      <i class="glare"></i>${langMark(c.lang)}
      ${c.qty > 1 ? `<span class="cqty">×${c.qty}</span>` : ""}
    </span>
    <span class="cname">${c.en ? `${esc(c.en)} <small class="cname-ja">${esc(c.name)}</small>` : esc(c.name)}</span>
    <span class="cset">${esc(c.set || "")}${c.localId ? ` · #${esc(c.localId)}` : ""}</span>
    <span class="crow"><span class="cprice">${value(c) != null ? priceText(c) : "<small>Inget pris</small>"}</span>${change(c.change)}</span>
    ${GAMES[c.game] ? `<span class="crar">${esc([rarityName(c), c.variant].filter(Boolean).join(" · "))}</span>`
      : c.rarity && c.rarity !== "None" ? `<span class="crar">${esc(c.rarity)}</span>` : ""}
  </button>`;
}

// Gör ett fullständigt TCGdex-kort till samma form som korten i trendfilen.
// meta: { lang, en } för japanska kort (språk och Pokémonens engelska namn).
function slim(c, meta = {}) {
  const cm = c.pricing?.cardmarket || {};
  return {
    lang: meta.lang || "en", en: meta.en || null,
    id: c.id, name: c.name, image: c.image, set: c.set?.name, localId: c.localId, rarity: c.rarity, variants: c.variants,
    eur: cm.trend ?? cm.avg ?? cm["trend-holo"] ?? null, avg7: cm.avg7 ?? null, avg30: cm.avg30 ?? null,
    change: cm.avg7 && cm.avg30 ? Math.round((cm.avg7 / cm.avg30 - 1) * 1000) / 10 : null, full: c,
  };
}

function renderGrid(el, list, offset = 0) {
  el.innerHTML = list.map((c, i) => tile(c, offset + i)).join("") || '<div class="msg">Hittade inga kort som matchar.</div>';
}

// ---------- Startvy: trender ----------
let landingId = 0;
async function landing() {
  const my = ++landingId, g = prebuilt() && game;
  for (const id of ["#rising", "#top", "#falling"]) $(id).innerHTML = skeleton(6);
  try {
    const t = await (await fetch(g ? `data/${g}/card-trends.json` : "data/card-trends.json", { cache: "no-cache" })).json();
    await getRates();
    if (my !== landingId) return;
    if (g) for (const k of ["rising", "top", "falling"]) t[k] = t[k].map((c) => preSlim(c, g));
    current = [...t.rising, ...t.top, ...t.falling];
    let i = 0;
    for (const [id, list] of [["#rising", t.rising.slice(0, 12)], ["#top", t.top.slice(0, 12)], ["#falling", t.falling.slice(0, 6)]]) {
      $(id).innerHTML = list.map((c) => tile(c, current.indexOf(c, i))).join("");
    }
    // One Piece- och Riftbound-trenderna bygger på vår egen historik, som behöver en vecka innan den säger något.
    // Tills dess göms de, så att "Dyraste i de senaste seten" hamnar överst.
    $("#rising-block").hidden = !t.rising.length;
    $("#falling-block").hidden = !t.falling.length;
    $("#top-sets").textContent = `Från de ${t.sets.length} senaste seten: ${t.sets.join(", ")}.${t.rising.length ? "" : " Trenderna visas när vi har sparat priserna i en vecka."}`;
  } catch {
    if (my !== landingId) return;
    for (const id of ["#rising", "#top", "#falling"]) $(id).innerHTML = "";
    $("#rising-block").hidden = false;
    $("#rising").innerHTML = `<div class="msg">Trenderna har inte räknats fram än. Kör <code>node scripts/${g ? `update-${g}-cards` : "update-card-trends"}.mjs</code>.</div>`;
  }
}

// ---------- Sök ----------
const PAGE = 24;
let found = [], loaded = [], next = 0, searchId = 0;

// Hämtar nästa sida av found. next räknas för sig, eftersom kort som inte går att hämta faller bort ur loaded.
async function loadDetails() {
  const ids = found.slice(next, next + PAGE);
  next += ids.length;
  const cards = await Promise.all(ids.map((c) => getJSON(`${apiFor(c.lang)}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));
  return cards.map((card, i) => card && slim(card, ids[i])).filter(Boolean);
}

function applyView() {
  const sort = $("#sort").value;
  let list = [...loaded];
  const cmp = {
    "price-desc": (a, b) => (value(b) ?? -1) - (value(a) ?? -1),
    "price-asc": (a, b) => (value(a) ?? Infinity) - (value(b) ?? Infinity),
    rising: (a, b) => (b.change ?? -999) - (a.change ?? -999),
    falling: (a, b) => (a.change ?? 999) - (b.change ?? 999),
    number: (a, b) => String(a.localId).localeCompare(String(b.localId), "sv", { numeric: true }),
  }[sort];
  // Korten i de färdigbyggda spelen finns redan alla i minnet, så där sorteras hela träfflistan och de första visas.
  list = prebuilt() || vaultOpen ? [...found].sort(cmp).slice(0, next) : list.sort(cmp);
  current = list;
  renderGrid($("#prices"), list);
  $("#more").hidden = next >= found.length;
}

async function search() {
  closeVault();
  const ja = isJa(), pre = !!prebuilt();
  // Set och sällsynthet finns bara för de engelska korten.
  $("#set").disabled = $("#rarity").disabled = ja;
  $("#lang-beta").hidden = $("#ja-note").hidden = !ja;
  const rawQ = $("#pq").value.trim(), rarity = ja ? "" : $("#rarity").value, set = ja ? "" : $("#set").value;
  const parsed = parseCardQuery(rawQ);
  const data = pre ? null : await loadDataset().catch(() => null);
  const resolvedName = !pre && parsed.textPart ? (resolvePokemonName(parsed.textPart, data) || parsed.textPart) : "";

  const params = new URLSearchParams();
  if (pre) params.set("game", game);
  if (rawQ) params.set("q", rawQ);
  if (ja) params.set("lang", "ja");
  if (rarity) params.set("rarity", rarity);
  if (set) params.set("set", set);
  if ($("#sort").value) params.set("sort", $("#sort").value);
  history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);
  if (rawQ) track("search", rawQ.toLowerCase());

  const hasQuery = rawQ || rarity || set;
  $("#landing").hidden = !!hasQuery;
  $("#results").hidden = !hasQuery;
  if (!hasQuery) return;

  const my = ++searchId;
  if (pre) return searchPrebuilt(my, rawQ, rarity, set);
  if (ja) return searchJa(my, parsed, resolvedName);
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
      list = (s.cards || []).filter((c) => {
        const nameMatch = !resolvedName || c.name.toLowerCase().includes(resolvedName.toLowerCase());
        if (!nameMatch) return false;
        return !parsed.numPart || sameNumber(c.localId, parsed.numPart);
      });
      if (rarity) {
        const all = await Promise.all(list.map((c) => getJSON(`${API}/cards/${encodeURIComponent(c.id)}`).catch(() => null)));
        list = all.filter((c) => c && c.rarity === rarity);
      }
    } else {
      if (parsed.numPart && resolvedName) {
        // TCGdex matchar delar av numret (4 ger även 14 och 40), så vi filtrerar fram exakt nummer själva.
        // 4, 04 och 004 räknas som samma nummer, och "004/123" väljer i första hand set med 123 kort.
        const p = new URLSearchParams({ name: resolvedName, localId: apiNumber(parsed.numPart) });
        if (rarity) p.set("rarity", `eq:${rarity}`);
        list = await filterByNumber(await getList(`${API}/cards?${p}`), parsed.numPart, parsed.setTotal);
        if (!list.length) {
          // Numret matchade inget kort med namnet (t.ex. "pikachu 151" där 151 är setet): visa alla kort för namnet.
          const p2 = new URLSearchParams({ name: resolvedName });
          if (rarity) p2.set("rarity", `eq:${rarity}`);
          list = await getList(`${API}/cards?${p2}`);
          if (my === searchId) $("#res-title").textContent = `Inget ${resolvedName} #${parsed.numPart}, visar alla kort som heter "${resolvedName}"`;
        }
      } else if (parsed.numPart && !resolvedName) {
        // Enbart kortnummer (t.ex. "4", "004" eller "004/102")
        const p = new URLSearchParams({ localId: apiNumber(parsed.numPart) });
        if (rarity) p.set("rarity", `eq:${rarity}`);
        list = await filterByNumber(await getList(`${API}/cards?${p}`), parsed.numPart, parsed.setTotal);
      } else {
        // Vanlig namnsökning
        const p = new URLSearchParams();
        if (resolvedName) p.set("name", resolvedName);
        if (rarity) p.set("rarity", `eq:${rarity}`);
        list = await getList(`${API}/cards?${p}`);
      }
    }
    if (my !== searchId) return;
    // Kort med bild först, så att listan inte fylls av bildlösa promokort.
    found = [...list].sort((a, b) => !!b.image - !!a.image);
    next = 0;
    await getRates();
    loaded = await loadDetails();
    if (my === searchId) applyView();
  } catch {
    $("#prices").innerHTML = '<div class="msg">Kunde inte nå TCGdex just nu. Försök igen om en stund.</div>';
  }
}

// Japanska kort (beta): Pokémonens engelska namn → Pokédex-nummer → japanska kort med samma Pokémon.
async function searchJa(my, parsed, name) {
  $("#res-title").textContent = name ? `Japanska kort: ${name}${parsed.numPart ? ` #${parsed.numPart}` : ""}` : "Japanska kort";
  $("#prices").innerHTML = skeleton(8);
  try {
    const list = name || parsed.numPart ? await findJapanese(name, parsed.numPart, parsed.setTotal) : null;
    if (my !== searchId) return;
    if (!list) {
      found = loaded = []; next = 0;
      $("#more").hidden = true;
      $("#prices").innerHTML = '<div class="msg">Japanska kort går just nu bara att söka fram med en Pokémons engelska namn, t.ex. Pikachu eller Charizard.</div>';
      return;
    }
    found = list.sort((a, b) => !!b.image - !!a.image);
    next = 0;
    await getRates();
    loaded = await loadDetails();
    if (my === searchId) applyView();
  } catch {
    $("#prices").innerHTML = '<div class="msg">Kunde inte nå TCGdex just nu. Försök igen om en stund.</div>';
  }
}

// One Piece och Riftbound: sök bara i det valda spelets färdigbyggda fil. Alla ord ska finnas i namn, variant,
// set eller kortnummer, och kortnumret får skrivas utan bindestreck ("op01120" eller "op01 120").
let openAfter = new URLSearchParams(location.search).get("card");
async function searchPrebuilt(my, q, rarity, set) {
  $("#res-title").textContent = q ? `Kort som matchar "${q}"` : set ? $("#set").selectedOptions[0].textContent : $("#rarity").selectedOptions[0].textContent;
  $("#prices").innerHTML = skeleton(8);
  try {
    const d = await gameCards(game);
    if (my !== searchId) return;
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const compact = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const cq = compact(q);
    found = d.cards.filter((c) => {
      if (set && c.setId !== set) return false;
      if (rarity && c.rarity !== rarity) return false;
      if (!q) return true;
      const hay = `${c.name} ${c.variant || ""} ${c.set} ${c.no}`.toLowerCase();
      return words.every((w) => hay.includes(w)) || (cq.length >= 4 && compact(c.no).startsWith(cq));
    });
    next = PAGE;
    loaded = [];
    applyView();
    // Länk från en setsida (priser.html?game=rb&set=…&card=<id>): kortet öppnas direkt, även om det ligger längre ner i listan.
    if (openAfter) {
      const id = openAfter;
      openAfter = null;
      if (found.some((c) => c.id === id) && !current.some((c) => c.id === id)) { next = found.length; applyView(); }
      const i = current.findIndex((c) => c.id === id);
      if (i >= 0) openCard(i);
    }
  } catch {
    $("#prices").innerHTML = '<div class="msg">Kunde inte läsa korten just nu. Försök igen om en stund.</div>';
  }
}

$("#more").addEventListener("click", async () => {
  if (prebuilt()) { next += PAGE; applyView(); return; }
  $("#more").disabled = true;
  loaded = loaded.concat(await loadDetails());
  $("#more").disabled = false;
  applyView();
});
$("#price-form").addEventListener("submit", (e) => { e.preventDefault(); search(); });
$("#sort").addEventListener("change", () => (loaded.length || (prebuilt() && found.length) ? applyView() : null));
// Sortera står vid resultatrubriken, men på mobilen i filterraden bredvid Sällsynthet, där det finns plats
const sortLabel = $("#sort").closest(".drop"), sortHome = sortLabel.parentElement, narrow = matchMedia("(max-width:640px)");
const placeSort = () => (narrow.matches ? $("#adv").after(sortLabel) : sortHome.append(sortLabel));
narrow.addEventListener("change", placeSort);
placeSort();
for (const id of ["#set", "#rarity", "#lang"]) $(id).addEventListener("change", search);
// Filter-knappen fäller ut språk, set och sällsynthet. Öppnas automatiskt om en länk redan har valt något där.
const advToggle = $("#adv-toggle"), adv = $("#adv");
const setAdv = (open) => { adv.hidden = !open; advToggle.setAttribute("aria-expanded", String(open)); };
advToggle.addEventListener("click", () => setAdv(adv.hidden));

mountCardAutocomplete($("#pq"), {
  // One Piece och Riftbound får förslag ur spelets egna kort, Pokémon de vanliga.
  source: (q) => (prebuilt() ? gameSuggestions(game, q) : null),
  suggest: () => !prebuilt(),
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

// ---------- Kortskanner för Riftbound och One Piece ----------
// Ett säkert kort öppnas direkt. Annars söks det lästa numret (t.ex. "001/167"), så att man kan välja bland träffarna.
// Skannern (js/card-scanner.js) är stor och laddas först när knappen trycks.
async function scanCards() {
  track("scan", "Öppnad");
  const { openScanner } = await import("./card-scanner.js?v=20261103b");
  openScanner(({ cardId, name, number, total }) => {
    track("scan", cardId ? "Säker träff" : "Läst, söker");
    if (cardId) { openAfter = cardId; $("#pq").value = name || ""; }
    // Siffrorna fylls ut som på kortet ("57a" blir "057a"), så att sökningen hittar "057a/221"
    else $("#pq").value = total ? `${String(number).replace(/^\d+/, (d) => d.padStart(total.length, "0"))}/${total}` : number || "";
    search();
  }, null, { game, done: async (list) => {
    track("scan", `Till valvet: ${await addScanned(list)} kort`);
    showVault();
  } });
}
$("#rb-scan").addEventListener("click", scanCards);

// ---------- Mitt valv ----------
// Korten man skannar och trycker Klar på hamnar här, och man kan lägga till och ta bort kort i den stora vyn.
// Valvet sparas i webbläsarens localStorage och lämnar den aldrig: bara spel, kort-id, antal och när kortet lades in.
// Bild och pris tas ur kortfilen när valvet visas, så priset är alltid dagens. Behövs för en funktion man själv
// använder, så det kräver inget samtycke (se integritet.html).
const VAULT_KEY = "nl:vault";
let vaultOpen = false, vaultDirty = false;
const loadVault = () => { try { return JSON.parse(localStorage.getItem(VAULT_KEY)) || []; } catch { return []; } };
function saveVault(v) {
  try { localStorage.setItem(VAULT_KEY, JSON.stringify(v)); } catch {}
  vaultButton();
}
const vaultQty = (c) => loadVault().find((x) => x.game === c.game && x.id === c.id)?.qty || 0;
function changeVault(c, d) {
  const v = loadVault(), i = v.findIndex((x) => x.game === c.game && x.id === c.id);
  if (i < 0 && d > 0) v.unshift({ game: c.game, id: c.id, qty: d, at: Date.now() });
  else if (i >= 0) {
    v[i].qty += d;
    if (v[i].qty <= 0) v.splice(i, 1);
  }
  saveVault(v);
}
// Knappen syns i One Piece och Riftbound när valvet har kort
function vaultButton() {
  const n = loadVault().reduce((s, x) => s + x.qty, 0);
  $("#vault-open").hidden = !prebuilt() || !n;
  $("#vault-open .vault-count").textContent = n ? `(${n})` : "";
}

// Skannerns lista in i valvet. Kort som bara fick ett nummer läst slås upp på numret. Svarar med antalet inlagda kort.
async function addScanned(list) {
  let added = 0;
  for (const s of list) {
    if (!GAMES[s.game]) continue;
    let id = s.cardId;
    if (!id && s.number && s.total) {
      const no = `${String(s.number).replace(/^\d+/, (d) => d.padStart(String(s.total).length, "0"))}/${s.total}`;
      id = (await gameCards(s.game).catch(() => null))?.cards.find((c) => c.no === no && !c.variant)?.id;
    }
    if (!id) continue;
    changeVault({ game: s.game, id }, 1);
    added++;
  }
  return added;
}

async function showVault(push = true) {
  const my = ++searchId;
  vaultOpen = true;
  vaultDirty = false;
  // Valvet får en egen plats i historiken, så att telefonens bakåtknapp leder tillbaka dit man var
  if (push && !new URLSearchParams(location.search).has("vault")) history.pushState({ vault: true }, "", `?game=${game}&vault=1`);
  $("#landing").hidden = true;
  $("#results").hidden = false;
  $("#vault-bar").hidden = false;
  $("#res-title").textContent = "Mitt valv";
  $("#prices").innerHTML = skeleton(6);
  $("#more").hidden = true;
  const v = loadVault();
  try {
    const games = [...new Set(v.map((x) => x.game))].filter((g) => GAMES[g]);
    const byId = {};
    for (const [g, d] of await Promise.all(games.map(async (g) => [g, await gameCards(g)]))) for (const c of d.cards) byId[`${g}:${c.id}`] = c;
    if (my !== searchId) return;
    found = v.map((x) => byId[`${x.game}:${x.id}`] && { ...byId[`${x.game}:${x.id}`], qty: x.qty }).filter(Boolean);
  } catch {
    $("#prices").innerHTML = '<div class="msg">Kunde inte läsa korten just nu. Försök igen om en stund.</div>';
    return;
  }
  next = found.length;
  loaded = [];
  const n = found.reduce((s, c) => s + c.qty, 0), worth = found.reduce((s, c) => s + (c.sek || 0) * c.qty, 0);
  $("#vault-bar .vault-sum").innerHTML = n ? `<b>${n} kort</b> · värt ungefär <b>${kr(worth)}</b>` : "";
  $("#vault-clear").hidden = !n;
  if (!n) {
    current = [];
    $("#prices").innerHTML = '<div class="msg">Valvet är tomt. Slå på <b>Flera kort</b> i skannern, skanna dina kort och tryck <b>Klar</b>, så hamnar de här.</div>';
    return;
  }
  applyView();
}
function closeVault() {
  vaultOpen = false;
  $("#vault-bar").hidden = true;
}
// Tillbaka: samma steg som bakåtknappen om valvet öppnades härifrån, annars till sökningen eller startvyn
function leaveVault() {
  if (history.state?.vault) return history.back();
  closeVault();
  search();
  if ($("#results").hidden) landing();
}
addEventListener("popstate", () => {
  if (new URLSearchParams(location.search).has("vault") && prebuilt()) return showVault(false);
  if (!vaultOpen) return;
  closeVault();
  search();
  if ($("#results").hidden) landing();
});
$("#vault-open").addEventListener("click", () => showVault());
$("#vault-back").addEventListener("click", leaveVault);
$("#vault-clear").addEventListener("click", () => {
  if (!confirm("Töm valvet? Alla kort i valvet tas bort från den här webbläsaren.")) return;
  saveVault([]);
  showVault(false);
});
// Knapparna i den stora vyn: lägg till ett exemplar eller ta bort ett
const vaultActions = (c) => {
  const q = vaultQty(c);
  return `<div class="cm-vault">
    <button type="button" class="btn small" data-vault="1">+ Lägg i valvet</button>
    ${q ? `<button type="button" class="btn small" data-vault="-1">− Ta bort</button><span class="cm-vault-qty">${q} i valvet</span>` : ""}
  </div>`;
};

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
  if (GAMES[c.game]) return openPrebuiltCard(c, i, body);
  const full = c.full || (await getJSON(`${apiFor(c.lang)}/cards/${encodeURIComponent(c.id)}`).catch(() => null)) || {};
  if (shownIndex !== i) return;
  await getRates();
  const ja = c.lang === "ja";
  const cm = full.pricing?.cardmarket || {}, tp = full.pricing?.tcgplayer || {};
  // "Senast sökta" hämtar korten från den engelska databasen, så japanska kort sparas inte där.
  if (!ja) recordCard({ id: c.id, name: c.name, set: full.set?.name, localId: full.localId || c.localId, total: full.set?.cardCount?.official, image: c.image || full.image, eur: cm.trend ?? cm.avg ?? null });
  track("card_view", [full.name || c.name, full.set?.name].filter(Boolean).join(" · "), c.eur != null && rates?.EUR ? Math.round(c.eur * rates.EUR) : null);
  const fin = finish({ ...c, variants: full.variants });
  const row = (label, v, cur) => (v == null ? "" : `<tr><th>${label}</th><td>${sek(v, cur)}</td></tr>`);
  const tpRows = Object.entries(tp).filter(([, v]) => v && typeof v === "object" && v.marketPrice != null)
    .map(([k, v]) => row({ normal: "Vanlig", holofoil: "Holo", reverseHolofoil: "Reverse holo", "1stEditionHolofoil": "1st edition holo" }[k] || k, v.marketPrice, "USD")).join("");
  const pages = ja ? null : await setPages();
  const facts = [
    full.set?.name && `<li><b>Set</b>${setLink(full.set, pages)}${full.localId ? ` · #${esc(full.localId)}` : ""}</li>`,
    full.rarity && `<li><b>Sällsynthet</b>${esc(full.rarity)}</li>`,
    full.illustrator && `<li><b>Illustratör</b>${esc(full.illustrator)}</li>`,
    full.hp && `<li><b>HP</b>${esc(full.hp)}${full.types?.length ? ` · ${esc(full.types.join(", "))}` : ""}</li>`,
    full.variants && `<li><b>Varianter</b>${Object.entries({ normal: "Vanlig", reverse: "Reverse holo", holo: "Holo", firstEdition: "1st edition" }).filter(([k]) => full.variants[k]).map(([, v]) => v).join(", ") || "–"}</li>`,
  ].filter(Boolean).join("");
  body.innerHTML = `
    <div class="cm-card-wrap">
      <div class="cm-card ${fin}" style="--rx:0deg;--ry:0deg;--mx:50%;--my:50%">
        ${cardImg(full, "high") ? `<img src="${esc(cardImg(full, "high"))}" alt="${esc(full.name || c.name)}" onload="this.parentNode.classList.add('loaded')" referrerpolicy="no-referrer" onerror="this.src='img/kortbaksida.webp';this.parentNode.classList.add('has-back');">` : `<img src="img/kortbaksida.webp" alt="Kortets baksida" onload="this.parentNode.classList.add('loaded')"><span class="csoon" style="position:absolute;inset:auto 12px 14px;padding:6px 12px;font-size:0.8rem">Bilder kommer snart</span>`}
        <i class="cm-holo"></i><i class="cm-glare"></i>
      </div>
      <ul class="cm-facts">${facts}</ul>
    </div>
    <div class="cm-info">
      <h2 id="cm-name">${ja && c.en ? `${esc(c.en)} <small class="cname-ja">${esc(full.name || c.name)}</small> <span class="beta-tag">Beta</span>` : esc(full.name || c.name)}</h2>
      <div class="cm-price">${c.eur != null ? sek(c.eur) : "Inget pris ännu"} ${change(c.change)}</div>
      <p class="muted">Cardmarkets trendpris i kronor. Vägledande, uppdateras dagligen.</p>
      <div class="pchart"></div>
      ${cm.trend != null || cm.avg != null ? `<h3>Cardmarket (Europa)</h3><table class="cm-table">${row("Trend", cm.trend, "EUR")}${row("Snitt", cm.avg, "EUR")}${row("Lägsta", cm.low, "EUR")}${row("Snitt 1 dag", cm.avg1, "EUR")}${row("Snitt 7 dagar", cm.avg7, "EUR")}${row("Snitt 30 dagar", cm.avg30, "EUR")}${row("Trend holo", cm["trend-holo"] || null, "EUR")}</table>` : ""}
      ${tpRows ? `<h3>TCGplayer (USA)</h3><table class="cm-table">${tpRows}</table>` : ""}
      <div class="cm-links">
        <a class="btn primary small" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(ja ? c.en || full.name : full.name || c.name)}" target="_blank" rel="noopener">Cardmarket ↗</a>
        ${ja ? "" : `<a class="btn small" href="https://www.tcgplayer.com/search/pokemon/product?q=${encodeURIComponent(full.name || c.name)}" target="_blank" rel="noopener">TCGplayer ↗</a>`}
      </div>
    </div>`;
  // Prishistoriken finns bara för de engelska korten.
  if (full.id && !ja) mountChart(body.querySelector(".pchart"), full, rates?.EUR).catch(() => {});
  modal.querySelector(".prev").hidden = i <= 0;
  modal.querySelector(".next").hidden = i >= current.length - 1;
}

// Stor vy för ett One Piece- eller Riftbound-kort. Allt finns redan i kortfilen, inget behöver hämtas.
function openPrebuiltCard(c, i, body) {
  const g = GAMES[c.game];
  track("card_view", [c.name, c.variant, c.set].filter(Boolean).join(" · "), c.sek != null ? Math.round(c.sek) : null);
  const fact = (label, v) => (v == null || v === "" ? "" : `<li><b>${label}</b>${esc(v)}</li>`);
  const facts = [
    fact("Set", `${c.set}${c.no ? ` · ${c.no}` : ""}`),
    fact("Sällsynthet", rarityName(c)), fact("Variant", c.variant),
    ...g.facts(c).map(([label, v]) => fact(label, v)),
  ].join("");
  const row = (label, v) => (v == null ? "" : `<tr><th>${label}</th><td>${kr(v)}</td></tr>`);
  const title = [c.name, c.variant && `(${c.variant})`].filter(Boolean).join(" ");
  body.innerHTML = `
    <div class="cm-card-wrap">
      <div class="cm-card ${finish(c)}" style="--rx:0deg;--ry:0deg;--mx:50%;--my:50%">
        <img src="${esc(c.image || backOf(c))}" alt="${esc(title)}" onload="this.parentNode.classList.add('loaded')" referrerpolicy="no-referrer" onerror="this.src='${backOf(c)}';this.parentNode.classList.add('has-back');">
        <i class="cm-holo"></i><i class="cm-glare"></i>
      </div>
      <ul class="cm-facts">${facts}</ul>
    </div>
    <div class="cm-info">
      <h2 id="cm-name">${esc(c.name)}${c.variant ? ` <small class="cname-ja">${esc(c.variant)}</small>` : ""}</h2>
      <div class="cm-price">${c.sek != null ? kr(c.sek) : "Inget pris ännu"} ${change(c.change)}</div>
      <p class="muted">TCGplayers marknadspris i kronor. Vägledande, uppdateras dagligen.</p>
      ${vaultActions(c)}
      <div class="pchart"></div>
      ${c.sek != null || c.low != null ? `<h3>TCGplayer (USA)</h3><table class="cm-table">${row("Marknadspris", c.sek)}${row("Foil", c.foil)}${row("Lägsta i lager", c.low)}</table>` : ""}
      <div class="cm-links">
        <a class="btn primary small" href="${esc(g.cardmarket(c))}" target="_blank" rel="noopener">Cardmarket ↗</a>
        <a class="btn small" href="${esc(g.tcgplayer(c))}" target="_blank" rel="noopener">TCGplayer ↗</a>
      </div>
    </div>`;
  mountChart(body.querySelector(".pchart"), { id: c.id, set: { id: c.setId } }, null, { dir: `data/${c.game}/history`, source: "TCGplayers marknadspris" }).catch(() => {});
  if (g.details) detailsOf(c.game).then((d) => {
    const x = d[c.id];
    // Hann man bläddra vidare till ett annat kort hör listan till ett annat kort.
    if (!x || shownIndex !== i) return;
    if (x.artist) body.querySelector(".cm-facts").insertAdjacentHTML("beforeend", `<li><b>Illustratör</b>${esc(x.artist)}</li>`);
  });
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
  const vb = e.target.closest("[data-vault]");
  if (vb) {
    const c = current[shownIndex];
    changeVault(c, +vb.dataset.vault);
    vaultDirty = true;
    modal.querySelector(".cm-vault").outerHTML = vaultActions(c);
  }
  if (e.target.closest(".prev")) openCard(shownIndex - 1);
  if (e.target.closest(".next")) openCard(shownIndex + 1);
});
// Ändrades valvet medan det visades ritas det om när den stora vyn stängs
modal.addEventListener("close", () => { if (vaultOpen && vaultDirty) showVault(false); });
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

// Byter set- och sällsynhetslistan, sökrutans exempel och rubriken efter spelet. Pokémons listor sparas
// första gången, så att de kan läggas tillbaka utan att TCGdex frågas igen.
let pokemonFilters = null, PAGE_TITLE = null;
async function applyGame() {
  const g = prebuilt();
  pokemonFilters ??= { set: $("#set").innerHTML, rarity: $("#rarity").innerHTML };
  for (const b of document.querySelectorAll("#game-seg button")) b.setAttribute("aria-pressed", String(b.dataset.game === game));
  $("#pq").placeholder = g ? g.placeholder : "Sök kort, t.ex. Pikachu eller Charizard ex";
  $("#page-h1").textContent = g ? g.h1 : "Kortpriser för Pokémonkort";
  // Fliken får spelets namn, t.ex. "Kortpriser för Riftbound-kort i kronor | Lootninja". Pokémon behåller sidans titel.
  PAGE_TITLE ??= document.title;
  document.title = g ? `${g.h1} i kronor | Lootninja` : PAGE_TITLE;
  $("#lang").closest("label").hidden = !!g;
  // Kortskannern finns för Riftbound och One Piece här. Pokémonkort skannas i värderingen.
  $("#rb-scan").hidden = !g;
  vaultButton();
  // "Senast sökta" leder till värderingen, som bara finns för Pokémon.
  $("#recent").style.display = g ? "none" : "";
  if (g) $("#lang").value = "en";
  $("#set").disabled = $("#rarity").disabled = false;
  $("#lang-beta").hidden = $("#ja-note").hidden = true;
  if (!g) {
    $("#set").innerHTML = pokemonFilters.set;
    $("#rarity").innerHTML = pokemonFilters.rarity;
    return;
  }
  $("#set").innerHTML = '<option value="">Alla</option>';
  $("#rarity").innerHTML = '<option value="">Alla</option>';
  const shown = game;
  try {
    const d = await gameCards(shown);
    if (game !== shown) return;
    // Set som väntar på sin kortlista (pending) har inga kort att visa än
    $("#set").insertAdjacentHTML("beforeend", d.sets.filter((s) => !s.pending).map((s) => `<option value="${esc(s.id)}">${esc(g.setLabel(s))}</option>`).join(""));
    $("#rarity").insertAdjacentHTML("beforeend", d.rarities.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join(""));
  } catch {}
}

async function setGame(g) {
  if (g === game) return;
  game = g;
  try { localStorage.setItem(GAME_KEY, g); } catch {}
  searchId++;
  closeVault();
  $("#pq").value = "";
  await applyGame();
  history.replaceState(null, "", prebuilt() ? `?game=${game}` : location.pathname);
  found = loaded = []; next = 0;
  $("#results").hidden = true;
  $("#landing").hidden = false;
  landing();
}
document.querySelector("#game-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-game]");
  if (b) setGame(b.dataset.game);
});

mountRecent($("#recent"), { eyebrow: "Nyligen sökta", title: "Senast sökta kort", hint: "Korten du senast öppnat. Sparas bara i den här webbläsaren." });
await fillFilters();
await applyGame();
const p = new URLSearchParams(location.search);
for (const [k, id] of [["q", "#pq"], ["lang", "#lang"], ["rarity", "#rarity"], ["set", "#set"], ["sort", "#sort"]]) if (p.get(k) && !(k === "lang" && prebuilt())) $(id).value = p.get(k);
if (p.get("lang") === "ja" || p.get("rarity") || p.get("set")) setAdv(true);
if (p.has("vault") && prebuilt()) showVault(false);
else if (p.get("q") || p.get("rarity") || p.get("set")) search(); else landing();
