// Bygger en statisk sida per set i set/<namn>.html och en översikt i set/index.html, så att sökmotorer hittar
// "Phantasmal Flames kortlista", "Delta Reign släppdatum" och liknande. Körs med: node scripts/build-set-pages.mjs
// Läser bara lokala filer (ingen nätverkstrafik), så den kan köras ofta:
//   data/sets/<id>.json           set och kort från TCGdex (scripts/update-sets.mjs)
//   data/card-history/<id>.json   priser i kronor och sällsynthet för de senaste seten (scripts/update-card-trends.mjs)
//   data/release-calendar.json    kommande släpp, även set som TCGdex inte har än
//   data/set-logos.json           loggor för set som TCGdex saknar logga för
//   data/card-images.json         kortbilder som TCGdex saknar (scripts/update-card-images.mjs)
//   data/extra-cards.json         handskrivna kort som TCGdex saknar i setets kortlista (t.ex. Mew RGB Edition)
// Butikernas lager står inte i HTML:en (det ändras hela tiden) utan hämtas live av js/setpage.js.
// Skriver också data/set-pages.json (set-id → adress) så att släppsidan kan länka hit.
import { readFile, writeFile, readdir, mkdir, unlink } from "node:fs/promises";

const SITE = "https://lootninja.se";
const ROOT = new URL("../", import.meta.url);
const OUT_DIR = new URL("set/", ROOT);
const at = (p) => new URL(p, ROOT);
const readJSON = async (p, fallback) => JSON.parse(await readFile(at(p), "utf8").catch(() => "null")) ?? fallback;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const slugify = (s) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/['\u2019]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const MONTH = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti", "september", "oktober", "november", "december"];
const longDate = (s) => { const [y, m, d] = s.split("-").map(Number); return `${d} ${MONTH[m - 1]} ${y}`; };
const kr = (n) => (n < 0.5 ? "under 1 kr" : `${Math.round(n).toLocaleString("sv-SE").replace(/\u00a0/g, " ")} kr`);
const byNumber = (a, b) => String(a.localId).localeCompare(String(b.localId), "sv", { numeric: true });
const LANG = { en: "engelska", ja: "japanska", ko: "koreanska", zh: "kinesiska" };
const today = new Date().toISOString().slice(0, 10);

// ---------- Data ----------
const setFiles = (await readdir(at("data/sets/")).catch(() => [])).filter((f) => f.endsWith(".json"));
const sets = (await Promise.all(setFiles.map((f) => readJSON(`data/sets/${f}`, null)))).filter(Boolean);
const calendar = (await readJSON("data/release-calendar.json", { releases: [] })).releases || [];
const extraLogos = await readJSON("data/set-logos.json", {});
const extraImages = await readJSON("data/card-images.json", {});
const extraCards = await readJSON("data/extra-cards.json", {});
// One Piece- och Riftbound-seten (scripts/update-op-cards.mjs, update-rb-cards.mjs). Varje set får en egen sida
// (set/one-piece-op17-….html, set/riftbound-radiance.html) med alla kort, bilder och priser ur data/<spel>/cards.json.
// Ett kort öppnas i Kortpriser. Kommande släpp i kalendern som inte har några kort än får en släppsida.
const GAMES = [["op", "one-piece", "One Piece Card Game", "One Piece"], ["rb", "riftbound", "Riftbound", "Riftbound"]];
const gameData = Object.fromEntries(await Promise.all(GAMES.map(async ([g]) => [g, await readJSON(`data/${g}/cards.json`, { sets: [], cards: [] })])));
const gameName = Object.fromEntries(GAMES.map(([g, , name]) => [g, name]));
const gameAnchor = Object.fromEntries(GAMES.map(([g, anchor]) => [g, anchor]));

const pages = sets.map((s) => {
  const cards = s.cards || [], known = new Set(cards.map((c) => c.id));
  const extra = (extraCards[s.id] || []).filter((c) => !known.has(c.id)).map((c) => ({ ...c, image: null, extra: true }));
  return { id: s.id, name: s.name, serie: s.serie?.name || null, date: s.releaseDate, cardCount: s.cardCount,
    logo: s.logo || extraLogos[s.id] || null, cards: [...cards, ...extra], language: "en", match: [] };
});
const bySetId = new Map(pages.map((p) => [p.id, p]));
// One Piece- och Riftbound-släppen i kalendern får ingen setsida, precis som seten ovan.
for (const r of calendar.filter((x) => !x.game)) {
  const first = r.waves?.map((w) => w.date).sort()[0] || null;
  const page = r.tcgdex && bySetId.get(r.tcgdex);
  if (page) { page.cal = r; page.match = r.match || []; continue; }
  // Loggan: handskriven i data/releases.json (logo), annars från scripts/update-set-logos.mjs när setet dyker upp där.
  pages.push({ id: null, calId: r.id, name: r.set, serie: r.series || null, date: first, cardCount: null, logo: r.logo || extraLogos[r.id] || null, cards: [],
    language: r.language || "en", match: r.match || [r.set], cal: r, slug: r.id });
}

// One Piece och Riftbound. Adressen börjar med spelet, så att "Legacy" (Riftbound) inte krockar med ett Pokémonset.
const gamePages = [];
for (const [g, prefix] of GAMES) {
  const { sets: gs, cards: gc } = gameData[g];
  for (const s of gs) {
    const cards = gc.filter((c) => c.set === s.id);
    if (!cards.length) continue;
    // Butikerna skriver setkoden på olika sätt ("OP-17", "OP17", "(OP 17)"), och bevakningen använder setets id.
    const match = [...new Set([s.name, s.id, s.code, g === "op" && s.code?.replace(/^([A-Z]+)(\d+)$/, "$1 $2")].filter((x) => x && x.length >= 4))];
    gamePages.push({ game: g, id: s.id, name: s.name, code: s.code, date: s.date, main: s.main, logo: s.image, cards, match,
      slug: slugify(`${prefix} ${g === "op" && s.code ? `${s.code} ` : ""}${s.name.replace(/^riftbound\s+/i, "")}`) });
  }
  // Kommande släpp i kalendern (scripts/update-releases.mjs): kopplas till setet med samma namn, annars en egen släppsida.
  for (const r of calendar.filter((x) => x.game === g)) {
    const page = gamePages.find((p) => p.game === g && p.name.toLowerCase() === r.set.toLowerCase());
    if (page) { page.cal = r; page.match = [...new Set([...page.match, ...(r.match || [])])]; continue; }
    gamePages.push({ game: g, id: null, name: r.set, code: null, date: r.waves?.map((w) => w.date).sort()[0] || null, main: true, logo: r.logo || null,
      cards: [], match: r.match || [r.set], cal: r, slug: slugify(`${prefix} ${r.set}`) });
  }
}
for (const p of gamePages) p.url = `${SITE}/set/${p.slug}.html`;

// Adresser: setets namn. Äldst först, så att ett nytt set med samma namn inte tar över en gammal adress.
const used = new Set(["index"]);
for (const p of [...pages].sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || String(a.id).localeCompare(String(b.id)))) {
  let slug = p.slug || slugify(p.name) || slugify(p.id);
  if (p.language !== "en" && !p.slug) slug += `-${p.language}`;
  if (used.has(slug)) slug = `${slug}-${slugify(p.id || p.calId)}`;
  used.add(slug);
  p.slug = slug;
  p.url = `${SITE}/set/${slug}.html`;
}

