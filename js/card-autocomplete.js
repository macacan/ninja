// Live-sökning och automatisk textkomplettering (ghost text) för Pokémon-kort.
// Förstår direkt vad du menar (t.ex. "cha" -> "Charizard", "pikachu 37" -> kort #37, "pikachui 037" -> Pikachu #037).

let dataPromise = null;
let cachedData = null;
let cachedTrends = null;

export async function loadDataset() {
  if (cachedData) return cachedData;
  if (!dataPromise) {
    dataPromise = Promise.all([
      fetch("data/pokemon-names.json").then((r) => r.json()).catch(() => ({ pokemon: [], popularCards: [] })),
      fetch("data/card-trends.json").then((r) => r.json()).catch(() => null),
    ]).then(([names, trends]) => {
      cachedData = names;
      cachedTrends = trends;
      return cachedData;
    });
  }
  return dataPromise;
}

function editDist(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) d[i][0] = i;
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
    }
  }
  return d[m][n];
}

const norm = (s) => String(s || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]/g, "");

export function resolvePokemonName(raw, data) {
  if (!raw) return null;
  const q = raw.toLowerCase().trim().replace(/\s+/g, " ");
  if (!q) return null;
  const nq = norm(q);
  const pokemonList = data?.pokemon || [];

  // 1. Exakt normaliserad matchning (t.ex. "flabebe" -> "Flabébé", "farfetchd" -> "Farfetch'd", "mr mime" -> "Mr. Mime")
  const exact = pokemonList.find((p) => norm(p.name) === nq);
  if (exact) return exact.name;

  // Flera ord ("charizard ex", "dark raichu", "mega gengar"): rätta bara ord som är ett Pokémon-namn
  // och behåll resten. Annars skulle "charizard ex" bli bara "Charizard" och orden efter mellanslaget försvinna.
  if (q.includes(" ")) {
    return q.split(" ").map((w) => {
      if (w.length < 4) return w;
      const hit = pokemonList.find((p) => norm(p.name) === norm(w));
      if (hit) return hit.name;
      if (w.length < 5) return w;
      let best = null, minD = 2;
      for (const p of pokemonList) {
        const d = editDist(norm(p.name), norm(w));
        if (d < minD) { minD = d; best = p; }
      }
      return best ? best.name : w;
    }).join(" ");
  }

  // 2. Börjar med
  const starts = pokemonList.filter((p) => p.name.toLowerCase().startsWith(q) || norm(p.name).startsWith(nq));
  if (starts.length) return starts.sort((a, b) => (b.score || 0) - (a.score || 0))[0].name;

  // 3. Innehåller
  const contains = pokemonList.filter((p) => p.name.toLowerCase().includes(q) || norm(p.name).includes(nq));
  if (contains.length) return contains.sort((a, b) => (b.score || 0) - (a.score || 0))[0].name;

  // 4. Stavfelstolerans (t.ex. "pikachui", "charzard")
  let best = null, minD = 3;
  for (const p of pokemonList) {
    const low = p.name.toLowerCase();
    const d = Math.min(editDist(low, q), editDist(norm(p.name), nq));
    if (d < minD) {
      minD = d;
      best = p;
    }
  }
  return best ? best.name : raw;
}

const cardMatchCache = new Map();
const API = "https://api.tcgdex.net/v2/en";

