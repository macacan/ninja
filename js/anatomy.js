// Produkt-anatomi och Pull Rates för Packninja.
// Visar vad boxar innehåller (packs, promokort, tillbehör) och chanser/odds per boosterpaket.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const kr = (n) => (n > 0 && n < 0.5 ? "under 1 kr" : Math.round(n).toLocaleString("sv-SE") + " kr");

let anatomyData = null;
export async function getAnatomyData() {
  if (anatomyData) return anatomyData;
  try {
    const [res, contents] = await Promise.all([
      fetch("data/product-anatomy.json", { cache: "no-cache" }).then((r) => r.json()),
      fetch("data/product-contents.json", { cache: "no-cache" }).then((r) => r.json()).catch(() => null),
    ]);
    anatomyData = res;
    anatomyData.bulbapedia = (contents?.products || []).map((p) => {
      const words = wordsOf(p.title);
      // "Lumiose City Mini Tin Collection" är Bulbapedias namn på serien av tins, butikerna skriver "Mini Tin"
      if (words.has("tin")) words.delete("collection");
      return { ...p, words };
    });
  } catch (err) {
    console.warn("Kunde inte ladda produktanatomi:", err);
    anatomyData = { defaults: {}, specific: {}, bulbapedia: [], pullRates: { packSlots: [], odds: [] } };
  }
  return anatomyData;
}

// ---------- Antal paket från Bulbapedia (data/product-contents.json, se scripts/update-product-contents.mjs) ----------
// Butikernas titlar och Bulbapedias produktnamn skrivs olika ("Booster Display Box" / "Booster Box", "ETB"),
// så båda görs om till samma ord innan de jämförs.
const IGNORE = new Set(["pokemon", "tcg", "the", "and", "of", "a", "an", "with"]);
function wordsOf(s) {
  const t = String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\betb\b/g, "elite trainer box").replace(/\bdisplay\b/g, "box").replace(/\bupc\b/g, "ultra premium collection");
  return new Set((t.match(/[a-z0-9]+/g) || []).filter((w) => !IGNORE.has(w)).map((w) => w.replace(/(?:es|s)$/, "")));
}

// Antal paket som står i butikens titel, t.ex. "(36 boosters)", "18 st", "36-pack".
// Köpgränser som "(max 2 st per kund)" tas bort först, och "Vol 2 Booster Box" är ett serienummer.
// Ett enda paket är inget att räkna per paket på, och fler än 40 är kort ("Deck (65 st)"), inte paket.
const titleCount = (t) => {
  const n = +(t.replace(/\(?\b(?:max|begränsat|limit)\b[^)]*\)?/gi, " ")
    .match(/(?<!\b(?:vol|volume|series|serie|del|nr|no)\.?\s*)\b(\d{1,2})\s*(?:-?\s*packs?\b|st\b|stk\b|boosters?\b|booster ?packs?\b|(?:booster)?paket\b)/i)?.[1] || 0);
  return n >= 2 && n <= 40 ? n : null;
};

// Bulbapedia-produkten vars alla ord finns i butikens titel. Flest ord vinner, så "Paldea Evolved Elite Trainer Box"
// går före "Scarlet & Violet Elite Trainer Box" när båda passar.
function bulbapediaMatch(title, data) {
  const words = wordsOf(title);
  let best = null;
  for (const p of data?.bulbapedia || []) {
    if (best && p.words.size <= best.words.size) continue;
    if (words.has("mini") !== p.words.has("mini")) continue; // mini tins har färre paket än vanliga tins
    let all = true;
    for (const w of p.words) if (!words.has(w)) { all = false; break; }
    if (all) best = p;
  }
  return best;
}

// Antal paket för produkten, eller null om det inte går att säga säkert. options är Bulbapedias varianter
// när de är flera (t.ex. hel display 36 och halv 18) och titeln inte avgör vilken det är.
// Ett antal i butikens titel går före allt annat: det beskriver just den produkten (t.ex. koreanska boxar med 30 paket).
// En hel kartong ("Sealed Case (10 Boxes)") utan antal paket i titeln får inget antal, annars blir priset per paket fel.
const CASE = /\bcase\b|kartong|\(\s*\d+\s*(?:boxes|boxar|etbs?|tins|displays?)\s*\)/i;
function packsFor(title, data) {
  const fromTitle = titleCount(title);
  if (fromTitle) return { packs: fromTitle };
  if (CASE.test(title)) return { packs: null };
  const hit = bulbapediaMatch(title, data);
  if (!hit) return null;
  if (/pok[eé]mon center/i.test(title) && hit.centerPacks) return { packs: hit.centerPacks, hit };
  if (hit.packs.length === 1) return { packs: hit.packs[0], hit };
  if (/\bhal(?:f|v)\b/i.test(title)) return { packs: Math.min(...hit.packs), hit };
  return { packs: null, options: hit.packs, hit };
}