// Priser och sällsynthet för set som har prishistorik.
for (const p of pages.filter((x) => x.id)) {
  const h = await readJSON(`data/card-history/${encodeURIComponent(p.id)}.json`, null);
  p.prices = new Map(); p.rarity = h?.rarity || {};
  for (const [id, pts] of Object.entries(h?.cards || {})) {
    const last = pts.at(-1);
    if (!last || (last[1] ?? last[2]) == null) continue;
    p.prices.set(id, last[1] ?? last[2]);
    if (!p.priceDate || last[0] > p.priceDate) p.priceDate = last[0];
  }
}

const upcoming = (p) => !!p.date && p.date > today;
const lastWave = (p) => p.cal?.waves?.map((w) => w.date).sort().at(-1);
// Ett set med pågående omgångar räknas som aktuellt även efter huvudsläppet.
const current = (p) => upcoming(p) || (lastWave(p) && lastWave(p) >= today);

// ---------- HTML ----------
// Google kortar titlar över ca 60 tecken och beskrivningar över ca 160. Långa titlar tappar " | Lootninja",
// långa beskrivningar tappar sista meningen tills de får plats (minst en mening blir kvar).
const fitTitle = (t) => (t.length > 60 ? t.replace(/ \| Lootninja$/, "") : t);
function fitDesc(d) {
  const parts = d.match(/[^.!?]+[.!?]+(\s|$)/g) || [d];
  while (parts.length > 1 && parts.join("").trim().length > 160) parts.pop();
  return parts.join("").trim();
}
const head = (o) => headHtml({ ...o, title: fitTitle(o.title), desc: fitDesc(o.desc) });
const headHtml = ({ title, desc, url, ld }) => `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<!-- Sidan ligger i set/. base gör att css, js, data och länkar hämtas från roten som på alla andra sidor. -->
<base href="/">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="max-image-preview:large">
<link rel="preconnect" href="https://assets.tcgdex.net">
<meta name="theme-color" content="#ffffff">
<meta name="theme-color" content="#1b1e28" media="(prefers-color-scheme: dark)">
<link rel="icon" href="logo.svg" type="image/svg+xml">
<link rel="icon" href="img/favicon-48.png?v=2" sizes="48x48" type="image/png">
<link rel="apple-touch-icon" href="img/apple-touch-icon.png?v=2">
<link rel="manifest" href="site.webmanifest">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Lootninja">
<meta property="og:locale" content="sv_SE">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:image" content="${SITE}/img/og-lootninja.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="Lootninja – Pokémonkort: släpp, butikslager och priser">
<meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
<link href="fonts/fonts.css" rel="stylesheet">
<link rel="stylesheet" href="style.css?v=20261029k">
<link rel="stylesheet" href="dark.css?v=20261029a" id="dark-css" media="(prefers-color-scheme: dark)">
<script src="js/theme.js?v=20261021"></script>
</head>
<body>
<main id="main">`;

