// Setsidorna i set/ (byggs av scripts/build-set-pages.mjs). Allt om setet står redan i HTML:en, här läggs bara
// det levande till: butikernas lager för setet (uppdateras varje minut) och knappen som visar alla kort med bilder.
import { $, esc, liveStock, productCard, skeleton } from "./site.js";
import { groupKey } from "./group.js";
import { bindSetCards } from "./setcards.js";

bindSetCards($("#main"));

const SHOW = 12;
const grid = $("#set-stock"), countEl = $("#set-stock-count");

async function stock() {
  if (!grid.children.length) grid.innerHTML = skeleton(4);
  try {
    const [p, s] = await liveStock();
    const name = grid.dataset.name, lang = grid.dataset.lang;
    // Samma koppling som släppkalendern: bevakningens setklassning eller något av setets sökord i namnet.
    const terms = JSON.parse(grid.dataset.match || "[]").map((t) => t.toLowerCase());
    const names = Object.fromEntries((s.stores || []).map((x) => [x.id, x.name]));
    const seen = new Set();
    // Äldre lagerfiler saknar spelet. Då räcker setets sökord.
    const byGame = (p.products || []).some((x) => x.game);
    const mine = (p.products || [])
      // Samma spel som setet: Riftbound "Legacy" ska inte hitta One Piece "Legacy of the Master".
      .filter((x) => (!byGame || (x.game || "") === (grid.dataset.game || "")) && (x.available || x.preorder)
        && (x.set === name || terms.includes(String(x.set).toLowerCase()) || terms.some((t) => x.title.toLowerCase().includes(t))) && (lang !== "en" || x.lang === "en"))
      .sort((a, b) => (b.available - a.available) || a.price - b.price);
    const stores = new Set(mine.map((x) => x.store));
    const list = mine.filter((x) => { const k = groupKey(x); return !seen.has(k) && seen.add(k); });
    // Före släppdagen är allt som går att köpa en förbeställning, även om butiken kallar det "i lager".
    const released = !grid.dataset.date || new Date(`${grid.dataset.date}T00:00:00`) <= new Date();
    const inStock = released ? mine.filter((x) => x.available).length : 0;
    countEl.textContent = mine.length
      ? `${[inStock && `${inStock} i lager`, mine.length > inStock && `${mine.length - inStock} att förbeställa`].filter(Boolean).join(" och ")} hos ${stores.size} ${stores.size === 1 ? "butik" : "butiker"} just nu. Billigast först.`
      : `Ingen bevakad butik har ${name} i lager just nu. Sidan uppdateras av sig själv när något kommer in.`;
    grid.innerHTML = list.slice(0, SHOW).map((x) => productCard(x, names[x.store])).join("");
    const more = $("#set-stock-more");
    more.hidden = list.length <= SHOW;
    more.querySelector("a").textContent = `Visa alla ${list.length} produkter`;
  } catch {
    grid.innerHTML = "";
    countEl.innerHTML = `Lagret kunde inte hämtas just nu. <a href="butiker.html?q=${esc(encodeURIComponent(grid.dataset.name))}#products">Sök i butikerna</a>.`;
  }
}

if (grid) { stock(); setInterval(stock, 60e3); }

// One Piece och Riftbound: korten med bilder kan sorteras på nummer eller pris.
const sortBox = $(".set-sort"), all = $(".set-all");
if (sortBox && all) sortBox.addEventListener("click", (e) => {
  const b = e.target.closest("[data-sort]");
  if (!b) return;
  sortBox.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  const price = (li) => (li.dataset.price === "" ? -1 : +li.dataset.price);
  const cmp = b.dataset.sort === "price" ? (x, y) => price(y) - price(x)
    : (x, y) => x.dataset.no.localeCompare(y.dataset.no, "sv", { numeric: true });
  all.append(...[...all.children].sort(cmp));
});

// Kortlistan: håll musen över ett namn så visas kortet bredvid pekaren. Bara med mus, inte på pekskärm.
const table = $(".set-table.cards");
if (table && matchMedia("(hover: hover) and (pointer: fine)").matches) {
  const peek = Object.assign(document.createElement("img"), { className: "card-peek", alt: "", hidden: true, decoding: "async" });
  peek.referrerPolicy = "no-referrer";
  peek.onerror = () => { peek.hidden = true; };
  document.body.append(peek);
  const place = (x, y) => {
    const w = peek.offsetWidth || 220, h = peek.offsetHeight || 308, gap = 18;
    const left = x + gap + w > innerWidth - 8 ? x - gap - w : x + gap;
    const top = Math.max(8, Math.min(y - h / 2, innerHeight - h - 8));
    peek.style.transform = `translate(${left}px, ${top}px)`;
  };
  table.addEventListener("pointerover", (e) => {
    const el = e.target.closest("[data-img]");
    if (!el) return;
    if (peek.getAttribute("src") !== el.dataset.img) peek.src = el.dataset.img;
    peek.hidden = false;
    place(e.clientX, e.clientY);
  });
  table.addEventListener("pointermove", (e) => { if (!peek.hidden) place(e.clientX, e.clientY); });
  table.addEventListener("pointerout", (e) => {
    const el = e.target.closest("[data-img]");
    if (el && !el.contains(e.relatedTarget)) peek.hidden = true;
  });
  addEventListener("scroll", () => { peek.hidden = true; }, { passive: true });
}
