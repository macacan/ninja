// Sektionen "Precis inne i butikerna" på startsidan:
//  1. ett levande flöde av de senast inkomna produkterna, som uppdateras varje minut
//  2. en packöppnare: välj ett pack från de senaste seten, riv upp det och dra korten ett i taget
import { groupKey, groupProducts, changedAt } from "./group.js";
import { $, esc, kr, ago, latestSets, setLogo, getJSON, API, safeUrl, liveStock } from "./site.js";
import { track } from "./tracker.js";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const BACK = "img/kortbaksida.webp";

// ---------- Flödet ----------
let seen = null; // produkter som redan visats, i ordning, så att nya kan markeras
// Vid uppdatering: nya produkter faller in uppifrån med guldglöd, de gamla glider ner till sin nya plats
// och en liten skylt visar hur många som kom in. Är listan oförändrad uppdateras bara tiden.
async function feed() {
  const el = $("#restock-feed");
  if (!el) return;
  try {
    const [p, s] = await liveStock();
    const names = Object.fromEntries(s.stores.map((x) => [x.id, x.name]));
    const used = new Set();
    const inStock = p.products.filter((x) => x.available);
    // Sorteras på senaste riktiga ändring: nytt i lager eller en prissänkning som gör butiken billigast.
    // En vanlig prisuppdatering hos en dyrare butik flyttar inte upp produkten (changedAt i group.js).
    const groups = groupProducts(p.products);
    const at = new Map(inStock.map((x) => [x, changedAt(x, groups.get(groupKey(x)) || [])]));
    const list = inStock.filter((x) => x.image).sort((a, b) => at.get(b) - at.get(a))
      .filter((x) => { const k = groupKey(x); return !used.has(k) && used.add(k); }).slice(0, 4);
    const meta = (x) => `${esc(names[x.store] || x.store)} · ${kr(x.price)}${at.get(x) ? ` · ${ago(at.get(x))}` : ""}`;
    const first = seen === null;
    if (!first && list.length && list.length === seen.length && list.every((x, i) => x.url === seen[i])) {
      el.querySelectorAll(".rf small").forEach((small, i) => { small.innerHTML = meta(list[i]); });
      return;
    }
    const fresh = new Set(list.map((x) => x.url).filter((u) => !first && !seen.includes(u)));
    seen = list.map((x) => x.url);
    const old = [...el.querySelectorAll(".rf[data-url]")];
    const before = new Map(old.map((li) => [li.dataset.url, li.getBoundingClientRect().top]));
    const imgs = new Map(old.map((li) => [li.dataset.url, li.querySelector(".rf-img img")]));
    el.innerHTML = list.map((x, i) => {
      const justIn = fresh.has(x.url) || Date.now() - at.get(x) < 3 * 3600e3;
      return `<li class="rf${first ? "" : fresh.has(x.url) ? " is-fresh" : " is-update"}" style="--i:${i}" data-url="${esc(x.url)}">
        <a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener nofollow">
          <span class="rf-img"><img src="${esc(x.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()"></span>
          <span class="rf-body"><b>${esc(x.title)}</b><small>${meta(x)}</small></span>
          ${justIn ? '<span class="rf-tag">Nytt</span>' : ""}
        </a></li>`;
    }).join("") || '<li class="rf-empty">Inget nytt i lager just nu.</li>';
    // Produkter som ligger kvar behåller sin redan laddade bild, så att den inte blinkar vitt.
    for (const li of el.querySelectorAll(".rf.is-update")) { const img = imgs.get(li.dataset.url); if (img) li.querySelector(".rf-img img")?.replaceWith(img); }
    if (!fresh.size || reduce) return;
    // De som fanns kvar glider från sin gamla plats till den nya.
    for (const li of el.querySelectorAll(".rf.is-update")) {
      const top = before.get(li.dataset.url);
      if (top != null) li.animate([{ transform: `translateY(${top - li.getBoundingClientRect().top}px)` }, { transform: "none" }], { duration: 500, easing: "cubic-bezier(.2,.8,.2,1)" });
    }
    el.insertAdjacentHTML("beforeend", `<li class="rf-toast" aria-hidden="true"><i></i>+${fresh.size} nytt i lager</li>`);
    setTimeout(() => el.querySelector(".rf-toast")?.remove(), 3600);
  } catch {
    el.innerHTML = '<li class="rf-empty">Lagret uppdateras snart.</li>';
  }
}

// ---------- Dragningsmodellen ----------
// Ett pack har 10 kort: 5 vanliga, 3 ovanliga, 1 reverse holo-plats och 1 sällsynt-plats.
// Sällsynt-platsen avgörs av vikterna nedan. Siffrorna är en förenklad uppskattning av vad samlare
// brukar mäta för Scarlet & Violet- och Mega-seten, inte officiella odds. Saknar ett set en rarity
// delas dess vikt upp på de andra, så att procenten alltid summerar till 100.
const RARE_CLASSES = [
  // nyckel, namn, TCGdex-rarity som ingår, vikt i sällsynt-platsen
  ["rare", "Rare", ["Rare", "Holo Rare", "Rare Holo"], 66],
  ["double", "Double Rare", ["Double rare"], 12],
  ["ultra", "Ultra Rare", ["Ultra Rare"], 5],
  ["ir", "Illustration Rare", ["Illustration rare"], 10],
  ["sir", "Special Illustration Rare", ["Special illustration rare"], 2.5],
  ["hyper", "Hyper Rare", ["Hyper rare", "Mega Hyper Rare"], 1],
  ["shiny", "Shiny Rare", ["Shiny rare"], 6],
  ["shinyultra", "Shiny Ultra Rare", ["Shiny Ultra Rare"], 2],
  ["ace", "ACE SPEC Rare", ["ACE SPEC Rare"], 5],
];
const BASE_RARITIES = ["Common", "Uncommon"];
const REVERSE_BONUS = 0.1; // chans att reverse holo-platsen blir ett bonuskort i stället för ett vanligt
const SLOTS = { commons: 5, uncommons: 3 };