const crumbsLd = (items) => ({
  "@context": "https://schema.org", "@type": "BreadcrumbList",
  itemListElement: items.map(([name, item], i) => ({ "@type": "ListItem", position: i + 1, name, item })),
});
const crumbsHtml = (items) => `<nav class="crumbs" aria-label="Brödsmulor">${items.map(([name, href], i) => i === items.length - 1
  ? `<span aria-current="page">${esc(name)}</span>` : `<a href="${href}">${esc(name)}</a><span aria-hidden="true">›</span>`).join("")}</nav>`;
const pageHead = (crumbs) => `
  <header class="page-head">
    <div class="wrap">
      ${crumbsHtml(crumbs)}
    </div>
    <canvas class="scene" data-banner="slapp" aria-hidden="true"></canvas>
  </header>`;
const foot = `
</main>
<script type="module" src="js/setpage.js?v=20261028a"></script>
</body>
</html>
`;

// Laddar loggan inte blir den en textlogga, som när setet saknar logga.
const logoImg = (p, cls) => p.logo
  ? `<img class="${cls}" src="${esc(p.logo)}" alt="${esc(p.name)}" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:this.className+' set-word',textContent:this.alt}))">`
  : `<span class="${cls} set-word">${esc(p.name)}</span>`;
const cardHref = (c) => `vardering.html?id=${encodeURIComponent(c.id)}`;
const cardImg = (c) => extraImages[c.id]?.low || (c.image ? `${c.image}/low.webp` : "img/kortbaksida.webp");
const count = (p) => p.cardCount?.official ?? p.cards.length;
// Bilden som visas när man håller musen över kortets namn i listan (js/setpage.js). Bara kort som har en bild.
const peek = (c) => (extraImages[c.id] || c.image ? ` data-img="${esc(cardImg(c))}"` : "");

function intro(p) {
  const n = count(p), total = p.cardCount?.total;
  const extra = total && total > n ? `, ${total} om man räknar med de hemliga korten` : "";
  const lang = p.language !== "en" ? ` på ${LANG[p.language] || p.language}` : "";
  const prel = p.cal?.preliminary ? " (preliminärt datum)" : "";
  if (!p.date) return `${p.name} är ett kommande Pokémon TCG-set${lang}${p.serie ? ` i serien ${p.serie}` : ""}. Släppdatumet är inte satt än. Här ser du produkterna så snart de annonseras och vilka svenska butiker som har dem.`;
  if (upcoming(p)) return `${p.name} är ett kommande Pokémon TCG-set${lang}${p.serie ? ` i serien ${p.serie}` : ""} som släpps ${longDate(p.date)}${prel}. Här ser du vilka produkter som kommer, när de släpps och vilka svenska butiker som redan har dem till förbeställning.`;
  const cards = n ? ` Setet har ${n} kort${extra}.` : "";
  const what = p.prices?.size ? "alla kort med Cardmarkets marknadspris i kronor, de dyraste korten" : p.cards.length ? "alla kort i setet" : "produkterna, när de släpps";
  return `${p.name} är ett Pokémon TCG-set${lang}${p.serie ? ` i serien ${p.serie}` : ""} som släpptes ${longDate(p.date)}.${cards} Här ser du ${what} och vilka svenska butiker som har ${p.name}-produkter i lager just nu.`;
}