// Matcha en produkt mot antingen en specifik box eller generell typ. Antalet paket kommer i första hand från
// butikens titel och Bulbapedia, och de handskrivna uppgifterna nedan används när ingen av dem vet.
// lang: Bulbapedias uppgifter gäller engelska produkter, så andra språk får bara de handskrivna.
// Tomma lådor och burkar ("Empty Elite Trainer Box (Endast box)", "Mini Tin (Endast tin)") innehåller inga paket
const EMPTY = /\bempty\b|endast (?:box|låda|tin|burk)|\btom (?:box|låda|burk)|only (?:box|tin)/i;

export function matchAnatomy(title = "", type = "", data, lang = "en") {
  if (EMPTY.test(title)) return null;
  // Mini tins (2 paket) och checklane-blister (1 paket) skulle annars få standardvärdet för vanliga tins och blister
  const kind = /mini[- ]?tins?\b/i.test(title) ? "Mini Tin" : type;
  const base = matchHandwritten(title, kind, data);
  if (base && !base.isSpecific && /checklane/i.test(title)) base.packs = 1;
  // Andra språk: bara ett antal som står i titeln. Bulbapedia och standardvärdena gäller engelska produkter,
  // och t.ex. japanska boxar har 30, 20 eller 10 paket beroende på set.
  const known = lang === "en" ? packsFor(title, data) : titleCount(title) ? { packs: titleCount(title) } : { packs: null };
  if (!known) return base;
  return {
    ...(base || { type, isSpecific: true }),
    packs: known.packs,
    packOptions: known.options || null,
    packSource: known.hit ? "Bulbapedia" : known.packs ? "butikens produktnamn" : null,
  };
}

function matchHandwritten(title, type, data) {
  if (!data) return null;
  const t = title.toLowerCase();

  // 1. Kolla specifika boxar först
  for (const [key, spec] of Object.entries(data.specific || {})) {
    const words = key.split(" ");
    if (words.every((w) => t.includes(w))) {
      return { ...spec, isSpecific: true, type };
    }
  }

  // 2. Falla tillbaka på typ-standard
  const def = data.defaults?.[type];
  if (def) {
    return { ...def, isSpecific: false, type };
  }

  // 3. Typkontroll baserat på titel om type saknas/är okänd
  if (/elite trainer box|\betb\b/i.test(t)) return { ...data.defaults["Elite Trainer Box"], isSpecific: false, type: "Elite Trainer Box" };
  if (/booster bundle/i.test(t)) return { ...data.defaults["Booster Bundle"], isSpecific: false, type: "Booster Bundle" };
  if (/booster box|booster display|display box/i.test(t)) return { ...data.defaults["Booster Box"], isSpecific: false, type: "Booster Box" };
  if (/ultra-premium|upc\b/i.test(t)) return { ...data.defaults["Ultra-Premium Collection"], isSpecific: false, type: "Ultra-Premium Collection" };
  if (/premium collection/i.test(t)) return { ...data.defaults["Premium Collection"], isSpecific: false, type: "Premium Collection" };
  if (/collection box|\bex box\b|\bv box\b/i.test(t)) return { ...data.defaults["Collection Box"], isSpecific: false, type: "Collection Box" };
  if (/mini tin/i.test(t)) return { ...data.defaults["Mini Tin"], isSpecific: false, type: "Mini Tin" };
  if (/\btin\b|plåtburk/i.test(t)) return { ...data.defaults["Tin"], isSpecific: false, type: "Tin" };
  if (/3-pack blister|trippelpack/i.test(t)) return { ...data.defaults["Blister"], isSpecific: false, type: "Blister" };
  if (/build & battle/i.test(t)) return { ...data.defaults["Build & Battle"], isSpecific: false, type: "Build & Battle" };

  return null;
}

