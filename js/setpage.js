// Setsidorna i set/ (byggs av scripts/build-set-pages.mjs). Allt om setet står redan i HTML:en, här läggs bara
// det levande till: butikernas lager för setet (uppdateras varje minut) och knappen som visar alla kort med bilder.
import { $, esc, liveJSON, productCard, skeleton } from "./site.js";
import { groupKey } from "./group.js";
import { bindSetCards } from "./setcards.js";

bindSetCards($("#main"));

const SHOW = 12;
const grid = $("#set-stock"), countEl = $("#set-stock-count");

async function stock() {
  if (!grid.children.length) grid.innerHTML = skeleton(4);
  try {
    const [p, s] = await Promise.all([liveJSON("data/stock.json"), liveJSON("data/stores-status.json")]);
    const name = grid.dataset.name, lang = grid.dataset.lang;
    // Samma koppling som släppkalendern: bevakningens setklassning eller något av setets sökord i namnet.
    const terms = JSON.parse(grid.dataset.match || "[]").map((t) => t.toLowerCase());
    const names = Object.fromEntries((s.stores || []).map((x) => [x.id, x.name]));
    const seen = new Set();
    const mine = (p.products || [])
      .filter((x) => (x.available || x.preorder) && (x.set === name || terms.some((t) => x.title.toLowerCase().includes(t))) && (lang !== "en" || x.lang === "en"))
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