function wavesHtml(p) {
  const r = p.cal;
  if (!r?.waves?.length) return "";
  const rows = r.waves.map((w) => {
    const items = w.products.length ? w.products.map((name) => `<li>${esc(name)}</li>`).join("") : "<li>Setet släpps</li>";
    return `<tr><td data-label="Datum"><time datetime="${w.date}">${longDate(w.date)}</time>${w.preliminary || r.preliminary ? " <small>(preliminärt)</small>" : ""}</td><td data-label="Produkter"><ul>${items}</ul></td></tr>`;
  }).join("");
  const pre = r.prerelease ? `<p>Förrelease (prerelease) i spelbutikerna: <time datetime="${r.prerelease.from}">${longDate(r.prerelease.from)}</time> till <time datetime="${r.prerelease.to}">${longDate(r.prerelease.to)}</time>.</p>` : "";
  return `
    <div class="section" id="slapp"><h2>Släppdatum och produkter</h2><a class="more" href="slapp.html?rel=${encodeURIComponent(r.id)}">I släppkalendern</a></div>
    ${r.about ? `<p class="set-about">${esc(r.about)}</p>` : ""}
    ${pre}
    <div class="table-scroll"><table class="set-table waves"><thead><tr><th>Datum</th><th>Produkter</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="hint">${p.game ? "Datumen kommer från TCGplayer och gäller USA." : "Datumen gäller den europeiska lanseringen."} Leveranserna till svenska butiker kan dröja några dagar.</p>`;
}

function topHtml(p) {
  const top = p.cards.filter((c) => p.prices.has(c.id)).sort((a, b) => p.prices.get(b.id) - p.prices.get(a.id)).slice(0, 12);
  if (!top.length) return "";
  return `
    <div class="section" id="dyrast"><h2>Dyraste korten i ${esc(p.name)}</h2></div>
    <ul class="set-top">${top.map((c) => {
      // Kort som TCGdex saknar (data/extra-cards.json) har ingen värderingssida att länka till.
      const [open, close] = c.extra ? ['<span class="set-top-item">', "</span>"] : [`<a href="${cardHref(c)}">`, "</a>"];
      return `
      <li>${open}
        <img src="${esc(cardImg(c))}" alt="${esc(`${c.name} ${c.localId}`)}" loading="lazy" decoding="async" width="245" height="337" onerror="this.src='img/kortbaksida.webp'">
        <b>${esc(c.name)}</b><small>#${esc(c.localId)}${p.rarity[c.id] ? ` · ${esc(p.rarity[c.id])}` : ""}</small>
        <span class="set-price">${kr(p.prices.get(c.id))}</span>${close}</li>`;
    }).join("")}
    </ul>`;
}

function cardsHtml(p) {
  if (!p.cards.length) return "";
  const hasRarity = p.cards.some((c) => p.rarity[c.id]);
  const rows = [...p.cards].sort(byNumber).map((c) => `<tr><td>${esc(c.localId)}</td><td>${c.extra ? `<span${peek(c)}>${esc(c.name)}</span>` : `<a href="${cardHref(c)}"${peek(c)}>${esc(c.name)}</a>`}</td>${hasRarity ? `<td>${esc(p.rarity[c.id] || "")}</td>` : ""}<td class="num">${p.prices.has(c.id) ? kr(p.prices.get(c.id)) : "–"}</td></tr>`).join("\n");
  const note = p.prices.size
    ? `Pris = Cardmarkets trendpris för ett ograderat kort i nyskick, omräknat till kronor ${longDate(p.priceDate)}. Tryck på ett kort för prishistorik och värdering.`
    : "Tryck på ett kort för att se dagens pris i kronor och värdera ditt exemplar.";
  return `
    <div class="section" id="kort"><h2>Alla ${p.cards.length} kort i ${esc(p.name)}</h2><button class="more" type="button" data-set="${esc(p.id)}">Visa med bilder</button></div>
    <p class="lead-sm">${note}</p>
    <div class="table-scroll"><table class="set-table cards"><thead><tr><th>Nr</th><th>Kort</th>${hasRarity ? "<th>Sällsynthet</th>" : ""}<th class="num">Pris</th></tr></thead><tbody>
${rows}
</tbody></table></div>`;
}

function relatedHtml(p, all) {
  const same = all.filter((o) => o !== p && o.serie && o.serie === p.serie).sort((a, b) => (b.date || "9999").localeCompare(a.date || "9999"));
  const list = (same.length ? same : all.filter((o) => o !== p).sort((a, b) => (b.date || "9999").localeCompare(a.date || "9999"))).slice(0, 8);
  if (!list.length) return "";
  return `
    <div class="section"><h2>${same.length ? `Fler set i ${esc(p.serie)}` : "Fler set"}</h2><a class="more" href="set/">Alla set</a></div>
    <ul class="set-tiles">${list.map(tile).join("")}</ul>`;
}