async function loadLists(setId) {
  const names = [...BASE_RARITIES, ...RARE_CLASSES.flatMap((c) => c[2])];
  const res = await Promise.allSettled(names.map((n) => getJSON(`${API}/cards?set.id=eq:${encodeURIComponent(setId)}&rarity=eq:${encodeURIComponent(n)}`)));
  const lists = {};
  names.forEach((n, i) => { if (res[i].status === "fulfilled" && Array.isArray(res[i].value)) lists[n] = res[i].value.filter((c) => c.image); });
  return lists;
}

function buildModel(set, lists) {
  const classes = RARE_CLASSES.map(([key, label, names, w]) => ({ key, label, w, cards: names.flatMap((n) => lists[n] || []) })).filter((c) => c.cards.length);
  let commons = lists.Common || [];
  let uncommons = (lists.Uncommon || []).length ? lists.Uncommon : commons;
  if (!classes.length || !commons.length) {
    // Set utan rarity-uppgifter: första 65 % räknas som vanliga, resten som sällsynta.
    const pool = set.cards.filter((c) => c.image), cut = Math.floor(pool.length * 0.65);
    commons = pool.slice(0, cut); uncommons = commons;
    classes.splice(0, classes.length, { key: "rare", label: "Rare", w: 60, cards: pool.slice(cut) });
  }
  const total = classes.reduce((s, c) => s + c.w, 0);
  const noRare = classes.filter((c) => c.key !== "rare");
  const bonusTotal = noRare.reduce((s, c) => s + c.w, 0);
  for (const c of classes) {
    c.slot = c.w / total;
    c.bonus = c.key === "rare" || !bonusTotal ? 0 : c.w / bonusTotal;
    // Chansen att få minst ett kort av den här sorten i ett pack, från båda platserna.
    c.chance = 1 - (1 - c.slot) * (1 - REVERSE_BONUS * c.bonus);
  }
  return { commons, uncommons, classes, noRare };
}

function pickClass(list, weight) {
  let r = Math.random() * list.reduce((s, c) => s + weight(c), 0);
  for (const c of list) { r -= weight(c); if (r <= 0) return c; }
  return list[list.length - 1];
}

function drawPack(m) {
  const used = new Set();
  const take = (arr) => {
    for (let t = 0; t < 40; t++) { const c = arr[Math.floor(Math.random() * arr.length)]; if (!used.has(c.id)) { used.add(c.id); return c; } }
    return arr[0];
  };
  const out = [];
  for (let i = 0; i < SLOTS.commons; i++) out.push({ card: take(m.commons), slot: "Vanlig" });
  for (let i = 0; i < SLOTS.uncommons; i++) out.push({ card: take(m.uncommons), slot: "Ovanlig" });
  if (m.noRare.length && Math.random() < REVERSE_BONUS) {
    const cl = pickClass(m.noRare, (c) => c.w);
    out.push({ card: take(cl.cards), slot: "Reverse holo-plats", reverse: true });
  } else {
    out.push({ card: take(Math.random() < 0.6 ? m.commons : m.uncommons), slot: "Reverse holo", reverse: true });
  }
  const cl = pickClass(m.classes, (c) => c.w);
  out.push({ card: take(cl.cards), slot: "Sällsynt-plats" });
  return out;
}

// Hur imponerande en dragning är: 3 = jackpot (över 500 kr eller toppsällsynt), 2 = riktigt bra, 1 = sällsynt, 0 = vanlig.
const tierOf = (rarity, value) => {
  const r = rarity || "";
  if ((value ?? 0) >= 500 || /special illustration|hyper/i.test(r)) return 3;
  if ((value ?? 0) >= 100 || /double|ultra|illustration|shiny|ace/i.test(r)) return 2;
  if (/rare/i.test(r) && !/^(none)$/i.test(r)) return 1;
  return 0;
};
const valueOf = (d, rate) => { const cm = d?.pricing?.cardmarket; const eur = cm?.trend ?? cm?.avg ?? null; return eur == null ? null : eur * rate; };
// Billiga kort visas med ören (0,56 kr), annars blir alla vanliga kort "1 kr".
const money = (v) => (v < 0.1 ? "under 0,10 kr" : v < 10 ? `${v.toFixed(2).replace(".", ",")} kr` : kr(v));
const pct = (x) => (x * 100 >= 10 ? (x * 100).toFixed(0) : (x * 100).toFixed(1)).replace(".", ",") + " %";
const ratePromise = () => getJSON("https://api.frankfurter.dev/v1/latest?from=EUR&to=SEK").then((r) => r.rates.SEK).catch(() => 11.2);
const preload = (src) => new Promise((res) => { const i = new Image(); i.onload = i.onerror = () => res(); i.src = src; setTimeout(res, 4000); });
// Byter bild och väntar tills den laddats (max 3 s). img.decode() används inte: den kan hänga för dolda bilder.
const setImage = (img, src) => new Promise((res) => {
  const done = () => { img.onload = img.onerror = null; res(); };
  img.onload = img.onerror = done;
  img.src = src;
  if (img.complete && img.naturalWidth) done();
  setTimeout(done, 3000);
});
const hue = (id) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

// ---------- Dagens pack ----------
// Ett pack per dag. Är packet värt under 10 kr får man öppna ett nytt, tills ett pack är värt minst 10 kr.
// Dagen sparas i webbläsaren och börjar om vid midnatt. Den räknas som klar så fort packet dras, inte när
// alla kort har visats, så att man inte kan ladda om sidan och dra ett nytt.
const DAY_MIN = 10; // kronor
const DAY_KEY = "nl:pack-day";
const today = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
const doneToday = () => { try { return localStorage.getItem(DAY_KEY) === today(); } catch { return false; } };
const markDone = () => { try { localStorage.setItem(DAY_KEY, today()); } catch {} };
// Tid kvar till midnatt, t.ex. "7 h 12 min".
function untilTomorrow() {
  const now = new Date(), next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const m = Math.ceil((next - now) / 60e3), h = Math.floor(m / 60);
  return h ? `${h} h ${m % 60} min` : `${m} min`;
}
const defaultHint = () => (doneToday()
  ? `Du har öppnat dagens pack. Nästa pack om ${untilTomorrow()}.`
  : "Välj ett pack och tryck för att öppna det · ett pack per dag");