// Bygg HTML för innehållsmodal (Produkt-Anatomi)
export function renderAnatomyModal(title, anatomy, lowestPrice = null) {
  if (!anatomy) return `<div class="anat-empty"><p>Innehållsinformation saknas för denna produkt.</p></div>`;

  const perPack = (lowestPrice && anatomy.packs) ? Math.round(lowestPrice / anatomy.packs) : null;

  return `<div class="anat-modal-content">
    <div class="anat-head">
      <span class="anat-tag">${esc(anatomy.type || "Förseglad produkt")}</span>
      <h2>${esc(anatomy.title || anatomy.name || title)}</h2>
    </div>

    ${lowestPrice ? `
    <div class="anat-price-banner">
      <div class="ap-item">
        <span class="ap-lbl">Lägsta pris i butik</span>
        <b class="ap-val">${kr(lowestPrice)}</b>
      </div>
      ${anatomy.packs ? `
      <div class="ap-item ap-highlight">
        <span class="ap-lbl">Pris per boosterpaket</span>
        <b class="ap-val ap-gold">${perPack} kr / pack</b>
      </div>
      ` : ""}
      <div class="ap-item">
        <span class="ap-lbl">Antal paket</span>
        <b class="ap-val">📦 ${anatomy.packs ? `${anatomy.packs} st` : anatomy.packOptions ? `${anatomy.packOptions.join(" eller ")} st` : "–"}</b>
      </div>
    </div>
    ` : ""}

    <div class="anat-grid">
      <!-- Paket & Promos -->
      <div class="anat-section">
        <h3><span class="anat-icon">📦</span> Innehåll & Paket</h3>
        <div class="anat-pack-box">
          <div class="anat-pack-count"><b>${anatomy.packs || (anatomy.packOptions ? anatomy.packOptions.join("/") : "–")}</b><span>Boosterpaket</span></div>
          <p class="anat-pack-desc">${anatomy.packSet ? `Från expansionen <b>${esc(anatomy.packSet)}</b>` : "Officiella fabriksförseglade paket med 10 kort per paket"}</p>
          ${anatomy.packOptions && !anatomy.packs ? `<p class="anat-pack-desc">Finns med ${anatomy.packOptions.join(" eller ")} paket. Kolla hos butiken vilken det är.</p>` : ""}
          ${anatomy.packSource === "Bulbapedia" ? `<p class="anat-pack-desc">Antal paket enligt <a href="https://bulbapedia.bulbagarden.net/" target="_blank" rel="noopener">Bulbapedia</a>.</p>` : ""}
        </div>

        ${anatomy.promos && anatomy.promos.length ? `
        <h4 class="anat-sub">Garanterade Promokort (${anatomy.promos.length} st)</h4>
        <ul class="anat-promo-list">
          ${anatomy.promos.map(p => `
            <li>
              <div class="promo-badge">${esc(p.code || "Promo")}</div>
              <div class="promo-info">
                <b>${esc(p.name)}</b>
                ${p.note ? `<small>${esc(p.note)}</small>` : ""}
              </div>
            </li>
          `).join("")}
        </ul>
        ` : anatomy.promoNote ? `
        <div class="anat-note-box">
          <b>Promokort:</b> ${esc(anatomy.promoNote)}
        </div>
        ` : ""}
      </div>

      <!-- Tillbehör -->
      <div class="anat-section">
        <h3><span class="anat-icon">🎲</span> Medföljande Tillbehör</h3>
        <ul class="anat-acc-list">
          ${(anatomy.accessories || []).map(a => `<li><span class="acc-chk">✓</span> ${esc(a)}</li>`).join("")}
        </ul>
      </div>
    </div>

    <div class="anat-footer">
      <button type="button" class="btn small" data-show-odds="true">🎯 Se vinstchanser & pull rates i paketen →</button>
    </div>
  </div>`;
}

// Bygg HTML för Booster-Anatomi & Pull Rates guide
export function renderPullRatesModal(data) {
  const pr = data?.pullRates;
  if (!pr) return "";

  return `<div class="odds-modal-content">
    <div class="odds-head">
      <span class="anat-tag">Officiell Booster Anatomi & Community Odds</span>
      <h2>Vad finns i ett Pokémon-boosterpaket?</h2>
      <p class="muted">Varje modernt boosterpaket (Scarlet & Violet) innehåller exakt 10 spelkort, 1 Basic Energy och 1 kodkort. Så här är platserna fördelade:</p>
    </div>

    <!-- Slot-för-slot fördelning -->
    <div class="odds-slots">
      <h3>Kortens ordning i paketet (12 kort)</h3>
      <div class="slots-flow">
        ${(pr.packSlots || []).map(s => `
          <div class="slot-card slot-${s.cls}">
            <div class="slot-num">${esc(s.slot)}</div>
            <div class="slot-body">
              <b>${esc(s.title)}</b>
              <p>${esc(s.desc)}</p>
              <span class="slot-rate">${esc(s.rate)}</span>
            </div>
          </div>
        `).join("")}
      </div>
    </div>

    <!-- Sannolikheter / Pull rates -->
    <div class="odds-rates-sec">
      <h3>Ungefärliga vinstchanser per paket (Pull Rates)</h3>
      <p class="muted">Baserat på community-öppningar av över 8 000 boosterpaket per set i Scarlet & Violet-eran:</p>
      <div class="rates-grid">
        ${(pr.odds || []).map(o => `
          <div class="rate-card" style="border-top-color:${o.color}">
            <div class="rate-icon">${o.icon}</div>
            <div class="rate-code" style="color:${o.color}">${esc(o.code)}</div>
            <b class="rate-name">${esc(o.name)}</b>
            <div class="rate-stat">
              <span class="rate-odds">${esc(o.odds)}</span>
              <span class="rate-pct" style="background:${o.color}20; color:${o.color}">${esc(o.pct)}</span>
            </div>
            <p class="rate-desc">${esc(o.desc)}</p>
          </div>
        `).join("")}
      </div>
    </div>

    <div class="odds-note">
      <p>⚠️ <b>Viktigt att veta:</b> Pokémon Company publicerar aldrig officiella procentuella vinstchanser. Chanserna ovan är empiriska genomsnitt från stora samlarstudier. Varje enskilt paket är unikt och slumpmässigt.</p>
    </div>
  </div>`;
}