const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const tile = (p) => `<li data-game="pk" data-q="${esc(fold([p.name, p.serie, p.id].filter(Boolean).join(" ")))}"><a href="set/${p.slug}.html">${logoImg(p, "set-tile-logo")}<b>${esc(p.name)}</b><small>${p.date ? (upcoming(p) ? `Släpps ${longDate(p.date)}` : longDate(p.date)) : "Datum ej satt"}${count(p) ? ` · ${count(p)} kort` : ""}</small></a></li>`;
const gameTile = (p) => `<li data-game="${p.game}" data-q="${esc(fold([p.name, p.code, p.id, GAMES.find(([g]) => g === p.game)[3]].filter(Boolean).join(" ")))}"><a href="set/${p.slug}.html">${p.logo ? `<img class="set-tile-logo" src="${esc(p.logo)}" alt="${esc(p.name)}" loading="lazy" decoding="async">` : `<span class="set-tile-logo set-word">${esc(p.name)}</span>`}<b>${esc(p.code ? `${p.code} · ${p.name}` : p.name)}</b><small>${p.date ? (p.date > today ? `Släpps ${longDate(p.date)}` : longDate(p.date)) : "Datum ej satt"}${p.cards.length ? ` · ${p.cards.length} kort` : ""}</small></a></li>`;
const anyTile = (p) => (p.game ? gameTile(p) : tile(p));

// ---------- One Piece och Riftbound ----------
const BACK = { op: "img/kortbaksida-op.webp", rb: "img/kortbaksida-rb.png" };
const OP_RARITY = { L: "Leader", C: "Common", UC: "Uncommon", R: "Rare", SR: "Super Rare", SEC: "Secret Rare", TR: "Treasure Rare", P: "Promo", PR: "Promo" };
const rarityOf = (p, c) => (p.game === "op" ? OP_RARITY[c.rarity] || c.rarity : c.rarity !== "None" ? c.rarity : null);
// Ett kort öppnas i Kortpriser, i samma stora vy som där (priser.html?…&card=<id>).
const priceHref = (p, c) => `priser.html?game=${p.game}&amp;set=${encodeURIComponent(p.id)}&amp;card=${encodeURIComponent(c.id)}`;
const gameCard = (p, c) => `<li data-no="${esc(c.no || "")}" data-price="${c.sek ?? ""}"><a href="${priceHref(p, c)}">
        <img src="${esc(c.image || BACK[p.game])}" alt="${esc(`${c.name} ${c.no || ""}`.trim())}" loading="lazy" decoding="async" width="245" height="342" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${BACK[p.game]}'">
        <b>${esc(c.name)}</b><small>${esc([c.no, rarityOf(p, c), c.variant].filter(Boolean).join(" · "))}</small>
        <span class="set-price">${c.sek != null ? kr(c.sek) : "–"}</span></a></li>`;
const byNo = (a, b) => String(a.no || "").localeCompare(String(b.no || ""), "sv", { numeric: true });

function gameIntro(p) {
  const game = gameName[p.game], code = p.code ? ` (${p.code})` : "";
  if (!p.cards.length) return `${p.name} är ett kommande ${game}-set som släpps ${p.date ? longDate(p.date) : "snart"}. Här ser du vilka produkter som kommer, när de släpps och vilka svenska butiker som redan har dem till förbeställning.`;
  const when = p.date ? ` som ${p.date > today ? "släpps" : "släpptes"} ${longDate(p.date)}` : "";
  return `${p.name} är ett set i ${game}${code}${when}. Setet har ${p.cards.length} kort. Här ser du alla kort med bilder och TCGplayers marknadspris i kronor, de dyraste korten och vilka svenska butiker som har ${p.name} i lager just nu.`;
}