function applyLock() {
  $("#pack-row")?.classList.toggle("is-locked", doneToday());
  const hint = $("#stage-hint");
  if (hint && !$("#pack-row")?.hidden) hint.textContent = defaultHint();
}

// ---------- Ljud ----------
// Myntljudet spelas när ett kort vänds och dess värde visas. Ljudvalet sparas i webbläsaren.
const SOUND_KEY = "nl:sound-muted";
let muted = (() => { try { return localStorage.getItem(SOUND_KEY) === "1"; } catch { return false; } })();
const coin = new Audio("sounds/coins.mp3");
coin.preload = "auto";
function playCoin(tier = 0) {
  if (muted) return;
  const a = coin.cloneNode();
  a.volume = tier >= 2 ? 0.8 : tier === 1 ? 0.6 : 0.4;
  a.play().catch(() => {}); // webbläsaren kan neka ljud innan sidan har klickats på
}
function setupMute() {
  const stage = $("#pack-stage");
  if (!stage || stage.querySelector(".sound-btn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sound-btn";
  const paint = () => {
    btn.setAttribute("aria-pressed", String(muted));
    btn.setAttribute("aria-label", muted ? "Slå på ljudet" : "Stäng av ljudet");
    btn.title = muted ? "Ljud av" : "Ljud på";
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M4 9h4l5-4v14l-5-4H4z"/>${muted
      ? '<path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'
      : '<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>'}</svg>`;
  };
  btn.addEventListener("click", () => {
    muted = !muted;
    try { localStorage.setItem(SOUND_KEY, muted ? "1" : "0"); } catch {}
    paint();
  });
  paint();
  stage.append(btn);
}

// ---------- Global räknare och topplista (api/highscore.php) ----------
// Varje öppnat pack räknas på servern och ger en biljett. Med biljetten kan packet skickas in till topplistan en gång.
const HS = "api/highscore.php";
const NICK_KEY = "nl:hs-nick";
const hsGet = (q) => fetch(`${HS}?${q}`, { cache: "no-store" }).then((r) => r.json());
const hsPost = (action, data) => fetch(`${HS}?action=${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) })
  .then((r) => r.json().catch(() => ({ ok: false })));
const nf = (n) => Math.round(n).toLocaleString("sv-SE");

function paintCounter(total) {
  const el = $("#pack-counter");
  if (!el || !Number.isFinite(total)) return;
  const b = el.querySelector("b"), before = +(b.dataset.n || 0);
  b.dataset.n = total;
  b.textContent = nf(total);
  el.hidden = false;
  if (before && total > before && !reduce) b.animate([{ transform: "scale(1.35)", color: "#fff2b0" }, { transform: "none" }], { duration: 500, easing: "cubic-bezier(.2,1.4,.4,1)" });
}
const loadCounter = () => hsGet("action=stats").then((d) => d.ok && paintCounter(d.totalOpened)).catch(() => {});

// Räknar upp packet direkt (räknaren ökar på en gång, även om servern är långsam) och ger biljetten till topplistan.
function openTicket(setId) {
  const b = $("#pack-counter b");
  if (b?.dataset.n) paintCounter(+b.dataset.n + 1);
  return hsPost("open", { set_id: setId }).then((d) => { if (Number.isFinite(d.totalOpened)) paintCounter(d.totalOpened); return d.token || null; }).catch(() => null);
}

// Topplistan visas i packöppnaren, direkt under ens eget inskickade pack. root: elementet som listan ritas i.
const boardHTML = () => `<div class="hs">
    <div class="hs-head">
      <h3>Topplistan: Värdefullaste packen</h3>
      <div class="seg2 hs-tabs" role="group" aria-label="Period">
        <button type="button" data-period="week" aria-pressed="true">Denna vecka</button>
        <button type="button" data-period="month" aria-pressed="false">Denna månad</button>
        <button type="button" data-period="all" aria-pressed="false">All-time</button>
      </div>
    </div>
    <ol class="hs-list" aria-live="polite"><li class="hs-empty">Laddar topplistan…</li></ol>
    <button type="button" class="btn small hs-more" hidden>Visa fler</button>
  </div>`;

// Topplistan visar fem rader åt gången. "Visa fler" lägger till fem till.
const HS_STEP = 5;
function paginate(root, upto) {
  const rows = [...root.querySelectorAll(".hs-row")], more = root.querySelector(".hs-more");
  rows.forEach((r, i) => { r.hidden = i >= upto; });
  more.hidden = rows.length <= upto;
  more.dataset.upto = upto;
}

async function renderBoard(root, period, mine) {
  const list = root.querySelector(".hs-list");
  root.querySelectorAll(".hs-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === period)));
  list.setAttribute("aria-busy", "true");
  try {
    const d = await hsGet(`action=leaderboard&period=${period}`);
    if (!d.ok) throw new Error();
    const empty = { week: "Ingen har skickat in ett pack den här veckan.", month: "Inga pack den här månaden än.", all: "Topplistan är tom." }[period];
    list.innerHTML = d.entries.length ? d.entries.map((e) => `<li class="hs-row r${e.rank}${e.id === mine ? " is-mine" : ""}">
        <span class="hs-rank" aria-label="Plats ${e.rank}">${e.rank}</span>
        <span class="hs-card"${e.best_card_img ? ` tabindex="0" role="button" aria-label="Visa ${esc(e.best_card_name || "kortet")} i stort format"` : ""}>${e.best_card_img ? `<img src="${esc(safeUrl(e.best_card_img))}" alt="" loading="lazy" decoding="async">` : ""}</span>
        <span class="hs-who"><b>${esc(e.name)}</b><small>${esc(e.best_card_name || "")}${e.best_card_value ? ` · ${kr(e.best_card_value)}` : ""}</small><small class="hs-meta">${esc(e.set_name || "")} · ${esc(e.date)}</small></span>
        <span class="hs-value">${kr(e.pack_value)}</span>
      </li>`).join("") : `<li class="hs-empty">${empty}</li>`;
  } catch {
    list.innerHTML = '<li class="hs-empty">Topplistan kunde inte laddas just nu.</li>';
  }
  list.removeAttribute("aria-busy");
  // Den egna raden ska alltid synas, även om den ligger längre ner än de första fem.
  const mineAt = [...list.querySelectorAll(".hs-row")].findIndex((r) => r.classList.contains("is-mine"));
  paginate(root, Math.max(HS_STEP, Math.ceil((mineAt + 1) / HS_STEP) * HS_STEP));
  const me = list.querySelector(".is-mine");
  if (me) list.scrollTop = me.offsetTop - list.offsetTop - 8;
}

// Kortet i stort format när man håller musen över miniatyren (eller trycker på den på mobilen). Bilden läggs direkt i
// <body> med fast position, så att packytans ram och topplistans rullning inte klipper bort den.
let peek = null;
function showPeek(thumb) {
  const small = thumb.querySelector("img");
  if (!small) return;
  if (!peek) { peek = document.createElement("img"); peek.className = "hs-peek"; peek.alt = ""; document.body.append(peek); }
  peek.src = small.src.replace(/\/low\.webp$/, "/high.webp");
  const r = thumb.getBoundingClientRect(), w = Math.min(240, innerWidth - 24), h = w * 1.395;
  // Till höger om miniatyren om det får plats, annars till vänster. Höjden hålls inom fönstret.
  const left = r.right + 12 + w <= innerWidth - 12 ? r.right + 12 : Math.max(12, r.left - 12 - w);
  const top = Math.min(Math.max(12, r.top + r.height / 2 - h / 2), innerHeight - h - 12);
  Object.assign(peek.style, { width: `${w}px`, left: `${left}px`, top: `${top}px` });
  peek.classList.add("is-on");
  peek.owner = thumb;
}
const hidePeek = () => { peek?.classList.remove("is-on"); if (peek) peek.owner = null; };
addEventListener("scroll", hidePeek, { passive: true });
document.addEventListener("click", (e) => { if (!e.target.closest?.(".hs-card")) hidePeek(); });

// Knappen "Topplistan" under packen: visar topplistan i packytan när som helst, även när dagens pack är öppnat.
function toggleBoard(show) {
  const btn = $("#hs-open"), box = $("#hs-box");
  if (!btn || !box) return;
  show ??= box.hidden;
  box.hidden = !show;
  $("#pack-stage").classList.toggle("show-board", show); // packen döljs så att topplistan får hela ytan
  btn.setAttribute("aria-expanded", String(show));
  btn.textContent = show ? "Dölj topplistan" : "Topplistan";
  hidePeek();
  if (show) { box.innerHTML = ""; showBoard(box, null); }
}
$("#hs-open")?.addEventListener("click", () => toggleBoard());

function showBoard(box, mine) {
  box.insertAdjacentHTML("beforeend", boardHTML());
  const root = box.lastElementChild;
  root.querySelector(".hs-tabs").addEventListener("click", (e) => { const b = e.target.closest("button[data-period]"); if (b) renderBoard(root, b.dataset.period, mine); });
  const more = root.querySelector(".hs-more");
  more.addEventListener("click", () => paginate(root, +more.dataset.upto + HS_STEP));
  const list = root.querySelector(".hs-list");
  list.addEventListener("pointerover", (e) => { const t = e.target.closest(".hs-card[tabindex]"); if (t && e.pointerType === "mouse") showPeek(t); });
  list.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse" && e.target.closest(".hs-card") && !e.relatedTarget?.closest?.(".hs-card")) hidePeek(); });
  // Tryck (mobil) eller Enter/mellanslag visar kortet, ett nytt tryck döljer det.
  list.addEventListener("click", (e) => { const t = e.target.closest(".hs-card[tabindex]"); if (t) (peek?.owner === t && peek.classList.contains("is-on") ? hidePeek() : showPeek(t)); });
  list.addEventListener("keydown", (e) => { const t = e.target.closest(".hs-card[tabindex]"); if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); peek?.owner === t ? hidePeek() : showPeek(t); } });
  list.addEventListener("focusout", hidePeek);
  list.addEventListener("scroll", hidePeek, { passive: true });
  renderBoard(root, "week", mine);
  root.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
}

