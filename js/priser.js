import { API, $, esc, kr, getJSON, getList, fxRates, skeleton, liveStamp, cardImg, setPages, setLink, clearCache } from "./site.js";
import { mountChart, mountSeries } from "./pricechart.js?v=20261103a";
import { recordCard, mountRecent } from "./recent.js";
import { mountCardAutocomplete, parseCardQuery, resolvePokemonName, loadDataset, sameNumber, filterByNumber, apiNumber } from "./card-autocomplete.js";
import { langMark } from "./langmark.js";
import { apiFor, findJapanese } from "./japanese.js";
import { track } from "./tracker.js";
import { gameSuggestions } from "./game-guess.js";
import { reverseEur, baseLabel, cardmarketTable, tcgplayerTable } from "./cmholo.js?v=20261104b";
import { unlockCoin } from "./scan/coin.js?v=20261105a";
import { backupDue, backupFile, backupState, cardCount, listCopies, markSaved, mergeCards, noteAdded, parseBackup, saveCopy, saveFile, snooze } from "./vault-backup.js?v=20261106a";

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
  // Gamla id för samma kort (se tcgAlias), så att valvet och skannern hittar kort som bytt id
  d.alias = new Map();
  for (const c of d.cards) { const a = tcgAlias(c.setId, c); if (a && a !== c.id) d.alias.set(a, c); }
  return d;
}).catch((e) => { delete gameData[g]; throw e; }));
// Illustratör (data/rb/details.json, från Riots kortgalleri). Hämtas först när man öppnar ett kort.
const gameDetails = {};
const detailsOf = (g) => (gameDetails[g] ??= fetch(`data/${g}/details.json`, { cache: "no-cache" }).then((r) => r.json())
  .catch(() => { delete gameDetails[g]; return {}; }));
// Ett nytt One Piece-kort får först TCGplayers id ("EB-05/tcg723376") och byter till optcgapis när de lägger in kortet
// (se scripts/update-op-cards.mjs). Det gamla id:t går att räkna fram ur TCGplayers produkt-id (c.tcg, eller numret
// i bildlänken så länge bilden är TCGplayers).
const tcgAlias = (set, c) => {
  const p = c.tcg || c.image?.match(/tcgplayer-cdn\.tcgplayer\.com\/product\/(\d+)_/)?.[1];
  return p ? `${set}/tcg${p}` : null;
};
// Samma form som Pokémonkorten i rutnätet: localId är kortnumret och priset ligger i kronor (sek).
const preSlim = (c, g) => ({ ...c, game: g, localId: c.no });
// Spelets egen kortbaksida när kortet saknar bild (eller bilden inte går att ladda).
const backOf = (c) => GAMES[c.game]?.back || "img/kortbaksida.webp";
const rarityName = (c) => GAMES[c.game]?.rarities[c.rarity] || c.rarity;

// ---------- Valuta ----------
let rates = null;
async function getRates() {
  rates ||= await fxRates();
  return rates;
}
// Alla priser visas i kronor. Går kursen inte att hämta visas hellre inget pris än ett i fel valuta.
const sek = (v, cur = "EUR") => (v == null || !rates?.[cur] ? "–" : kr(v * rates[cur]));
// Kortets pris för sortering och visning: de färdigbyggda spelen har redan kronor, Pokémonkorten euro.
// I valvet har Pokémonkorten också kronor (pokemonCard), så att spelen kan sorteras ihop.
const value = (c) => (GAMES[c.game] || VAULT_PAGE ? c.sek : c.eur);
// Kortets pris i kronor, eller null
const sekOf = (c) => c.sek ?? (GAMES[c.game] || c.eur == null || !rates?.EUR ? null : Math.round(c.eur * rates.EUR * 100) / 100);
const toSek = (v) => (v == null || !rates?.EUR ? null : Math.round(v * rates.EUR * 100) / 100);

// ---------- Vanlig eller foil ----------
// Ett kort som finns både som vanligt och som foil har två priser: Riftbound har TCGplayers foilpris (c.foil), Pokémon
// Cardmarkets pris för reverse holo och holo ("-holo"). One Piece har ett pris per kort. I valvet är foil egna
// exemplar (f: 1) med eget pris.
const cmOf = (c) => c.full?.pricing?.cardmarket || {};

// Foilpriset i kronor när kortet finns i båda, annars null
// Foil är aldrig billigare än vanligt: ett lägre foilpris är brus och ger inget val.
function foilSek(c) {
  if (c.game === "rb") return c.foil != null && c.sek != null && c.foil >= c.sek ? c.foil : null;
  if (GAMES[c.game]) return null;
  return toSek(reverseEur(c.full));
}
const foilLabel = (c) => (c.game === "rb" ? "Foil" : "Reverse holo");
// Kortets vanliga version: Vanlig, eller Holo för Pokémonkort som bara trycktes som holo
const plainLabel = (c) => (GAMES[c.game] ? "Vanlig" : baseLabel(c.full));
const priceText = (c) => (GAMES[c.game] ? kr(c.sek) : sek(c.eur));

// ---------- Holo-nivå ----------
// Vanliga kort får bara en ljusreflex, holo får regnbågsglans och specialkort en starkare effekt.
function finish(c) {
  if (c.holo) return "rainbow";
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
      ${c.holo ? `<span class="cfoil">${esc(foilLabel(c))}</span>` : ""}
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
    game: "pokemon", lang: meta.lang || "en", en: meta.en || null, setId: c.set?.id,
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
    // Valvet: senast inlagda först, och störst ökning sedan inläggningen (kort utan sparat pris sist)
    added: (a, b) => (b.at ?? 0) - (a.at ?? 0),
    gain: (a, b) => {
      const g = (c) => (c.p && c.sek != null ? c.sek / c.p - 1 : -Infinity);
      return g(b) - g(a);
    },
  }[sort];
  // Korten i de färdigbyggda spelen finns redan alla i minnet, så där sorteras hela träfflistan och de första visas.
  list = prebuilt() || VAULT_PAGE ? [...found].sort(cmp).slice(0, next) : list.sort(cmp);
  current = list;
  renderGrid($("#prices"), list);
  $("#more").hidden = next >= found.length;
  if (selecting) paintPicked();
}