function gamePage(p) {
  const game = gameName[p.game], priced = p.cards.filter((c) => c.sek != null);
  const top = [...priced].sort((a, b) => b.sek - a.sek);
  const release = !p.cards.length || (p.date && p.date > today);
  const title = release ? `${p.name} – ${game}, släppdatum och produkter | Lootninja` : `${p.name} – alla ${game}-kort och priser i kronor | Lootninja`;
  const desc = release
    ? `${p.name} (${game}) släpps ${p.date ? longDate(p.date) : "snart"}. Se alla produkter, släppdatum och vilka svenska butiker som har förbeställning eller lager.`
    : `Alla ${p.cards.length} kort i ${p.name} (${game}${p.code ? ` ${p.code}` : ""}) med bilder och priser i kronor.${p.date ? ` Släpptes ${longDate(p.date)}.` : ""}${top[0] ? ` Dyrast just nu: ${top[0].name} (${kr(top[0].sek)}).` : ""} Se var setet finns i lager i Sverige.`;
  const crumbs = [["Hem", `${SITE}/`, "./"], ["Alla set", `${SITE}/set/`, "set/"], [game, `${SITE}/set/#${gameAnchor[p.game]}`, `set/#${gameAnchor[p.game]}`], [p.name, p.url, null]];
  const facts = [esc(game), p.code && `Kod: ${esc(p.code)}`, p.date && (p.date > today ? `Släpps <time datetime="${p.date}">${longDate(p.date)}</time>` : `Släpptes <time datetime="${p.date}">${longDate(p.date)}</time>`),
    p.cards.length && `${p.cards.length} kort`].filter(Boolean);
  const others = gamePages.filter((o) => o !== p && o.game === p.game).sort((a, b) => (b.main - a.main) || (b.date || "").localeCompare(a.date || "")).slice(0, 8);
  const priceNote = `Pris = TCGplayers marknadspris för ett ograderat kort i nyskick, omräknat till kronor ${longDate(new Date(gameData[p.game].updated || Date.now()).toISOString().slice(0, 10))}. Tryck på ett kort för att se det i stort format med pris och fakta.`;
  return `${head({ title, desc, url: p.url, ld: crumbsLd(crumbs.map(([n, u]) => [n, u])) })}${pageHead(crumbs.map(([n, , h]) => [n, h]))}

  <div class="wrap">
    <section class="set-hero">
      ${p.logo ? `<img class="set-hero-logo set-hero-box" src="${esc(p.logo)}" alt="${esc(p.name)}" decoding="async">` : `<span class="set-hero-logo set-word">${esc(p.name)}</span>`}
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="set-facts">${facts.join(" · ")}</p>
        <p>${esc(gameIntro(p))}</p>
        <p class="set-actions">${p.cards.length ? `<a class="btn gold" href="set/${p.slug}.html#kort">Visa alla kort</a><a class="btn" href="priser.html?game=${p.game}&amp;set=${encodeURIComponent(p.id)}">Öppna i Kortpriser</a>` : ""}<a class="btn" href="set/${p.slug}.html#lager">Var finns det i lager?</a></p>
      </div>
    </section>
${wavesHtml(p)}
    <div class="section" id="lager"><h2>${esc(p.name)} i svenska butiker</h2><a class="more" href="butiker.html?q=${encodeURIComponent(p.name)}#products">Sök i butikerna</a></div>
    <p class="lead-sm" id="set-stock-count">Butikernas lager uppdateras hela dygnet.</p>
    <div id="set-stock" class="pgrid" data-density="small" data-game="${p.game}" data-name="${esc(p.name)}" data-lang="en" data-date="${p.date || ""}" data-match="${esc(JSON.stringify(p.match))}"></div>
    <p class="more-row" id="set-stock-more" hidden><a class="btn" href="butiker.html?q=${encodeURIComponent(p.name)}#products">Visa alla produkter</a></p>
${top.length ? `
    <div class="section" id="dyrast"><h2>Dyraste korten i ${esc(p.name)}</h2></div>
    <ul class="set-top">${top.slice(0, 12).map((c) => gameCard(p, c)).join("")}
    </ul>` : ""}
${p.cards.length ? `
    <div class="section" id="kort"><h2>Alla ${p.cards.length} kort i ${esc(p.name)}</h2>
      <div class="seg2 set-sort" role="group" aria-label="Sortera korten"><button type="button" data-sort="no" aria-pressed="true">Nummer</button><button type="button" data-sort="price" aria-pressed="false">Dyrast</button></div></div>
    <p class="lead-sm">${priceNote}</p>
    <ul class="set-top set-all">${[...p.cards].sort(byNo).map((c) => gameCard(p, c)).join("")}
    </ul>` : ""}
${others.length ? `
    <div class="section"><h2>Fler ${esc(game)}-set</h2><a class="more" href="set/?spel=${p.game}">Alla set</a></div>
    <ul class="set-tiles">${others.map(gameTile).join("")}</ul>` : ""}
  </div>${foot}`;
}