// Formuläret under resultatet: skicka in packet med ett ninjanick. Efter inskickningen visas topplistan på samma ställe.
function submitForm(box, entry, ticket) {
  let nick = "";
  try { nick = localStorage.getItem(NICK_KEY) || ""; } catch {}
  box.innerHTML = `<form class="hs-form">
      <label for="hs-nick">Registrera ditt pack på topplistan:</label>
      <div class="hs-form-row">
        <input id="hs-nick" name="nick" maxlength="20" minlength="2" required autocomplete="nickname" placeholder="Namn" aria-label="Namn" value="${esc(nick)}">
        <button type="submit" class="btn small gold">Skicka in</button>
      </div>
      <p class="hs-msg" role="status"></p>
    </form>`;
  box.hidden = false;
  const form = box.querySelector("form"), msg = form.querySelector(".hs-msg"), btn = form.querySelector("button");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = form.nick.value.trim();
    if (name.length < 2) { msg.textContent = "Skriv minst 2 tecken."; return; }
    btn.disabled = true;
    msg.textContent = "Skickar…";
    const token = await ticket;
    if (!token) { msg.textContent = "Det här packet kunde inte registreras. Topplistan är inte nåbar just nu."; btn.disabled = false; return; }
    const d = await hsPost("submit", { token, name, ...entry });
    if (!d.ok) { msg.textContent = d.error || "Det gick inte att skicka in. Försök igen."; btn.disabled = !!d.error?.includes("Öppna ett nytt"); return; }
    try { localStorage.setItem(NICK_KEY, name); } catch {}
    track("pack_submit", entry.set_name, entry.pack_value);
    box.innerHTML = `<p class="hs-done">Inskickat! Du ligger <b>${ordinal(d.weekRank)}</b> den här veckan.</p>`;
    showBoard(box, d.id);
  });
}
// 1:a, 2:a, 3:e, 11:e, 21:a …
const ordinal = (n) => `${n}:${[1, 2].includes(n % 10) && ![11, 12].includes(n % 100) ? "a" : "e"}`;