async function search() {
  // I valvet söker sökrutan bara bland valvets kort
  if (VAULT_PAGE) return showVault();
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
    if (my === searchId) { applyView(); openWanted(); }
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
// cardId: ett förslag i menyns sökruta som pekade ut ett enda Pokémonkort (js/card-autocomplete.js)
let openAfter = new URLSearchParams(location.search).get("card") || new URLSearchParams(location.search).get("cardId");
// Öppnar kortet som söktes fram (openAfter) när det finns bland de visade träffarna
function openWanted() {
  if (!openAfter) return;
  const id = openAfter;
  openAfter = null;
  const i = current.findIndex((c) => c.id === id);
  if (i >= 0) openCard(i);
}
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
      const hay = `${c.name} ${c.variant || ""} ${c.set} ${c.no || c.localId || ""} ${c.holo ? `foil ${foilLabel(c)}` : ""}`.toLowerCase();
      return words.every((w) => hay.includes(w)) || (cq.length >= 4 && compact(c.no).startsWith(cq));
    });
    next = PAGE;
    loaded = [];
    applyView();
    // Länk från en setsida (priser.html?game=rb&set=…&card=<id>): kortet öppnas direkt, även om det ligger längre ner i listan.
    if (openAfter) {
      if (found.some((c) => c.id === openAfter) && !current.some((c) => c.id === openAfter)) { next = found.length; applyView(); }
      openWanted();
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
// Valvet har alla sina kort i found, oavsett vilket spel som senast valdes på Kortpriser
$("#sort").addEventListener("change", () => (loaded.length || ((prebuilt() || VAULT_PAGE) && found.length) ? applyView() : null));
// Sortera står vid resultatrubriken, men på mobilen i filterraden bredvid Sällsynthet, där det finns plats
const sortLabel = $("#sort").closest(".drop"), sortHome = sortLabel.parentElement, narrow = matchMedia("(max-width:640px)");
// Valvet: Sortera står alltid i verktygsraden ovanför korten
const placeSort = () => (document.body.dataset.page === "valv" ? null : narrow.matches ? $("#adv").after(sortLabel) : sortHome.append(sortLabel));
narrow.addEventListener("change", placeSort);
placeSort();
for (const id of ["#set", "#rarity", "#lang"]) $(id).addEventListener("change", search);
// Språk, set och sällsynthet visas inte (ingen Filter-knapp), men gäller fortfarande när en länk väljer dem,
// t.ex. ett set från setsidorna (?set=…).

mountCardAutocomplete($("#pq"), {
  // One Piece och Riftbound får förslag ur spelets egna kort, Pokémon de vanliga. I valvet inga förslag.
  source: (q) => (prebuilt() && !VAULT_PAGE ? gameSuggestions(game, q) : null),
  suggest: () => !prebuilt() && !VAULT_PAGE,
  // Ett förslag som pekar ut ett enda kort (t.ex. "Pikachu 051/162") öppnar kortet direkt, med träffarna bakom
  onSelect: (val, cardId) => {
    openAfter = cardId || null;
    // Utan fokus i sökrutan öppnas inte förslagen igen när kortet stängs (dialogen ger fokus tillbaka)
    if (cardId) $("#pq").blur();
    $("#pq").value = val;
    search();
  },
  onLiveChange: (val) => {
    if (VAULT_PAGE) return showVault();
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

// ---------- Mitt valv ----------
// Korten man skannar och trycker Klar på hamnar i valvet, och man kan lägga till och ta bort kort i den stora vyn.
// Valvet visas på en egen sida (valv.html, body data-page="valv"), som använder samma kortrutor och stora vy som
// Kortpriser. Det sparas i webbläsarens localStorage och lämnar den aldrig: spel, kort-id, antal, när kortet lades in
// och priset då (för portföljens utveckling). Bild och dagens pris tas ur kortfilen när valvet visas. Behövs för en
// funktion man själv använder, så det kräver inget samtycke (se integritet.html).
const VAULT_PAGE = document.body.dataset.page === "valv";
const VAULT_KEY = "nl:vault";
let vaultDirty = false;
let backToScan = false; // kortet öppnades från skannern, som ska komma tillbaka när kortet stängs
const loadVault = () => { try { return JSON.parse(localStorage.getItem(VAULT_KEY)) || []; } catch { return []; } };
function saveVault(v) {
  const json = JSON.stringify(v);
  try { localStorage.setItem(VAULT_KEY, json); }
  catch {
    // Full lagring: sparade TCGdex-svar får ge plats åt valvet. Går det ändå inte ska det inte försvinna i tysthet.
    clearCache();
    try { localStorage.setItem(VAULT_KEY, json); }
    catch { alert("Valvet kunde inte sparas: webbläsarens lagring är full. Rensa webbplatsdata för andra sidor och försök igen."); }
  }
  // Be webbläsaren behålla sidans lagring, så att den inte rensas när telefonen får ont om plats
  navigator.storage?.persist?.().catch(() => {});
  // En automatisk kopia av läget, en stund efter senaste ändringen (många kort kan skannas i rad)
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => saveCopy(loadVault()), 800);
}
let copyTimer = 0;
// Samma kort i valvet, vanligt (f falskt) eller foil
const sameEntry = (x, c, f) => x.game === c.game && x.id === c.id && !x.f === !f;
const vaultQty = (c, f = false) => loadVault().find((x) => sameEntry(x, c, f))?.qty || 0;
const priceAs = (c, f) => (f ? foilSek(c) : sekOf(c));
// c: kortet (med dagens pris i sek, om det finns), f: foil. Inköpspriset (p) är snittet av priserna då exemplaren lades in.
// Ett nytt exemplar av ett kort som redan finns flyttar kortet först, som senast inlagt (Nyaste först).
function changeVault(c, d, f = false) {
  const v = loadVault(), i = v.findIndex((x) => sameEntry(x, c, f));
  const now = priceAs(c, f);
  if (d > 0) noteAdded(d, cardCount(v) + d);
  if (i < 0 && d > 0) v.unshift({ game: c.game, id: c.id, qty: d, at: Date.now(), p: now, ...(f && { f: 1 }) });
  else if (i >= 0) {
    const x = v[i];
    if (d > 0 && x.p != null && now != null) x.p = Math.round(((x.p * x.qty + now * d) / (x.qty + d)) * 100) / 100;
    x.qty += d;
    if (x.qty <= 0) v.splice(i, 1);
    else if (d > 0) { x.at = Date.now(); v.unshift(...v.splice(i, 1)); }
  }
  saveVault(v);
}
// Ett exemplar byter mellan vanligt och foil (foil: vad det blir), och behåller sin plats och sin tid i valvet.
// Inköpspriset blir dagens pris för det nya slaget.
function moveVault(c, foil) {
  const v = loadVault(), x = v.find((y) => sameEntry(y, c, !foil));
  if (!x) return;
  const now = priceAs(c, foil), y = v.find((z) => sameEntry(z, c, foil));
  if (y) {
    if (y.p != null && now != null) y.p = Math.round(((y.p * y.qty + now) / (y.qty + 1)) * 100) / 100;
    y.qty += 1;
  } else v.splice(v.indexOf(x), 0, { game: c.game, id: c.id, qty: 1, at: x.at, p: now, ...(foil && { f: 1 }) });
  x.qty -= 1;
  if (x.qty <= 0) v.splice(v.indexOf(x), 1);
  saveVault(v);
}
// Ett Pokémonkort i valvet, från TCGdex. Pris och månadssnitt räknas om till kronor, som de andra spelens.
async function pokemonCard(id) {
  const [full] = await Promise.all([getJSON(`${API}/cards/${enc(id)}`), getRates()]);
  const c = slim(full);
  return { ...c, sek: toSek(c.eur), avg30: toSek(c.avg30) };
}
// Ett skannat Pokémonkort: kort-id:t, eller namn och nummer när de bara pekar ut ett kort
async function scannedPokemon(s) {
  if (s.cardId) return pokemonCard(s.cardId);
  if (!s.name || !s.number) return null;
  const list = await filterByNumber(await getList(`${API}/cards?${new URLSearchParams({ name: s.name, localId: apiNumber(s.number) })}`), s.number, s.total);
  return list.length === 1 ? pokemonCard(list[0].id) : null;
}

// Ett skannat kort ur kortfilen (eller TCGdex). Kort som bara fick ett nummer läst slås upp på numret.
async function scannedCard(s) {
  if (s.game === "pokemon") return scannedPokemon(s);
  if (!GAMES[s.game]) return null;
  const d = await gameCards(s.game), cards = d.cards;
  let c = s.cardId && (cards.find((x) => x.id === s.cardId) || d.alias.get(s.cardId));
  if (!c && s.number && s.total) {
    const no = `${String(s.number).replace(/^\d+/, (d) => d.padStart(String(s.total).length, "0"))}/${s.total}`;
    c = cards.find((x) => x.no === no && !x.variant);
  }
  return c || null;
}
// Skannade kort in i valvet. Svarar med de inlagda korten.
async function addScanned(list) {
  const added = [];
  for (const s of list) {
    const c = await scannedCard(s).catch(() => null);
    if (!c) continue;
    changeVault(c, 1);
    added.push(c);
  }
  return added;
}

// ---------- Kortskanner ----------
// Kortpriser: ett kort i taget i det valda spelet (Pokémonskannern känner också igen tydliga One Piece- och
// Riftbound-kort). Träffen poppar upp i skannern, som stängs, och kortet öppnas i den stora vyn med sökträffarna
// bakom, så att ✕ visar kortet i listan. Ett kort som bara gick att läsa delvis söks på numret (t.ex. "001/167") eller
// namnet. Valvet: skannern letar bland alla tre spelen ("vault"), och varje träff läggs i valvet direkt. Ett tryck på
// träffen i skannern öppnar kortet.
// Skannern (js/card-scanner.js) är stor och laddas först när knappen trycks.
const hitKey = (r) => `${r.game}:${r.cardId || `${r.number}/${r.total}`}`;
// Sökningen som hittar ett skannat kort på Kortpriser. Pokémonkort som känts igen på bilden har bara id:t, så namnet
// och numret hämtas från TCGdex.
async function scanQuery({ game: g, cardId, name, number, total }) {
  if (g === "pokemon") {
    const c = cardId && (await getJSON(`${API}/cards/${enc(cardId)}`).catch(() => null));
    if (c?.name) return `${c.name} ${c.localId}`;
    return number ? `${name ? `${name} ` : ""}${number}${total ? `/${total}` : ""}` : name || "";
  }
  if (cardId) return name || "";
  // Siffrorna fylls ut som på kortet ("57a" blir "057a"), så att sökningen hittar "057a/221"
  return total ? `${String(number).replace(/^\d+/, (d) => d.padStart(total.length, "0"))}/${total}` : number || name || "";
}
// manual: skannern öppnas direkt med sökrutan (Sök och lägg till i valvet)
async function scanCards(g = VAULT_PAGE ? "vault" : game, { manual = false } = {}) {
  if (VAULT_PAGE) {
    unlockCoin(); // måste ske i trycket, före första await
    getRates(); // kursen ska finnas när första kortet hittas
  }
  track("scan", "Öppnad");
  const { openScanner } = await import("./card-scanner.js?v=20261106j");
  const added = new Map(); // valvet: träffarna som lagts in, för att kunna öppna rätt kort
  openScanner(async (r) => {
    track("scan", r.cardId ? "Säker träff" : "Läst, söker");
    if (VAULT_PAGE) {
      const c = await added.get(hitKey(r));
      await showVault();
      const i = c ? current.findIndex((x) => x.game === c.game && x.id === c.id) : -1;
      // Stängs kortet går man tillbaka till kameran, inte till valvet
      if (i < 0) return scanCards("vault");
      backToScan = true;
      openCard(i);
      return;
    }
    // Ett kort från ett annat spel än det valda (t.ex. One Piece i Pokémonskannern) byter spel
    const g = r.game || "pokemon";
    if (g !== game) await setGame(g);
    if (g === "pokemon") $("#lang").value = "en";
    openAfter = r.cardId || null;
    $("#pq").value = await scanQuery({ ...r, game: g });
    search();
  }, null, {
    game: g,
    manual,
    open: !VAULT_PAGE,
    preview: VAULT_PAGE ? scannedCard : null,
    hit: VAULT_PAGE ? (r) => {
      // Kortet läggs i valvet så fort det hittats, och valvet bakom skannern ritas om
      const p = addScanned([r]).then(([c]) => { if (c) track("scan", "Till valvet: 1 kort"); showVault(); return c; });
      added.set(hitKey(r), p);
      return p; // skannern visar kortets namn och värde
    } : null,
  });
}

// ---------- Valvsidan ----------
// Sökrutan söker bara bland valvets kort, och spelknapparna är filter: alla är tända, och ett tryck släcker (eller
// tänder) ett spel. Överst portföljen: värdet, utvecklingen sedan korten lades in och mot månadens snittpris.
let vaultOff = new Set();
function paintGameSeg() {
  const seg = $("#game-seg");
  seg.classList.add("vault-mode");
  for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(!vaultOff.has(b.dataset.game)));
}
// "+12 kr (+4,2 %)" med färg efter riktningen
const diff = (now, then) => {
  if (!then) return "–";
  const d = now - then, pct = Math.round((d / then) * 1000) / 10;
  return `<span class="${d >= 0 ? "up" : "down"}">${d >= 0 ? "+" : "−"}${kr(Math.abs(d))} (${d >= 0 ? "+" : "−"}${Math.abs(pct).toLocaleString("sv-SE")} %)</span>`;
};

// Valvets värde dag för dag, ur korten prishistorik (data/<spel>/history/<set>.json, en punkt per kort och dag).
// En dag utan pris för ett kort använder det senaste priset före, eller det första kända om historiken börjar
// senare. Kort utan historik räknas med dagens pris. Sista punkten är i dag, med dagens priser.
const vaultHist = {};
// Pokémonkortens historik ligger i data/card-history (också i kronor)
const histDir = (g) => (GAMES[g] ? `data/${g}/history` : "data/card-history");
const histOf = (g, set) => (vaultHist[`${g}/${set}`] ??= fetch(`${histDir(g)}/${encodeURIComponent(set)}.json`, { cache: "no-cache" })
  .then((r) => (r.ok ? r.json() : { cards: {} })).catch(() => ({ cards: {} })));
async function valueSeries(cards) {
  // Historiken gäller det vanliga priset. Foil räknas med samma utveckling, i dagens foilpris.
  const k = (c) => (!c.holo ? 1 : c.orig.sek ? c.sek / c.orig.sek : 0);
  const rows = await Promise.all(cards.map(async (c) => (k(c) ? (await histOf(c.game, c.setId)).cards[c.id] || [] : [])
    .filter(([, p]) => p != null).map(([d, p]) => [d, p * k(c)])));
  const today = new Date().toISOString().slice(0, 10);
  const dates = [...new Set([...rows.flat().map(([d]) => d), today])].filter((d) => d <= today).sort();
  return dates.map((date) => ({
    date,
    price: cards.reduce((s, c, i) => {
      if (date === today && c.sek != null) return s + c.sek * c.qty;
      const h = rows[i];
      let p = h[0]?.[1] ?? c.sek ?? 0;
      for (const [d, v] of h) { if (d > date) break; p = v; }
      return s + p * c.qty;
    }, 0),
  }));
}
// Liten graf utan axlar i portföljens värderuta
function spark(pts) {
  const W = 120, H = 40, ys = pts.map((p) => p.price), lo = Math.min(...ys), hi = Math.max(...ys), k = hi - lo || 1;
  const xy = pts.map((p, i) => [(i / (pts.length - 1)) * W, H - 3 - ((p.price - lo) / k) * (H - 6)]);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path class="vs-area" d="${line} L${W},${H} L0,${H} Z"/><path class="vs-line" d="${line}"/></svg>`;
}
let valuePts = [];
async function drawValue(cards, worth, my) {
  const pts = await valueSeries(cards);
  if (my !== searchId) return;
  valuePts = pts;
  const box = $("#vault-stats .vs-value");
  if (!box || pts.length < 2) { box?.classList.add("flat"); return; }
  const first = pts[0].price, pct = first ? Math.round((worth / first - 1) * 1000) / 10 : 0;
  box.classList.toggle("down", pct < 0);
  box.querySelector(".vs-spark").innerHTML = spark(pts);
  box.querySelector(".vs-chg").innerHTML = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toLocaleString("sv-SE")} %`;
  box.querySelector(".vs-chg").title = `Sedan ${new Date(`${pts[0].date}T12:00:00`).toLocaleDateString("sv-SE", { day: "numeric", month: "long" })}`;
}

// Väljläget: ett tryck på ett kort markerar det i stället för att öppna det. Vanligt och foil är olika kort i valvet.
let selecting = false;
const picked = new Set();
const pickKey = (game, id, foil) => `${game}:${id}:${foil ? 1 : 0}`;
const keyOfTile = (c) => pickKey(c.game, c.id, c.holo);
function paintPicked() {
  for (const t of document.querySelectorAll("#prices .ctile")) {
    const c = current[+t.dataset.i], on = picked.has(keyOfTile(c));
    t.classList.toggle("picked", on);
    t.setAttribute("aria-pressed", String(on));
    t.setAttribute("aria-label", `Välj ${c.name}`);
  }
  $("#vs-count").textContent = `${picked.size} ${picked.size === 1 ? "vald" : "valda"}`;
  $("#vs-delete").disabled = !picked.size;
  $("#vs-all").textContent = found.length && picked.size === found.length ? "Avmarkera alla" : "Välj alla";
}
function setSelecting(on) {
  selecting = on;
  picked.clear();
  $("#vault-select").textContent = on ? "Avbryt" : "Välj";
  $("#vault-select").setAttribute("aria-pressed", String(on));
  $("#vault-selbar").hidden = !on;
  $("#prices").classList.toggle("selecting", on);
  if (found.length) applyView();
}

async function showVault() {
  const my = ++searchId;
  vaultDirty = false;
  paintGameSeg();
  paintBackup();
  $("#prices").innerHTML = skeleton(6);
  $("#more").hidden = true;
  const v = loadVault();
  try {
    const games = [...new Set(v.map((x) => x.game))].filter((g) => GAMES[g]);
    const byId = {}, alias = {};
    // Pokémonkorten hämtas ett och ett från TCGdex. Ett kort som inte går att hämta just nu visas inte, men ligger kvar.
    const pk = await Promise.all(v.filter((x) => x.game === "pokemon").map((x) => pokemonCard(x.id).catch(() => null)));
    for (const c of pk) if (c) byId[`pokemon:${c.id}`] = c;
    for (const [g, d] of await Promise.all(games.map(async (g) => [g, await gameCards(g)]))) {
      for (const c of d.cards) byId[`${g}:${c.id}`] = c;
      for (const [a, c] of d.alias) alias[`${g}:${a}`] = c;
    }
    if (my !== searchId) return;
    // Kort som bytt id sedan de lades in (se tcgAlias) flyttas till sitt nya id, och slås ihop om kortet redan finns
    const moved = v.filter((x) => !byId[`${x.game}:${x.id}`] && alias[`${x.game}:${x.id}`]);
    for (const x of moved) {
      const id = alias[`${x.game}:${x.id}`].id, same = v.find((y) => y !== x && y.game === x.game && y.id === id && !y.f === !x.f);
      if (same) { same.qty += x.qty; same.at = Math.min(same.at ?? x.at, x.at ?? same.at); x.qty = 0; }
      else x.id = id;
    }
    if (moved.length) {
      const keep = v.filter((x) => x.qty > 0);
      v.length = 0;
      v.push(...keep);
      saveVault(v);
    }
    // Foil visas som ett eget kort med foilpriset. orig är kortet som det står i kortfilen.
    found = v.map((x) => {
      const c = byId[`${x.game}:${x.id}`];
      if (!c) return null;
      const e = { ...c, orig: c, qty: x.qty, at: x.at, p: x.p ?? null };
      if (!x.f) return e;
      return { ...e, holo: true, sek: foilSek(c), change: null, avg30: c.game === "pokemon" ? toSek(cmOf(c)["avg30-holo"]) : null };
    }).filter(Boolean);
  } catch {
    $("#prices").innerHTML = '<div class="msg">Kunde inte läsa korten just nu. Försök igen om en stund.</div>';
    return;
  }
  const all = found.length;
  // Släckta spel och sökordet (alla ord i namn, variant, set eller kortnummer, som i sökningen)
  const words = $("#pq").value.toLowerCase().split(/\s+/).filter(Boolean);
  found = found.filter((c) => !vaultOff.has(c.game) && words.every((w) => `${c.name} ${c.variant || ""} ${c.set} ${c.no}`.toLowerCase().includes(w)));
  next = found.length;
  loaded = [];
  // Ett kort som filtrerats bort ska inte kunna tas bort utan att synas
  const shownKeys = new Set(found.map(keyOfTile));
  for (const k of picked) if (!shownKeys.has(k)) picked.delete(k);
  if (selecting) paintPicked();
  // Portföljen räknas på korten som visas. Utvecklingen sedan inläggningen bara för kort med sparat pris.
  const sum = (f) => found.reduce((s, c) => s + f(c) * c.qty, 0);
  const n = sum(() => 1), worth = sum((c) => c.sek || 0);
  const bought = found.filter((c) => c.p != null && c.sek != null);
  const nowB = bought.reduce((s, c) => s + c.sek * c.qty, 0), thenB = bought.reduce((s, c) => s + c.p * c.qty, 0);
  const withAvg = found.filter((c) => c.avg30 != null && c.sek != null);
  const nowA = withAvg.reduce((s, c) => s + c.sek * c.qty, 0), thenA = withAvg.reduce((s, c) => s + c.avg30 * c.qty, 0);
  const top = found.reduce((a, c) => ((c.sek ?? -1) > (a?.sek ?? -1) ? c : a), null);
  $("#vault-stats").innerHTML = n ? `
    <button type="button" class="vs-value" aria-label="Visa valvets värde i en större graf">
      <span><small>Värde</small><b>${kr(worth)}</b><em class="vs-chg"></em></span>
      <span class="vs-spark" aria-hidden="true"></span>
    </button>
    <div><small>Kort</small><b>${n}</b></div>
    <div><small>Dyraste</small><b class="vs-top">${top?.sek != null ? `${esc(top.name)} · ${kr(top.sek)}` : "–"}</b></div>
    <div><small>Sedan inlagt</small><b>${diff(nowB, thenB)}</b></div>
    <div><small>Mot månadssnitt</small><b>${diff(nowA, thenA)}</b></div>` : "";
  if (n) drawValue(found, worth, my);
  $("#vault-clear").hidden = !all;
  $("#vault-tools").hidden = !all;
  if (!all && selecting) setSelecting(false);
  if (!n) {
    current = [];
    $("#prices").innerHTML = all
      ? '<div class="msg">Inga kort i valvet matchar.</div>'
      // Texten i ett eget element: rutan är flex, och annars blir varje fetstilt ord en egen kolumn
      : '<div class="msg"><span>Valvet är tomt. Tryck på <b>Lägg till i valvet</b> för att skanna eller söka fram dina kort.</span></div>';
    return;
  }
  applyView();
}

// ---------- Säkerhetskopia ----------
const when = (t) => new Date(t).toLocaleString("sv-SE", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const cardsText = (n) => `${n} kort`;
let vaultCopies = [];
async function paintBackup() {
  const v = loadVault(), n = cardCount(v), s = backupState(n);
  $("#vb-save").disabled = !n;
  $("#vb-state").textContent = !n ? "Spara en fil med dina kort när du har lagt in några, så kan du få tillbaka dem om något händer."
    : s.at ? `Senast sparad ${when(s.at)}${s.added ? `, ${cardsText(s.added)} tillagda sedan dess` : ""}.`
    : "Spara en fil med dina kort. Då får du tillbaka valvet även om appen tas bort eller du byter telefon.";
  $("#vault-remind").hidden = !backupDue(n);
  $("#vr-text").textContent = s.at ? `Du har lagt till ${cardsText(s.added)} sedan senaste säkerhetskopian.` : `Du har ${cardsText(n)} i valvet men ingen säkerhetskopia än.`;
  vaultCopies = await listCopies();
  $("#vb-copies").hidden = !vaultCopies.length;
  // Valvet är tomt men en kopia finns: det kan ha rensats av misstag
  const last = vaultCopies[0];
  $("#vb-lost").hidden = !!n || !last;
  if (!n && last) $("#vb-lost-text").textContent = `Valvet är tomt, men det finns en kopia från ${when(last.at)} med ${cardsText(last.count)}.`;
}
function backupMessage(text) {
  $("#vb-msg").textContent = text;
  $("#vb-msg").hidden = !text;
}
async function saveBackup() {
  const v = loadVault(), file = backupFile(v);
  const saved = await saveFile(file);
  if (!saved) return;
  markSaved();
  backupMessage(`Sparat som ${file.name}. Lägg gärna filen i iCloud eller Google Drive, så överlever den även en ny telefon.`);
  paintBackup();
}
// Frågar hur korten ska återställas. Läget innan sparas som kopia, så att återställningen går att ångra.
let restoring = [];
function askRestore(cards, from) {
  const have = cardCount(loadVault());
  restoring = cards;
  $("#vr-title").textContent = have ? "Återställ valvet?" : "Återställ korten?";
  $("#vr-info").textContent = `${from} innehåller ${cardsText(cardCount(cards))}.${have ? ` Du har ${cardsText(have)} i valvet nu. Lägg ihop behåller alla kort, och finns ett kort i båda används det högsta antalet.` : ""}`;
  $("#vr-replace").hidden = !have;
  $("#vr-merge").textContent = have ? "Lägg ihop" : "Återställ";
  const d = $("#vault-restore");
  d.returnValue = "";
  d.showModal();
}
async function restoreVault(how) {
  const now = loadVault(), next = how === "replace" ? restoring : mergeCards(now, restoring);
  clearTimeout(copyTimer);
  await saveCopy(now);
  saveVault(next);
  backupMessage(`Klart. Valvet har nu ${cardsText(cardCount(next))}.`);
  showVault();
}

$("#rb-scan").addEventListener("click", () => scanCards());
if (VAULT_PAGE) {
  saveCopy(loadVault());
  $("#vb-save").addEventListener("click", saveBackup);
  $("#vr-save").addEventListener("click", saveBackup);
  $("#vr-later").addEventListener("click", () => { snooze(cardCount(loadVault())); paintBackup(); });
  $("#vb-open").addEventListener("click", () => $("#vb-file").click());
  $("#vb-file").addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const { cards, saved } = parseBackup(await file.text());
      if (!cards.length) return backupMessage("Säkerhetskopian är tom.");
      backupMessage("");
      askRestore(cards, saved ? `Säkerhetskopian från ${when(saved)}` : "Säkerhetskopian");
    } catch (err) { backupMessage(err.message); }
  });
  $("#vault-restore").addEventListener("close", () => {
    const how = $("#vault-restore").returnValue;
    if (how === "merge" || how === "replace") restoreVault(how);
  });
  $("#vault-restore").addEventListener("click", (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  $("#vb-lost-btn").addEventListener("click", () => {
    const c = vaultCopies[0];
    if (c) askRestore(c.cards, `Kopian från ${when(c.at)}`);
  });
  // Tidigare versioner: de automatiska kopiorna, nyaste först
  const copies = $("#vault-copies");
  $("#vb-copies").addEventListener("click", () => {
    copies.querySelector("ul").innerHTML = vaultCopies.map((c, i) => `<li><button type="button" class="btn small" data-copy="${i}"><span>${esc(when(c.at))}</span><b>${esc(cardsText(c.count))}</b></button></li>`).join("");
    copies.showModal();
  });
  copies.addEventListener("click", (e) => {
    const b = e.target.closest("[data-copy]");
    if (b) {
      const c = vaultCopies[+b.dataset.copy];
      copies.close();
      askRestore(c.cards, `Kopian från ${when(c.at)}`);
    } else if (e.target === copies || e.target.closest(".cm-close")) copies.close();
  });
  $("#pq").placeholder = "Sök i ditt valv";
  // Sökrutan står utanför formuläret, i verktygsraden ovanför korten: valvet filtreras medan man skriver
  let typing = 0;
  $("#pq").addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(showVault, 200); });
  $("#pq").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(typing); showVault(); } });
  // Lägg till i valvet: en meny med Skanna kort och Sök och lägg till
  const addBtn = $("#vault-add"), addMenu = $("#vault-add-menu");
  const showMenu = (on) => { addMenu.hidden = !on; addBtn.setAttribute("aria-expanded", String(on)); };
  addBtn.addEventListener("click", () => {
    showMenu(addMenu.hidden);
    if (!addMenu.hidden) addMenu.querySelector("button").focus();
  });
  addMenu.addEventListener("click", (e) => {
    const b = e.target.closest("[data-add]");
    if (!b) return;
    showMenu(false);
    scanCards("vault", { manual: b.dataset.add === "manual" });
  });
  document.addEventListener("click", (e) => { if (!addMenu.hidden && !e.target.closest(".vault-add")) showMenu(false); });
  addMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { showMenu(false); addBtn.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = [...addMenu.querySelectorAll("button")], i = items.indexOf(document.activeElement);
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length].focus();
    }
  });
  const vaultConfirm = $("#vault-confirm");
  $("#vault-clear").addEventListener("click", () => {
    vaultConfirm.returnValue = "";
    vaultConfirm.showModal();
  });
  vaultConfirm.addEventListener("close", () => {
    if (vaultConfirm.returnValue !== "ok") return;
    clearTimeout(copyTimer);
    saveCopy(loadVault()).then(() => { saveVault([]); showVault(); });
  });
  // Klick utanför rutan avbryter
  vaultConfirm.addEventListener("click", (e) => { if (e.target === vaultConfirm) vaultConfirm.close(); });
  // Väljläget: markera flera kort och ta bort dem med papperskorgen
  const vaultDelete = $("#vault-delete");
  $("#vault-select").addEventListener("click", () => setSelecting(!selecting));
  $("#vs-all").addEventListener("click", () => {
    const all = picked.size === found.length;
    picked.clear();
    if (!all) for (const c of found) picked.add(keyOfTile(c));
    paintPicked();
  });
  $("#vs-delete").addEventListener("click", () => {
    const n = found.filter((c) => picked.has(keyOfTile(c))).reduce((s, c) => s + c.qty, 0);
    $("#vd-title").textContent = `Ta bort ${n} kort?`;
    vaultDelete.returnValue = "";
    vaultDelete.showModal();
  });
  vaultDelete.addEventListener("click", (e) => {
    if (e.target === vaultDelete) return vaultDelete.close();
    if (!e.target.closest('[value="ok"]')) return;
    clearTimeout(copyTimer);
    const gone = new Set(picked);
    saveCopy(loadVault()).then(() => {
      saveVault(loadVault().filter((x) => !gone.has(pickKey(x.game, x.id, x.f))));
      setSelecting(false);
      showVault();
    });
  });
  // Värderutan öppnar valvets värde i en stor graf, med knappar för perioden
  const chart = $("#vault-chart");
  $("#vault-stats").addEventListener("click", (e) => {
    if (!e.target.closest(".vs-value") || valuePts.length < 2) return;
    mountSeries(chart.querySelector(".pchart"), valuePts, {
      title: "Valvets värde",
      note: "Värdet räknas med dagens antal kort och priserna vi sparat varje dag (i kronor: Cardmarkets trendpris för Pokémon, TCGplayers marknadspris för One Piece och Riftbound).",
    });
    chart.showModal();
  });
  chart.addEventListener("click", (e) => { if (e.target === chart || e.target.closest(".cm-close")) chart.close(); });
}
// Knapparna i den stora vyn: lägg till ett exemplar eller ta bort ett. Finns kortet som foil får vanlig och foil
// var sin rad med sitt pris, och i valvet kan kortet som visas byta slag (shown: kortet i valvet).
const vaultActions = (c, shown = null) => {
  const fs = foilSek(c);
  const buttons = (f, label) => {
    const q = vaultQty(c, f);
    return `<button type="button" class="btn primary small" data-vault="1" data-f="${+f}">+ ${label}${q ? ` (${q})` : ""}</button>
    ${q ? `<button type="button" class="btn small cm-vault-minus" data-vault="-1" data-f="${+f}" aria-label="Ta bort ett ${f ? esc(foilLabel(c)) : "vanligt"} ur valvet">−</button>` : ""}`;
  };
  if (fs == null) return `<div class="cm-vault">${buttons(false, "Lägg i valvet")}</div>`;
  // Knappen säger vad den gör ("Lägg vanlig i valvet"), och priset för just det slaget står bredvid
  const row = (f, label, price) => `<div class="cm-vault-row">${buttons(f, `Lägg ${label.toLowerCase()} i valvet`)}<span class="cm-vault-price">${price != null ? kr(price) : "–"}</span></div>`;
  const from = !!shown?.holo, swap = VAULT_PAGE && shown?.orig && vaultQty(c, from)
    ? `<button type="button" class="cm-vault-swap" data-swap="${+!from}">Markera ett som ${from ? esc(plainLabel(c).toLowerCase()) : esc(foilLabel(c))}</button>` : "";
  return `<div class="cm-vault two">${row(false, plainLabel(c), sekOf(c))}${row(true, esc(foilLabel(c)), fs)}${swap}</div>`;
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
  c.game ??= "pokemon"; // trendlistornas kort saknar spel, som valvet behöver
  const full = c.full || (await getJSON(`${apiFor(c.lang)}/cards/${encodeURIComponent(c.id)}`).catch(() => null)) || {};
  if (shownIndex !== i) return;
  await getRates();
  if (full.id) (c.orig || c).full ||= full; // foilpriset till valvets knappar
  const ja = c.lang === "ja";
  const cm = full.pricing?.cardmarket || {};
  // "Senast sökta" hämtar korten från den engelska databasen, så japanska kort sparas inte där.
  if (!ja) recordCard({ id: c.id, name: c.name, set: full.set?.name, localId: full.localId || c.localId, total: full.set?.cardCount?.official, image: c.image || full.image, eur: cm.trend ?? cm.avg ?? null });
  track("card_view", [full.name || c.name, full.set?.name].filter(Boolean).join(" · "), c.eur != null && rates?.EUR ? Math.round(c.eur * rates.EUR) : null);
  const fin = finish({ ...c, variants: full.variants });
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
      <div class="cm-price">${c.holo ? (c.sek != null ? `${kr(c.sek)} <small class="cname-ja">${esc(foilLabel(c))}</small>` : "Inget pris ännu") : c.eur != null ? sek(c.eur) : "Inget pris ännu"} ${change(c.change)}</div>
      <p class="muted">Cardmarkets trendpris i kronor. Vägledande, uppdateras dagligen.</p>
      <div class="pchart"></div>
      ${cardmarketTable(full, sek)}
      ${tcgplayerTable(full, sek)}
      <div class="cm-links">
        ${ja || !VAULT_PAGE ? "" : vaultActions(c.orig || c, c)}
        <a class="btn${ja ? " primary" : ""} small" href="https://www.cardmarket.com/en/Pokemon/Products/Search?searchString=${encodeURIComponent(ja ? c.en || full.name : full.name || c.name)}" target="_blank" rel="noopener">Cardmarket ↗</a>
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
      <div class="cm-price">${c.sek != null ? kr(c.sek) : "Inget pris ännu"}${c.holo ? ` <small class="cname-ja">${esc(foilLabel(c))}</small>` : ""} ${change(c.change)}</div>
      <p class="muted">TCGplayers marknadspris i kronor. Vägledande, uppdateras dagligen.</p>
      <div class="pchart"></div>
      ${c.sek != null || c.low != null ? `<h3>TCGplayer (USA)</h3><table class="cm-table">${row("Marknadspris", c.sek)}${row("Foil", c.foil)}${row("Lägsta i lager", c.low)}</table>` : ""}
      <div class="cm-links">
        ${VAULT_PAGE ? vaultActions(c.orig || c, c) : ""}
        <a class="btn small" href="${esc(g.cardmarket(c))}" target="_blank" rel="noopener">Cardmarket ↗</a>
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
  const vb = e.target.closest("[data-vault]"), sw = e.target.closest("[data-swap]");
  if (vb || sw) {
    const shown = current[shownIndex], c = shown.orig || shown;
    if (vb) changeVault(c, +vb.dataset.vault, vb.dataset.f === "1");
    else moveVault(c, sw.dataset.swap === "1");
    vaultDirty = true;
    modal.querySelector(".cm-vault").outerHTML = vaultActions(c, shown);
  }
  if (e.target.closest(".prev")) openCard(shownIndex - 1);
  if (e.target.closest(".next")) openCard(shownIndex + 1);
});
// Ändrades valvet medan det visades ritas det om när den stora vyn stängs
modal.addEventListener("close", () => {
  if (VAULT_PAGE && vaultDirty) showVault();
  if (backToScan) { backToScan = false; scanCards("vault"); }
});
modal.addEventListener("keydown", (e) => {
  if (e.key === "ArrowLeft" && shownIndex > 0) openCard(shownIndex - 1);
  if (e.key === "ArrowRight" && shownIndex < current.length - 1) openCard(shownIndex + 1);
});
document.addEventListener("click", (e) => {
  const t = e.target.closest(".ctile");
  if (!t) return;
  if (!selecting) return openCard(+t.dataset.i);
  const k = keyOfTile(current[+t.dataset.i]);
  picked.has(k) ? picked.delete(k) : picked.add(k);
  paintPicked();
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
  if (!b) return;
  // I valvet släcker eller tänder knappen spelet i stället för att byta spel
  if (VAULT_PAGE) {
    const g = b.dataset.game;
    vaultOff.has(g) ? vaultOff.delete(g) : vaultOff.add(g);
    return showVault();
  }
  setGame(b.dataset.game);
});

// Valvsidan visar bara valvet. Kortpriser: filtren, spelet och sökningen eller startvyn.
if (VAULT_PAGE) showVault();
else {
  mountRecent($("#recent"), { eyebrow: "Nyligen sökta", title: "Senast sökta kort", hint: "Korten du senast öppnat. Sparas bara i den här webbläsaren." });
  await fillFilters();
  await applyGame();
  const p = new URLSearchParams(location.search);
  for (const [k, id] of [["q", "#pq"], ["lang", "#lang"], ["rarity", "#rarity"], ["set", "#set"], ["sort", "#sort"]]) if (p.get(k) && !(k === "lang" && prebuilt())) $(id).value = p.get(k);
  // Gamla länkar till valvet i Kortpriser (?vault=1) leder till valvsidan
  if (p.has("vault")) location.replace("valv.html");
  else if (p.get("q") || p.get("rarity") || p.get("set")) search(); else landing();
}