function setPage(p, all) {
  const priced = p.prices?.size > 0;
  const top = priced ? p.cards.filter((c) => p.prices.has(c.id)).sort((a, b) => p.prices.get(b.id) - p.prices.get(a.id))[0] : null;
  // Utan kortlista (kommande set, eller ett set som TCGdex inte har än) handlar sidan om släppet.
  const release = upcoming(p) || !p.date || !p.cards.length;
  const title = release ? `${p.name} – släppdatum och produkter | Lootninja`
    : priced ? `${p.name} – alla kort och priser i kronor | Lootninja`
    : `${p.name} – kortlista och släppdatum | Lootninja`;
  const desc = release
    ? `${p.name} ${upcoming(p) || !p.date ? "släpps" : "släpptes"} ${p.date ? longDate(p.date) : "snart"}${p.cal?.preliminary ? " (preliminärt)" : ""}. Se alla produkter, släppdatum och vilka svenska butiker som har ${upcoming(p) ? "förbeställning eller lager" : "setet i lager"}.`
    : `Alla ${p.cards.length} kort i ${p.name}${p.serie && p.serie !== p.name ? ` (${p.serie})` : ""}${priced ? " med priser i kronor" : ""}. Släpptes ${longDate(p.date)}.${top ? ` Dyrast just nu: ${top.name} (${kr(p.prices.get(top.id))}).` : ""} Se var setet finns i lager i Sverige.`;
  const crumbs = [["Hem", `${SITE}/`, "./"], ["Kalender", `${SITE}/slapp.html`, "slapp.html"], ["Alla set", `${SITE}/set/`, "set/"], [p.name, p.url, null]];
  const facts = [p.serie && `Serie: ${esc(p.serie)}`, p.date && (upcoming(p) ? `Släpps <time datetime="${p.date}">${longDate(p.date)}</time>` : `Släpptes <time datetime="${p.date}">${longDate(p.date)}</time>`),
    count(p) && `${count(p)} kort${p.cardCount?.total > count(p) ? ` (${p.cardCount.total} med hemliga)` : ""}`, p.language !== "en" && `Språk: ${LANG[p.language] || p.language}`].filter(Boolean);
  return `${head({ title, desc, url: p.url, ld: crumbsLd(crumbs.map(([n, u]) => [n, u])) })}${pageHead(crumbs.map(([n, , h]) => [n, h]))}

  <div class="wrap">
    <section class="set-hero">
      ${logoImg(p, "set-hero-logo")}
      <div>
        <h1>${esc(p.name)}</h1>
        <p class="set-facts">${facts.join(" · ")}</p>
        <p>${esc(intro(p))}</p>
        <p class="set-actions">${p.id ? `<button class="btn gold" type="button" data-set="${esc(p.id)}">Visa alla kort med bilder</button>` : ""}<a class="btn" href="set/${p.slug}.html#lager">Var finns det i lager?</a></p>
      </div>
    </section>
${wavesHtml(p)}
    <div class="section" id="lager"><h2>${esc(p.name)} i svenska butiker</h2><a class="more" href="butiker.html?q=${encodeURIComponent(p.name)}#products">Sök i butikerna</a></div>
    <p class="lead-sm" id="set-stock-count">Butikernas lager uppdateras hela dygnet.</p>
    <div id="set-stock" class="pgrid" data-density="small" data-name="${esc(p.name)}" data-lang="${esc(p.language)}" data-date="${p.date || ""}" data-match="${esc(JSON.stringify(p.match))}"></div>
    <p class="more-row" id="set-stock-more" hidden><a class="btn" href="butiker.html?q=${encodeURIComponent(p.name)}#products">Visa alla produkter</a></p>
${priced ? topHtml(p) : ""}
${cardsHtml(p)}
${relatedHtml(p, all)}
  </div>${foot}`;
}