// ---------- Packen att välja bland ----------
let packSets = [];
let packPool = []; // alla set som går att öppna, tre slumpas fram åt gången
const shuffled = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
function renderPacks() {
  const row = $("#pack-row");
  packSets = shuffled(packPool).slice(0, 3);
  row.innerHTML = packSets.map((s, i) => packHTML(s, i)).join("");
  row.querySelectorAll(".pack").forEach((b, i) => b.style.setProperty("--d", `${i * 0.45}s`));
}
let busy = false;

function packHTML(s, i) {
  // Varje pack får en egen färgton: grundton från setets id, förskjuten 120 grader per pack.
  const h = (hue(s.id) % 120 + i * 120) % 360;
  return `<button type="button" class="pack" data-set="${esc(s.id)}" style="--c1:hsl(${h} 72% 46%);--c2:hsl(${(h + 38) % 360} 78% 22%);--glow:hsl(${h} 90% 62%)" aria-label="Öppna ett pack från ${esc(s.name)}">
    <span class="pack-flash" aria-hidden="true"></span>
    <span class="pack-lid" aria-hidden="true"></span>
    <span class="pack-body">
      <span class="pack-shine" aria-hidden="true"></span>
      <span class="pack-holo" aria-hidden="true"></span>
      <img class="pack-logo" src="${esc(setLogo(s))}" alt="" loading="lazy">
      <b class="pack-kind">Booster</b>
      <small class="pack-set">${esc(s.name)}</small>
    </span>
    <span class="pack-foot" aria-hidden="true"></span>
  </button>`;
}

async function setupPacks() {
  setupMute();
  loadCounter();
  const row = $("#pack-row");
  if (!row) return;
  try {
    const sets = await latestSets(16); // samma anrop som startsidans setlista, så svaren finns redan i cachen
    packPool = sets.filter((s) => setLogo(s) && (s.cards || []).filter((c) => c.image).length >= 20);
    if (!packPool.length) throw new Error("inga set");
    renderPacks();
    applyLock();
    setInterval(applyLock, 60e3); // nedräkningen räknar ner, och packen låses upp vid midnatt
  } catch {
    row.innerHTML = '<p class="stage-hint">Packen kunde inte laddas just nu.</p>';
  }
}

async function openPack(btn) {
  if (busy) return;
  const set = packSets.find((s) => s.id === btn.dataset.set);
  if (!set) return;
  if (doneToday()) return applyLock(); // dagens pack är redan öppnat, tipset förklarar det
  busy = true;
  const ticket = openTicket(set.id);
  const row = $("#pack-row"), hint = $("#stage-hint");
  $("#pack-stage").classList.add("is-opening"); // ljudknappen syns bara när ett pack öppnas
  toggleBoard(false);
  row.classList.add("has-chosen");
  btn.classList.add("is-chosen");
  hint.textContent = "Öppnar…";
  const rate = ratePromise();
  const prepared = loadLists(set.id).then(async (lists) => {
    const model = buildModel(set, lists);
    const picks = drawPack(model);
    const details = picks.map((p) => getJSON(`${API}/cards/${encodeURIComponent(p.card.id)}`).catch(() => null));
    const [r] = await Promise.all([rate, preload(`${picks[0].card.image}/high.webp`), preload(`${picks[1].card.image}/high.webp`)]);
    // Pris och rarity för alla tio kort hämtas innan korten visas, så att priset syns direkt när ett kort avslöjas.
    const info = await Promise.all(details.map(async (p) => {
      const d = await Promise.race([p, wait(2500).then(() => null)]);
      const value = valueOf(d, r);
      const rarity = d?.rarity && d.rarity !== "None" ? d.rarity : "";
      return { d, value, rarity, tier: tierOf(rarity, value) };
    }));
    if (info.reduce((s, x) => s + (x.value || 0), 0) >= DAY_MIN) markDone();
    return { model, picks, info };
  });
  await wait(450); // packet glider till mitten, utan skakning
  btn.classList.add("is-torn");
  await wait(650);
  let data;
  try { data = await prepared; } catch { data = null; }
  if (!data) { hint.textContent = "Packet gick inte att öppna just nu. Försök igen."; btn.classList.remove("is-chosen", "is-torn"); row.classList.remove("has-chosen"); $("#pack-stage").classList.remove("is-opening"); busy = false; return; }
  row.hidden = true;
  hint.textContent = "Dra kortet åt sidan för att se nästa";
  renderDeck(set, data, ticket);
  busy = false;
}

// ---------- Förstora ett kort ----------
// Sista kortet (och de små dragna korten efteråt) kan tryckas på för att förstoras: kortet växer från sin plats till mitten.
let pz = null, pzBusy = false;