// Kortnummer jämförs utan inledande nollor: 4, 04 och 004 är samma kort, liksom TG4 och TG04.
const numKey = (s) => String(s ?? "").trim().toLowerCase().replace(/^#/, "").replace(/^([a-z]*)0+(?=\d)/, "$1");
export const sameNumber = (localId, num) => numKey(localId) === numKey(num);
// TCGdex söker på delar av numret (localId=4 ger även 14, 40 och 284), så vi frågar med numret
// utan nollor, vilket ger alla varianter, och filtrerar fram exakt nummer själva.
export const apiNumber = (num) => numKey(num) || String(num ?? "");

// Antal kort per set, för att tolka "004/123": bara set med 123 kort är aktuella.
let setSizes = null;
function loadSetSizes() {
  setSizes ??= fetch(`${API}/sets`).then((r) => (r.ok ? r.json() : [])).then((l) => new Map(l.map((x) => [x.id, x.cardCount || {}]))).catch(() => new Map());
  return setSizes;
}

// Behåller bara kort med exakt det numret. Med setTotal ("004/123") väljs i första hand kort ur set med så många kort.
export async function filterByNumber(list, num, setTotal = null) {
  let hits = (Array.isArray(list) ? list : []).filter((c) => sameNumber(c.localId, num));
  if (setTotal && hits.length > 1) {
    const sizes = await loadSetSizes(), t = +setTotal;
    const inSet = hits.filter((c) => {
      const size = sizes.get(String(c.id).slice(0, String(c.id).lastIndexOf("-")));
      return size && (size.official === t || size.total === t);
    });
    if (inSet.length) hits = inSet;
  }
  return hits;
}

/**
 * Hitta matchande kort i cachedTrends (0 ms) eller asynkront från TCGdex API.
 */
export async function lookupCardMatch(namePart, numPart, trends, setTotal = null) {
  const cleanNum = numKey(numPart);
  const cleanName = String(namePart || "").trim();
  const cacheKey = `${cleanName}::${cleanNum}::${setTotal || ""}`.toLowerCase();

  if (cardMatchCache.has(cacheKey)) {
    return cardMatchCache.get(cacheKey);
  }

  // 1. Kolla först i trendkort (0 ms direkt från minnet)
  if (trends && !setTotal) {
    const allTrends = [...(trends.rising || []), ...(trends.top || []), ...(trends.falling || [])];
    const trendHit = allTrends.find((c) => {
      if (!sameNumber(c.localId, numPart)) return false;
      if (!cleanName) return true;
      const lowName = (c.name || "").toLowerCase();
      return lowName.includes(cleanName.toLowerCase()) || cleanName.toLowerCase().includes(lowName);
    });
    if (trendHit && trendHit.image) {
      const res = [{ id: trendHit.id, localId: trendHit.localId, name: trendHit.name, image: trendHit.image, set: trendHit.set, rarity: trendHit.rarity, eur: trendHit.eur }];
      cardMatchCache.set(cacheKey, res);
      return res;
    }
  }

  // 2. Anropa TCGdex API och filtrera fram exakt nummer
  // Nätverksfel och serverfel cachas inte som "inga träffar", så att nästa sökning försöker igen.
  let failed = false;
  const get = (p) => fetch(`${API}/cards?${new URLSearchParams(p)}`)
    .then((r) => (r.ok ? r.json() : (r.status !== 404 && (failed = true), [])))
    .catch(() => ((failed = true), []));
  const SUFFIX = /\s+(?:ex|gx|v|vmax|vstar|mega|radiant|gold|star|prime)$/i;
  try {
    let list = [];
    if (cleanName && cleanNum) {
      list = await filterByNumber(await get({ name: cleanName, localId: apiNumber(numPart) }), numPart, setTotal);
      // Namnet slutar på t.ex. "ex" eller "vmax": prova även basnamnet
      if (!list.length && SUFFIX.test(cleanName)) {
        list = await filterByNumber(await get({ name: cleanName.replace(SUFFIX, "").trim(), localId: apiNumber(numPart) }), numPart, setTotal);
      }
    } else if (cleanNum) {
      list = await filterByNumber(await get({ localId: apiNumber(numPart) }), numPart, setTotal);
    } else if (cleanName) {
      list = await get({ name: cleanName });
    }
    if (Array.isArray(list) && list.length) {
      list.sort((x, y) => (y.image ? 1 : 0) - (x.image ? 1 : 0));
      cardMatchCache.set(cacheKey, list);
      return list;
    }
  } catch { failed = true; }

  if (!failed) cardMatchCache.set(cacheKey, []);
  return [];
}

/**
 * Delar upp en sökfras i namn och eventuellt kortnummer.
 * Exempel:
 * - "pikachu 37"       -> { textPart: "pikachu", numPart: "37", isNumOnly: false }
 * - "pikachu ex 219"   -> { textPart: "pikachu ex", numPart: "219", isNumOnly: false }
 * - "pikachu 219/191"  -> { textPart: "pikachu", numPart: "219", setTotal: "191", isNumOnly: false }
 * - "sv08-219"         -> { textPart: "sv08", numPart: "219", isCardId: true, isNumOnly: false }
 * - "037"              -> { textPart: "", numPart: "037", isNumOnly: true }
 * - "#37"              -> { textPart: "", numPart: "37", isNumOnly: true }
 * - "charizard 4"      -> { textPart: "charizard", numPart: "4", isNumOnly: false }
 * - "charizard"        -> { textPart: "charizard", numPart: null, isNumOnly: false }
 */
export function parseCardQuery(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { textPart: "", numPart: null, isNumOnly: false, raw: "" };

  // 1. Fraktion t.ex. "219/191" eller "Pikachu 219/191" eller "#219/191"
  const fractionMatch = trimmed.match(/^(.*?)(?:[#\s]+)?([a-z]{0,3}\d{1,4}[a-z]?)\s*\/\s*(\d{1,4})$/i);
  if (fractionMatch && /\d/.test(fractionMatch[2])) {
    return {
      textPart: fractionMatch[1].trim(),
      numPart: fractionMatch[2].trim(),
      setTotal: fractionMatch[3].trim(),
      isNumOnly: !fractionMatch[1].trim(),
      raw: trimmed,
    };
  }

  // 2. Set-ID med bindestreck t.ex. "sv08-219", "sv03.5-199", "swsh7-215"
  const cardIdMatch = trimmed.match(/^([a-z]{2,5}\d{0,2}(?:\.\d)?)-([a-z0-9]{1,4})$/i);
  if (cardIdMatch) {
    return {
      textPart: cardIdMatch[1],
      numPart: cardIdMatch[2],
      isNumOnly: false,
      isCardId: true,
      cardId: trimmed.toLowerCase(),
      raw: trimmed,
    };
  }

  // 3. Enbart nummer (t.ex. "37", "037", "#37", "#037", "TG01")
  const onlyNumMatch = trimmed.match(/^#?([a-z]{0,3}\d{1,4}[a-z]?)$/i);
  if (onlyNumMatch && /\d/.test(onlyNumMatch[1])) {
    return { textPart: "", numPart: onlyNumMatch[1], isNumOnly: true, raw: trimmed };
  }

  // 4. Namn + kortnummer (t.ex. "pikachu 37", "pikachu ex 219", "pika 037", "charizard 4", "mew nr 151")
  const combinedMatch = trimmed.match(/^(.*?)(?:[#\s]+|nr\.?\s*)([a-z]{0,3}\d{1,4}[a-z]?)$/i);
  if (combinedMatch && combinedMatch[1].trim() && /\d/.test(combinedMatch[2])) {
    return {
      textPart: combinedMatch[1].trim(),
      numPart: combinedMatch[2].trim(),
      isNumOnly: false,
      raw: trimmed,
    };
  }

  // 5. Vanlig textsökning
  return { textPart: trimmed, numPart: null, isNumOnly: false, raw: trimmed };
}

// Gör en träffsäker sökning med högsta relevans först
export function findMatches(rawQuery, data, trends) {
  const parsed = parseCardQuery(rawQuery);
  const q = rawQuery.trim().toLowerCase();
  if (!q) return { bestMatch: null, pokemon: [], cards: [], trending: [], parsed };

  const pokemonList = data?.pokemon || [];
  const cardList = data?.popularCards || [];
  const allPokemonNames = new Set(pokemonList.map((p) => p.name.toLowerCase()));

  // ==========================================
  // FALL A: Kortnummer angivet (t.ex. "pikachu 37", "pikachu ex 219" eller "037")
  // ==========================================
  if (parsed.numPart) {
    const cleanNum = numKey(parsed.numPart);
    const cleanName = (parsed.textPart || "").trim();
    const resolvedPoke = cleanName ? (resolvePokemonName(cleanName, data) || cleanName) : null;
    const cacheKey = `${cleanName}::${cleanNum}::${parsed.setTotal || ""}`.toLowerCase();
    const cachedCardList = cardMatchCache.get(cacheKey);

    let bestMatch = null;
    const pokemonMatches = [];

    // 1. Har vi redan kortet cachat från tidigare sökning/API-anrop?
    if (cachedCardList && cachedCardList.length > 0) {
      const topC = cachedCardList[0];
      bestMatch = `${topC.name} ${topC.localId || parsed.numPart}`;
      pokemonMatches.push({
        name: `${topC.name} #${topC.localId || parsed.numPart}`,
        val: `${topC.name} ${topC.localId || parsed.numPart}`,
        sub: `Kort #${topC.localId || parsed.numPart} · ${topC.set || resolvedPoke || topC.name}`,
        image: topC.image,
        cardId: topC.id,
        isExactCard: true,
        isSingleMatch: cachedCardList.length === 1,
      });

      if (resolvedPoke && resolvedPoke.toLowerCase() !== topC.name.toLowerCase()) {
        pokemonMatches.push({
          name: resolvedPoke,
          val: resolvedPoke,
          sub: `Alla kort för ${resolvedPoke}`,
        });
      }
    } else {
      // 2. Kolla om kortet finns i trends (0 ms)
      let trendHit = null;
      if (trends) {
        const allTrendCards = [...(trends.rising || []), ...(trends.top || []), ...(trends.falling || [])];
        trendHit = allTrendCards.find((c) => {
          const matchesNum = sameNumber(c.localId, parsed.numPart);
          if (!matchesNum) return false;
          if (!cleanName) return true;
          const low = (c.name || "").toLowerCase();
          return low.includes(cleanName.toLowerCase()) || cleanName.toLowerCase().includes(low);
        });
      }

      if (trendHit && trendHit.image) {
        bestMatch = `${trendHit.name} ${trendHit.localId}`;
        pokemonMatches.push({
          name: `${trendHit.name} #${trendHit.localId}`,
          val: `${trendHit.name} ${trendHit.localId}`,
          sub: `${trendHit.set ? `${trendHit.set} · ` : ""}Kort #${trendHit.localId}`,
          image: trendHit.image,
          cardId: trendHit.id,
          isExactCard: true,
          isSingleMatch: true,
        });
        if (resolvedPoke) {
          pokemonMatches.push({
            name: resolvedPoke,
            val: resolvedPoke,
            sub: `Alla kort för ${resolvedPoke}`,
          });
        }
      } else if (resolvedPoke) {
        bestMatch = `${resolvedPoke} ${parsed.numPart}`;
        pokemonMatches.push({
          name: `${resolvedPoke} #${parsed.numPart}`,
          val: `${resolvedPoke} ${parsed.numPart}`,
          sub: `Kort #${parsed.numPart} · ${resolvedPoke}`,
          isExactCard: true,
          isLoadingCard: true,
        });
        pokemonMatches.push({
          name: resolvedPoke,
          val: resolvedPoke,
          sub: `Alla kort för ${resolvedPoke}`,
        });
      } else if (parsed.isNumOnly) {
        bestMatch = `#${parsed.numPart}`;
        pokemonMatches.push({
          name: `Kortnummer #${parsed.numPart}`,
          val: parsed.numPart,
          sub: `Sök bland alla set efter kort #${parsed.numPart}`,
          isExactCard: true,
          isLoadingCard: true,
        });
      }
    }

    // Hitta matchande trendande kort med detta kortnummer
    const trending = [];
    if (trends) {
      const allTrendCards = [...(trends.rising || []), ...(trends.top || []), ...(trends.falling || [])];
      for (const c of allTrendCards) {
        const matchesNum = sameNumber(c.localId, parsed.numPart);
        const matchesName = !resolvedPoke || (c.name || "").toLowerCase().includes(resolvedPoke.toLowerCase());
        if (matchesNum && matchesName) {
          trending.push(c);
          if (trending.length >= 3) break;
        }
      }
    }

    // Kortvarianter som matchar Pokémonen
    const cards = [];
    if (resolvedPoke) {
      const lowPoke = resolvedPoke.toLowerCase();
      for (const c of cardList) {
        const low = c.name.toLowerCase();
        if (allPokemonNames.has(low)) continue;
        if (low.startsWith(lowPoke) || low.includes(lowPoke)) {
          cards.push(c);
          if (cards.length >= 3) break;
        }
      }
    }

    return {
      bestMatch,
      pokemon: pokemonMatches,
      cards,
      trending,
      parsed,
    };
  }

  // ==========================================
  // FALL B: Vanlig textsökning på namn
  // ==========================================
  const pPrefix = [];
  const pContains = [];

  for (const p of pokemonList) {
    const low = p.name.toLowerCase();
    if (low.startsWith(q)) {
      pPrefix.push(p);
    } else if (low.includes(q)) {
      pContains.push(p);
    }
  }

  pPrefix.sort((a, b) => (b.score || 0) - (a.score || 0));
  pContains.sort((a, b) => (b.score || 0) - (a.score || 0));

  // Stavfelstolerans om inget prefix matchade
  let typoMatch = null;
  if (!pPrefix.length && q.length >= 3) {
    const resolved = resolvePokemonName(q, data);
    if (resolved && resolved.toLowerCase() !== q) {
      typoMatch = pokemonList.find((p) => p.name.toLowerCase() === resolved.toLowerCase());
    }
  }

  const pokemonMatches = typoMatch
    ? [typoMatch, ...pPrefix, ...pContains].slice(0, 6)
    : [...pPrefix, ...pContains.slice(0, 3)].slice(0, 6);

  const bestMatch = pPrefix[0]?.name || typoMatch?.name || (pContains[0] && q.length >= 3 ? pContains[0].name : null);

  // Populära kortnamn
  const cards = [];
  const startsWith = [];
  const containsBest = [];
  const otherContains = [];
  const bestLow = bestMatch?.toLowerCase();

  for (const c of cardList) {
    const low = c.name.toLowerCase();
    if (allPokemonNames.has(low)) continue;

    if (low.startsWith(q)) {
      startsWith.push(c);
    } else if (bestLow && low.includes(bestLow)) {
      containsBest.push(c);
    } else if (low.includes(q)) {
      otherContains.push(c);
    }
  }

  const sortedCards = [...startsWith, ...containsBest, ...otherContains];
  for (const c of sortedCards) {
    if (cards.length >= 4) break;
    cards.push(c);
  }

  // Trendande kort
  const trending = [];
  if (trends) {
    const allTrendCards = [...(trends.rising || []), ...(trends.top || []), ...(trends.falling || [])];
    const seenIds = new Set();
    for (const c of allTrendCards) {
      if (seenIds.has(c.id)) continue;
      const low = (c.name || "").toLowerCase();
      if (low.startsWith(q) || (bestLow && low.includes(bestLow)) || low.includes(q)) {
        seenIds.add(c.id);
        trending.push(c);
        if (trending.length >= 2) break;
      }
    }
  }

  // Flera ord (t.ex. "dark raichu"): matcha orden var för sig, så att kortnamn som inte står
  // i listan över populära kort ändå får ett förslag.
  const words = q.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    for (const c of cardList) {
      if (cards.length >= 4) break;
      const low = c.name.toLowerCase();
      if (!cards.includes(c) && words.every((w) => low.includes(w))) cards.push(c);
    }
    const hasPoke = pokemonList.some((p) => words.some((w) => w.length >= 3 && p.name.toLowerCase().includes(w)));
    if (!pokemonMatches.length && hasPoke) {
      const title = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
      pokemonMatches.push({ name: title, val: title, sub: "Sök alla kort med det namnet" });
    }
  }

  return {
    bestMatch,
    pokemon: pokemonMatches,
    cards: cards.slice(0, 4),
    trending,
    parsed,
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function highlightMatch(text, query) {
  if (!query) return escapeHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + query.length);
  const after = text.slice(idx + query.length);
  return `${escapeHtml(before)}<mark class="cad-mark">${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

/**
 * Kopplar på live ghost text och smart sökförslag på ett input-element.
 */
export function mountCardAutocomplete(input, options = {}) {
  if (!input || input._cardAutocompleteMounted) return;
  input._cardAutocompleteMounted = true;

  // Ladda data i bakgrunden
  loadDataset();

  // Skapa wrapper runt inputen
  const wrap = document.createElement("div");
  wrap.className = "card-suggest-wrap";
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  input.setAttribute("autocomplete", "off");
  input.setAttribute("spellcheck", "false");
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("aria-autocomplete", "both");
  input.classList.add("card-suggest-input");

  // Ghost text-lager
  const ghost = document.createElement("div");
  ghost.className = "card-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.innerHTML = `<span class="card-ghost-typed"></span><span class="card-ghost-tail"></span>`;
  wrap.appendChild(ghost);

  const ghostTyped = ghost.querySelector(".card-ghost-typed");
  const ghostTail = ghost.querySelector(".card-ghost-tail");

  // Förslags-popup
  const dropdown = document.createElement("div");
  dropdown.className = "card-suggest-dropdown";
  dropdown.hidden = true;
  dropdown.setAttribute("role", "listbox");
  dropdown.setAttribute("aria-label", "Sökförslag");
  wrap.appendChild(dropdown);

  let currentBestMatch = null;
  let activeIndex = -1;
  let items = [];
  let liveSearchTimer = null;

  function clearGhost() {
    currentBestMatch = null;
    ghostTyped.textContent = "";
    ghostTail.textContent = "";
  }

  function setGhost(typed, match) {
    if (!match || !match.toLowerCase().startsWith(typed.toLowerCase()) || typed.length >= match.length) {
      clearGhost();
      return;
    }
    currentBestMatch = match;
    ghostTyped.textContent = typed;
    ghostTail.textContent = match.slice(typed.length);
  }

  function closeDropdown() {
    dropdown.hidden = true;
    activeIndex = -1;
    items = [];
    input.removeAttribute("aria-activedescendant");
  }

  function selectValue(val, cardId) {
    if (!val) return;
    input.value = val;
    clearGhost();
    closeDropdown();
    if (options.onSelect) {
      options.onSelect(val, cardId);
    } else {
      const form = input.closest("form");
      if (form) {
        if (cardId) {
          let hid = form.querySelector('input[name="cardId"]');
          if (!hid) {
            hid = document.createElement("input");
            hid.type = "hidden";
            hid.name = "cardId";
            form.appendChild(hid);
          }
          hid.value = cardId;
        }
        if (typeof form.requestSubmit === "function") {
          form.requestSubmit();
        } else {
          form.submit();
        }
      } else if (options.formAction) {
        location.href = `${options.formAction}?q=${encodeURIComponent(val)}${cardId ? `&id=${encodeURIComponent(cardId)}` : ""}`;
      }
    }
  }

  function acceptGhost() {
    if (currentBestMatch) {
      const topOpt = dropdown.querySelector(".cad-item.is-top");
      const cardId = topOpt ? topOpt.dataset.cardId : null;
      selectValue(currentBestMatch, cardId);
      return true;
    }
    return false;
  }

  const form = input.closest("form");
  if (form) {
    form.addEventListener(
      "submit",
      () => {
        if (currentBestMatch && currentBestMatch.toLowerCase().startsWith(input.value.trim().toLowerCase()) && input.value.trim().length >= 2) {
          input.value = currentBestMatch;
          clearGhost();
          closeDropdown();
        }
      },
      true
    );
  }

  function updateActiveItem() {
    items.forEach((it, idx) => {
      const isAct = idx === activeIndex;
      it.classList.toggle("is-active", isAct);
      it.setAttribute("aria-selected", isAct);
      if (isAct) {
        input.setAttribute("aria-activedescendant", it.id);
        it.scrollIntoView({ block: "nearest" });
      }
    });
    if (activeIndex === -1) {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function renderDropdown(matches, query) {
    const hasPokemon = matches.pokemon.length > 0;
    const hasCards = matches.cards.length > 0;

    if (!hasPokemon && !hasCards) {
      closeDropdown();
      return;
    }

    let html = "";

    if (hasPokemon) {
      const secLabel = matches.parsed?.numPart ? "Kortnummer & träffar" : "Pokémon";
      html += `<div class="cad-sec-title">${secLabel}</div><ul class="cad-list">`;
      matches.pokemon.forEach((p, idx) => {
        const val = p.val || p.name;
        const isTop = idx === 0;
        const num = p.id ? `#${String(p.id).padStart(4, "0")}` : "";
        const tag = p.sub || (isTop ? "Mest eftersökt" : p.id <= 151 ? "Kanto" : "Populär");

        // Visa kortet som en liten bild när ett matchande kort finns
        let actionHtml = "";
        if (p.image) {
          actionHtml = `
            <div class="cad-card-thumb-wrap" title="${escapeHtml(p.name)} (klicka för att välja)">
              <img src="${escapeHtml(p.image)}/low.webp" alt="${escapeHtml(p.name)}" class="cad-card-thumb" loading="eager" decoding="async" onerror="this.parentNode.remove()">
              <i class="cad-card-gloss" aria-hidden="true"></i>
            </div>`;
        } else if (p.isLoadingCard) {
          actionHtml = `
            <div class="cad-card-thumb-wrap is-loading" aria-label="Laddar kortbild…">
              <div class="cad-card-thumb-skel"></div>
            </div>`;
        }

        html += `
          <li role="option" id="cad-opt-${idx}" class="cad-item is-pokemon${isTop ? " is-top" : ""}${p.image ? " has-card-thumb" : ""}" data-val="${escapeHtml(val)}"${p.cardId ? ` data-card-id="${escapeHtml(p.cardId)}"` : ""}>
            <div class="cad-text">
              <span class="cad-name">${highlightMatch(p.name, matches.parsed?.textPart || query)}</span>
              <span class="cad-sub">${num ? `${num} · ` : ""}${escapeHtml(tag)}</span>
            </div>
            ${actionHtml}
          </li>`;
      });
      html += `</ul>`;
    }

    if (hasCards) {
      html += `<div class="cad-sec-title">Kortvarianter</div><ul class="cad-list">`;
      matches.cards.forEach((c, idx) => {
        const optId = `cad-opt-c${idx}`;
        // Kolla om kortvarianten har en bild i trendande kort
        let trendImg = null;
        if (cachedTrends) {
          const allT = [...(cachedTrends.rising || []), ...(cachedTrends.top || []), ...(cachedTrends.falling || [])];
          const hit = allT.find((tc) => (tc.name || "").toLowerCase() === c.name.toLowerCase());
          if (hit?.image) trendImg = hit.image;
        }
        html += `
          <li role="option" id="${optId}" class="cad-item is-card${trendImg ? " has-card-thumb" : ""}" data-val="${escapeHtml(c.name)}">
            <div class="cad-text">
              <span class="cad-name">${highlightMatch(c.name, query)}</span>
              <span class="cad-sub">${c.count ? `${c.count} utgåvor i databasen` : "Samlarkort"}</span>
            </div>
            ${trendImg ? `
              <div class="cad-card-thumb-wrap" title="${escapeHtml(c.name)}">
                <img src="${escapeHtml(trendImg)}/low.webp" alt="${escapeHtml(c.name)}" class="cad-card-thumb" loading="lazy">
                <i class="cad-card-gloss" aria-hidden="true"></i>
              </div>` : `<span class="cad-arrow" aria-hidden="true">→</span>`}
          </li>`;
      });
      html += `</ul>`;
    }

    html += `
      <div class="cad-footer" data-val="${escapeHtml(query)}">
        <span>Sök på "<strong>${escapeHtml(query)}</strong>"</span>
        <kbd>↵ Sök</kbd>
      </div>`;

    dropdown.innerHTML = html;
    dropdown.hidden = false;

    items = Array.from(dropdown.querySelectorAll(".cad-item, .cad-footer"));
    activeIndex = -1;

    items.forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
      });
      item.addEventListener("click", () => {
        const val = item.dataset.val || query;
        const cardId = item.dataset.cardId || null;
        selectValue(val, cardId);
      });
    });
  }

  async function handleInput() {
    const raw = input.value;
    const q = raw.trim();

    if (!q) {
      clearGhost();
      closeDropdown();
      if (options.onLiveChange) {
        clearTimeout(liveSearchTimer);
        options.onLiveChange("");
      }
      return;
    }

    const data = await loadDataset();
    const matches = findMatches(q, data, cachedTrends);

    // Uppdatera ghost text
    if (matches.bestMatch && matches.bestMatch.toLowerCase().startsWith(q.toLowerCase())) {
      setGhost(raw, matches.bestMatch);
    } else {
      clearGhost();
    }

    // Rita dropdown
    renderDropdown(matches, q);

    // Om vi har en kortträff som fortfarande laddar bilden asynkront från TCGdex:
    if (matches.pokemon[0]?.isLoadingCard && matches.parsed?.numPart) {
      const activeQ = q;
      lookupCardMatch(matches.parsed.textPart, matches.parsed.numPart, cachedTrends, matches.parsed.setTotal).then((cards) => {
        if (input.value.trim().toLowerCase() !== activeQ.toLowerCase() || dropdown.hidden) return;
        if (cards && cards.length) {
          const freshMatches = findMatches(input.value.trim(), data, cachedTrends);
          renderDropdown(freshMatches, input.value.trim());
        } else {
          const loader = dropdown.querySelector(".cad-card-thumb-wrap.is-loading");
          if (loader) {
            loader.remove();
          }
        }
      });
    }

    // Live debouncerad callback för live-sökning på sidan
    if (options.onLiveChange) {
      clearTimeout(liveSearchTimer);
      liveSearchTimer = setTimeout(() => {
        options.onLiveChange(input.value.trim());
      }, 350);
    }
  }

  input.addEventListener("input", handleInput);

  input.addEventListener("focus", () => {
    if (input.value.trim()) {
      handleInput();
    }
  });

  input.addEventListener("blur", () => {
    setTimeout(() => {
      clearGhost();
      closeDropdown();
    }, 220);
  });

  input.addEventListener("keydown", (e) => {
    const isDropDownOpen = !dropdown.hidden && items.length > 0;

    // 1. ArrowRight: acceptera ghost text om markören är i slutet
    if (e.key === "ArrowRight") {
      if (input.selectionStart === input.value.length && currentBestMatch) {
        e.preventDefault();
        selectValue(currentBestMatch);
        return;
      }
    }

    // 3. ArrowDown: navigera nedåt i dropdown
    if (e.key === "ArrowDown") {
      if (!isDropDownOpen) {
        handleInput();
        return;
      }
      e.preventDefault();
      activeIndex = (activeIndex + 1) % items.length;
      updateActiveItem();
      return;
    }

    // 4. ArrowUp: navigera uppåt i dropdown
    if (e.key === "ArrowUp") {
      if (!isDropDownOpen) return;
      e.preventDefault();
      activeIndex = (activeIndex - 1 + items.length) % items.length;
      updateActiveItem();
      return;
    }

    // 5. Enter: bekräfta markerat val eller acceptera ghost text
    if (e.key === "Enter") {
      if (isDropDownOpen && activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        selectValue(items[activeIndex].dataset.val, items[activeIndex].dataset.cardId);
        return;
      }
      if (currentBestMatch && currentBestMatch.toLowerCase() !== input.value.trim().toLowerCase()) {
        e.preventDefault();
        const topOpt = dropdown.querySelector(".cad-item.is-top");
        selectValue(currentBestMatch, topOpt?.dataset?.cardId);
        return;
      }
    }

    // 6. Escape: stäng dropdown och rensa ghost text
    if (e.key === "Escape") {
      clearGhost();
      closeDropdown();
    }
  });

  return {
    clearGhost,
    closeDropdown,
    refresh: handleInput,
  };
}