function indexPage(all) {
  const url = `${SITE}/set/`;
  const soon = [...all, ...gamePages].filter(current).sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));
  const rest = all.filter((p) => !current(p));
  const series = new Map();
  for (const p of rest.sort((a, b) => (b.date || "").localeCompare(a.date || ""))) {
    const k = p.serie || "Övriga";
    if (!series.has(k)) series.set(k, []);
    series.get(k).push(p);
  }
  const title = "Alla set – Pokémon TCG, One Piece och Riftbound";
  const desc = `Alla ${all.length} Pokémon TCG-set från Base Set till de senaste, plus seten i One Piece Card Game och Riftbound, med kortlistor, priser i kronor, släppdatum och kommande set.`;
  const crumbs = [["Hem", `${SITE}/`, "./"], ["Kalender", `${SITE}/slapp.html`, "slapp.html"], ["Alla set", url, null]];
  return `${head({ title, desc, url, ld: crumbsLd(crumbs.map(([n, u]) => [n, u])) })}${pageHead(crumbs.map(([n, , h]) => [n, h]))}

  <div class="wrap">
    <section class="set-hero">
      <div>
        <h1>Alla set</h1>
        <p>Varje set i Pokémon, One Piece och Riftbound har en egen sida med alla kort och bilder, priser i kronor, släppdatum och vilka svenska butiker som har setet i lager. Kommande set står först, sedan varje spel och serie, nyast först.</p>
        <form class="set-search" role="search" onsubmit="return false">
          <input type="search" id="set-q" placeholder="Sök set, t.ex. Scarlet, OP-12 eller Origins" aria-label="Sök set" autocomplete="off">
        </form>
      </div>
    </section>
    <div class="seg game-seg" id="set-games" role="group" aria-label="Kortspel">
      <button type="button" data-game="" aria-pressed="true">Alla</button><button type="button" data-game="pk" aria-pressed="false">Pokémon</button><button type="button" data-game="op" aria-pressed="false">One Piece</button><button type="button" data-game="rb" aria-pressed="false">Riftbound</button>
    </div>
    <p class="lead-sm" id="set-none" hidden>Inget set matchar. Prova ett annat namn eller en serie, till exempel Scarlet.</p>
${soon.length ? `
    <div class="section"><h2>Aktuella och kommande set</h2><a class="more" href="slapp.html">Släppkalendern</a></div>
    <ul class="set-tiles">${soon.map(anyTile).join("")}</ul>` : ""}
${GAMES.map(([g, anchor, name]) => [g, anchor, name, gamePages.filter((p) => p.game === g && p.cards.length).sort((a, b) => (b.main - a.main) || (b.date || "").localeCompare(a.date || ""))])
  .filter(([, , , list]) => list.length).map(([g, anchor, name, list]) => `
    <div class="section" id="${anchor}"><h2>${esc(name)}</h2><a class="more" href="priser.html?game=${g}">Kortpriser</a></div>
    <ul class="set-tiles">${list.map(gameTile).join("")}</ul>`).join("")}
${[...series].map(([name, list]) => `
    <div class="section"><h2>${esc(name)}</h2></div>
    <ul class="set-tiles">${list.map(tile).join("")}</ul>`).join("")}
  </div>${foot}<script>
(() => {
  const q = document.getElementById("set-q"), none = document.getElementById("set-none");
  const fold = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const lists = [...document.querySelectorAll(".set-tiles")], seg = document.getElementById("set-games");
  // Spelknapparna och sökrutan gäller tillsammans. Valt spel står i adressen (?spel=op), så att det går att länka.
  let game = new URLSearchParams(location.search).get("spel") || "";
  const apply = () => {
    const t = fold(q.value.trim());
    for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.game === game));
    let shown = 0;
    for (const ul of lists) {
      let any = false;
      for (const li of ul.children) { const ok = (!t || li.dataset.q.includes(t)) && (!game || li.dataset.game === game); li.hidden = !ok; any = any || ok; }
      ul.hidden = !any;
      const h = ul.previousElementSibling;
      if (h && h.classList.contains("section")) h.hidden = !any;
      if (any) shown += [...ul.children].filter((li) => !li.hidden).length;
    }
    none.hidden = shown > 0;
  };
  q.addEventListener("input", apply);
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-game]");
    if (!b) return;
    game = b.dataset.game;
    history.replaceState(null, "", location.pathname + (game ? "?spel=" + game : ""));
    apply();
  });
  if (game) apply();
})();
</script>`;
}

// ---------- Skriv ----------
await mkdir(OUT_DIR, { recursive: true });
const files = new Map(pages.map((p) => [`${p.slug}.html`, setPage(p, pages)]));
for (const p of gamePages) files.set(`${p.slug}.html`, gamePage(p));
files.set("index.html", indexPage(pages));
let written = 0;
for (const [name, html] of files) {
  const old = await readFile(new URL(name, OUT_DIR), "utf8").catch(() => null);
  if (old !== html) { await writeFile(new URL(name, OUT_DIR), html); written++; }
}
// Set som försvunnit (t.ex. ett kalendersläpp som bytt namn) tas bort.
let removed = 0;
for (const f of await readdir(OUT_DIR)) if (f.endsWith(".html") && !files.has(f)) { await unlink(new URL(f, OUT_DIR)); removed++; }

const map = { sets: Object.fromEntries(pages.filter((p) => p.id).map((p) => [p.id, `set/${p.slug}.html`])),
  releases: Object.fromEntries([...pages, ...gamePages].filter((p) => p.cal).map((p) => [p.cal.id, `set/${p.slug}.html`])),
  games: Object.fromEntries(GAMES.map(([g]) => [g, Object.fromEntries(gamePages.filter((p) => p.game === g && p.id).map((p) => [p.id, `set/${p.slug}.html`]))])) };
const mapText = JSON.stringify(map, null, 1) + "\n";
if (await readFile(at("data/set-pages.json"), "utf8").catch(() => null) !== mapText) await writeFile(at("data/set-pages.json"), mapText);
console.log(`${pages.length + gamePages.length} setsidor (${gamePages.length} One Piece och Riftbound): ${written} ändrade, ${removed} borttagna.`);