function packZoomDialog() {
  if (pz) return pz;
  pz = document.createElement("dialog");
  pz.className = "zoom-dlg";
  pz.setAttribute("aria-label", "Kortet i stort format");
  pz.innerHTML = `<button type="button" class="zm-close" aria-label="Stäng">✕</button>
    <div class="zm-stage">
      <div class="zm-tilt"><div class="zm-card"><img class="zm-img" alt="" decoding="async"><span class="zm-holo"></span><span class="zm-glare"></span></div></div>
      <div class="zm-info"><h3 class="zm-name"></h3><p class="zm-sub"></p><div class="zm-row"><span class="zm-price"></span></div></div>
    </div>`;
  document.body.append(pz);
  const card = pz.querySelector(".zm-card"), tilt = pz.querySelector(".zm-tilt");

  const close = async () => {
    if (pzBusy || !pz.open) return;
    pzBusy = true;
    const to = card.getBoundingClientRect();
    const from = pz.fromEl?.isConnected ? pz.fromEl.getBoundingClientRect() : null;
    const dur = reduce ? 1 : 360;
    const anims = [pz.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur, easing: "ease-in", fill: "forwards" })];
    if (from && from.width && from.bottom > 0 && from.top < innerHeight) {
      const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2), s = from.width / to.width;
      anims.push(card.animate([{ transform: "none" }, { transform: `translate(${dx}px,${dy}px) scale(${s})` }], { duration: dur, easing: "cubic-bezier(.5,0,.2,1)", fill: "forwards" }));
    } else {
      anims.push(card.animate([{ transform: "none", opacity: 1 }, { transform: "scale(.85)", opacity: 0 }], { duration: dur, fill: "forwards" }));
    }
    await Promise.race([Promise.all(anims.map((a) => a.finished.catch(() => {}))), wait(dur + 300)]);
    anims.forEach((a) => a.cancel());
    pz.close();
    pzBusy = false;
  };
  pz.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
  pz.addEventListener("click", (e) => {
    if (e.target === pz || e.target.classList.contains("zm-stage") || e.target.closest(".zm-close")) close();
  });
  card.addEventListener("pointermove", (e) => {
    if (e.pointerType === "touch") return;
    const r = card.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
    tilt.style.transform = `rotateY(${x * 20}deg) rotateX(${-y * 20}deg)`;
    card.style.setProperty("--gx", `${(x + 0.5) * 100}%`); card.style.setProperty("--gy", `${(y + 0.5) * 100}%`);
  });
  card.addEventListener("pointerleave", () => { tilt.style.transform = ""; });
  return pz;
}

// pick: { card, slot }, x: { value, rarity }, fromEl: elementet kortet ska växa fram från.
function packZoom(pick, x, fromEl) {
  const d = packZoomDialog();
  pzBusy = false;
  d.fromEl = fromEl;
  const img = d.querySelector(".zm-img");
  img.alt = pick.card.name;
  img.src = `${pick.card.image}/high.webp`;
  d.querySelector(".zm-name").textContent = pick.card.name;
  d.querySelector(".zm-sub").textContent = [x.rarity || pick.slot, pick.reverse ? "reverse holo" : ""].filter(Boolean).join(" · ");
  d.querySelector(".zm-price").innerHTML = x.value != null ? `<b>${money(x.value)}</b>` : "Inget pris";
  d.showModal();
  const card = d.querySelector(".zm-card");
  const dur = reduce ? 1 : 520;
  d.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reduce ? 1 : 240 });
  const to = card.getBoundingClientRect(), from = fromEl?.getBoundingClientRect();
  if (from && from.width) {
    const dx = from.left + from.width / 2 - (to.left + to.width / 2), dy = from.top + from.height / 2 - (to.top + to.height / 2), s = from.width / to.width;
    card.animate([{ transform: `translate(${dx}px,${dy}px) scale(${s})` }, { transform: "none" }], { duration: dur, easing: "cubic-bezier(.2,.8,.2,1)" });
  } else {
    card.animate([{ transform: "scale(.85)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: dur, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  d.querySelector(".zm-info").animate([{ opacity: 0, transform: "translateY(14px)" }, { opacity: 1, transform: "none" }], { duration: reduce ? 1 : 340, delay: reduce ? 0 : 200, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" });
}

// ---------- Kortleken: dra ett kort i taget åt sidan ----------
// Översta kortet ligger med framsidan upp. Dra det åt vänster eller höger (eller tryck på det) så flyger det
// ut ur bild och nästa kort, som låg under, visas med pris direkt.
const SHOW_ODDS = new URLSearchParams(location.search).has("odds"); // dropchans visas bara med ?odds i adressen

function renderDeck(set, { model, picks, info }, ticket) {
  const pull = $("#pull");
  const N = picks.length;
  pull.hidden = false;
  const cardHTML = (cls) => `<div class="dcard ${cls}"><img alt="" decoding="async" draggable="false"><span class="holo"></span><span class="glare"></span><span class="deck-tag" hidden></span></div>`;
  pull.innerHTML = `<div class="deck" data-tier="0">
      <div class="deck-fx" aria-hidden="true"></div>
      <div class="deck-stage" data-left="${N - 1}">
        <div class="deck-stack" aria-hidden="true"><i></i><i></i><i></i></div>
        ${cardHTML("under")}${cardHTML("top")}
      </div>
      <div class="deck-meta" aria-live="polite">
        <span class="deck-count"></span>
        <b class="deck-name"></b>
        <span class="deck-rarity"></span>
      </div>
      <p class="swipe-hint">Dra kortet åt sidan eller tryck på det</p>
      <div class="drawn" aria-label="Dragna kort"></div>
      <p class="pull-total" aria-live="polite"></p>
      <div class="hs-submit" hidden></div>
      <div class="pull-actions">
        <button type="button" class="btn small" data-skip>Visa alla</button>
        <button type="button" class="btn small primary" data-again hidden>Öppna ett till</button>
        <a class="btn small" href="butiker.html#notiser" data-notis hidden>Få notis när nya produkter kommer in</a>
      </div>
      ${SHOW_ODDS ? `<details class="odds" open><summary>Dropchans för ${esc(set.name)}</summary>${oddsTable(model)}</details>` : ""}
    </div>`;
  const deck = pull.querySelector(".deck"), stage = pull.querySelector(".deck-stage");
  let top = stage.querySelector(".dcard.top"), under = stage.querySelector(".dcard.under");
  const count = pull.querySelector(".deck-count"), nameEl = pull.querySelector(".deck-name"), rarityEl = pull.querySelector(".deck-rarity");
  const drawn = pull.querySelector(".drawn"), total = pull.querySelector(".pull-total"), fx = pull.querySelector(".deck-fx");
  const swipeHint = pull.querySelector(".swipe-hint");
  let idx = 0, animating = false, drag = null;
  const hintNormal = swipeHint.textContent, hintLast = "Dra kortet åt sidan för att avsluta, eller tryck på det för att förstora";
  const updateHint = () => { const last = idx === N - 1; swipeHint.textContent = last ? hintLast : hintNormal; top.classList.toggle("is-last", last); };

  const asTop = (el) => { el.classList.remove("under"); el.classList.add("top"); el.setAttribute("role", "button"); el.setAttribute("tabindex", "0"); el.setAttribute("aria-label", "Dra kortet åt sidan för att se nästa"); };
  const asUnder = (el) => { el.classList.remove("top"); el.classList.add("under"); el.removeAttribute("role"); el.removeAttribute("tabindex"); el.removeAttribute("aria-label"); };

  // Fyller ett kort med kort nummer i: bild, pris-pill och glöd efter värde.
  const paint = (el, i) => {
    const p = picks[i], x = info[i], img = el.querySelector("img");
    img.alt = p.card.name; img.src = `${p.card.image}/high.webp`;
    el.classList.remove("t0", "t1", "t2", "t3"); el.classList.add(`t${x.tier}`);
    el.classList.toggle("is-reverse", !!p.reverse);
    const tag = el.querySelector(".deck-tag");
    tag.classList.toggle("none", x.value == null);
    tag.innerHTML = x.value != null ? `<b>${money(x.value)}</b>` : "Inget pris";
    tag.hidden = false;
    el.hidden = false;
  };
  // Priset poppar fram när kortet avslöjas, extra mycket för värdefulla kort.
  const popTag = (el, tier) => {
    const tag = el.querySelector(".deck-tag");
    if (!tag || tag.hidden) return;
    playCoin(tier);
    if (reduce) return;
    const big = tier >= 2 ? 1.55 : 1.3;
    tag.animate([
      { transform: "translateX(-50%) scale(.3)", opacity: 0 },
      { transform: `translateX(-50%) scale(${big})`, opacity: 1, offset: 0.6 },
      { transform: "translateX(-50%) scale(1)", opacity: 1 },
    ], { duration: 560, delay: 120, easing: "cubic-bezier(.2,1.3,.4,1)", fill: "backwards" });
  };
  const meta = (i) => {
    const x = info[i];
    count.textContent = `Kort ${i + 1} av ${N}`;
    nameEl.textContent = picks[i].card.name;
    rarityEl.textContent = [x.rarity || picks[i].slot, picks[i].reverse ? "· reverse holo" : ""].filter(Boolean).join(" ");
    rarityEl.className = `deck-rarity t${x.tier}`;
  };
  const pushDrawn = (i) => drawn.insertAdjacentHTML("beforeend", `<span class="dthumb t${info[i].tier}" data-i="${i}" role="button" tabindex="0" aria-label="Förstora ${esc(picks[i].card.name)}"><img src="${esc(picks[i].card.image)}/low.webp" alt="${esc(picks[i].card.name)}"></span>`);

  const celebrate = (tier) => {
    deck.dataset.tier = tier;
    fx.innerHTML = "";
    if (tier < 2 || reduce) return;
    const colors = tier === 3 ? ["#f2b632", "#fff2b0", "#ff7ab0", "#5fd3e0", "#e4572e"] : ["#f2b632", "#fff2b0", "#ffffff"];
    const n = tier === 3 ? 46 : 16;
    fx.insertAdjacentHTML("beforeend", Array.from({ length: n }, () => {
      const a = Math.random() * Math.PI * 2, dist = 110 + Math.random() * (tier === 3 ? 230 : 150);
      return `<b style="--x:${Math.round(Math.cos(a) * dist)}px;--y:${Math.round(Math.sin(a) * dist - 40)}px;--r:${Math.round(Math.random() * 540 - 270)}deg;--c:${colors[Math.floor(Math.random() * colors.length)]};--d:${(Math.random() * 0.25).toFixed(2)}s"></b>`;
    }).join(""));
    setTimeout(() => (fx.innerHTML = ""), 2600);
    if (tier === 3) stage.animate([{ translate: "0 0" }, { translate: "-6px 3px" }, { translate: "6px -3px" }, { translate: "-4px -2px" }, { translate: "4px 2px" }, { translate: "0 0" }], { duration: 480, delay: 350 });
  };

  const finish = () => {
    const sum = info.reduce((s, x) => s + (x.value || 0), 0);
    const best = info.reduce((b, x, i) => ((x.value || 0) > (info[b].value || 0) ? i : b), 0);
    // Under 10 kr: man får öppna ett nytt. Annars var det dagens pack.
    const again = sum < DAY_MIN;
    total.innerHTML = `${sum > 0 ? `Packet var värt ca <b>${kr(sum)}</b>${info[best].value ? ` · bästa kort: ${esc(picks[best].card.name)} (ca ${kr(info[best].value)})` : ""}. ` : ""}`
      + (again ? `<b class="pull-again">Under ${DAY_MIN} kr, så du får öppna ett till!</b>` : `Det var dagens pack. Nästa pack om ${untilTomorrow()}.`);
    pull.querySelector("[data-again]").hidden = !again;
    pull.querySelector("[data-notis]").hidden = again; // efter dagens pack: tipsa om notiser i stället
    stage.hidden = true; swipeHint.hidden = true;
    count.textContent = `Alla ${N} kort dragna`;
    nameEl.textContent = info[best].value ? picks[best].card.name : "";
    rarityEl.textContent = info[best].value ? `Bästa kortet · ca ${kr(info[best].value)}` : "";
    rarityEl.className = `deck-rarity t${info[best].tier}`;
    deck.dataset.tier = "0";
    track("pack_open", set.name, Math.round(sum));
    // Topplistan bara för pack värda minst 10 kr, alltså dagens riktiga pack.
    if (!again) {
      const b = picks[best].card;
      submitForm(pull.querySelector(".hs-submit"), {
        pack_value: Math.round(sum), set_id: set.id, set_name: set.name,
        best_card_name: b.name, best_card_value: Math.round(info[best].value || 0), best_card_img: b.image ? `${b.image}/low.webp` : "",
      }, ticket);
    }
  };

  // Flyger översta kortet ur bild åt vänster (dir -1) eller höger (1). Nästa kort ligger redan under och syns direkt.
  const fling = async (dir, fromDx = 0) => {
    if (animating) return;
    animating = true;
    const i = idx, next = i + 1, last = next >= N;
    if (!last) { meta(next); celebrate(info[next].tier); popTag(under, info[next].tier); } // priset och glöden visas direkt när kortet avslöjas
    const off = dir * (innerWidth * 0.75 + 260);
    const a = top.animate([
      { transform: `translateX(${fromDx}px) rotate(${fromDx / 16}deg)`, opacity: 1 },
      { transform: `translateX(${off}px) rotate(${dir * 26}deg)`, opacity: 0.25 },
    ], { duration: reduce ? 1 : 430, easing: "cubic-bezier(.4,0,.9,.55)", fill: "forwards" });
    await Promise.race([a.finished.catch(() => {}), wait(750)]);
    pushDrawn(i);
    if (last) { a.cancel(); top.hidden = true; under.hidden = true; finish(); animating = false; return; }
    idx = next;
    stage.dataset.left = String(N - 1 - idx);
    // Rollerna byts: kortet som låg under är nu överst, det som flög bort läggs underst med kortet efter nästa.
    const flown = top;
    [top, under] = [under, top];
    asTop(top); asUnder(under);
    if (idx + 1 < N) paint(under, idx + 1); else under.hidden = true;
    flown.style.transform = "";
    a.cancel();
    updateHint();
    top.focus({ preventScroll: true });
    animating = false;
  };

  const skip = () => {
    if (animating || idx >= N - 1) return;
    while (idx < N - 1) { pushDrawn(idx); idx++; }
    paint(top, N - 1); under.hidden = true;
    stage.dataset.left = "0";
    meta(N - 1); celebrate(info[N - 1].tier);
    updateHint();
  };

  // Start: översta kortet kommer in, nästa ligger under.
  paint(top, 0);
  if (N > 1) paint(under, 1); else under.hidden = true;
  asTop(top); asUnder(under);
  meta(0);
  top.animate([{ transform: "scale(.82) translateY(30px)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: reduce ? 1 : 420, easing: "cubic-bezier(.2,.8,.2,1)" });
  celebrate(info[0].tier);
  popTag(top, info[0].tier);
  updateHint();

  // Dra med pekaren eller fingret. Kort drag studsar tillbaka, långt drag eller ett tryck flyger kortet iväg.
  stage.addEventListener("pointerdown", (e) => {
    if (animating || !e.target.closest(".dcard.top")) return;
    drag = { x: e.clientX, dx: 0, t: performance.now() };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    drag.dx = e.clientX - drag.x;
    top.style.transform = `translateX(${drag.dx}px) rotate(${drag.dx / 16}deg)`;
  });
  // Tryck: sista kortet förstoras, övriga flyger iväg åt ett slumpat håll.
  const tapCard = () => { if (idx === N - 1) packZoom(picks[idx], info[idx], top); else fling(Math.random() < 0.5 ? -1 : 1); };
  drawn.addEventListener("click", (e) => { const t = e.target.closest(".dthumb"); if (t) packZoom(picks[+t.dataset.i], info[+t.dataset.i], t.querySelector("img")); });
  drawn.addEventListener("keydown", (e) => { const t = e.target.closest(".dthumb"); if (t && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); packZoom(picks[+t.dataset.i], info[+t.dataset.i], t.querySelector("img")); } });
  const release = () => {
    if (!drag) return;
    const { dx, t } = drag; drag = null;
    const speed = Math.abs(dx) / Math.max(1, performance.now() - t);
    if (Math.abs(dx) < 8) { top.style.transform = ""; tapCard(); }
    else if (Math.abs(dx) > 70 || speed > 0.6) fling(dx < 0 ? -1 : 1, dx);
    else {
      const back = top.animate([{ transform: `translateX(${dx}px) rotate(${dx / 16}deg)` }, { transform: "none" }], { duration: reduce ? 1 : 260, easing: "cubic-bezier(.2,1.2,.4,1)" });
      top.style.transform = ""; back.finished.catch(() => {});
    }
  };
  stage.addEventListener("pointerup", release);
  stage.addEventListener("pointercancel", release);
  stage.addEventListener("keydown", (e) => {
    if (!e.target.closest(".dcard.top")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); fling(-1); }
    else if (e.key === "ArrowRight") { e.preventDefault(); fling(1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); tapCard(); }
  });
  pull.querySelector("[data-skip]").addEventListener("click", skip);
  pull.querySelector("[data-again]").addEventListener("click", reset);
}

function oddsTable(m) {
  const rows = m.classes.map((c) => `<tr><td>${esc(c.label)}</td><td>${c.cards.length}</td><td>${pct(c.chance)}</td></tr>`).join("");
  return `<table class="odds-table"><thead><tr><th>Sort</th><th>Kort i setet</th><th>Chans per pack</th></tr></thead><tbody>${rows}</tbody></table>
    <p>Varje pack har 10 kort: 5 vanliga, 3 ovanliga, en reverse holo-plats och en sällsynt-plats. Sällsynt-platsen avgör vad du får. Reverse holo-platsen har dessutom ${pct(REVERSE_BONUS)} chans att bli ett bonuskort av en högre sort. Procenten är en förenklad uppskattning, inte officiella odds.</p>`;
}

function reset() {
  const row = $("#pack-row"), pull = $("#pull");
  pull.hidden = true;
  pull.innerHTML = "";
  row.hidden = false;
  row.classList.remove("has-chosen");
  $("#pack-stage").classList.remove("is-opening");
  if (packPool.length) renderPacks(); // nya slumpade pack till nästa öppning
  applyLock();
}

$("#pack-row")?.addEventListener("click", (e) => { const b = e.target.closest(".pack"); if (b) openPack(b); });

feed();
setInterval(feed, 60e3);
setupPacks();
